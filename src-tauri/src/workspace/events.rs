use crate::workspace::types::{CwdSource, RemoteFileEntry, TerminalState, TransferState};
use serde::Serialize;
use std::sync::Arc;
use ts_rs::TS;

pub const TERMINAL_OUTPUT_EVENT: &str = "workspace-terminal-output";
pub const SESSION_STATE_EVENT: &str = "workspace-session-state";
pub const SESSION_HEARTBEAT_EVENT: &str = "workspace-session-heartbeat";
pub const TERMINAL_CWD_EVENT: &str = "workspace-terminal-cwd";
pub const TRANSFER_UPDATED_EVENT: &str = "workspace-transfer-updated";
pub const FILE_SEARCH_UPDATED_EVENT: &str = "workspace-file-search-updated";

pub type WorkspaceEventSink =
    Arc<dyn Fn(&'static str, serde_json::Value) -> Result<(), String> + Send + Sync>;

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTerminalOutputEventDto")]
pub struct TerminalOutputEvent {
    pub session_id: String,
    pub generation: u32,
    #[ts(type = "number")]
    pub sequence: u64,
    pub data_base64: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceSessionStateEventDto")]
pub struct SessionStateEvent {
    pub session_id: String,
    pub generation: u32,
    #[ts(type = "number")]
    pub revision: u64,
    pub state: TerminalState,
    pub reconnectable: bool,
    pub attempt: u8,
    pub next_retry_at: Option<String>,
    pub reason: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceSessionHeartbeatEventDto")]
pub struct SessionHeartbeatEvent {
    pub session_id: String,
    pub generation: u32,
    #[ts(type = "number")]
    pub revision: u64,
    pub observed_at: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTerminalCwdEventDto")]
pub struct TerminalCwdEvent {
    pub session_id: String,
    pub generation: u32,
    #[ts(type = "number")]
    pub revision: u64,
    pub path: String,
    pub source: CwdSource,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTransferUpdatedEventDto")]
pub struct TransferUpdatedEvent {
    pub transfer_id: String,
    pub updated_at: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub state: TransferState,
    #[ts(type = "number")]
    pub bytes: u64,
    #[ts(type = "number | null")]
    pub total: Option<u64>,
    #[ts(type = "number | null")]
    pub speed: Option<u64>,
    #[ts(type = "number | null")]
    pub eta_seconds: Option<u64>,
    pub attempt: u8,
    pub resumable: bool,
    pub error_code: Option<String>,
    pub task_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceFileSearchUpdatedEventDto")]
pub struct FileSearchUpdatedEvent {
    pub search_id: String,
    pub file_session_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub state: FileSearchState,
    pub entries: Vec<RemoteFileEntry>,
    pub scanned: u32,
    pub truncated: bool,
    pub error_code: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceFileSearchStateDto")]
pub enum FileSearchState {
    Running,
    Completed,
    Cancelled,
    Failed,
}

pub(crate) fn emit<T: Serialize>(
    sink: Option<&WorkspaceEventSink>,
    event_name: &'static str,
    payload: &T,
) {
    let Some(sink) = sink else {
        return;
    };
    let Ok(value) = serde_json::to_value(payload) else {
        return;
    };
    if let Err(error) = sink(event_name, value) {
        // Event errors are intentionally best effort. Never print the payload,
        // since terminal output and remote paths can contain sensitive data.
        eprintln!("Workspace event delivery failed: {error}");
    }
}
