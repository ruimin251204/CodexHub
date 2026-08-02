use crate::workspace::error::{WorkspaceError, WorkspaceResult};
use crate::workspace::events::{
    emit, TransferUpdatedEvent, WorkspaceEventSink, TRANSFER_UPDATED_EVENT,
};
use crate::workspace::types::{
    ConflictStrategy, EnqueueTransfersRequest, ResolveTransferConflictRequest, TransferDto,
    TransferIdentityRequest, TransferState,
};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub const MAX_GLOBAL_TRANSFERS: usize = 4;
pub const MAX_HOST_TRANSFERS: usize = 2;

/// Durable implementations should store each update transactionally. Terminal
/// bytes and file preview contents must never be added to this persistence API.
pub trait TransferPersistence: Send + Sync {
    fn load_all(&self) -> Result<Vec<TransferDto>, String>;
    fn upsert(&self, transfer: &TransferDto) -> Result<(), String>;
}

#[derive(Default)]
pub struct MemoryTransferPersistence {
    values: Mutex<HashMap<String, TransferDto>>,
}

impl TransferPersistence for MemoryTransferPersistence {
    fn load_all(&self) -> Result<Vec<TransferDto>, String> {
        let mut values = self
            .values
            .lock()
            .map_err(|_| "transfer persistence lock is poisoned".to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.transfer_id.cmp(&right.transfer_id));
        Ok(values)
    }

    fn upsert(&self, transfer: &TransferDto) -> Result<(), String> {
        self.values
            .lock()
            .map_err(|_| "transfer persistence lock is poisoned".to_string())?
            .insert(transfer.transfer_id.clone(), transfer.clone());
        Ok(())
    }
}

pub struct TransferQueue {
    values: Mutex<HashMap<String, TransferDto>>,
    /// A token is deliberately process-local.  Durable state records the
    /// outcome, while a live worker observes pause/cancel at chunk boundaries.
    controls: Mutex<HashMap<String, CancellationToken>>,
    persistence: Arc<dyn TransferPersistence>,
    event_sink: Option<WorkspaceEventSink>,
}

/// Internal result for one conflict decision. The command returns only the
/// requested transfer, while its audit layer can settle every batch item that
/// was cancelled by an explicitly selected "apply to batch" decision.
#[derive(Debug)]
pub struct ConflictResolution {
    pub primary: TransferDto,
    pub affected: Vec<TransferDto>,
}

impl TransferQueue {
    pub fn new(
        persistence: Arc<dyn TransferPersistence>,
        event_sink: Option<WorkspaceEventSink>,
    ) -> WorkspaceResult<Self> {
        let mut values = HashMap::new();
        for mut transfer in persistence
            .load_all()
            .map_err(|error| WorkspaceError::new("transfer-storage-unavailable", error))?
        {
            // A process restart loses every live transfer plan and one-shot
            // local grant. Both queued and in-flight rows must be explicitly
            // rebound rather than later claiming a worker with no authority.
            if matches!(
                transfer.state,
                TransferState::Queued
                    | TransferState::WaitingConflict
                    | TransferState::Running
                    | TransferState::Pausing
                    | TransferState::Verifying
                    | TransferState::Finalizing
            ) {
                transfer.state = TransferState::Interrupted;
                transfer.revision = transfer.revision.saturating_add(1);
                transfer.error_code = Some("transfer-reauthorization-required".into());
                persistence
                    .upsert(&transfer)
                    .map_err(|error| WorkspaceError::new("transfer-storage-unavailable", error))?;
            }
            values.insert(transfer.transfer_id.clone(), transfer);
        }
        Ok(Self {
            values: Mutex::new(values),
            controls: Mutex::new(HashMap::new()),
            persistence,
            event_sink,
        })
    }

    pub fn in_memory(event_sink: Option<WorkspaceEventSink>) -> Self {
        Self::new(Arc::new(MemoryTransferPersistence::default()), event_sink)
            .expect("in-memory transfer persistence cannot fail")
    }

    pub fn list(&self) -> WorkspaceResult<Vec<TransferDto>> {
        let mut values = self
            .values
            .lock()
            .map_err(|_| {
                WorkspaceError::new("workspace-lock-poisoned", "Transfer queue is unavailable.")
            })?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        values.sort_by(|left, right| left.transfer_id.cmp(&right.transfer_id));
        Ok(values)
    }

    pub fn enqueue(&self, request: EnqueueTransfersRequest) -> WorkspaceResult<Vec<TransferDto>> {
        if request.items.is_empty() {
            return Err(WorkspaceError::new(
                "empty-transfer-batch",
                "At least one transfer item is required.",
            ));
        }
        if request.items.len() > 500 {
            return Err(WorkspaceError::new(
                "transfer-batch-too-large",
                "A transfer batch cannot contain more than 500 items.",
            ));
        }

        let batch_id = format!("batch-{}", Uuid::new_v4());
        let mut created = Vec::with_capacity(request.items.len());
        let mut values = self.values.lock().map_err(|_| {
            WorkspaceError::new("workspace-lock-poisoned", "Transfer queue is unavailable.")
        })?;
        for draft in request.items {
            if draft.destination_path.trim().is_empty() {
                return Err(WorkspaceError::new(
                    "invalid-destination",
                    "The transfer destination path is required.",
                ));
            }
            let now = chrono::Local::now().to_rfc3339();
            let transfer = TransferDto {
                transfer_id: format!("transfer-{}", Uuid::new_v4()),
                batch_id: batch_id.clone(),
                task_id: None,
                direction: draft.direction,
                host_id: draft.host_id,
                host_name: draft.host_name,
                host_alias: draft.host_alias,
                source_ref: draft.source_ref,
                destination_path: draft.destination_path,
                created_at: now.clone(),
                updated_at: now,
                state: TransferState::Queued,
                revision: 1,
                bytes: 0,
                total: draft.total_bytes,
                speed: None,
                eta_seconds: None,
                attempt: 0,
                resumable: false,
                resume_offset: None,
                conflict_strategy: draft.conflict_strategy.unwrap_or(ConflictStrategy::Ask),
                conflict_revision: None,
                error_code: None,
                fingerprint_status: None,
                durable_source_fingerprint: None,
                durable_partial_locator: None,
            };
            self.persistence
                .upsert(&transfer)
                .map_err(|error| WorkspaceError::new("transfer-storage-unavailable", error))?;
            values.insert(transfer.transfer_id.clone(), transfer.clone());
            created.push(transfer);
        }
        drop(values);
        for transfer in &created {
            self.emit_update(transfer);
        }
        Ok(created)
    }

    pub fn pause(&self, request: TransferIdentityRequest) -> WorkspaceResult<TransferDto> {
        let updated = self.update(&request.transfer_id, |transfer| match transfer.state {
            TransferState::Running | TransferState::Verifying => {
                transfer.state = TransferState::Pausing;
                Ok(())
            }
            TransferState::Queued => {
                transfer.state = TransferState::Paused;
                Ok(())
            }
            _ => Err(invalid_transition("pause", transfer.state)),
        })?;
        if matches!(updated.state, TransferState::Pausing) {
            self.signal_worker(&updated.transfer_id);
        }
        Ok(updated)
    }

    /// Called by a transfer worker after it has closed the current attempt and
    /// left the verified partial file in place.
    pub fn mark_paused(
        &self,
        transfer_id: &str,
        resume_offset: u64,
    ) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if transfer.state != TransferState::Pausing {
                return Err(invalid_transition("finish pausing", transfer.state));
            }
            transfer.state = TransferState::Paused;
            transfer.resumable = true;
            transfer.resume_offset = Some(resume_offset);
            transfer.bytes = resume_offset;
            transfer.speed = None;
            transfer.eta_seconds = None;
            Ok(())
        })
    }

    pub fn resume(&self, request: TransferIdentityRequest) -> WorkspaceResult<TransferDto> {
        self.update(&request.transfer_id, |transfer| match transfer.state {
            TransferState::Paused | TransferState::Interrupted => {
                transfer.state = TransferState::Queued;
                transfer.error_code = None;
                Ok(())
            }
            _ => Err(invalid_transition("resume", transfer.state)),
        })
    }

    pub fn cancel(&self, request: TransferIdentityRequest) -> WorkspaceResult<TransferDto> {
        let updated = self.update(&request.transfer_id, |transfer| match transfer.state {
            TransferState::Finalizing | TransferState::Completed => Err(WorkspaceError::new(
                "too-late",
                "The transfer is already committing or completed and cannot be cancelled.",
            )),
            TransferState::Cancelled => Ok(()),
            _ => {
                transfer.state = TransferState::Cancelled;
                transfer.speed = None;
                transfer.eta_seconds = None;
                Ok(())
            }
        })?;
        self.signal_worker(&updated.transfer_id);
        Ok(updated)
    }

    pub fn retry(&self, request: TransferIdentityRequest) -> WorkspaceResult<TransferDto> {
        self.update(&request.transfer_id, |transfer| match transfer.state {
            TransferState::Failed | TransferState::Interrupted => {
                transfer.state = TransferState::Queued;
                transfer.error_code = None;
                transfer.speed = None;
                transfer.eta_seconds = None;
                if request.restart {
                    transfer.bytes = 0;
                    transfer.resumable = false;
                    transfer.resume_offset = None;
                }
                Ok(())
            }
            _ => Err(invalid_transition("retry", transfer.state)),
        })
    }

    /// Associates the durable Job Manager audit record after queue creation.
    pub fn set_task_id(&self, transfer_id: &str, task_id: String) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            transfer.task_id = Some(task_id);
            Ok(())
        })
    }

    pub fn resolve_conflict(
        &self,
        request: ResolveTransferConflictRequest,
    ) -> WorkspaceResult<ConflictResolution> {
        let mut values = self.values.lock().map_err(|_| {
            WorkspaceError::new("workspace-lock-poisoned", "Transfer queue is unavailable.")
        })?;
        let primary = values
            .get(&request.transfer_id)
            .cloned()
            .ok_or_else(|| WorkspaceError::new("transfer-not-found", "Transfer not found."))?;
        if primary.state != TransferState::WaitingConflict {
            return Err(invalid_transition("resolve conflict", primary.state));
        }
        if primary.conflict_revision != Some(request.conflict_revision) {
            return Err(WorkspaceError::new(
                "stale-conflict",
                "The transfer conflict changed and must be reviewed again.",
            ));
        }

        // Apply only to pending conflicts of the same kind in this enqueue
        // batch: same direction and host. It is intentionally not a global
        // preference and never touches already-running or completed items.
        let affected_ids = values
            .values()
            .filter(|candidate| {
                candidate.transfer_id == primary.transfer_id
                    || (request.apply_to_batch
                        && candidate.batch_id == primary.batch_id
                        && candidate.host_id == primary.host_id
                        && candidate.direction == primary.direction
                        && candidate.state == TransferState::WaitingConflict)
            })
            .map(|candidate| candidate.transfer_id.clone())
            .collect::<Vec<_>>();
        let mut affected = Vec::with_capacity(affected_ids.len());
        for transfer_id in affected_ids {
            let transfer = values
                .get_mut(&transfer_id)
                .expect("conflict candidate remains present while queue lock is held");
            transfer.conflict_strategy = request.strategy;
            transfer.conflict_revision = None;
            transfer.state = if request.strategy == ConflictStrategy::Skip {
                TransferState::Cancelled
            } else {
                TransferState::Queued
            };
            transfer.revision = transfer.revision.saturating_add(1);
            transfer.speed = None;
            transfer.eta_seconds = None;
            self.persistence
                .upsert(transfer)
                .map_err(|error| WorkspaceError::new("transfer-storage-unavailable", error))?;
            affected.push(transfer.clone());
        }
        let primary = affected
            .iter()
            .find(|candidate| candidate.transfer_id == request.transfer_id)
            .cloned()
            .expect("primary conflict candidate is always affected");
        drop(values);
        for transfer in &affected {
            self.emit_update(transfer);
        }
        Ok(ConflictResolution { primary, affected })
    }

    /// Claims the next queued transfer while enforcing the fixed global and
    /// per-host limits. The caller owns actual I/O and must report each stage.
    pub fn claim_next(&self) -> WorkspaceResult<Option<TransferDto>> {
        let values = self.values.lock().map_err(|_| {
            WorkspaceError::new("workspace-lock-poisoned", "Transfer queue is unavailable.")
        })?;
        let running = values
            .values()
            .filter(|transfer| is_active_worker_state(transfer.state))
            .collect::<Vec<_>>();
        if running.len() >= MAX_GLOBAL_TRANSFERS {
            return Ok(None);
        }
        let candidate = values
            .values()
            .filter(|transfer| transfer.state == TransferState::Queued)
            .find(|candidate| {
                running
                    .iter()
                    .filter(|active| active.host_id == candidate.host_id)
                    .count()
                    < MAX_HOST_TRANSFERS
            })
            .map(|transfer| transfer.transfer_id.clone());
        drop(values);
        candidate.map(|id| self.mark_running(&id)).transpose()
    }

    pub fn mark_running(&self, transfer_id: &str) -> WorkspaceResult<TransferDto> {
        let updated = self.update(transfer_id, |transfer| {
            if transfer.state != TransferState::Queued {
                return Err(invalid_transition("start", transfer.state));
            }
            transfer.state = TransferState::Running;
            transfer.attempt = transfer.attempt.saturating_add(1);
            transfer.error_code = None;
            Ok(())
        })?;
        self.controls
            .lock()
            .map_err(|_| {
                WorkspaceError::new(
                    "workspace-lock-poisoned",
                    "Transfer controls are unavailable.",
                )
            })?
            .insert(updated.transfer_id.clone(), CancellationToken::new());
        Ok(updated)
    }

    /// The token is only meaningful while the worker owns a running attempt.
    /// It is never persisted because a restarted process cannot safely resume
    /// an old cancellation request.
    pub fn worker_token(&self, transfer_id: &str) -> WorkspaceResult<CancellationToken> {
        self.controls
            .lock()
            .map_err(|_| {
                WorkspaceError::new(
                    "workspace-lock-poisoned",
                    "Transfer controls are unavailable.",
                )
            })?
            .get(transfer_id)
            .cloned()
            .ok_or_else(|| {
                WorkspaceError::new("transfer-not-running", "The transfer has no active worker.")
            })
    }

    pub fn release_worker(&self, transfer_id: &str) {
        if let Ok(mut controls) = self.controls.lock() {
            controls.remove(transfer_id);
        }
    }

    /// A bounded automatic retry stays in the same worker slot.  It creates a
    /// fresh cancellation token and an observable attempt number.
    pub fn restart_attempt(&self, transfer_id: &str) -> WorkspaceResult<TransferDto> {
        let updated = self.update(transfer_id, |transfer| {
            if !matches!(
                transfer.state,
                TransferState::Running | TransferState::Verifying
            ) {
                return Err(invalid_transition("retry", transfer.state));
            }
            transfer.attempt = transfer.attempt.saturating_add(1);
            transfer.error_code = None;
            transfer.speed = None;
            transfer.eta_seconds = None;
            // This legacy helper models an explicit restart, not a transport
            // retry. Only `restart_attempt_preserving_resume` may retain an
            // offset until I/O has checked both partial-file prefixes.
            transfer.bytes = 0;
            transfer.resumable = false;
            transfer.resume_offset = None;
            Ok(())
        })?;
        self.controls
            .lock()
            .map_err(|_| {
                WorkspaceError::new(
                    "workspace-lock-poisoned",
                    "Transfer controls are unavailable.",
                )
            })?
            .insert(updated.transfer_id.clone(), CancellationToken::new());
        Ok(updated)
    }

    /// A transport retry keeps the last durable stream position until the I/O
    /// layer has reconnected and verified the partial prefix.  It still gets
    /// a fresh cancellation token and an observable attempt number.
    pub fn restart_attempt_preserving_resume(
        &self,
        transfer_id: &str,
    ) -> WorkspaceResult<TransferDto> {
        let updated = self.update(transfer_id, |transfer| {
            if !matches!(
                transfer.state,
                TransferState::Running | TransferState::Verifying
            ) {
                return Err(invalid_transition("retry", transfer.state));
            }
            transfer.attempt = transfer.attempt.saturating_add(1);
            transfer.error_code = None;
            transfer.speed = None;
            transfer.eta_seconds = None;
            Ok(())
        })?;
        self.controls
            .lock()
            .map_err(|_| {
                WorkspaceError::new(
                    "workspace-lock-poisoned",
                    "Transfer controls are unavailable.",
                )
            })?
            .insert(updated.transfer_id.clone(), CancellationToken::new());
        Ok(updated)
    }

    pub fn set_total_and_fingerprint(
        &self,
        transfer_id: &str,
        total: u64,
        fingerprint_status: impl Into<String>,
    ) -> WorkspaceResult<TransferDto> {
        let fingerprint_status = fingerprint_status.into();
        self.update(transfer_id, |transfer| {
            if transfer.state != TransferState::Running {
                return Err(invalid_transition("preflight", transfer.state));
            }
            transfer.total = Some(total);
            transfer.fingerprint_status = Some(fingerprint_status);
            Ok(())
        })
    }

    /// Binds private recovery facts only after a native local-path grant has
    /// been consumed. The public DTO exposes just the coarse verified state.
    pub fn configure_resume(
        &self,
        transfer_id: &str,
        total: u64,
        durable_source_fingerprint: String,
        durable_partial_locator: String,
    ) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if !matches!(
                transfer.state,
                TransferState::Queued | TransferState::Running
            ) {
                return Err(invalid_transition("configure resume", transfer.state));
            }
            transfer.total = Some(total);
            transfer.fingerprint_status = Some("source-verified".into());
            transfer.durable_source_fingerprint = Some(durable_source_fingerprint);
            transfer.durable_partial_locator = Some(durable_partial_locator);
            Ok(())
        })
    }

    /// Aligns durable progress with a freshly checked staging prefix before a
    /// resumed stream starts. It intentionally permits a safe restart at 0.
    pub fn set_stream_position(
        &self,
        transfer_id: &str,
        offset: u64,
    ) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if transfer.state != TransferState::Running {
                return Err(invalid_transition("resume stream", transfer.state));
            }
            if transfer.total.is_some_and(|total| offset > total) {
                return Err(WorkspaceError::new(
                    "invalid-resume-offset",
                    "The verified partial exceeds the transfer total.",
                ));
            }
            transfer.bytes = offset;
            transfer.resumable = offset > 0;
            transfer.resume_offset = (offset > 0).then_some(offset);
            transfer.speed = None;
            transfer.eta_seconds = None;
            Ok(())
        })
    }

    pub fn replace_destination(
        &self,
        transfer_id: &str,
        destination: String,
    ) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if !matches!(
                transfer.state,
                TransferState::Queued | TransferState::Running
            ) {
                return Err(invalid_transition("choose destination", transfer.state));
            }
            transfer.destination_path = destination;
            Ok(())
        })
    }

    pub fn update_progress(
        &self,
        transfer_id: &str,
        bytes: u64,
        speed: Option<u64>,
        eta_seconds: Option<u64>,
    ) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if transfer.state != TransferState::Running {
                return Err(invalid_transition("report progress", transfer.state));
            }
            if bytes < transfer.bytes || transfer.total.is_some_and(|total| bytes > total) {
                return Err(WorkspaceError::new(
                    "invalid-transfer-progress",
                    "Transfer progress must be monotonic and cannot exceed the total size.",
                ));
            }
            transfer.bytes = bytes;
            transfer.speed = speed;
            transfer.eta_seconds = eta_seconds;
            Ok(())
        })
    }

    pub fn mark_waiting_conflict(&self, transfer_id: &str) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if !matches!(
                transfer.state,
                TransferState::Queued | TransferState::Running
            ) {
                return Err(invalid_transition("wait for conflict", transfer.state));
            }
            transfer.state = TransferState::WaitingConflict;
            transfer.conflict_revision = Some(transfer.revision.saturating_add(1));
            Ok(())
        })
    }

    pub fn mark_verifying(&self, transfer_id: &str) -> WorkspaceResult<TransferDto> {
        self.transition(
            transfer_id,
            TransferState::Running,
            TransferState::Verifying,
        )
    }

    pub fn mark_finalizing(&self, transfer_id: &str) -> WorkspaceResult<TransferDto> {
        self.transition(
            transfer_id,
            TransferState::Verifying,
            TransferState::Finalizing,
        )
    }

    pub fn mark_completed(&self, transfer_id: &str) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if transfer.state != TransferState::Finalizing {
                return Err(invalid_transition("complete", transfer.state));
            }
            transfer.state = TransferState::Completed;
            if let Some(total) = transfer.total {
                transfer.bytes = total;
            }
            transfer.speed = None;
            transfer.eta_seconds = None;
            transfer.resumable = false;
            transfer.resume_offset = None;
            transfer.durable_partial_locator = None;
            Ok(())
        })
    }

    pub fn mark_failed(
        &self,
        transfer_id: &str,
        error_code: impl Into<String>,
        resumable: bool,
        resume_offset: Option<u64>,
    ) -> WorkspaceResult<TransferDto> {
        let error_code = error_code.into();
        self.update(transfer_id, |transfer| {
            if matches!(
                transfer.state,
                TransferState::Completed | TransferState::Cancelled
            ) {
                return Err(invalid_transition("fail", transfer.state));
            }
            transfer.state = TransferState::Failed;
            transfer.error_code = Some(error_code);
            transfer.resumable = resumable;
            transfer.resume_offset = resume_offset;
            transfer.speed = None;
            transfer.eta_seconds = None;
            Ok(())
        })
    }

    pub fn mark_interrupted(
        &self,
        transfer_id: &str,
        resume_offset: Option<u64>,
    ) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if matches!(
                transfer.state,
                TransferState::Completed | TransferState::Cancelled
            ) {
                return Err(invalid_transition("interrupt", transfer.state));
            }
            transfer.state = TransferState::Interrupted;
            transfer.error_code = Some("interrupted".into());
            transfer.resumable = resume_offset.is_some();
            transfer.resume_offset = resume_offset;
            transfer.speed = None;
            transfer.eta_seconds = None;
            Ok(())
        })
    }

    fn transition(
        &self,
        transfer_id: &str,
        from: TransferState,
        to: TransferState,
    ) -> WorkspaceResult<TransferDto> {
        self.update(transfer_id, |transfer| {
            if transfer.state != from {
                return Err(invalid_transition("advance", transfer.state));
            }
            transfer.state = to;
            Ok(())
        })
    }

    fn update(
        &self,
        transfer_id: &str,
        mutate: impl FnOnce(&mut TransferDto) -> WorkspaceResult<()>,
    ) -> WorkspaceResult<TransferDto> {
        let mut values = self.values.lock().map_err(|_| {
            WorkspaceError::new("workspace-lock-poisoned", "Transfer queue is unavailable.")
        })?;
        let current = values.get(transfer_id).cloned().ok_or_else(|| {
            WorkspaceError::new("transfer-not-found", "The transfer no longer exists.")
        })?;
        let mut updated = current;
        mutate(&mut updated)?;
        updated.revision = updated.revision.saturating_add(1);
        updated.updated_at = chrono::Local::now().to_rfc3339();
        self.persistence
            .upsert(&updated)
            .map_err(|error| WorkspaceError::new("transfer-storage-unavailable", error))?;
        values.insert(transfer_id.to_string(), updated.clone());
        drop(values);
        self.emit_update(&updated);
        Ok(updated)
    }

    fn emit_update(&self, transfer: &TransferDto) {
        emit(
            self.event_sink.as_ref(),
            TRANSFER_UPDATED_EVENT,
            &TransferUpdatedEvent {
                transfer_id: transfer.transfer_id.clone(),
                updated_at: transfer.updated_at.clone(),
                revision: transfer.revision,
                state: transfer.state,
                bytes: transfer.bytes,
                total: transfer.total,
                speed: transfer.speed,
                eta_seconds: transfer.eta_seconds,
                attempt: transfer.attempt,
                resumable: transfer.resumable,
                error_code: transfer.error_code.clone(),
                task_id: transfer.task_id.clone(),
            },
        );
    }

    fn signal_worker(&self, transfer_id: &str) {
        if let Ok(controls) = self.controls.lock() {
            if let Some(token) = controls.get(transfer_id) {
                token.cancel();
            }
        }
    }
}

fn is_active_worker_state(state: TransferState) -> bool {
    matches!(
        state,
        TransferState::Running
            | TransferState::Pausing
            | TransferState::Verifying
            | TransferState::Finalizing
    )
}

fn invalid_transition(action: &str, state: TransferState) -> WorkspaceError {
    WorkspaceError::new(
        "invalid-transfer-transition",
        format!("Cannot {action} a transfer in state {state:?}."),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::types::{TransferDirection, TransferDraft};

    fn draft(host_id: &str) -> TransferDraft {
        TransferDraft {
            direction: TransferDirection::Upload,
            host_id: host_id.into(),
            host_name: host_id.into(),
            host_alias: host_id.into(),
            source_ref: "grant-1".into(),
            local_grant_id: None,
            destination_path: "/tmp/file".into(),
            total_bytes: Some(10),
            conflict_strategy: None,
        }
    }

    #[test]
    fn transfer_lifecycle_is_explicit_and_monotonic() {
        let queue = TransferQueue::in_memory(None);
        let transfer = queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1")],
            })
            .unwrap()
            .remove(0);
        let running = queue.mark_running(&transfer.transfer_id).unwrap();
        assert_eq!(running.attempt, 1);
        assert_eq!(running.state, TransferState::Running);
        assert!(queue
            .update_progress(&transfer.transfer_id, 11, None, None)
            .is_err());
        queue
            .update_progress(&transfer.transfer_id, 5, Some(5), Some(1))
            .unwrap();
        queue.mark_verifying(&transfer.transfer_id).unwrap();
        queue.mark_finalizing(&transfer.transfer_id).unwrap();
        assert_eq!(
            queue
                .cancel(TransferIdentityRequest {
                    transfer_id: transfer.transfer_id.clone(),
                    revision: None,
                    file_session_id: None,
                    local_grant_id: None,
                    restart: false,
                })
                .unwrap_err()
                .code,
            "too-late"
        );
        assert_eq!(
            queue.mark_completed(&transfer.transfer_id).unwrap().bytes,
            10
        );
    }

    #[test]
    fn restart_converts_in_flight_state_to_interrupted() {
        let persistence = Arc::new(MemoryTransferPersistence::default());
        let queue = TransferQueue::new(persistence.clone(), None).unwrap();
        let transfer = queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1")],
            })
            .unwrap()
            .remove(0);
        queue.mark_running(&transfer.transfer_id).unwrap();
        drop(queue);
        let restored = TransferQueue::new(persistence, None)
            .unwrap()
            .list()
            .unwrap();
        assert_eq!(restored[0].state, TransferState::Interrupted);
        assert_eq!(
            restored[0].error_code.as_deref(),
            Some("transfer-reauthorization-required")
        );
    }

    #[test]
    fn restart_converts_unbound_queued_transfer_to_interrupted() {
        let persistence = Arc::new(MemoryTransferPersistence::default());
        let queue = TransferQueue::new(persistence.clone(), None).unwrap();
        queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1")],
            })
            .unwrap();
        drop(queue);

        let restored = TransferQueue::new(persistence, None)
            .unwrap()
            .list()
            .unwrap();
        assert_eq!(restored[0].state, TransferState::Interrupted);
        assert_eq!(
            restored[0].error_code.as_deref(),
            Some("transfer-reauthorization-required")
        );
    }

    #[test]
    fn restart_requires_reauthorization_before_revisiting_a_conflict() {
        let persistence = Arc::new(MemoryTransferPersistence::default());
        let queue = TransferQueue::new(persistence.clone(), None).unwrap();
        let transfer = queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1")],
            })
            .unwrap()
            .remove(0);
        queue.mark_waiting_conflict(&transfer.transfer_id).unwrap();
        drop(queue);

        let restored = TransferQueue::new(persistence, None)
            .unwrap()
            .list()
            .unwrap();
        assert_eq!(restored[0].state, TransferState::Interrupted);
    }

    #[test]
    fn conflict_revision_rejects_stale_decisions() {
        let queue = TransferQueue::in_memory(None);
        let transfer = queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1")],
            })
            .unwrap()
            .remove(0);
        let waiting = queue.mark_waiting_conflict(&transfer.transfer_id).unwrap();
        let error = queue
            .resolve_conflict(ResolveTransferConflictRequest {
                transfer_id: transfer.transfer_id,
                conflict_revision: waiting.conflict_revision.unwrap() + 1,
                strategy: ConflictStrategy::KeepBoth,
                apply_to_batch: false,
            })
            .unwrap_err();
        assert_eq!(error.code, "stale-conflict");
    }

    #[test]
    fn conflict_apply_to_batch_is_scoped_to_matching_pending_items() {
        let queue = TransferQueue::in_memory(None);
        let mut other_host = draft("host-2");
        other_host.direction = TransferDirection::Download;
        let created = queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1"), draft("host-1"), other_host],
            })
            .unwrap();
        let first = queue
            .mark_waiting_conflict(&created[0].transfer_id)
            .unwrap();
        queue
            .mark_waiting_conflict(&created[1].transfer_id)
            .unwrap();
        queue
            .mark_waiting_conflict(&created[2].transfer_id)
            .unwrap();

        let resolution = queue
            .resolve_conflict(ResolveTransferConflictRequest {
                transfer_id: first.transfer_id,
                conflict_revision: first.conflict_revision.expect("conflict revision"),
                strategy: ConflictStrategy::Skip,
                apply_to_batch: true,
            })
            .unwrap();
        assert_eq!(resolution.affected.len(), 2);
        assert!(resolution
            .affected
            .iter()
            .all(|transfer| transfer.state == TransferState::Cancelled));
        let values = queue.list().unwrap();
        let unrelated = values
            .iter()
            .find(|transfer| transfer.transfer_id == created[2].transfer_id)
            .expect("unrelated batch transfer remains in the queue");
        assert_eq!(unrelated.state, TransferState::WaitingConflict);
    }

    #[test]
    fn retry_starts_a_new_attempt_without_reusing_unverified_progress() {
        let queue = TransferQueue::in_memory(None);
        let transfer = queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1")],
            })
            .unwrap()
            .remove(0);
        queue.mark_running(&transfer.transfer_id).unwrap();
        queue
            .update_progress(&transfer.transfer_id, 5, None, None)
            .unwrap();
        let retried = queue.restart_attempt(&transfer.transfer_id).unwrap();
        assert_eq!(retried.attempt, 2);
        assert_eq!(retried.bytes, 0);
        assert!(!retried.resumable);
        assert_eq!(retried.resume_offset, None);
    }

    #[test]
    fn transport_retry_keeps_position_until_prefix_verification() {
        let queue = TransferQueue::in_memory(None);
        let transfer = queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1")],
            })
            .unwrap()
            .remove(0);
        queue.mark_running(&transfer.transfer_id).unwrap();
        queue
            .set_total_and_fingerprint(&transfer.transfer_id, 10, "source-verified")
            .unwrap();
        queue.set_stream_position(&transfer.transfer_id, 5).unwrap();
        let retried = queue
            .restart_attempt_preserving_resume(&transfer.transfer_id)
            .unwrap();
        assert_eq!(retried.attempt, 2);
        assert_eq!(retried.bytes, 5);
        assert_eq!(retried.resume_offset, Some(5));
    }

    #[test]
    fn durable_resume_facts_survive_queue_restart() {
        let persistence = Arc::new(MemoryTransferPersistence::default());
        let queue = TransferQueue::new(persistence.clone(), None).unwrap();
        let transfer = queue
            .enqueue(EnqueueTransfersRequest {
                file_session_id: "files-test".into(),
                items: vec![draft("host-1")],
            })
            .unwrap()
            .remove(0);
        queue
            .configure_resume(
                &transfer.transfer_id,
                10,
                "durable-fingerprint".into(),
                "durable-partial".into(),
            )
            .unwrap();
        queue.mark_running(&transfer.transfer_id).unwrap();
        queue.set_stream_position(&transfer.transfer_id, 4).unwrap();
        drop(queue);

        let restored = TransferQueue::new(persistence, None)
            .unwrap()
            .list()
            .unwrap()
            .remove(0);
        assert_eq!(restored.state, TransferState::Interrupted);
        assert_eq!(restored.resume_offset, Some(4));
        assert_eq!(
            restored.durable_source_fingerprint.as_deref(),
            Some("durable-fingerprint")
        );
        assert_eq!(
            restored.durable_partial_locator.as_deref(),
            Some("durable-partial")
        );
    }
}
