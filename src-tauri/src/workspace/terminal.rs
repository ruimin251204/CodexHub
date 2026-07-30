use super::error::{WorkspaceError, WorkspaceResult};
use super::events::{
    emit, SessionHeartbeatEvent, SessionStateEvent, TerminalCwdEvent, TerminalOutputEvent,
    WorkspaceEventSink, SESSION_HEARTBEAT_EVENT, SESSION_STATE_EVENT, TERMINAL_CWD_EVENT,
    TERMINAL_OUTPUT_EVENT,
};
use super::types::{
    AttachTerminalRequest, AttachTerminalResult, CwdSource, OpenTerminalRequest,
    TerminalAckRequest, TerminalIdentityRequest, TerminalReplayFrame, TerminalResizeRequest,
    TerminalSessionDto, TerminalState, TerminalWriteRequest, ValidatedCwd,
};
use crate::adapters::TaskEventSink;
use crate::jobs;
use crate::storage::TaskStore;
use crate::tasks::{TaskLog, TaskLogLevel, TaskStatus, TaskStep, TaskStepStatus};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{Duration as ChronoDuration, Local};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const MAX_GLOBAL_TERMINALS: usize = 12;
pub const MAX_HOST_TERMINALS: usize = 4;
const MAX_FRAME_BYTES: usize = 32 * 1024;
const MAX_UNACKED_BYTES: usize = 4 * 1024 * 1024;
const MAX_RECENT_OUTPUT_BYTES: usize = 16 * 1024;
const OUTPUT_COALESCE_WINDOW: Duration = Duration::from_millis(16);
const ACK_STALL: Duration = Duration::from_secs(30);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(15);
const RECONNECT_STABLE_AFTER: Duration = Duration::from_secs(30);
const RECONNECT_DELAYS: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];
const SHELL_PID_OSC_PREFIX: &[u8] = b"\x1b]777;CodexHubPid=";

struct Frame {
    sequence: u64,
    bytes: Vec<u8>,
}

struct TerminalInner {
    dto: TerminalSessionDto,
    next_sequence: u64,
    acknowledged: u64,
    buffered_bytes: usize,
    frames: VecDeque<Frame>,
    last_ack: Instant,
    recent_output: Vec<u8>,
    osc7_cwd: Option<String>,
    /// Per-generation nonce and PID emitted by the backend-issued shell
    /// probe. The PID is never accepted without the matching random nonce.
    shell_pid_token: Option<String>,
    shell_pid: Option<u32>,
    /// A canonical Files path that may be sent once to a new ordinary shell.
    /// It never contains frontend-provided shell syntax.
    pending_shell_cwd: Option<String>,
    reconnect_attempts: u8,
    reconnect_scheduled: bool,
    connected_at: Option<Instant>,
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn Child + Send + Sync>>,
    killer: Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
}

#[derive(Clone, Debug)]
pub(crate) struct TerminalCwdCandidate {
    pub host_id: String,
    pub path: String,
    pub source: CwdSource,
}

/// A PTY session keeps bytes opaque through the Rust layer. Decoding happens
/// only in xterm, so invalid locale data cannot be silently rewritten.
struct Terminal {
    inner: Mutex<TerminalInner>,
    /// Back-pressures the PTY reader when the acknowledged replay window is
    /// full. This keeps the in-memory ring bounded without dropping bytes.
    output_ready: Condvar,
    sink: Option<WorkspaceEventSink>,
    audit: Option<Arc<dyn TerminalAuditSink>>,
}

pub struct TerminalSessions {
    values: Mutex<HashMap<String, Arc<Terminal>>>,
    sink: Option<WorkspaceEventSink>,
    audit: Option<Arc<dyn TerminalAuditSink>>,
}

/// Job records contain only lifecycle summaries and stable error codes. PTY
/// bytes, SSH stderr, paths and user input remain outside the task store.
pub trait TerminalAuditSink: Send + Sync {
    fn begin_attempt(&self, session: &TerminalSessionDto) -> Result<String, String>;
    fn record(&self, task_id: &str, event: TerminalAuditEvent, reason: Option<&str>);
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TerminalAuditEvent {
    ProcessLaunched,
    Connected,
    Failed,
    Interrupted,
    Closed,
}

/// Durable Job Manager adapter for terminal attempts. It is deliberately
/// owned by Workspace so automatic reconnects receive the same audit policy.
pub struct JobManagerTerminalAudit {
    task_store: Arc<TaskStore>,
    task_event_sink: Option<TaskEventSink>,
}

impl JobManagerTerminalAudit {
    pub fn new(task_store: Arc<TaskStore>, task_event_sink: Option<TaskEventSink>) -> Self {
        Self {
            task_store,
            task_event_sink,
        }
    }
}

impl TerminalAuditSink for JobManagerTerminalAudit {
    fn begin_attempt(&self, session: &TerminalSessionDto) -> Result<String, String> {
        let task_id = format!("task-workspace-terminal-{}", Uuid::new_v4());
        let action = if session.attempt > 1 {
            "Reconnect Workspace terminal"
        } else {
            "Connect Workspace terminal"
        };
        let mut task = jobs::begin_task(
            self.task_store.as_ref(),
            self.task_event_sink.as_ref(),
            &task_id,
            &session.host_id,
            &session.host_name,
            action,
        )?;
        let now = Local::now().to_rfc3339();
        task.steps = terminal_task_steps(&task_id);
        if let Some(step) = task.steps.iter_mut().find(|step| step.step_id == "launch") {
            step.status = TaskStepStatus::Running;
            step.started_at = Some(now);
        }
        task.summary = "Launching the local SSH terminal process.".into();
        jobs::persist_task(
            self.task_store.as_ref(),
            self.task_event_sink.as_ref(),
            &task,
        )?;
        Ok(task_id)
    }

    fn record(&self, task_id: &str, event: TerminalAuditEvent, reason: Option<&str>) {
        let Ok(Some(mut task)) = self.task_store.get(task_id) else {
            return;
        };
        if matches!(
            task.status,
            TaskStatus::Success
                | TaskStatus::Failed
                | TaskStatus::Cancelled
                | TaskStatus::Interrupted
        ) {
            return;
        }

        let now = Local::now().to_rfc3339();
        let connect_started = task
            .steps
            .iter()
            .find(|step| step.step_id == "connect")
            .is_some_and(|step| !matches!(step.status, TaskStepStatus::Pending));
        let connect_succeeded = task
            .steps
            .iter()
            .find(|step| step.step_id == "connect")
            .is_some_and(|step| matches!(step.status, TaskStepStatus::Success));
        let (summary, level, final_status) = match event {
            TerminalAuditEvent::ProcessLaunched => {
                set_terminal_step(&mut task, "launch", TaskStepStatus::Success, &now);
                set_terminal_step(&mut task, "connect", TaskStepStatus::Running, &now);
                (
                    "Connecting the SSH terminal.".to_string(),
                    TaskLogLevel::Info,
                    None,
                )
            }
            TerminalAuditEvent::Connected => {
                set_terminal_step(&mut task, "launch", TaskStepStatus::Success, &now);
                set_terminal_step(&mut task, "connect", TaskStepStatus::Success, &now);
                (
                    "SSH terminal connected.".to_string(),
                    TaskLogLevel::Info,
                    None,
                )
            }
            TerminalAuditEvent::Failed => {
                if connect_started {
                    set_terminal_step(&mut task, "launch", TaskStepStatus::Success, &now);
                    set_terminal_step(&mut task, "connect", TaskStepStatus::Failed, &now);
                } else {
                    set_terminal_step(&mut task, "launch", TaskStepStatus::Failed, &now);
                    set_terminal_step(&mut task, "connect", TaskStepStatus::Skipped, &now);
                }
                (
                    format!(
                        "SSH terminal connection failed ({}).",
                        safe_terminal_reason(reason)
                    ),
                    TaskLogLevel::Error,
                    Some(TaskStatus::Failed),
                )
            }
            TerminalAuditEvent::Interrupted => {
                if !connect_succeeded {
                    if connect_started {
                        set_terminal_step(&mut task, "connect", TaskStepStatus::Failed, &now);
                    } else {
                        set_terminal_step(&mut task, "launch", TaskStepStatus::Failed, &now);
                        set_terminal_step(&mut task, "connect", TaskStepStatus::Skipped, &now);
                    }
                }
                (
                    format!(
                        "SSH terminal connection interrupted ({}).",
                        safe_terminal_reason(reason)
                    ),
                    TaskLogLevel::Warn,
                    Some(TaskStatus::Interrupted),
                )
            }
            TerminalAuditEvent::Closed => {
                if connect_succeeded {
                    set_terminal_step(&mut task, "launch", TaskStepStatus::Success, &now);
                    set_terminal_step(&mut task, "connect", TaskStepStatus::Success, &now);
                    (
                        "SSH terminal session closed.".to_string(),
                        TaskLogLevel::Info,
                        Some(TaskStatus::Success),
                    )
                } else {
                    set_terminal_step(&mut task, "connect", TaskStepStatus::Skipped, &now);
                    (
                        "SSH terminal connection cancelled by the user.".to_string(),
                        TaskLogLevel::Warn,
                        Some(TaskStatus::Cancelled),
                    )
                }
            }
        };
        task.summary = summary.clone();
        task.logs.push(TaskLog {
            id: jobs::task_log_id(task_id, task.logs.len() + 1),
            task_run_id: task_id.to_string(),
            step_id: None,
            level,
            timestamp: now.clone(),
            message: summary,
            command: None,
            stdout: None,
            stderr: None,
            exit_code: None,
            duration_ms: None,
            timed_out: None,
        });
        if let Some(status) = final_status {
            task.status = status;
            task.ended_at = Some(now);
        }
        let _ = jobs::persist_task(
            self.task_store.as_ref(),
            self.task_event_sink.as_ref(),
            &task,
        );
    }
}

fn terminal_task_steps(task_id: &str) -> Vec<TaskStep> {
    [
        ("launch", 1, "Launching the local SSH terminal process."),
        ("connect", 2, "Connecting through the selected SSH alias."),
    ]
    .into_iter()
    .map(|(step_id, sequence, summary)| TaskStep {
        task_run_id: task_id.to_string(),
        step_id: step_id.to_string(),
        sequence,
        status: TaskStepStatus::Pending,
        summary: summary.to_string(),
        started_at: None,
        ended_at: None,
    })
    .collect()
}

fn set_terminal_step(
    task: &mut crate::tasks::TaskRun,
    step_id: &str,
    status: TaskStepStatus,
    now: &str,
) {
    let Some(step) = task.steps.iter_mut().find(|step| step.step_id == step_id) else {
        return;
    };
    if step.started_at.is_none() {
        step.started_at = Some(now.to_string());
    }
    let completed = !matches!(status, TaskStepStatus::Running | TaskStepStatus::Pending);
    step.status = status;
    if completed {
        step.ended_at = Some(now.to_string());
    }
}

fn safe_terminal_reason(reason: Option<&str>) -> String {
    let value = reason.unwrap_or("connection-failed");
    [
        "application-exit",
        "closed-by-user",
        "consumer-stalled",
        "network-disconnected",
        "shell-exited",
        "ssh-authentication-failed",
        "ssh-eof",
        "ssh-host-key-failed",
        "ssh-read-failed",
        "ssh-reader-disconnected",
        "terminal-initial-directory-unavailable",
        "terminal-initial-directory-write-failed",
        "terminal-pty-create-failed",
        "terminal-reader-failed",
        "terminal-ssh-start-failed",
        "terminal-writer-failed",
    ]
    .contains(&value)
    .then_some(value)
    .unwrap_or("connection-failed")
    .to_string()
}

impl TerminalSessions {
    pub fn new(
        sink: Option<WorkspaceEventSink>,
        audit: Option<Arc<dyn TerminalAuditSink>>,
    ) -> Self {
        Self {
            values: Mutex::new(HashMap::new()),
            sink,
            audit,
        }
    }

    pub fn open(
        &self,
        request: OpenTerminalRequest,
        initial_directory: Option<String>,
    ) -> WorkspaceResult<TerminalSessionDto> {
        validate_size(request.rows, request.cols)?;
        let mut values = self.values.lock().map_err(lock_error)?;
        // Terminal IDs are logical tab IDs, but only live sessions consume a
        // PTY slot. Prune terminal states that can no longer reconnect before
        // enforcing the process limit so repeated open/close cycles recover.
        values.retain(|_, session| {
            session
                .inner
                .lock()
                .map(|inner| session_consumes_slot(inner.dto.state))
                .unwrap_or(true)
        });
        if values
            .values()
            .filter(|session| {
                session
                    .inner
                    .lock()
                    .ok()
                    .is_some_and(|inner| session_consumes_slot(inner.dto.state))
            })
            .count()
            >= MAX_GLOBAL_TERMINALS
        {
            return Err(WorkspaceError::new(
                "terminal-limit-reached",
                "At most 12 terminal sessions may be open.",
            ));
        }
        if values
            .values()
            .filter(|session| {
                session.inner.lock().ok().is_some_and(|inner| {
                    inner.dto.host_id == request.host_id && session_consumes_slot(inner.dto.state)
                })
            })
            .count()
            >= MAX_HOST_TERMINALS
        {
            return Err(WorkspaceError::new(
                "host-terminal-limit-reached",
                "At most 4 terminal sessions may be open for one host.",
            ));
        }

        let id = format!("term-{}", Uuid::new_v4());
        let terminal = Arc::new(Terminal {
            inner: Mutex::new(TerminalInner {
                dto: TerminalSessionDto {
                    session_id: id.clone(),
                    created_at: Local::now().to_rfc3339(),
                    host_id: request.host_id,
                    host_name: request.host_name,
                    host_alias: request.host_alias,
                    generation: 0,
                    revision: 0,
                    state: TerminalState::Creating,
                    reconnectable: false,
                    attempt: 0,
                    auto_reconnect: request.auto_reconnect,
                    rows: request.rows,
                    cols: request.cols,
                    verified_cwd: None,
                    reason: None,
                    task_id: None,
                },
                next_sequence: 0,
                acknowledged: 0,
                buffered_bytes: 0,
                frames: VecDeque::new(),
                last_ack: Instant::now(),
                recent_output: Vec::new(),
                osc7_cwd: None,
                shell_pid_token: None,
                shell_pid: None,
                pending_shell_cwd: initial_directory,
                reconnect_attempts: 0,
                reconnect_scheduled: false,
                connected_at: None,
                master: None,
                writer: None,
                child: None,
                killer: None,
            }),
            output_ready: Condvar::new(),
            sink: self.sink.clone(),
            audit: self.audit.clone(),
        });
        start_pty(&terminal, false, true)?;
        let dto = terminal.inner.lock().map_err(lock_error)?.dto.clone();
        values.insert(id, terminal);
        Ok(dto)
    }

    pub fn list(&self) -> WorkspaceResult<Vec<TerminalSessionDto>> {
        let values = self.values.lock().map_err(lock_error)?;
        let mut result = values
            .values()
            .filter_map(|session| session.inner.lock().ok().map(|inner| inner.dto.clone()))
            .collect::<Vec<_>>();
        result.sort_by(|left, right| left.session_id.cmp(&right.session_id));
        Ok(result)
    }

    pub fn attach(&self, request: AttachTerminalRequest) -> WorkspaceResult<AttachTerminalResult> {
        let terminal = self.get(&request.session_id)?;
        let state = terminal.inner.lock().map_err(lock_error)?;
        ensure_generation(&state, request.generation)?;
        let oldest = state
            .frames
            .front()
            .map(|frame| frame.sequence)
            .unwrap_or(state.next_sequence.saturating_add(1));
        let gap = request.after_sequence.saturating_add(1) < oldest;
        let frames = state
            .frames
            .iter()
            .filter(|frame| frame.sequence > request.after_sequence)
            .map(|frame| TerminalReplayFrame {
                sequence: frame.sequence,
                data_base64: STANDARD.encode(&frame.bytes),
            })
            .collect();
        Ok(AttachTerminalResult {
            session: state.dto.clone(),
            gap,
            frames,
            latest_sequence: state.next_sequence,
        })
    }

    pub fn write(&self, request: TerminalWriteRequest) -> WorkspaceResult<()> {
        let bytes = STANDARD.decode(request.data_base64).map_err(|_| {
            WorkspaceError::new(
                "invalid-terminal-input",
                "Terminal input must be base64 bytes.",
            )
        })?;
        let terminal = self.get(&request.session_id)?;
        let mut inner = terminal.inner.lock().map_err(lock_error)?;
        ensure_generation(&inner, request.generation)?;
        if inner.dto.state != TerminalState::Connected {
            return Err(WorkspaceError::new(
                "terminal-not-connected",
                "The terminal is not connected.",
            ));
        }
        let writer = inner.writer.as_mut().ok_or_else(|| {
            WorkspaceError::new(
                "terminal-writer-unavailable",
                "The terminal writer is unavailable.",
            )
        })?;
        writer
            .write_all(&bytes)
            .and_then(|_| writer.flush())
            .map_err(|error| WorkspaceError::retryable("terminal-write-failed", error.to_string()))
    }

    pub fn resize(&self, request: TerminalResizeRequest) -> WorkspaceResult<TerminalSessionDto> {
        validate_size(request.rows, request.cols)?;
        let terminal = self.get(&request.session_id)?;
        let mut inner = terminal.inner.lock().map_err(lock_error)?;
        ensure_generation(&inner, request.generation)?;
        inner
            .master
            .as_ref()
            .ok_or_else(|| WorkspaceError::new("terminal-closed", "The terminal is closed."))?
            .resize(PtySize {
                rows: request.rows,
                cols: request.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| {
                WorkspaceError::retryable("terminal-resize-failed", error.to_string())
            })?;
        inner.dto.rows = request.rows;
        inner.dto.cols = request.cols;
        inner.dto.revision = inner.dto.revision.saturating_add(1);
        Ok(inner.dto.clone())
    }

    pub fn ack(&self, request: TerminalAckRequest) -> WorkspaceResult<()> {
        let terminal = self.get(&request.session_id)?;
        let mut inner = terminal.inner.lock().map_err(lock_error)?;
        ensure_generation(&inner, request.generation)?;
        if request.sequence > inner.next_sequence {
            return Err(WorkspaceError::new(
                "invalid-terminal-ack",
                "Acknowledgement is ahead of terminal output.",
            ));
        }
        inner.acknowledged = inner.acknowledged.max(request.sequence);
        inner.last_ack = Instant::now();
        while inner
            .frames
            .front()
            .is_some_and(|frame| frame.sequence <= inner.acknowledged)
        {
            if let Some(frame) = inner.frames.pop_front() {
                inner.buffered_bytes = inner.buffered_bytes.saturating_sub(frame.bytes.len());
            }
        }
        terminal.output_ready.notify_all();
        Ok(())
    }

    pub fn reconnect(&self, session_id: &str) -> WorkspaceResult<TerminalSessionDto> {
        let terminal = self.get(session_id)?;
        {
            let inner = terminal.inner.lock().map_err(lock_error)?;
            if !inner.dto.auto_reconnect
                || !inner.dto.reconnectable
                || inner.dto.state != TerminalState::Disconnected
            {
                return Err(WorkspaceError::new(
                    "terminal-not-reconnectable",
                    "This terminal cannot be reconnected.",
                ));
            }
        }
        start_pty(&terminal, true, true)?;
        let dto = terminal.inner.lock().map_err(lock_error)?.dto.clone();
        Ok(dto)
    }

    pub fn close(&self, request: TerminalIdentityRequest) -> WorkspaceResult<TerminalSessionDto> {
        let terminal = self.get(&request.session_id)?;
        let mut inner = terminal.inner.lock().map_err(lock_error)?;
        ensure_generation(&inner, request.generation)?;
        inner.dto.state = TerminalState::Closing;
        inner.dto.revision = inner.dto.revision.saturating_add(1);
        inner.reconnect_scheduled = false;
        if let Some(killer) = inner.killer.as_mut() {
            let _ = killer.kill();
        }
        release_pty(&mut inner);
        inner.dto.state = TerminalState::Closed;
        inner.dto.reconnectable = false;
        inner.dto.reason = Some("closed-by-user".into());
        inner.dto.revision = inner.dto.revision.saturating_add(1);
        emit_state(&terminal, &inner, None);
        record_terminal_audit(
            &terminal,
            inner.dto.task_id.as_deref(),
            TerminalAuditEvent::Closed,
            Some("closed-by-user"),
        );
        terminal.output_ready.notify_all();
        let dto = inner.dto.clone();
        drop(inner);
        self.values
            .lock()
            .map_err(lock_error)?
            .remove(&request.session_id);
        Ok(dto)
    }

    /// A heartbeat reports local ownership of the live PTY only. It never
    /// writes a durable Job record and does not claim remote process health.
    pub fn heartbeat(&self, session_id: &str) -> WorkspaceResult<()> {
        let terminal = self.get(session_id)?;
        let inner = terminal.inner.lock().map_err(lock_error)?;
        emit_heartbeat(&terminal, &inner);
        Ok(())
    }

    /// Returns backend-observed cwd candidates in trust order. `/proc` is
    /// queried only through the matching SFTP session; OSC 7 remains a
    /// canonicalized fallback when the shell probe is unavailable.
    pub(crate) fn cwd_candidates(
        &self,
        request: &TerminalIdentityRequest,
    ) -> WorkspaceResult<Vec<TerminalCwdCandidate>> {
        let terminal = self.get(&request.session_id)?;
        let inner = terminal.inner.lock().map_err(lock_error)?;
        ensure_generation(&inner, request.generation)?;
        let mut candidates = Vec::new();
        if let Some(pid) = inner.shell_pid {
            candidates.push(TerminalCwdCandidate {
                host_id: inner.dto.host_id.clone(),
                path: format!("/proc/{pid}/cwd"),
                source: CwdSource::Proc,
            });
        }
        if let Some(path) = inner.osc7_cwd.clone() {
            candidates.push(TerminalCwdCandidate {
                host_id: inner.dto.host_id.clone(),
                path,
                source: CwdSource::Osc7,
            });
        }
        if candidates.is_empty() {
            return Err(WorkspaceError::new(
                "terminal-cwd-unknown",
                "The terminal has not supplied a usable working directory.",
            ));
        }
        Ok(candidates)
    }

    /// Records a freshly SFTP-canonicalized cwd for the live session. It
    /// remains in memory only and is invalidated by the next generation.
    pub fn record_verified_cwd(
        &self,
        request: TerminalIdentityRequest,
        path: String,
        source: CwdSource,
    ) -> WorkspaceResult<ValidatedCwd> {
        let terminal = self.get(&request.session_id)?;
        let mut inner = terminal.inner.lock().map_err(lock_error)?;
        ensure_generation(&inner, request.generation)?;
        let candidate_present = match source {
            CwdSource::Proc => inner.shell_pid.is_some(),
            CwdSource::Osc7 => inner.osc7_cwd.is_some(),
        };
        if !candidate_present {
            return Err(WorkspaceError::new(
                "terminal-cwd-unknown",
                "The terminal cwd candidate is no longer available.",
            ));
        }
        if inner.dto.verified_cwd.as_deref() == Some(path.as_str()) {
            return Ok(ValidatedCwd {
                session_id: inner.dto.session_id.clone(),
                generation: inner.dto.generation,
                revision: inner.dto.revision,
                path,
                source,
            });
        }
        inner.dto.verified_cwd = Some(path.clone());
        inner.dto.revision = inner.dto.revision.saturating_add(1);
        let validated = ValidatedCwd {
            session_id: inner.dto.session_id.clone(),
            generation: inner.dto.generation,
            revision: inner.dto.revision,
            path: path.clone(),
            source,
        };
        emit(
            terminal.sink.as_ref(),
            TERMINAL_CWD_EVENT,
            &TerminalCwdEvent {
                session_id: validated.session_id.clone(),
                generation: validated.generation,
                revision: validated.revision,
                path,
                source,
            },
        );
        Ok(validated)
    }

    pub fn shutdown(&self) -> WorkspaceResult<()> {
        let mut values = self.values.lock().map_err(lock_error)?;
        for terminal in values.values() {
            let mut inner = terminal.inner.lock().map_err(lock_error)?;
            inner.reconnect_scheduled = false;
            if let Some(killer) = inner.killer.as_mut() {
                let _ = killer.kill();
            }
            release_pty(&mut inner);
            if !matches!(
                inner.dto.state,
                TerminalState::Closed | TerminalState::Failed
            ) {
                inner.dto.state = TerminalState::Closed;
                inner.dto.reconnectable = false;
                inner.dto.reason = Some("application-exit".into());
                inner.dto.revision = inner.dto.revision.saturating_add(1);
                emit_state(terminal, &inner, None);
                record_terminal_audit(
                    terminal,
                    inner.dto.task_id.as_deref(),
                    TerminalAuditEvent::Interrupted,
                    Some("application-exit"),
                );
                terminal.output_ready.notify_all();
            }
        }
        values.clear();
        Ok(())
    }

    fn get(&self, id: &str) -> WorkspaceResult<Arc<Terminal>> {
        self.values
            .lock()
            .map_err(lock_error)?
            .get(id)
            .cloned()
            .ok_or_else(|| {
                WorkspaceError::new(
                    "terminal-not-found",
                    "The terminal session no longer exists.",
                )
            })
    }
}

/// Starts a generation-local PTY. A new generation intentionally discards
/// prior replay frames so clients can never ACK or render stale shell bytes.
fn start_pty(
    terminal: &Arc<Terminal>,
    reconnect: bool,
    reset_retries: bool,
) -> WorkspaceResult<()> {
    let (alias, rows, cols, generation, requested_cwd, requires_initial_cwd, task_id) = {
        let mut inner = terminal.inner.lock().map_err(lock_error)?;
        if matches!(
            inner.dto.state,
            TerminalState::Closing | TerminalState::Closed
        ) && !reconnect
        {
            return Err(WorkspaceError::new(
                "terminal-closed",
                "The terminal is closed.",
            ));
        }
        // Only an SFTP-verified cwd survives a reconnect. A new session may
        // also have a Files-verified launch directory. Neither value is ever
        // inferred from a prompt or supplied as a terminal command by React.
        let requested_cwd = if reconnect {
            inner.dto.verified_cwd.clone()
        } else {
            inner.pending_shell_cwd.take()
        };
        if let Some(killer) = inner.killer.as_mut() {
            let _ = killer.kill();
        }
        release_pty(&mut inner);
        inner.dto.generation = inner.dto.generation.saturating_add(1);
        inner.dto.attempt = inner.dto.attempt.saturating_add(1);
        inner.dto.state = if reconnect {
            TerminalState::Reconnecting
        } else {
            TerminalState::Connecting
        };
        inner.dto.reason = None;
        inner.dto.reconnectable = false;
        inner.dto.verified_cwd = None;
        inner.dto.revision = inner.dto.revision.saturating_add(1);
        inner.reconnect_scheduled = false;
        if reset_retries {
            inner.reconnect_attempts = 0;
        }
        reset_generation_buffers(&mut inner);
        inner.dto.task_id = terminal
            .audit
            .as_ref()
            .map(|audit| audit.begin_attempt(&inner.dto))
            .transpose()
            .map_err(|_| {
                WorkspaceError::new(
                    "terminal-task-create-failed",
                    "Could not create the terminal connection task.",
                )
            })?;
        emit_state(terminal, &inner, None);
        terminal.output_ready.notify_all();
        (
            inner.dto.host_alias.clone(),
            inner.dto.rows,
            inner.dto.cols,
            inner.dto.generation,
            requested_cwd,
            !reconnect,
            inner.dto.task_id.clone(),
        )
    };

    let shell_input_allowed = remote_command_allows_shell_input(&alias);
    let launch_cwd = match requested_cwd {
        Some(path) if shell_input_allowed => match shell_cd_input(&path) {
            Ok(input) => Some(input),
            Err(error) if requires_initial_cwd => {
                return fail_start(
                    terminal,
                    generation,
                    "terminal-initial-directory-unavailable",
                    error,
                );
            }
            Err(_) => None,
        },
        Some(_) if requires_initial_cwd => {
            return fail_start(
                terminal,
                generation,
                "terminal-initial-directory-unavailable",
                "The SSH alias has a RemoteCommand or cannot be safely inspected.",
            );
        }
        _ => None,
    };
    let pid_probe = shell_input_allowed.then(|| {
        let token = Uuid::new_v4().to_string().replace('-', "");
        let input = shell_pid_probe_input(&token);
        (token, input)
    });

    let system = native_pty_system();
    let pair = match system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(error) => return fail_start(terminal, generation, "terminal-pty-create-failed", error),
    };
    let mut command = CommandBuilder::new("ssh");
    command.args([
        "-tt",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "TCPKeepAlive=yes",
        &alias,
    ]);
    let mut child = match pair.slave.spawn_command(command) {
        Ok(child) => child,
        Err(error) => return fail_start(terminal, generation, "terminal-ssh-start-failed", error),
    };
    record_terminal_audit(
        terminal,
        task_id.as_deref(),
        TerminalAuditEvent::ProcessLaunched,
        None,
    );
    drop(pair.slave);
    let reader = match pair.master.try_clone_reader() {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            return fail_start(terminal, generation, "terminal-reader-failed", error);
        }
    };
    let mut writer = match pair.master.take_writer() {
        Ok(writer) => writer,
        Err(error) => {
            let _ = child.kill();
            return fail_start(terminal, generation, "terminal-writer-failed", error);
        }
    };
    if let Some(input) = launch_cwd {
        if let Err(error) = writer.write_all(&input).and_then(|_| writer.flush()) {
            let _ = child.kill();
            return fail_start(
                terminal,
                generation,
                "terminal-initial-directory-write-failed",
                error,
            );
        }
    }
    // The probe is an optional convenience. If its write races an early SSH
    // failure, retain a usable terminal and let OSC 7 remain the cwd source.
    let shell_pid_token = pid_probe.and_then(|(token, input)| {
        writer
            .write_all(&input)
            .and_then(|_| writer.flush())
            .ok()
            .map(|_| token)
    });
    let killer = child.clone_killer();

    {
        let mut inner = terminal.inner.lock().map_err(lock_error)?;
        if inner.dto.generation != generation || inner.dto.state == TerminalState::Closed {
            let _ = child.kill();
            return Err(WorkspaceError::new(
                "terminal-generation-replaced",
                "The terminal was replaced while it was connecting.",
            ));
        }
        inner.shell_pid_token = shell_pid_token;
        inner.master = Some(pair.master);
        inner.writer = Some(writer);
        inner.child = Some(child);
        inner.killer = Some(killer);
        inner.dto.state = TerminalState::Connected;
        inner.dto.reconnectable = true;
        inner.dto.revision = inner.dto.revision.saturating_add(1);
        inner.connected_at = Some(Instant::now());
        emit_state(terminal, &inner, None);
        record_terminal_audit(
            terminal,
            inner.dto.task_id.as_deref(),
            TerminalAuditEvent::Connected,
            None,
        );
    }

    spawn_reader(terminal.clone(), reader, generation);
    spawn_heartbeat(terminal.clone(), generation);
    if reconnect {
        record_output(
            terminal,
            generation,
            b"\r\n\x1b[90m--- CodexHub: new SSH shell established; foreground programs were not restored ---\x1b[0m\r\n".to_vec(),
        );
    }
    Ok(())
}

fn fail_start(
    terminal: &Arc<Terminal>,
    generation: u32,
    code: &str,
    error: impl std::fmt::Display,
) -> WorkspaceResult<()> {
    let message = error.to_string();
    if let Ok(mut inner) = terminal.inner.lock() {
        if inner.dto.generation == generation && inner.dto.state != TerminalState::Closed {
            inner.dto.state = TerminalState::Disconnected;
            inner.dto.reason = Some(code.into());
            inner.dto.reconnectable = inner.dto.auto_reconnect;
            inner.dto.revision = inner.dto.revision.saturating_add(1);
            emit_state(terminal, &inner, None);
            record_terminal_audit(
                terminal,
                inner.dto.task_id.as_deref(),
                TerminalAuditEvent::Failed,
                Some(code),
            );
        }
    }
    Err(WorkspaceError::retryable(code, message))
}

fn reset_generation_buffers(inner: &mut TerminalInner) {
    inner.next_sequence = 0;
    inner.acknowledged = 0;
    inner.buffered_bytes = 0;
    inner.frames.clear();
    inner.recent_output.clear();
    inner.osc7_cwd = None;
    inner.shell_pid_token = None;
    inner.shell_pid = None;
    inner.last_ack = Instant::now();
    inner.connected_at = None;
}

fn release_pty(inner: &mut TerminalInner) {
    inner.master = None;
    inner.writer = None;
    inner.child = None;
    inner.killer = None;
    inner.connected_at = None;
}

/// `ssh -G` resolves the user's existing Include/Match configuration without
/// connecting to the remote host. We send the one-time `cd` only when the
/// resolved alias has no RemoteCommand; otherwise a shell write could alter an
/// unrelated interactive program. Failure and timeout deliberately deny this
/// optional convenience instead of guessing.
fn remote_command_allows_shell_input(alias: &str) -> bool {
    let Ok(mut child) = ProcessCommand::new("ssh")
        .args(["-G", alias])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        return false;
    };
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout.read_to_end(&mut output).map(|_| output);
        let _ = sender.send(result);
    });

    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                return receiver
                    .recv_timeout(Duration::from_millis(200))
                    .ok()
                    .and_then(Result::ok)
                    .is_some_and(|output| ssh_g_remote_command_is_none(&output));
            }
            Ok(Some(_)) | Err(_) => return false,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

fn ssh_g_remote_command_is_none(output: &[u8]) -> bool {
    let Ok(config) = std::str::from_utf8(output) else {
        return false;
    };
    config.lines().any(|line| {
        line.strip_prefix("remotecommand ")
            .is_some_and(|value| value.trim() == "none")
    })
}

/// Builds the sole backend-issued shell input. Canonical UTF-8 paths are
/// POSIX-single-quoted and control characters are rejected before they can
/// influence terminal line discipline.
fn shell_cd_input(path: &str) -> WorkspaceResult<Vec<u8>> {
    if !path.starts_with('/')
        || path.is_empty()
        || path
            .as_bytes()
            .iter()
            .any(|byte| *byte == 0 || *byte < 0x20 || *byte == 0x7f)
    {
        return Err(WorkspaceError::new(
            "terminal-directory-unsafe",
            "The verified directory cannot be represented safely in a shell command.",
        ));
    }
    let escaped = path.replace('\'', "'\"'\"'");
    Ok(format!("cd -- '{escaped}'\n").into_bytes())
}

/// Emits only a nonce-bound shell PID. The remote shell expands `$$`; the
/// WebView cannot supply either the command or the nonce.
fn shell_pid_probe_input(token: &str) -> Vec<u8> {
    format!("printf '\\033]777;CodexHubPid={token}:%s\\007' \"$$\"\n").into_bytes()
}

enum ReaderEvent {
    Data(Vec<u8>),
    End(&'static str),
}

/// Coalesces read chunks for at most 16 ms while retaining the 32 KiB frame
/// cap. It limits event pressure without decoding or losing terminal bytes.
fn spawn_reader(terminal: Arc<Terminal>, reader: Box<dyn Read + Send>, generation: u32) {
    let (sender, receiver) = mpsc::sync_channel::<ReaderEvent>(128);
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = vec![0; MAX_FRAME_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => {
                    let _ = sender.send(ReaderEvent::End("ssh-eof"));
                    return;
                }
                Ok(count) => {
                    if sender
                        .send(ReaderEvent::Data(buffer[..count].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(_) => {
                    let _ = sender.send(ReaderEvent::End("ssh-read-failed"));
                    return;
                }
            }
        }
    });

    thread::spawn(move || {
        let mut pending_end = None;
        while pending_end.is_none() {
            let first = match receiver.recv() {
                Ok(value) => value,
                Err(_) => return,
            };
            let mut bytes = match first {
                ReaderEvent::Data(bytes) => bytes,
                ReaderEvent::End(reason) => {
                    mark_disconnected(&terminal, generation, reason);
                    return;
                }
            };
            let deadline = Instant::now() + OUTPUT_COALESCE_WINDOW;
            while Instant::now() < deadline {
                match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(ReaderEvent::Data(next)) => bytes.extend_from_slice(&next),
                    Ok(ReaderEvent::End(reason)) => {
                        pending_end = Some(reason);
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        pending_end = Some("ssh-reader-disconnected");
                        break;
                    }
                }
            }
            for frame in bytes.chunks(MAX_FRAME_BYTES) {
                record_output(&terminal, generation, frame.to_vec());
            }
        }
        mark_disconnected(
            &terminal,
            generation,
            pending_end.unwrap_or("ssh-reader-disconnected"),
        );
    });
}

fn spawn_heartbeat(terminal: Arc<Terminal>, generation: u32) {
    thread::spawn(move || loop {
        thread::sleep(HEARTBEAT_INTERVAL);
        let mut inner = match terminal.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        if inner.dto.generation != generation || inner.dto.state != TerminalState::Connected {
            return;
        }
        if inner
            .connected_at
            .is_some_and(|connected_at| connected_at.elapsed() >= RECONNECT_STABLE_AFTER)
        {
            inner.reconnect_attempts = 0;
        }
        emit_heartbeat(&terminal, &inner);
    });
}

fn record_output(terminal: &Arc<Terminal>, generation: u32, bytes: Vec<u8>) {
    // Do not discard an unacknowledged frame. When the 4 MiB replay window is
    // full, stop draining the PTY until an ACK makes room; the bounded reader
    // channel and OS PTY then provide back-pressure to the remote producer.
    loop {
        let mut inner = match terminal.inner.lock() {
            Ok(value) => value,
            Err(_) => return,
        };
        if inner.dto.generation != generation || inner.dto.state != TerminalState::Connected {
            return;
        }
        if inner.buffered_bytes.saturating_add(bytes.len()) > MAX_UNACKED_BYTES {
            if inner.last_ack.elapsed() >= ACK_STALL {
                if let Some(killer) = inner.killer.as_mut() {
                    let _ = killer.kill();
                }
                release_pty(&mut inner);
                inner.dto.state = TerminalState::Failed;
                inner.dto.reason = Some("consumer-stalled".into());
                inner.dto.reconnectable = false;
                inner.dto.revision = inner.dto.revision.saturating_add(1);
                emit_state(terminal, &inner, None);
                record_terminal_audit(
                    terminal,
                    inner.dto.task_id.as_deref(),
                    TerminalAuditEvent::Failed,
                    Some("consumer-stalled"),
                );
                terminal.output_ready.notify_all();
                return;
            }
            let remaining = ACK_STALL.saturating_sub(inner.last_ack.elapsed());
            let wait_for = remaining.min(Duration::from_millis(250));
            let _ = terminal.output_ready.wait_timeout(inner, wait_for);
            continue;
        }
        append_recent_output(&mut inner.recent_output, &bytes);
        if let Some(token) = inner.shell_pid_token.as_deref() {
            if let Some(pid) = latest_shell_pid(&inner.recent_output, token) {
                inner.shell_pid = Some(pid);
            }
        }
        if let Some(path) = latest_osc7_path(&inner.recent_output) {
            inner.osc7_cwd = Some(path);
        }
        inner.next_sequence = inner.next_sequence.saturating_add(1);
        let sequence = inner.next_sequence;
        inner.buffered_bytes = inner.buffered_bytes.saturating_add(bytes.len());
        inner.frames.push_back(Frame {
            sequence,
            bytes: bytes.clone(),
        });
        emit(
            terminal.sink.as_ref(),
            TERMINAL_OUTPUT_EVENT,
            &TerminalOutputEvent {
                session_id: inner.dto.session_id.clone(),
                generation,
                sequence,
                data_base64: STANDARD.encode(bytes),
            },
        );
        return;
    }
}

fn append_recent_output(recent: &mut Vec<u8>, bytes: &[u8]) {
    recent.extend_from_slice(bytes);
    if recent.len() > MAX_RECENT_OUTPUT_BYTES {
        let surplus = recent.len() - MAX_RECENT_OUTPUT_BYTES;
        recent.drain(..surplus);
    }
}

fn mark_disconnected(terminal: &Arc<Terminal>, generation: u32, fallback_reason: &'static str) {
    let (should_retry, audit_event, task_id, reason) = {
        let mut inner = match terminal.inner.lock() {
            Ok(value) => value,
            Err(_) => return,
        };
        if inner.dto.generation != generation
            || matches!(
                inner.dto.state,
                TerminalState::Closing | TerminalState::Closed | TerminalState::Failed
            )
        {
            return;
        }

        match disconnect_reason(&mut inner, fallback_reason) {
            DisconnectReason::NormalExit => {
                inner.dto.state = TerminalState::Closed;
                inner.dto.reason = Some("shell-exited".into());
                inner.dto.reconnectable = false;
                inner.dto.revision = inner.dto.revision.saturating_add(1);
                release_pty(&mut inner);
                emit_state(terminal, &inner, None);
                (
                    false,
                    TerminalAuditEvent::Closed,
                    inner.dto.task_id.clone(),
                    inner.dto.reason.clone(),
                )
            }
            DisconnectReason::Authentication => {
                inner.dto.state = TerminalState::Failed;
                inner.dto.reason = Some("ssh-authentication-failed".into());
                inner.dto.reconnectable = false;
                inner.dto.revision = inner.dto.revision.saturating_add(1);
                release_pty(&mut inner);
                emit_state(terminal, &inner, None);
                (
                    false,
                    TerminalAuditEvent::Failed,
                    inner.dto.task_id.clone(),
                    inner.dto.reason.clone(),
                )
            }
            DisconnectReason::HostKey => {
                inner.dto.state = TerminalState::Failed;
                inner.dto.reason = Some("ssh-host-key-failed".into());
                inner.dto.reconnectable = false;
                inner.dto.revision = inner.dto.revision.saturating_add(1);
                release_pty(&mut inner);
                emit_state(terminal, &inner, None);
                (
                    false,
                    TerminalAuditEvent::Failed,
                    inner.dto.task_id.clone(),
                    inner.dto.reason.clone(),
                )
            }
            DisconnectReason::Network(reason) => {
                inner.dto.state = TerminalState::Disconnected;
                inner.dto.reason = Some(reason.into());
                inner.dto.reconnectable = inner.dto.auto_reconnect;
                inner.dto.revision = inner.dto.revision.saturating_add(1);
                release_pty(&mut inner);
                emit_state(terminal, &inner, None);
                (
                    inner.dto.auto_reconnect,
                    TerminalAuditEvent::Interrupted,
                    inner.dto.task_id.clone(),
                    inner.dto.reason.clone(),
                )
            }
        }
    };
    record_terminal_audit(terminal, task_id.as_deref(), audit_event, reason.as_deref());
    if should_retry {
        schedule_auto_reconnect(terminal.clone());
    }
}

enum DisconnectReason {
    NormalExit,
    Authentication,
    HostKey,
    Network(&'static str),
}

fn disconnect_reason(inner: &mut TerminalInner, fallback: &'static str) -> DisconnectReason {
    if inner
        .child
        .as_mut()
        .and_then(|child| child.try_wait().ok().flatten())
        .is_some_and(|status| status.success())
    {
        return DisconnectReason::NormalExit;
    }
    if has_ascii_marker(&inner.recent_output, b"permission denied")
        || has_ascii_marker(&inner.recent_output, b"too many authentication failures")
        || has_ascii_marker(&inner.recent_output, b"authentication failed")
    {
        return DisconnectReason::Authentication;
    }
    if has_ascii_marker(&inner.recent_output, b"host key verification failed")
        || has_ascii_marker(
            &inner.recent_output,
            b"remote host identification has changed",
        )
        || has_ascii_marker(&inner.recent_output, b"host key has changed")
    {
        return DisconnectReason::HostKey;
    }
    DisconnectReason::Network(fallback)
}

fn has_ascii_marker(bytes: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() || bytes.len() < needle.len() {
        return false;
    }
    bytes.windows(needle.len()).any(|window| {
        window
            .iter()
            .zip(needle)
            .all(|(left, right)| left.to_ascii_lowercase() == *right)
    })
}

/// Parses only complete OSC 7 `file://` URI sequences. The terminal payload
/// stays opaque; malformed or non-UTF-8 path bytes simply remain unavailable.
fn latest_osc7_path(bytes: &[u8]) -> Option<String> {
    let marker = b"\x1b]7;";
    let mut latest = None;
    let mut cursor = 0;
    while cursor + marker.len() <= bytes.len() {
        let relative = bytes[cursor..]
            .windows(marker.len())
            .position(|window| window == marker)?;
        let start = cursor + relative + marker.len();
        let mut end = None;
        let mut index = start;
        while index < bytes.len() {
            if bytes[index] == 0x07 {
                end = Some(index);
                break;
            }
            if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                end = Some(index);
                break;
            }
            index += 1;
        }
        let Some(end) = end else {
            break;
        };
        if let Some(path) = osc7_uri_path(&bytes[start..end]) {
            latest = Some(path);
        }
        cursor = end.saturating_add(1);
    }
    latest
}

/// Accepts a complete, nonce-bound PID marker emitted by `shell_pid_probe_input`.
/// It intentionally does not decode the rest of the terminal stream.
fn latest_shell_pid(bytes: &[u8], token: &str) -> Option<u32> {
    let mut latest = None;
    let mut cursor = 0;
    while cursor + SHELL_PID_OSC_PREFIX.len() <= bytes.len() {
        let Some(relative) = bytes[cursor..]
            .windows(SHELL_PID_OSC_PREFIX.len())
            .position(|window| window == SHELL_PID_OSC_PREFIX)
        else {
            break;
        };
        let start = cursor + relative + SHELL_PID_OSC_PREFIX.len();
        let mut end = None;
        let mut index = start;
        while index < bytes.len() {
            if bytes[index] == 0x07 {
                end = Some(index);
                break;
            }
            if bytes[index] == 0x1b && bytes.get(index + 1) == Some(&b'\\') {
                end = Some(index);
                break;
            }
            index += 1;
        }
        let Some(end) = end else {
            break;
        };
        if let Ok(payload) = std::str::from_utf8(&bytes[start..end]) {
            if let Some(pid) = payload
                .strip_prefix(token)
                .and_then(|value| value.strip_prefix(':'))
                .filter(|value| {
                    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                })
                .and_then(|value| value.parse::<u32>().ok())
                .filter(|pid| *pid > 1)
            {
                latest = Some(pid);
            }
        }
        cursor = if bytes.get(end) == Some(&0x1b) {
            end + 2
        } else {
            end + 1
        };
    }
    latest
}

fn osc7_uri_path(value: &[u8]) -> Option<String> {
    let uri = std::str::from_utf8(value).ok()?;
    let remainder = uri.strip_prefix("file://")?;
    let path_start = remainder.find('/')?;
    let path = percent_decode_utf8(&remainder[path_start..])?;
    (path.starts_with('/') && !path.contains('\0')).then_some(path)
}

fn percent_decode_utf8(value: &str) -> Option<String> {
    let mut bytes = Vec::with_capacity(value.len());
    let raw = value.as_bytes();
    let mut index = 0;
    while index < raw.len() {
        if raw[index] == b'%' {
            let high = *raw.get(index + 1)?;
            let low = *raw.get(index + 2)?;
            bytes.push((hex_digit(high)? << 4) | hex_digit(low)?);
            index += 3;
        } else {
            bytes.push(raw[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn schedule_auto_reconnect(terminal: Arc<Terminal>) {
    let (delay, generation) = {
        let mut inner = match terminal.inner.lock() {
            Ok(inner) => inner,
            Err(_) => return,
        };
        if !inner.dto.auto_reconnect
            || !inner.dto.reconnectable
            || inner.reconnect_scheduled
            || matches!(
                inner.dto.state,
                TerminalState::Closing | TerminalState::Closed | TerminalState::Failed
            )
        {
            return;
        }
        let Some(delay) = RECONNECT_DELAYS
            .get(inner.reconnect_attempts as usize)
            .copied()
        else {
            inner.dto.state = TerminalState::Disconnected;
            inner.dto.reason = Some("auto-reconnect-exhausted".into());
            inner.dto.reconnectable = true;
            inner.dto.revision = inner.dto.revision.saturating_add(1);
            emit_state(&terminal, &inner, None);
            return;
        };
        inner.reconnect_attempts = inner.reconnect_attempts.saturating_add(1);
        inner.reconnect_scheduled = true;
        inner.dto.state = TerminalState::Reconnecting;
        inner.dto.reason = Some("network-disconnected".into());
        inner.dto.reconnectable = true;
        inner.dto.revision = inner.dto.revision.saturating_add(1);
        let next_retry_at =
            (Local::now() + ChronoDuration::from_std(delay).unwrap_or_default()).to_rfc3339();
        emit_state(&terminal, &inner, Some(next_retry_at));
        (delay, inner.dto.generation)
    };
    thread::spawn(move || {
        thread::sleep(delay);
        let should_start = {
            let mut inner = match terminal.inner.lock() {
                Ok(inner) => inner,
                Err(_) => return,
            };
            if inner.dto.generation != generation
                || !inner.reconnect_scheduled
                || inner.dto.state != TerminalState::Reconnecting
            {
                return;
            }
            inner.reconnect_scheduled = false;
            true
        };
        if should_start && start_pty(&terminal, true, false).is_err() {
            schedule_auto_reconnect(terminal);
        }
    });
}

fn record_terminal_audit(
    terminal: &Terminal,
    task_id: Option<&str>,
    event: TerminalAuditEvent,
    reason: Option<&str>,
) {
    let (Some(audit), Some(task_id)) = (terminal.audit.as_ref(), task_id) else {
        return;
    };
    audit.record(task_id, event, reason);
}

fn emit_state(terminal: &Terminal, inner: &TerminalInner, next_retry_at: Option<String>) {
    emit(
        terminal.sink.as_ref(),
        SESSION_STATE_EVENT,
        &SessionStateEvent {
            session_id: inner.dto.session_id.clone(),
            generation: inner.dto.generation,
            revision: inner.dto.revision,
            state: inner.dto.state,
            reconnectable: inner.dto.reconnectable,
            attempt: inner.dto.attempt,
            next_retry_at,
            reason: inner.dto.reason.clone(),
            task_id: inner.dto.task_id.clone(),
        },
    );
}

fn emit_heartbeat(terminal: &Terminal, inner: &TerminalInner) {
    emit(
        terminal.sink.as_ref(),
        SESSION_HEARTBEAT_EVENT,
        &SessionHeartbeatEvent {
            session_id: inner.dto.session_id.clone(),
            generation: inner.dto.generation,
            revision: inner.dto.revision,
            observed_at: Local::now().to_rfc3339(),
        },
    );
}

fn validate_size(rows: u16, cols: u16) -> WorkspaceResult<()> {
    if !(1..=300).contains(&rows) || !(2..=500).contains(&cols) {
        Err(WorkspaceError::new(
            "invalid-terminal-size",
            "Terminal size must be 1-300 rows and 2-500 columns.",
        ))
    } else {
        Ok(())
    }
}

fn ensure_generation(inner: &TerminalInner, generation: u32) -> WorkspaceResult<()> {
    if inner.dto.generation == generation {
        Ok(())
    } else {
        Err(WorkspaceError::new(
            "stale-terminal-generation",
            "The terminal has been reconnected; attach its current generation.",
        ))
    }
}

fn session_consumes_slot(state: TerminalState) -> bool {
    !matches!(state, TerminalState::Closed | TerminalState::Failed)
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> WorkspaceError {
    WorkspaceError::new(
        "workspace-lock-poisoned",
        "Workspace session state is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audit_session(attempt: u8) -> TerminalSessionDto {
        TerminalSessionDto {
            session_id: "term-test".into(),
            created_at: "2026-07-30T00:00:00Z".into(),
            host_id: "host-test".into(),
            host_name: "Test host".into(),
            host_alias: "test-host".into(),
            generation: 1,
            revision: 1,
            state: TerminalState::Connecting,
            reconnectable: false,
            attempt,
            auto_reconnect: true,
            rows: 24,
            cols: 80,
            verified_cwd: None,
            reason: None,
            task_id: None,
        }
    }

    #[test]
    fn terminal_audit_tracks_connection_attempts_without_secret_text() {
        let store = Arc::new(TaskStore::in_memory());
        let audit = JobManagerTerminalAudit::new(store.clone(), None);
        let task_id = audit.begin_attempt(&audit_session(1)).unwrap();
        audit.record(&task_id, TerminalAuditEvent::ProcessLaunched, None);
        audit.record(
            &task_id,
            TerminalAuditEvent::Failed,
            Some("ssh-authentication-failed"),
        );

        let task = store.get(&task_id).unwrap().unwrap();
        assert!(matches!(task.status, TaskStatus::Failed));
        assert!(
            task.steps
                .iter()
                .any(|step| step.step_id == "launch"
                    && matches!(step.status, TaskStepStatus::Success))
        );
        assert!(
            task.steps
                .iter()
                .any(|step| step.step_id == "connect"
                    && matches!(step.status, TaskStepStatus::Failed))
        );
        assert!(task
            .logs
            .iter()
            .any(|log| log.message.contains("ssh-authentication-failed")));
        assert!(task
            .logs
            .iter()
            .all(|log| !log.message.contains("private-key")));
    }

    #[test]
    fn terminal_audit_only_accepts_known_reason_codes() {
        assert_eq!(
            safe_terminal_reason(Some("ssh-host-key-failed")),
            "ssh-host-key-failed"
        );
        assert_eq!(
            safe_terminal_reason(Some("token=private-key:/home/user/.ssh/id_ed25519")),
            "connection-failed"
        );
    }

    #[test]
    fn terminal_size_has_fixed_safe_bounds() {
        assert!(validate_size(1, 2).is_ok());
        assert!(validate_size(300, 500).is_ok());
        assert_eq!(
            validate_size(0, 2).unwrap_err().code,
            "invalid-terminal-size"
        );
        assert_eq!(
            validate_size(1, 501).unwrap_err().code,
            "invalid-terminal-size"
        );
    }

    #[test]
    fn authentication_and_host_key_markers_do_not_need_utf8_decoding() {
        assert!(has_ascii_marker(
            b"Permission denied (publickey).",
            b"permission denied"
        ));
        assert!(has_ascii_marker(
            b"WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!",
            b"remote host identification has changed"
        ));
        assert!(!has_ascii_marker(&[0xff, 0xfe, b'x'], b"permission denied"));
    }

    #[test]
    fn osc7_path_requires_a_complete_utf8_file_uri() {
        assert_eq!(
            latest_osc7_path(b"\x1b]7;file://host/home/a%20b\x07"),
            Some("/home/a b".into())
        );
        assert_eq!(latest_osc7_path(b"\x1b]7;file://host/home/partial"), None);
        assert_eq!(latest_osc7_path(b"\x1b]7;https://host/a\x07"), None);
    }

    #[test]
    fn shell_pid_probe_requires_the_generation_nonce() {
        let token = "nonce-123";
        assert_eq!(
            latest_shell_pid(b"\x1b]777;CodexHubPid=nonce-123:4242\x07", token),
            Some(4242)
        );
        assert_eq!(
            latest_shell_pid(b"\x1b]777;CodexHubPid=other:4242\x07", token),
            None
        );
        assert_eq!(
            latest_shell_pid(b"\x1b]777;CodexHubPid=nonce-123:not-a-pid\x07", token),
            None
        );
        assert_eq!(
            shell_pid_probe_input(token),
            b"printf '\\033]777;CodexHubPid=nonce-123:%s\\007' \"$$\"\n"
        );
    }

    #[test]
    fn cwd_shell_input_requires_a_safe_absolute_path_and_quotes_it() {
        assert_eq!(
            shell_cd_input("/home/a b/'quoted'").unwrap(),
            b"cd -- '/home/a b/'\"'\"'quoted'\"'\"''\n"
        );
        assert_eq!(
            shell_cd_input("relative").unwrap_err().code,
            "terminal-directory-unsafe"
        );
        assert_eq!(
            shell_cd_input("/home/line\nfeed").unwrap_err().code,
            "terminal-directory-unsafe"
        );
    }

    #[test]
    fn cwd_restore_requires_an_explicit_none_remote_command() {
        assert!(ssh_g_remote_command_is_none(
            b"host target\nremotecommand none\nuser developer\n"
        ));
        assert!(!ssh_g_remote_command_is_none(
            b"host target\nremotecommand tmux new-session\n"
        ));
        assert!(!ssh_g_remote_command_is_none(b"remotecommand \xff\n"));
    }

    #[test]
    fn only_live_terminal_states_consume_a_ptyslot() {
        assert!(session_consumes_slot(TerminalState::Creating));
        assert!(session_consumes_slot(TerminalState::Connected));
        assert!(session_consumes_slot(TerminalState::Disconnected));
        assert!(!session_consumes_slot(TerminalState::Closed));
        assert!(!session_consumes_slot(TerminalState::Failed));
    }
}
