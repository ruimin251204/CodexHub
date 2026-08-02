use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceTerminalStateDto")]
pub enum TerminalState {
    Creating,
    Connecting,
    Connected,
    Reconnecting,
    Disconnected,
    Closing,
    Closed,
    Failed,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceOpenTerminalRequestDto")]
pub struct OpenTerminalRequest {
    pub host_id: String,
    pub host_name: String,
    pub host_alias: String,
    /// A Files session must canonicalize this directory before a shell may
    /// receive it. It is intentionally optional for ordinary Home sessions.
    #[serde(default)]
    #[ts(optional)]
    pub initial_directory: Option<InitialTerminalDirectory>,
    pub rows: u16,
    pub cols: u16,
    #[serde(default = "default_true")]
    pub auto_reconnect: bool,
}

/// Opaque-to-the-shell directory context. The command boundary resolves the
/// path again through this Files session before it reaches the PTY writer.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceInitialTerminalDirectoryDto")]
pub struct InitialTerminalDirectory {
    pub file_session_id: String,
    pub path: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTerminalSessionDto")]
pub struct TerminalSessionDto {
    pub session_id: String,
    pub created_at: String,
    pub host_id: String,
    pub host_name: String,
    pub host_alias: String,
    pub generation: u32,
    #[ts(type = "number")]
    pub revision: u64,
    pub state: TerminalState,
    pub reconnectable: bool,
    pub attempt: u8,
    pub auto_reconnect: bool,
    pub rows: u16,
    pub cols: u16,
    pub verified_cwd: Option<String>,
    pub reason: Option<String>,
    /// The active connection-attempt audit record. Terminal bytes never enter it.
    pub task_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceAttachTerminalRequestDto")]
pub struct AttachTerminalRequest {
    pub session_id: String,
    pub generation: u32,
    #[serde(default)]
    #[ts(type = "number")]
    pub after_sequence: u64,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTerminalReplayFrameDto")]
pub struct TerminalReplayFrame {
    #[ts(type = "number")]
    pub sequence: u64,
    pub data_base64: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceAttachTerminalResultDto")]
pub struct AttachTerminalResult {
    pub session: TerminalSessionDto,
    pub gap: bool,
    pub frames: Vec<TerminalReplayFrame>,
    #[ts(type = "number")]
    pub latest_sequence: u64,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTerminalWriteRequestDto")]
pub struct TerminalWriteRequest {
    pub session_id: String,
    pub generation: u32,
    pub data_base64: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTerminalResizeRequestDto")]
pub struct TerminalResizeRequest {
    pub session_id: String,
    pub generation: u32,
    pub rows: u16,
    pub cols: u16,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTerminalAckRequestDto")]
pub struct TerminalAckRequest {
    pub session_id: String,
    pub generation: u32,
    #[ts(type = "number")]
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTerminalIdentityRequestDto")]
pub struct TerminalIdentityRequest {
    pub session_id: String,
    pub generation: u32,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceOpenFilesRequestDto")]
pub struct OpenFilesRequest {
    pub host_id: String,
    pub host_name: String,
    pub host_alias: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceFileSessionDto")]
pub struct FileSessionDto {
    pub file_session_id: String,
    pub host_id: String,
    pub host_name: String,
    pub host_alias: String,
    pub home_path: String,
    pub supports_fsync: bool,
    /// A remote hard link gives regular files an atomic create-if-absent
    /// publish path. Workspace refuses a claimed no-replace move without it.
    pub supports_hardlink: bool,
    pub supports_posix_rename: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "RemoteFileKindDto")]
pub enum RemoteFileKind {
    File,
    Directory,
    Symlink,
    Fifo,
    Socket,
    BlockDevice,
    CharacterDevice,
    Unknown,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "RemoteFileEntryDto")]
pub struct RemoteFileEntry {
    pub entry_ref: String,
    pub path: String,
    pub name: String,
    pub kind: RemoteFileKind,
    /// String avoids losing precision in JavaScript for very large files.
    pub size: Option<String>,
    /// UTC RFC 3339 timestamp suitable for direct JavaScript parsing.
    pub modified_at: Option<String>,
    pub permissions: Option<String>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    pub symlink_target: Option<String>,
    pub fingerprint: String,
    pub writable_name: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceFileSortFieldDto")]
pub enum FileSortField {
    Name,
    Type,
    Size,
    Modified,
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(rename = "WorkspaceSortDirectionDto")]
pub enum SortDirection {
    Asc,
    Desc,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceListDirectoryRequestDto")]
pub struct ListDirectoryRequest {
    pub file_session_id: String,
    pub path: String,
    #[serde(default)]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub page_token: Option<String>,
    #[serde(default)]
    pub sort: Option<FileSortField>,
    #[serde(default)]
    pub direction: Option<SortDirection>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceListDirectoryResultDto")]
pub struct ListDirectoryResult {
    pub canonical_path: String,
    pub snapshot_id: String,
    pub entries: Vec<RemoteFileEntry>,
    pub next_page_token: Option<String>,
    pub total_entries: u32,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceStartFileSearchRequestDto")]
pub struct StartFileSearchRequest {
    pub file_session_id: String,
    pub path: String,
    pub query: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceFileSearchStartedDto")]
pub struct FileSearchStarted {
    pub search_id: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceCancelFileSearchRequestDto")]
pub struct CancelFileSearchRequest {
    pub search_id: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspacePreviewFileRequestDto")]
pub struct PreviewFileRequest {
    pub file_session_id: String,
    pub entry_ref: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspacePreviewKindDto")]
pub enum PreviewKind {
    Text,
    Image,
    Metadata,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceFilePreviewDto")]
pub struct FilePreview {
    pub entry: RemoteFileEntry,
    pub kind: PreviewKind,
    pub mime_type: String,
    pub text: Option<String>,
    pub data_base64: Option<String>,
    pub truncated: bool,
}

/// Creates a single directory below a canonical, user-visible parent.  The
/// backend rejects separators and dot segments so a webview cannot escape the
/// selected parent through a filename.
#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceCreateDirectoryRequestDto")]
pub struct CreateDirectoryRequest {
    pub file_session_id: String,
    pub parent_path: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceValidateTerminalCwdRequestDto")]
pub struct ValidateTerminalCwdRequest {
    pub session_id: String,
    pub generation: u32,
    pub file_session_id: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceCwdSourceDto")]
pub enum CwdSource {
    Osc7,
    Proc,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceValidatedCwdDto")]
pub struct ValidatedCwd {
    pub session_id: String,
    pub generation: u32,
    #[ts(type = "number")]
    pub revision: u64,
    pub path: String,
    pub source: CwdSource,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceFileOperationKindDto")]
pub enum FileOperationKind {
    Delete,
    Rename,
    Overwrite,
}

/// Durable recovery state. A `prepared` journal is intentionally retained if
/// the process stops between the remote mutation and its final state write.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceRecoveryStateDto")]
pub enum RecoveryState {
    Prepared,
    Available,
    Restoring,
    Restored,
    PurgePrepared,
    Purged,
    Failed,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspacePrepareFileOperationRequestDto")]
pub struct PrepareFileOperationRequest {
    pub file_session_id: String,
    pub kind: FileOperationKind,
    pub source_entry_ref: String,
    #[serde(default)]
    pub destination_path: Option<String>,
    /// Overwrite commits a previously verified staging file. It must also be
    /// represented by a fresh entry ref instead of a frontend-provided path.
    #[serde(default)]
    pub staging_entry_ref: Option<String>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspacePreparedFileOperationDto")]
pub struct PreparedFileOperation {
    pub operation_token: String,
    pub kind: FileOperationKind,
    pub host_alias: String,
    pub source_path: String,
    pub destination_path: Option<String>,
    pub recovery_path: String,
    pub expires_at: String,
    pub requires_destination_backup: bool,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceConfirmFileOperationRequestDto")]
pub struct ConfirmFileOperationRequest {
    pub operation_token: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceFileOperationResultDto")]
pub struct FileOperationResult {
    pub recovery_id: String,
    pub task_id: Option<String>,
    pub recovery: RecoveryDto,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceRecoveryDto")]
pub struct RecoveryDto {
    pub recovery_id: String,
    /// Stable host identity is durable. A FileSession is a short-lived SFTP
    /// handle and must never be used to recover a mutation after app restart.
    pub host_id: String,
    pub host_alias: String,
    pub kind: FileOperationKind,
    pub original_path: String,
    pub current_path: Option<String>,
    pub backup_path: Option<String>,
    pub state: RecoveryState,
    pub task_id: Option<String>,
    pub reason: Option<String>,
    pub created_at: String,
    pub restored_at: Option<String>,
    pub purged_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceRecoveryIdentityRequestDto")]
pub struct RecoveryIdentityRequest {
    pub recovery_id: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspacePreparedRecoveryPurgeDto")]
pub struct PreparedRecoveryPurge {
    pub purge_token: String,
    pub recovery: RecoveryDto,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspacePurgeRecoveryRequestDto")]
pub struct PurgeRecoveryRequest {
    pub purge_token: String,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceTransferDirectionDto")]
pub enum TransferDirection {
    Upload,
    Download,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceTransferStateDto")]
pub enum TransferState {
    Queued,
    Running,
    Pausing,
    Paused,
    WaitingConflict,
    Verifying,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceConflictStrategyDto")]
pub enum ConflictStrategy {
    Ask,
    Skip,
    KeepBoth,
    ReplaceWithBackup,
}

/// A local path is never sent back to the webview.  Native picker/drop code
/// turns it into this short-lived opaque capability before queuing a transfer.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceLocalPathGrantDto")]
pub struct LocalPathGrantDto {
    pub grant_id: String,
    pub display_name: String,
    pub is_directory: bool,
    #[ts(type = "number | null")]
    pub total_bytes: Option<u64>,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTransferDraftDto")]
pub struct TransferDraft {
    pub direction: TransferDirection,
    pub host_id: String,
    pub host_name: String,
    pub host_alias: String,
    pub source_ref: String,
    /// Required by downloads: opaque local-directory grant used only in Rust.
    #[serde(default)]
    pub local_grant_id: Option<String>,
    pub destination_path: String,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub total_bytes: Option<u64>,
    #[serde(default)]
    pub conflict_strategy: Option<ConflictStrategy>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceEnqueueTransfersRequestDto")]
pub struct EnqueueTransfersRequest {
    pub file_session_id: String,
    pub items: Vec<TransferDraft>,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTransferSnapshotDto")]
pub struct TransferSnapshotDto {
    pub transfers: Vec<TransferDto>,
    pub recoveries: Vec<RecoveryDto>,
    #[serde(default)]
    pub local_recoveries: Vec<LocalTransferRecoveryDto>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename = "WorkspaceLocalTransferRecoveryStateDto")]
pub enum LocalTransferRecoveryState {
    Prepared,
    Available,
    Restored,
    Purged,
    Failed,
}

/// Local recovery intentionally exposes only basenames. The original and
/// backup absolute paths are retained solely in the desktop SQLite journal.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceLocalTransferRecoveryDto")]
pub struct LocalTransferRecoveryDto {
    pub recovery_id: String,
    pub transfer_id: String,
    pub destination_name: String,
    pub backup_name: String,
    pub state: LocalTransferRecoveryState,
    pub created_at: String,
    pub restored_at: Option<String>,
    pub purged_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceLocalTransferRecoveryIdentityRequestDto")]
pub struct LocalTransferRecoveryIdentityRequest {
    pub recovery_id: String,
}

#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspacePreparedLocalTransferRecoveryPurgeDto")]
pub struct PreparedLocalTransferRecoveryPurge {
    pub purge_token: String,
    pub recovery: LocalTransferRecoveryDto,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspacePurgeLocalTransferRecoveryRequestDto")]
pub struct PurgeLocalTransferRecoveryRequest {
    pub purge_token: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTransferDto")]
pub struct TransferDto {
    pub transfer_id: String,
    /// A batch is durable queue metadata only. Keeping it out of the WebView
    /// prevents a UI caller from widening a conflict decision after reload.
    #[serde(skip)]
    #[ts(skip)]
    pub(crate) batch_id: String,
    pub task_id: Option<String>,
    pub direction: TransferDirection,
    pub host_id: String,
    pub host_name: String,
    pub host_alias: String,
    pub source_ref: String,
    pub destination_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub state: TransferState,
    #[ts(type = "number")]
    pub revision: u64,
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
    #[ts(type = "number | null")]
    pub resume_offset: Option<u64>,
    pub conflict_strategy: ConflictStrategy,
    #[ts(type = "number | null")]
    pub conflict_revision: Option<u64>,
    pub error_code: Option<String>,
    pub fingerprint_status: Option<String>,
    /// Durable resume facts stay in the app database only. They can contain a
    /// local staging path, so neither Tauri nor generated TypeScript exposes
    /// them to the WebView.
    #[serde(skip)]
    #[ts(skip)]
    pub(crate) durable_source_fingerprint: Option<String>,
    #[serde(skip)]
    #[ts(skip)]
    pub(crate) durable_partial_locator: Option<String>,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceTransferIdentityRequestDto")]
pub struct TransferIdentityRequest {
    pub transfer_id: String,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub revision: Option<u64>,
    /// Resume after an app restart must receive fresh native-path authority.
    /// Pause/cancel keep these absent and never resolve local paths.
    #[serde(default)]
    pub file_session_id: Option<String>,
    #[serde(default)]
    pub local_grant_id: Option<String>,
    #[serde(default)]
    pub restart: bool,
}

#[derive(Clone, Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceResolveTransferConflictRequestDto")]
pub struct ResolveTransferConflictRequest {
    pub transfer_id: String,
    #[ts(type = "number")]
    pub conflict_revision: u64,
    pub strategy: ConflictStrategy,
    #[serde(default)]
    pub apply_to_batch: bool,
}

fn default_true() -> bool {
    true
}
