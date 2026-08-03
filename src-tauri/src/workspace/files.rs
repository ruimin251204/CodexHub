use super::background_process::configure_tokio_command;
use super::error::{WorkspaceError, WorkspaceResult};
use super::local_files::LocalFileSessions;
use super::events::{
    emit, FileSearchState, FileSearchUpdatedEvent, WorkspaceEventSink, FILE_SEARCH_UPDATED_EVENT,
};
use super::remote_path;
use super::types::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use futures_util::StreamExt;
use openssh_sftp_client::{
    metadata::{MetaData, Permissions},
    Sftp, SftpOptions,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex as AsyncMutex, RwLock};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const DIRECTORY_PAGE_SIZE: usize = 500;
const MAX_DIRECTORY_ENTRIES: usize = 50_000;
const MAX_DIRECTORY_SNAPSHOTS: usize = 16;
const TEXT_PREVIEW_LIMIT: u64 = 1024 * 1024;
const IMAGE_PREVIEW_LIMIT: u64 = 10 * 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 10_000;
const TRANSFER_CHUNK_BYTES: usize = 128 * 1024;
const MAX_SEARCH_DURATION: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TransferFingerprint {
    pub size: u64,
    pub modified: Option<String>,
}

/// Lstat-only snapshot used by destructive preflight.  It intentionally has
/// no entry reference: callers cannot turn an arbitrary path into a mutable
/// frontend capability through this internal value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OperationPathSnapshot {
    pub path: String,
    pub fingerprint: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TransferStreamStop {
    Complete,
    Cancelled,
}

struct ConnectedSftp {
    child: Child,
    sftp: Sftp,
}
struct FileSession {
    dto: FileSessionDto,
    connection: AsyncMutex<ConnectedSftp>,
    entries: RwLock<HashMap<String, RemoteFileEntry>>,
    snapshots: Mutex<HashMap<String, DirectorySnapshot>>,
}

pub(crate) struct OpenFileSession {
    pub session: FileSessionDto,
    pub reused: bool,
}

/// A bounded, SFTP-derived directory ordering. It prevents later pages from
/// re-reading a mutable directory and silently changing their sort position.
#[derive(Clone)]
struct DirectorySnapshot {
    canonical_path: String,
    entries: Vec<RemoteFileEntry>,
    truncated: bool,
}
pub struct FileSessions {
    values: Mutex<HashMap<String, Arc<FileSession>>>,
    /// Serializes first-open per manager so the host reuse lookup and insert
    /// cannot race into duplicate SFTP subsystem processes.
    opening: AsyncMutex<()>,
    searches: Mutex<HashMap<String, CancellationToken>>,
    event_sink: Option<WorkspaceEventSink>,
    local: LocalFileSessions,
}

impl FileSessions {
    pub fn new(event_sink: Option<WorkspaceEventSink>) -> Self {
        Self {
            values: Mutex::new(HashMap::new()),
            opening: AsyncMutex::new(()),
            searches: Mutex::new(HashMap::new()),
            local: LocalFileSessions::new(event_sink.clone()),
            event_sink,
        }
    }
    /// Uses `ssh -s sftp`; OpenSSH therefore applies Include, Match, agent,
    /// ProxyJump and known_hosts exactly as it does in the user's terminal.
    pub async fn open(&self, request: OpenFilesRequest) -> WorkspaceResult<OpenFileSession> {
        if request.local {
            return Ok(OpenFileSession { session: self.local.open()?, reused: true });
        }
        let _opening = self.opening.lock().await;
        if let Some(existing) = self
            .values
            .lock()
            .map_err(lock_error)?
            .values()
            .find(|session| session.dto.host_id == request.host_id)
            .cloned()
        {
            return Ok(OpenFileSession {
                session: existing.dto.clone(),
                reused: true,
            });
        }
        let mut connection = connect_sftp(&request.host_alias).await?;
        let home = match {
            let mut fs = connection.sftp.fs();
            fs.canonicalize(".").await
        } {
            Ok(home) => home,
            Err(error) => {
                stop_sftp_child(&mut connection.child).await;
                return Err(WorkspaceError::retryable(
                    "sftp-home-failed",
                    error.to_string(),
                ));
            }
        };
        let dto = FileSessionDto {
            file_session_id: format!("files-{}", Uuid::new_v4()),
            host_id: request.host_id,
            host_name: request.host_name,
            host_alias: request.host_alias,
            home_path: path_string(&home)?,
            supports_fsync: connection.sftp.support_fsync(),
            supports_hardlink: connection.sftp.support_hardlink(),
            supports_posix_rename: connection.sftp.support_posix_rename(),
            target_kind: FileTargetKind::Remote,
        };
        self.values.lock().map_err(lock_error)?.insert(
            dto.file_session_id.clone(),
            Arc::new(FileSession {
                dto: dto.clone(),
                connection: AsyncMutex::new(connection),
                entries: RwLock::new(HashMap::new()),
                snapshots: Mutex::new(HashMap::new()),
            }),
        );
        Ok(OpenFileSession {
            session: dto,
            reused: false,
        })
    }
    pub async fn close(&self, file_session_id: &str) -> WorkspaceResult<()> {
        if LocalFileSessions::owns(file_session_id) {
            return Ok(());
        }
        let session = self
            .values
            .lock()
            .map_err(lock_error)?
            .remove(file_session_id)
            .ok_or_else(|| {
                WorkspaceError::new(
                    "file-session-not-found",
                    "The file session no longer exists.",
                )
            })?;
        close_session(session).await
    }
    pub async fn shutdown(&self) -> Result<(), String> {
        let sessions = std::mem::take(
            &mut *self
                .values
                .lock()
                .map_err(|_| "workspace lock is poisoned".to_string())?,
        );
        for session in sessions.into_values() {
            close_session(session).await.map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Recreate a broken subsystem process only after the caller classified a
    /// transport failure. Permission and path errors retain the live session.
    pub(crate) async fn reconnect(&self, file_session_id: &str) -> WorkspaceResult<()> {
        if LocalFileSessions::owns(file_session_id) {
            return Ok(());
        }
        let session = self.get(file_session_id)?;
        let replacement = connect_sftp(&session.dto.host_alias).await?;
        let mut previous = {
            let mut connection = session.connection.lock().await;
            std::mem::replace(&mut *connection, replacement)
        };
        stop_sftp_child(&mut previous.child).await;
        Ok(())
    }
    pub async fn list_directory(
        &self,
        request: ListDirectoryRequest,
    ) -> WorkspaceResult<ListDirectoryResult> {
        if LocalFileSessions::owns(&request.file_session_id) {
            return self.local.list_directory(request).await;
        }
        let session = self.get(&request.file_session_id)?;
        let canonical = canonicalize(&session, &request.path).await?;
        let canonical_path = path_string(&canonical)?;
        let (snapshot_id, snapshot) = if let Some(snapshot_id) = request.snapshot_id.as_deref() {
            let snapshot = session
                .snapshots
                .lock()
                .map_err(lock_error)?
                .get(snapshot_id)
                .cloned()
                .ok_or_else(|| {
                    WorkspaceError::new(
                        "directory-snapshot-expired",
                        "Refresh the directory and try again.",
                    )
                })?;
            if snapshot.canonical_path != canonical_path {
                return Err(WorkspaceError::new(
                    "directory-snapshot-path-mismatch",
                    "The directory snapshot belongs to a different path.",
                ));
            }
            (snapshot_id.to_string(), snapshot)
        } else {
            let connection = session.connection.lock().await;
            let mut fs = connection.sftp.fs();
            let dir = fs
                .open_dir(&canonical)
                .await
                .map_err(sftp_error("directory-open-failed"))?;
            let stream = dir.read_dir();
            tokio::pin!(stream);
            let mut all = Vec::new();
            let mut truncated = false;
            while let Some(entry) = stream.as_mut().next().await {
                let entry = entry.map_err(sftp_error("directory-read-failed"))?;
                let name = entry.filename().as_os_str().to_os_string();
                if is_dot_directory_entry(&name) {
                    continue;
                }
                if all.len() >= MAX_DIRECTORY_ENTRIES {
                    truncated = true;
                    break;
                }
                let name_text = name.to_str().ok_or_else(|| {
                    WorkspaceError::new(
                        "unsupported-path-encoding",
                        "This remote path is not valid UTF-8 and is read-only.",
                    )
                })?;
                let path = remote_path::join(&canonical_path, name_text)?;
                all.push(entry_from_metadata(path, name, entry.metadata(), None)?);
            }
            sort_entries(
                &mut all,
                request.sort.unwrap_or(FileSortField::Name),
                request.direction.unwrap_or(SortDirection::Asc),
            );
            let snapshot_id = format!("snapshot-{}", Uuid::new_v4());
            let snapshot = DirectorySnapshot {
                canonical_path: canonical_path.clone(),
                entries: all,
                truncated,
            };
            let mut snapshots = session.snapshots.lock().map_err(lock_error)?;
            if snapshots.len() >= MAX_DIRECTORY_SNAPSHOTS {
                // Snapshot IDs are opaque and only valid for this short-lived
                // session. Evicting one bounded entry keeps directory data
                // from growing unbounded without inventing later pages.
                if let Some(evicted) = snapshots.keys().next().cloned() {
                    snapshots.remove(&evicted);
                }
            }
            snapshots.insert(snapshot_id.clone(), snapshot.clone());
            (snapshot_id, snapshot)
        };
        let offset = request
            .page_token
            .as_deref()
            .unwrap_or("0")
            .parse::<usize>()
            .map_err(|_| {
                WorkspaceError::new("invalid-page-token", "Invalid directory page token.")
            })?;
        if offset > snapshot.entries.len() {
            return Err(WorkspaceError::new(
                "invalid-page-token",
                "Directory page token is outside this snapshot.",
            ));
        }
        let end = (offset + DIRECTORY_PAGE_SIZE).min(snapshot.entries.len());
        let page = snapshot.entries[offset..end].to_vec();
        let next_page_token = (end < snapshot.entries.len()).then(|| end.to_string());
        let mut refs = session.entries.write().await;
        for entry in &page {
            refs.insert(entry.entry_ref.clone(), entry.clone());
        }
        Ok(ListDirectoryResult {
            canonical_path,
            snapshot_id,
            entries: page,
            next_page_token,
            total_entries: snapshot.entries.len() as u32,
            truncated: snapshot.truncated,
        })
    }
    pub async fn preview(&self, request: PreviewFileRequest) -> WorkspaceResult<FilePreview> {
        if LocalFileSessions::owns(&request.file_session_id) {
            return self.local.preview(request).await;
        }
        let session = self.get(&request.file_session_id)?;
        let entry = self.resolve_entry(&session, &request.entry_ref).await?;
        if entry.kind != RemoteFileKind::File {
            return Err(WorkspaceError::new(
                "preview-not-file",
                "Only regular files can be previewed.",
            ));
        }
        if is_prohibited_path(&entry.path) {
            return Err(WorkspaceError::new(
                "protected-file",
                "This sensitive file cannot be previewed or transferred.",
            ));
        }
        let mime = mime_for(&entry.name);
        let limit = if is_image(&mime) {
            IMAGE_PREVIEW_LIMIT
        } else {
            TEXT_PREVIEW_LIMIT
        };
        let size = entry
            .size
            .as_deref()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        if size > limit {
            return Ok(FilePreview {
                entry,
                kind: PreviewKind::Metadata,
                mime_type: mime,
                text: None,
                data_base64: None,
                truncated: true,
            });
        }
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let bytes = fs
            .read(Path::new(&entry.path))
            .await
            .map_err(sftp_error("preview-read-failed"))?;
        if is_image(&mime) {
            Ok(FilePreview {
                entry,
                kind: PreviewKind::Image,
                mime_type: mime,
                text: None,
                data_base64: Some(STANDARD.encode(bytes)),
                truncated: false,
            })
        } else {
            let text = std::str::from_utf8(&bytes).map_err(|_| {
                WorkspaceError::new(
                    "unsupported-file-encoding",
                    "Only UTF-8 text preview is supported.",
                )
            })?;
            Ok(FilePreview {
                entry,
                kind: PreviewKind::Text,
                mime_type: mime,
                text: Some(text.into()),
                data_base64: None,
                truncated: false,
            })
        }
    }
    /// OSC 7 is only a candidate. The Files session canonicalizes it through
    /// the same SFTP connection before Workspace exposes it as a terminal cwd.
    pub async fn canonicalize_cwd(
        &self,
        file_session_id: &str,
        candidate_path: &str,
    ) -> WorkspaceResult<String> {
        if LocalFileSessions::owns(file_session_id) {
            return self.local.canonicalize(candidate_path).await;
        }
        let session = self.get(file_session_id)?;
        let canonical = canonicalize(&session, candidate_path).await?;
        path_string(&canonical)
    }
    /// A Files session is bound to one saved host.  Callers that combine a
    /// terminal or transfer with it must prove the same host before any SFTP
    /// path is canonicalized or a transfer plan is bound.
    pub(crate) fn assert_host(
        &self,
        file_session_id: &str,
        expected_host_id: &str,
    ) -> WorkspaceResult<()> {
        if LocalFileSessions::owns(file_session_id) {
            return if expected_host_id == "local" { Ok(()) } else { Err(WorkspaceError::new("file-session-host-mismatch", "The Files session belongs to the local computer.")) };
        }
        let session = self.get(file_session_id)?;
        if session.dto.host_id == expected_host_id {
            return Ok(());
        }
        Err(WorkspaceError::new(
            "file-session-host-mismatch",
            "The Files session belongs to a different SSH host.",
        ))
    }
    /// Revalidates a Files-owned path before it becomes a shell `cd` request.
    /// The WebView never supplies a command; it can only point at a directory
    /// that this host's existing SFTP session canonicalizes and lstat-checks.
    pub(crate) async fn validate_terminal_initial_directory(
        &self,
        file_session_id: &str,
        expected_host_id: &str,
        candidate_path: &str,
    ) -> WorkspaceResult<String> {
        if LocalFileSessions::owns(file_session_id) {
            return Err(WorkspaceError::new("terminal-directory-local", "A remote terminal cannot start in a local directory."));
        }
        let session = self.get(file_session_id)?;
        self.assert_host(file_session_id, expected_host_id)
            .map_err(|_| {
                WorkspaceError::new(
                    "terminal-directory-host-mismatch",
                    "The selected directory belongs to a different SSH host.",
                )
            })?;
        let canonical = canonicalize(&session, candidate_path).await?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let metadata = fs
            .symlink_metadata(&canonical)
            .await
            .map_err(sftp_error("terminal-directory-stale"))?;
        ensure_plain_directory(&metadata, "terminal-directory-unsafe")?;
        path_string(&canonical)
    }
    pub async fn start_search(
        &self,
        request: StartFileSearchRequest,
    ) -> WorkspaceResult<FileSearchStarted> {
        if LocalFileSessions::owns(&request.file_session_id) {
            return self.local.start_search(request).await;
        }
        let session = self.get(&request.file_session_id)?;
        let start = path_string(&canonicalize(&session, &request.path).await?)?;
        if request.query.trim().is_empty() {
            return Err(WorkspaceError::new(
                "empty-search-query",
                "Search query is required.",
            ));
        }
        let id = format!("search-{}", Uuid::new_v4());
        let cancel = CancellationToken::new();
        self.searches
            .lock()
            .map_err(lock_error)?
            .insert(id.clone(), cancel.clone());
        tokio::spawn(search_task(
            id.clone(),
            request.file_session_id,
            session,
            start,
            request.query,
            cancel,
            self.event_sink.clone(),
        ));
        Ok(FileSearchStarted { search_id: id })
    }
    pub fn cancel_search(&self, request: CancelFileSearchRequest) -> WorkspaceResult<()> {
        if request.search_id.starts_with("local-search-") {
            return self.local.cancel_search(request);
        }
        self.searches
            .lock()
            .map_err(lock_error)?
            .remove(&request.search_id)
            .ok_or_else(|| {
                WorkspaceError::new("search-not-found", "The search is no longer active.")
            })?
            .cancel();
        Ok(())
    }
    pub async fn entry(
        &self,
        file_session_id: &str,
        entry_ref: &str,
    ) -> WorkspaceResult<RemoteFileEntry> {
        if LocalFileSessions::owns(file_session_id) {
            return self.local.operation_stat(entry_ref).await;
        }
        self.resolve_entry(&self.get(file_session_id)?, entry_ref)
            .await
    }
    /// Directory creation is deliberately a separate operation: it does not
    /// accept an arbitrary remote path or reuse a destructive-operation token.
    pub async fn create_directory(
        &self,
        request: CreateDirectoryRequest,
    ) -> WorkspaceResult<RemoteFileEntry> {
        if LocalFileSessions::owns(&request.file_session_id) {
            return self.local.create_directory(request).await;
        }
        if !safe_child_name(&request.name) {
            return Err(WorkspaceError::new(
                "invalid-directory-name",
                "Directory names cannot contain separators, dot segments, or unsupported encoding.",
            ));
        }
        let session = self.get(&request.file_session_id)?;
        let parent = canonicalize(&session, &request.parent_path).await?;
        let parent_path = path_string(&parent)?;
        let child = remote_path::join(&parent_path, &request.name)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let parent_metadata = fs
            .symlink_metadata(&parent)
            .await
            .map_err(sftp_error("directory-parent-stale"))?;
        ensure_plain_directory(&parent_metadata, "directory-parent-unsafe")?;
        match fs.symlink_metadata(Path::new(&child)).await {
            Ok(_) => {
                return Err(WorkspaceError::new(
                    "destination-exists",
                    "A file already exists with this directory name.",
                ))
            }
            Err(_) => {}
        }
        fs.create_dir(Path::new(&child))
            .await
            .map_err(sftp_error("directory-create-failed"))?;
        let metadata = fs
            .symlink_metadata(Path::new(&child))
            .await
            .map_err(sftp_error("directory-create-stale"))?;
        ensure_plain_directory(&metadata, "directory-create-unsafe")?;
        entry_from_metadata(
            child,
            std::ffi::OsString::from(request.name),
            metadata,
            None,
        )
    }
    pub async fn copy_entry(&self, request: CopyFileEntryRequest) -> WorkspaceResult<RemoteFileEntry> {
        if LocalFileSessions::owns(&request.file_session_id) {
            return self.local.copy_entry(&request.source_entry_ref, &request.destination_path).await;
        }
        let session = self.get(&request.file_session_id)?;
        let source = self.resolve_entry(&session, &request.source_entry_ref).await?;
        if !matches!(source.kind, RemoteFileKind::File | RemoteFileKind::Directory) || !source.writable_name {
            return Err(WorkspaceError::new("copy-source-unsupported", "Remote copy requires a regular file or plain directory with a UTF-8 name."));
        }
        let name = remote_path::file_name(&request.destination_path)?;
        if !safe_child_name(name) {
            return Err(WorkspaceError::new("invalid-destination", "The copy destination name is invalid."));
        }
        let parent = remote_path::parent(&request.destination_path)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let canonical_parent = fs.canonicalize(Path::new(parent)).await.map_err(sftp_error("destination-parent-stale"))?;
        let parent_meta = fs.symlink_metadata(&canonical_parent).await.map_err(sftp_error("destination-parent-stale"))?;
        ensure_plain_directory(&parent_meta, "destination-parent-unsafe")?;
        let destination = remote_path::join(&path_string(&canonical_parent)?, name)?;
        if fs.symlink_metadata(Path::new(&destination)).await.is_ok() {
            return Err(WorkspaceError::new("destination-exists", "The copy destination already exists."));
        }
        if source.kind == RemoteFileKind::File {
            copy_remote_regular_file(&connection.sftp, &source.path, &destination).await?;
        } else {
            fs.create_dir(Path::new(&destination)).await.map_err(sftp_error("copy-destination-create-failed"))?;
            let mut stack = vec![(source.path.clone(), destination.clone())];
            while let Some((source_dir, destination_dir)) = stack.pop() {
                let directory = fs.open_dir(Path::new(&source_dir)).await.map_err(sftp_error("copy-source-open-failed"))?;
                let stream = directory.read_dir();
                tokio::pin!(stream);
                while let Some(item) = stream.as_mut().next().await {
                    let item = item.map_err(sftp_error("copy-source-read-failed"))?;
                    let name = item.filename().to_str().filter(|name| safe_child_name(name)).ok_or_else(|| WorkspaceError::new("unsupported-path-encoding", "A directory entry cannot be copied safely."))?;
                    let child_source = remote_path::join(&source_dir, name)?;
                    let child_destination = remote_path::join(&destination_dir, name)?;
                    match item.metadata().file_type() {
                        Some(kind) if kind.is_dir() => {
                            fs.create_dir(Path::new(&child_destination)).await.map_err(sftp_error("copy-destination-create-failed"))?;
                            stack.push((child_source, child_destination));
                        }
                        Some(kind) if kind.is_file() => copy_remote_regular_file(&connection.sftp, &child_source, &child_destination).await?,
                        _ => return Err(WorkspaceError::new("copy-source-unsupported", "Folders containing links or special files cannot be copied safely.")),
                    }
                }
            }
        }
        let metadata = fs.symlink_metadata(Path::new(&destination)).await.map_err(sftp_error("copy-destination-stale"))?;
        let entry = entry_from_metadata(destination, std::ffi::OsString::from(name), metadata, None)?;
        session.entries.write().await.insert(entry.entry_ref.clone(), entry.clone());
        Ok(entry)
    }
    pub(crate) fn operation_host_alias(&self, file_session_id: &str) -> WorkspaceResult<String> {
        if LocalFileSessions::owns(file_session_id) { return Ok(String::new()); }
        Ok(self.get(file_session_id)?.dto.host_alias.clone())
    }
    pub(crate) async fn operation_stat(
        &self,
        file_session_id: &str,
        entry_ref: &str,
    ) -> WorkspaceResult<RemoteFileEntry> {
        if LocalFileSessions::owns(file_session_id) {
            return self.local.operation_stat(entry_ref).await;
        }
        let session = self.get(file_session_id)?;
        let entry = self.resolve_entry(&session, entry_ref).await?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let metadata = fs
            .symlink_metadata(Path::new(&entry.path))
            .await
            .map_err(sftp_error("stale-entry-ref"))?;
        let fresh = entry_from_metadata(
            entry.path.clone(),
            std::ffi::OsString::from(&entry.name),
            metadata,
            None,
        )?;
        if fresh.fingerprint != entry.fingerprint {
            return Err(WorkspaceError::new(
                "stale-preview",
                "The file changed after it was previewed.",
            ));
        }
        Ok(entry)
    }
    /// Creates a fresh opaque reference for an internal staging file.  The
    /// pathname is generated by the backend, never accepted from the webview.
    pub(crate) async fn operation_internal_entry(
        &self,
        file_session_id: &str,
        path: &str,
    ) -> WorkspaceResult<RemoteFileEntry> {
        if LocalFileSessions::owns(file_session_id) {
            return self.local.operation_internal_entry(path).await;
        }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let metadata = fs
            .symlink_metadata(Path::new(path))
            .await
            .map_err(sftp_error("staging-stat-failed"))?;
        let name = std::ffi::OsString::from(remote_path::file_name(path)?);
        let entry = entry_from_metadata(path.to_string(), name, metadata, None)?;
        session
            .entries
            .write()
            .await
            .insert(entry.entry_ref.clone(), entry.clone());
        Ok(entry)
    }
    /// Resolves the parent first, then lstat's the final path without
    /// following it.  Overwrite accepts regular files only, never a symlink,
    /// directory, or device boundary.
    pub(crate) async fn operation_snapshot_overwrite_destination(
        &self,
        file_session_id: &str,
        path: &str,
    ) -> WorkspaceResult<OperationPathSnapshot> {
        if LocalFileSessions::owns(file_session_id) {
            return self.local.operation_snapshot_overwrite_destination(path).await;
        }
        let name = remote_path::file_name(path)?;
        if !safe_child_name(name) {
            return Err(WorkspaceError::new(
                "invalid-destination",
                "Overwrite destination has no safe file name.",
            ));
        }
        let parent = remote_path::parent(path)?;
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let canonical_parent = fs
            .canonicalize(Path::new(parent))
            .await
            .map_err(sftp_error("destination-parent-stale"))?;
        let parent_metadata = fs
            .symlink_metadata(&canonical_parent)
            .await
            .map_err(sftp_error("destination-parent-stale"))?;
        ensure_plain_directory(&parent_metadata, "destination-parent-unsafe")?;
        let canonical_parent = path_string(&canonical_parent)?;
        let destination = remote_path::join(&canonical_parent, name)?;
        let metadata = fs
            .symlink_metadata(Path::new(&destination))
            .await
            .map_err(sftp_error("destination-missing"))?;
        match metadata.file_type() {
            Some(kind) if kind.is_file() => {}
            _ => {
                return Err(WorkspaceError::new(
                    "unsafe-overwrite-destination",
                    "Workspace overwrites only regular, non-symlink files.",
                ))
            }
        }
        let entry = entry_from_metadata(
            destination.clone(),
            std::ffi::OsString::from(name),
            metadata,
            None,
        )?;
        Ok(OperationPathSnapshot {
            path: destination,
            fingerprint: entry.fingerprint,
        })
    }
    pub(crate) async fn operation_exists(
        &self,
        file_session_id: &str,
        path: &str,
    ) -> WorkspaceResult<bool> {
        if LocalFileSessions::owns(file_session_id) { return self.local.operation_exists(path).await; }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        match fs.symlink_metadata(Path::new(path)).await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }
    pub(crate) async fn operation_mkdir(
        &self,
        file_session_id: &str,
        path: &str,
    ) -> WorkspaceResult<()> {
        if LocalFileSessions::owns(file_session_id) { return self.local.operation_mkdir(path).await; }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        fs.create_dir(Path::new(path))
            .await
            .map_err(sftp_error("backup-create-failed"))
    }
    /// Creates and verifies the per-operation recovery directory under the
    /// source parent. Every component is lstat'ed, so an existing symlink is
    /// never accepted as a backup root.
    pub(crate) async fn operation_create_recovery_dir(
        &self,
        file_session_id: &str,
        path: &str,
    ) -> WorkspaceResult<()> {
        if LocalFileSessions::owns(file_session_id) { return self.local.operation_create_recovery_dir(path).await; }
        let recovery = path;
        let backup_root = remote_path::parent(recovery)?;
        let parent = remote_path::parent(backup_root)?;
        if !remote_path::file_name(recovery)?.starts_with("recovery-")
            || remote_path::file_name(backup_root)? != ".codexhub-workspace-backups"
        {
            return Err(WorkspaceError::new(
                "unsafe-recovery-path",
                "Recovery path is outside the Workspace backup root.",
            ));
        }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let parent_metadata = fs
            .symlink_metadata(Path::new(parent))
            .await
            .map_err(sftp_error("backup-parent-stale"))?;
        ensure_plain_directory(&parent_metadata, "backup-parent-unsafe")?;
        match fs.symlink_metadata(Path::new(backup_root)).await {
            Ok(metadata) => ensure_plain_directory(&metadata, "backup-root-unsafe")?,
            Err(_) => {
                fs.create_dir(Path::new(backup_root))
                    .await
                    .map_err(sftp_error("backup-create-failed"))?;
                let metadata = fs
                    .symlink_metadata(Path::new(backup_root))
                    .await
                    .map_err(sftp_error("backup-create-stale"))?;
                ensure_plain_directory(&metadata, "backup-root-unsafe")?;
                fs.set_permissions(Path::new(backup_root), owner_only_permissions())
                    .await
                    .map_err(sftp_error("backup-permissions-failed"))?;
            }
        }
        fs.set_permissions(Path::new(backup_root), owner_only_permissions())
            .await
            .map_err(sftp_error("backup-permissions-failed"))?;
        // A recovery id must be unique.  Never reuse an existing directory.
        if fs.symlink_metadata(Path::new(recovery)).await.is_ok() {
            return Err(WorkspaceError::new(
                "recovery-already-exists",
                "Recovery path already exists; prepare the operation again.",
            ));
        }
        fs.create_dir(Path::new(recovery))
            .await
            .map_err(sftp_error("backup-create-failed"))?;
        let metadata = fs
            .symlink_metadata(Path::new(recovery))
            .await
            .map_err(sftp_error("backup-create-stale"))?;
        ensure_plain_directory(&metadata, "backup-root-unsafe")?;
        fs.set_permissions(Path::new(recovery), owner_only_permissions())
            .await
            .map_err(sftp_error("backup-permissions-failed"))?;
        Ok(())
    }
    pub(crate) async fn operation_rename(
        &self,
        file_session_id: &str,
        from: &str,
        to: &str,
    ) -> WorkspaceResult<()> {
        if LocalFileSessions::owns(file_session_id) { return self.local.operation_rename(from, to).await; }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        fs.rename(Path::new(from), Path::new(to))
            .await
            .map_err(sftp_error("remote-rename-failed"))
    }
    /// SFTP has no portable atomic no-replace rename.  Verify the parent and
    /// destination immediately before writing and refuse symlink boundaries.
    pub(crate) async fn operation_rename_no_replace(
        &self,
        file_session_id: &str,
        from: &str,
        to: &str,
    ) -> WorkspaceResult<()> {
        if LocalFileSessions::owns(file_session_id) { return self.local.operation_rename_no_replace(from, to).await; }
        let session = self.get(file_session_id)?;
        let parent = remote_path::parent(to)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let parent_metadata = fs
            .symlink_metadata(Path::new(parent))
            .await
            .map_err(sftp_error("destination-parent-stale"))?;
        ensure_plain_directory(&parent_metadata, "destination-parent-unsafe")?;
        let source = fs
            .symlink_metadata(Path::new(from))
            .await
            .map_err(sftp_error("source-stale"))?;
        if !source.file_type().is_some_and(|kind| kind.is_file()) {
            return Err(WorkspaceError::new(
                "safe-no-replace-unsupported",
                "Workspace can only perform race-safe recovery moves for regular files on this SFTP server.",
            ));
        }
        if !connection.sftp.support_hardlink() {
            return Err(WorkspaceError::new(
                "safe-no-replace-unsupported",
                "This SFTP server does not support the hard-link extension required for a safe no-replace move.",
            ));
        }
        // `hardlink@openssh.com` maps to the remote create-if-absent link
        // operation. It closes the lstat-to-rename overwrite race for regular
        // files; removing the old name happens only after the new link exists.
        fs.hard_link(Path::new(from), Path::new(to))
            .await
            .map_err(sftp_error("destination-create-failed"))?;
        fs.remove_file(Path::new(from))
            .await
            .map_err(sftp_error("source-remove-failed"))
    }
    /// Deletes only a previously prepared recovery directory. Symlinks are
    /// unlinked as entries and never traversed, preventing recursive escape.
    pub(crate) async fn operation_purge_recovery(
        &self,
        file_session_id: &str,
        root: &str,
        recovery_id: &str,
    ) -> WorkspaceResult<()> {
        if LocalFileSessions::owns(file_session_id) { return self.local.operation_purge_recovery(root, recovery_id).await; }
        let backup_root = remote_path::parent(root)?;
        let target_parent = remote_path::parent(backup_root)?;
        if !is_managed_recovery_root(root, recovery_id) {
            return Err(WorkspaceError::new(
                "unsafe-recovery-path",
                "Only a prepared Workspace recovery directory may be purged.",
            ));
        }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let parent_metadata = fs
            .symlink_metadata(Path::new(target_parent))
            .await
            .map_err(sftp_error("recovery-purge-stale"))?;
        let backup_root_metadata = fs
            .symlink_metadata(Path::new(backup_root))
            .await
            .map_err(sftp_error("recovery-purge-stale"))?;
        let root_metadata = fs
            .symlink_metadata(Path::new(root))
            .await
            .map_err(sftp_error("recovery-purge-stale"))?;
        ensure_plain_directory(&parent_metadata, "recovery-purge-unsafe")?;
        ensure_plain_directory(&backup_root_metadata, "recovery-purge-unsafe")?;
        ensure_plain_directory(&root_metadata, "recovery-purge-unsafe")?;
        let mut stack = vec![(root.to_string(), false)];
        while let Some((path, visited)) = stack.pop() {
            let metadata = fs
                .symlink_metadata(Path::new(&path))
                .await
                .map_err(sftp_error("recovery-purge-stale"))?;
            let is_dir = metadata.file_type().is_some_and(|kind| kind.is_dir());
            if !is_dir {
                fs.remove_file(Path::new(&path))
                    .await
                    .map_err(sftp_error("recovery-purge-failed"))?;
                continue;
            }
            if visited {
                fs.remove_dir(Path::new(&path))
                    .await
                    .map_err(sftp_error("recovery-purge-failed"))?;
                continue;
            }
            stack.push((path.clone(), true));
            let dir = fs
                .open_dir(Path::new(&path))
                .await
                .map_err(sftp_error("recovery-purge-failed"))?;
            let stream = dir.read_dir();
            tokio::pin!(stream);
            while let Some(item) = stream.as_mut().next().await {
                let item = item.map_err(sftp_error("recovery-purge-failed"))?;
                let name = item.filename();
                if is_dot_directory_entry(name.as_os_str()) {
                    continue;
                }
                let name = name.to_str().ok_or_else(|| {
                    WorkspaceError::new(
                        "unsupported-path-encoding",
                        "This remote path is not valid UTF-8 and cannot be purged.",
                    )
                })?;
                stack.push((remote_path::join(&path, name)?, false));
            }
        }
        Ok(())
    }
    /// Streams a local file to an already selected remote staging path.  The
    /// opaque local grant is resolved by the transfer worker, never here from
    /// a webview supplied pathname.
    pub(crate) async fn transfer_upload(
        &self,
        file_session_id: &str,
        local_path: &Path,
        remote_staging: &str,
        offset: u64,
        cancel: &CancellationToken,
        progress: &mut (dyn FnMut(u64) -> WorkspaceResult<()> + Send),
    ) -> WorkspaceResult<TransferStreamStop> {
        if LocalFileSessions::owns(file_session_id) {
            return self.local.transfer_upload(local_path, remote_staging, offset, cancel, progress).await;
        }
        let session = self.get(file_session_id)?;
        let local_meta = tokio::fs::metadata(local_path)
            .await
            .map_err(|e| WorkspaceError::new("local-source-unavailable", e.to_string()))?;
        if !local_meta.is_file() || offset > local_meta.len() {
            return Err(WorkspaceError::new(
                "invalid-resume-offset",
                "The local source cannot resume at the requested offset.",
            ));
        }
        let mut local = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| WorkspaceError::new("local-source-unavailable", e.to_string()))?;
        local
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(|e| WorkspaceError::new("local-source-unavailable", e.to_string()))?;
        let connection = session.connection.lock().await;
        let mut options = connection.sftp.options();
        options.write(true).create(true).truncate(offset == 0);
        let mut remote = options
            .open(Path::new(remote_staging))
            .await
            .map_err(sftp_error("transfer-staging-open-failed"))?;
        if offset > 0 {
            remote
                .seek(SeekFrom::Start(offset))
                .await
                .map_err(|e| WorkspaceError::new("transfer-resume-seek-failed", e.to_string()))?;
        }
        let mut copied = offset;
        let mut buffer = vec![0u8; TRANSFER_CHUNK_BYTES];
        loop {
            if cancel.is_cancelled() {
                return Ok(TransferStreamStop::Cancelled);
            }
            let read = local
                .read(&mut buffer)
                .await
                .map_err(|e| WorkspaceError::new("local-source-read-failed", e.to_string()))?;
            if read == 0 {
                break;
            }
            remote
                .write_all(&buffer[..read])
                .await
                .map_err(sftp_error("transfer-write-failed"))?;
            copied = copied.saturating_add(read as u64);
            progress(copied)?;
        }
        // OpenSSH's fsync extension is required before an upload can commit.
        remote
            .sync_all()
            .await
            .map_err(sftp_error("sftp-fsync-required"))?;
        remote
            .close()
            .await
            .map_err(sftp_error("transfer-close-failed"))?;
        Ok(TransferStreamStop::Complete)
    }
    /// Streams a remote regular file to a local partial path.  The caller has
    /// already verified the grant and destination parent directory.
    pub(crate) async fn transfer_download(
        &self,
        file_session_id: &str,
        remote_source: &str,
        local_partial: &Path,
        offset: u64,
        cancel: &CancellationToken,
        progress: &mut (dyn FnMut(u64) -> WorkspaceResult<()> + Send),
    ) -> WorkspaceResult<TransferStreamStop> {
        if LocalFileSessions::owns(file_session_id) {
            return self.local.transfer_download(remote_source, local_partial, offset, cancel, progress).await;
        }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let remote_meta = fs
            .metadata(Path::new(remote_source))
            .await
            .map_err(sftp_error("remote-source-stat-failed"))?;
        let remote_len = remote_meta.len().ok_or_else(|| {
            WorkspaceError::new(
                "remote-size-unknown",
                "Remote source does not provide a size.",
            )
        })?;
        if offset > remote_len {
            return Err(WorkspaceError::new(
                "invalid-resume-offset",
                "The remote source is shorter than the saved partial file.",
            ));
        }
        let mut remote = connection
            .sftp
            .open(Path::new(remote_source))
            .await
            .map_err(sftp_error("remote-source-open-failed"))?;
        remote
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(|e| WorkspaceError::new("transfer-resume-seek-failed", e.to_string()))?;
        let mut local_options = tokio::fs::OpenOptions::new();
        local_options.create(true).write(true);
        let mut local = local_options
            .open(local_partial)
            .await
            .map_err(|e| WorkspaceError::new("local-partial-open-failed", e.to_string()))?;
        local
            .set_len(offset)
            .await
            .map_err(|e| WorkspaceError::new("local-partial-truncate-failed", e.to_string()))?;
        local
            .seek(SeekFrom::Start(offset))
            .await
            .map_err(|e| WorkspaceError::new("local-partial-seek-failed", e.to_string()))?;
        let mut copied = offset;
        loop {
            if cancel.is_cancelled() {
                local
                    .sync_all()
                    .await
                    .map_err(|e| WorkspaceError::new("local-partial-sync-failed", e.to_string()))?;
                return Ok(TransferStreamStop::Cancelled);
            }
            let Some(bytes) = remote
                .read(TRANSFER_CHUNK_BYTES as u32, Default::default())
                .await
                .map_err(sftp_error("transfer-read-failed"))?
            else {
                break;
            };
            local
                .write_all(&bytes)
                .await
                .map_err(|e| WorkspaceError::new("local-partial-write-failed", e.to_string()))?;
            copied = copied.saturating_add(bytes.len() as u64);
            progress(copied)?;
        }
        local
            .sync_all()
            .await
            .map_err(|e| WorkspaceError::new("local-partial-sync-failed", e.to_string()))?;
        Ok(TransferStreamStop::Complete)
    }
    pub(crate) async fn transfer_fingerprint(
        &self,
        file_session_id: &str,
        path: &str,
    ) -> WorkspaceResult<TransferFingerprint> {
        if LocalFileSessions::owns(file_session_id) { return self.local.transfer_fingerprint(path).await; }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let meta = fs
            .metadata(Path::new(path))
            .await
            .map_err(sftp_error("transfer-stat-failed"))?;
        Ok(TransferFingerprint {
            size: meta.len().ok_or_else(|| {
                WorkspaceError::new(
                    "remote-size-unknown",
                    "Remote source does not provide a size.",
                )
            })?,
            modified: meta.modified().map(|value| value.into_raw().to_string()),
        })
    }
    pub(crate) async fn transfer_sha256(
        &self,
        file_session_id: &str,
        path: &str,
    ) -> WorkspaceResult<String> {
        if LocalFileSessions::owns(file_session_id) { return self.local.transfer_sha256(path).await; }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut remote = connection
            .sftp
            .open(Path::new(path))
            .await
            .map_err(sftp_error("transfer-verify-open-failed"))?;
        let mut hash = Sha256::new();
        while let Some(bytes) = remote
            .read(TRANSFER_CHUNK_BYTES as u32, Default::default())
            .await
            .map_err(sftp_error("transfer-verify-read-failed"))?
        {
            hash.update(&bytes);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    /// Hashes exactly one remote prefix for resume validation. The caller
    /// compares it with a local prefix before allowing an offset seek.
    pub(crate) async fn transfer_prefix_sha256(
        &self,
        file_session_id: &str,
        path: &str,
        length: u64,
    ) -> WorkspaceResult<String> {
        if LocalFileSessions::owns(file_session_id) { return self.local.transfer_prefix_sha256(path, length).await; }
        let session = self.get(file_session_id)?;
        let connection = session.connection.lock().await;
        let mut remote = connection
            .sftp
            .open(Path::new(path))
            .await
            .map_err(sftp_error("transfer-prefix-open-failed"))?;
        let mut remaining = length;
        let mut hash = Sha256::new();
        while remaining > 0 {
            let request = remaining.min(TRANSFER_CHUNK_BYTES as u64) as u32;
            let Some(bytes) = remote
                .read(request, Default::default())
                .await
                .map_err(sftp_error("transfer-prefix-read-failed"))?
            else {
                return Err(WorkspaceError::new(
                    "transfer-prefix-short",
                    "The transfer partial is shorter than its saved offset.",
                ));
            };
            if bytes.is_empty() || bytes.len() as u64 > remaining {
                return Err(WorkspaceError::new(
                    "transfer-prefix-short",
                    "The transfer partial could not be verified at its saved offset.",
                ));
            }
            remaining = remaining.saturating_sub(bytes.len() as u64);
            hash.update(&bytes);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    /// Returns the stable saved-host identity for a live SFTP handle. Recovery
    /// records persist this identity rather than this ephemeral session id.
    pub(crate) fn operation_host_id(&self, file_session_id: &str) -> WorkspaceResult<String> {
        if LocalFileSessions::owns(file_session_id) { return Ok("local".into()); }
        Ok(self.get(file_session_id)?.dto.host_id.clone())
    }

    pub(crate) fn operation_host_identity(
        &self,
        file_session_id: &str,
    ) -> WorkspaceResult<(String, String)> {
        if LocalFileSessions::owns(file_session_id) { return Ok(("local".into(), "Local files".into())); }
        let session = self.get(file_session_id)?;
        Ok((session.dto.host_id.clone(), session.dto.host_name.clone()))
    }
    fn get(&self, id: &str) -> WorkspaceResult<Arc<FileSession>> {
        self.values
            .lock()
            .map_err(lock_error)?
            .get(id)
            .cloned()
            .ok_or_else(|| {
                WorkspaceError::new(
                    "file-session-not-found",
                    "The file session no longer exists.",
                )
            })
    }
    async fn resolve_entry(
        &self,
        session: &Arc<FileSession>,
        entry_ref: &str,
    ) -> WorkspaceResult<RemoteFileEntry> {
        session
            .entries
            .read()
            .await
            .get(entry_ref)
            .cloned()
            .ok_or_else(|| {
                WorkspaceError::new(
                    "stale-entry-ref",
                    "Refresh the directory before changing this file.",
                )
            })
    }
}

async fn close_session(session: Arc<FileSession>) -> WorkspaceResult<()> {
    let mut connection = session.connection.lock().await;
    // Sftp owns background protocol tasks; terminate and reap the subsystem
    // child instead of leaving a zombie after a tab/app lifecycle transition.
    stop_sftp_child(&mut connection.child).await;
    Ok(())
}

async fn stop_sftp_child(child: &mut Child) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn copy_remote_regular_file(sftp: &Sftp, source: &str, destination: &str) -> WorkspaceResult<()> {
    let mut input = sftp.open(Path::new(source)).await.map_err(sftp_error("copy-source-open-failed"))?;
    let mut options = sftp.options();
    options.create_new(true).write(true);
    let mut output = options.open(Path::new(destination)).await.map_err(sftp_error("copy-destination-open-failed"))?;
    while let Some(bytes) = input.read(TRANSFER_CHUNK_BYTES as u32, Default::default()).await.map_err(sftp_error("copy-source-read-failed"))? {
        output.write_all(&bytes).await.map_err(sftp_error("copy-destination-write-failed"))?;
    }
    output.sync_all().await.map_err(sftp_error("sftp-fsync-required"))?;
    output.close().await.map_err(sftp_error("copy-destination-close-failed"))
}

async fn connect_sftp(alias: &str) -> WorkspaceResult<ConnectedSftp> {
    let mut command = Command::new("ssh");
    configure_tokio_command(&mut command);
    command
        .args(["-T", "-s", alias, "sftp"])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = command
        .spawn()
        .map_err(|error| WorkspaceError::retryable("sftp-start-failed", error.to_string()))?;
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            stop_sftp_child(&mut child).await;
            return Err(WorkspaceError::new(
                "sftp-stdin-unavailable",
                "SFTP stdin is unavailable.",
            ));
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            stop_sftp_child(&mut child).await;
            return Err(WorkspaceError::new(
                "sftp-stdout-unavailable",
                "SFTP stdout is unavailable.",
            ));
        }
    };
    let sftp = match Sftp::new(stdin, stdout, SftpOptions::default()).await {
        Ok(sftp) => sftp,
        Err(error) => {
            stop_sftp_child(&mut child).await;
            return Err(WorkspaceError::retryable(
                "sftp-connect-failed",
                error.to_string(),
            ));
        }
    };
    Ok(ConnectedSftp { child, sftp })
}
async fn canonicalize(session: &Arc<FileSession>, path: &str) -> WorkspaceResult<PathBuf> {
    let connection = session.connection.lock().await;
    let mut fs = connection.sftp.fs();
    fs.canonicalize(Path::new(path))
        .await
        .map_err(sftp_error("invalid-remote-path"))
}
async fn search_task(
    search_id: String,
    file_session_id: String,
    session: Arc<FileSession>,
    start: String,
    query: String,
    cancel: CancellationToken,
    sink: Option<WorkspaceEventSink>,
) {
    let mut revision = 0u64;
    emit(
        sink.as_ref(),
        FILE_SEARCH_UPDATED_EVENT,
        &FileSearchUpdatedEvent {
            search_id: search_id.clone(),
            file_session_id: file_session_id.clone(),
            revision: next_search_revision(&mut revision),
            state: FileSearchState::Running,
            entries: Vec::new(),
            scanned: 0,
            truncated: false,
            error_code: None,
        },
    );
    let mut queue = VecDeque::from([start]);
    let mut scanned = 0u32;
    let mut results = Vec::new();
    let query = query.to_lowercase();
    let mut truncated = false;
    let mut error_code = None;
    let deadline = Instant::now() + MAX_SEARCH_DURATION;
    'walk: while let Some(path) = queue.pop_front() {
        if Instant::now() >= deadline {
            truncated = true;
            error_code = Some("search-time-limit".into());
            break;
        }
        if cancel.is_cancelled() {
            break;
        }
        let connection = session.connection.lock().await;
        let mut fs = connection.sftp.fs();
        let dir = match fs.open_dir(Path::new(&path)).await {
            Ok(v) => v,
            Err(_) => {
                error_code = Some("search-directory-read-failed".into());
                break;
            }
        };
        let stream = dir.read_dir();
        tokio::pin!(stream);
        while let Some(next) = stream.as_mut().next().await {
            if Instant::now() >= deadline {
                truncated = true;
                error_code = Some("search-time-limit".into());
                break 'walk;
            }
            if cancel.is_cancelled() {
                break;
            }
            let entry = match next {
                Ok(v) => v,
                Err(_) => continue,
            };
            let name = entry.filename().as_os_str().to_os_string();
            if is_dot_directory_entry(&name) {
                continue;
            }
            scanned = scanned.saturating_add(1);
            let Some(name_text) = name.to_str() else {
                continue;
            };
            let child_path = match remote_path::join(&path, name_text) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let item = match entry_from_metadata(child_path.clone(), name, entry.metadata(), None) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if item.kind == RemoteFileKind::Directory {
                queue.push_back(child_path);
            } // Never follow symlinks.
            if item.name.to_lowercase().contains(&query) {
                results.push(item);
                if results.len() >= MAX_SEARCH_RESULTS {
                    truncated = true;
                    break;
                }
            }
        }
        drop(connection);
        if results.len() >= 100 || truncated {
            let mut refs = session.entries.write().await;
            for entry in &results {
                refs.insert(entry.entry_ref.clone(), entry.clone());
            }
            emit(
                sink.as_ref(),
                FILE_SEARCH_UPDATED_EVENT,
                &FileSearchUpdatedEvent {
                    search_id: search_id.clone(),
                    file_session_id: file_session_id.clone(),
                    revision: next_search_revision(&mut revision),
                    state: FileSearchState::Running,
                    entries: std::mem::take(&mut results),
                    scanned,
                    truncated,
                    error_code: None,
                },
            );
        }
        if truncated {
            break;
        }
    }
    if !results.is_empty() {
        let mut refs = session.entries.write().await;
        for entry in &results {
            refs.insert(entry.entry_ref.clone(), entry.clone());
        }
    }
    emit(
        sink.as_ref(),
        FILE_SEARCH_UPDATED_EVENT,
        &FileSearchUpdatedEvent {
            search_id,
            file_session_id,
            revision: next_search_revision(&mut revision),
            state: if cancel.is_cancelled() {
                FileSearchState::Cancelled
            } else if error_code.is_some() {
                FileSearchState::Failed
            } else {
                FileSearchState::Completed
            },
            entries: results,
            scanned,
            truncated,
            error_code,
        },
    );
}
fn next_search_revision(revision: &mut u64) -> u64 {
    *revision = revision.saturating_add(1);
    *revision
}
fn entry_from_metadata(
    path: String,
    name: std::ffi::OsString,
    metadata: MetaData,
    symlink_target: Option<String>,
) -> WorkspaceResult<RemoteFileEntry> {
    let writable_name = name.to_str().is_some();
    let name = name
        .into_string()
        .unwrap_or_else(|raw| format!("[unsupported filename encoding: {} bytes]", raw.len()));
    let kind = match metadata.file_type() {
        Some(kind) if kind.is_file() => RemoteFileKind::File,
        Some(kind) if kind.is_dir() => RemoteFileKind::Directory,
        Some(kind) if kind.is_symlink() => RemoteFileKind::Symlink,
        Some(kind) if kind.is_fifo() => RemoteFileKind::Fifo,
        Some(kind) if kind.is_socket() => RemoteFileKind::Socket,
        Some(kind) if kind.is_block_device() => RemoteFileKind::BlockDevice,
        _ => RemoteFileKind::Unknown,
    };
    let modified_raw = metadata.modified().map(|time| time.into_raw());
    let modified_at = modified_raw.and_then(format_remote_modified_at);
    let fingerprint = remote_entry_fingerprint(metadata.len().unwrap_or(0), modified_raw, kind);
    Ok(RemoteFileEntry {
        entry_ref: format!("entry-{}", Uuid::new_v4()),
        path,
        name,
        kind,
        size: metadata.len().map(|x| x.to_string()),
        modified_at,
        permissions: metadata
            .permissions()
            .map(|p| format!("{:o}", p.as_raw().bits())),
        uid: metadata.uid(),
        gid: metadata.gid(),
        symlink_target,
        fingerprint,
        writable_name,
    })
}

fn format_remote_modified_at(seconds: u32) -> Option<String> {
    DateTime::<Utc>::from_timestamp(i64::from(seconds), 0)
        .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn remote_entry_fingerprint(size: u64, modified_raw: Option<u32>, kind: RemoteFileKind) -> String {
    let modified = modified_raw
        .map(|value| value.to_string())
        .unwrap_or_else(|| "?".into());
    format!("{size}:{modified}:{kind:?}")
}
fn sort_entries(entries: &mut [RemoteFileEntry], field: FileSortField, direction: SortDirection) {
    entries.sort_by(|a, b| {
        let folders = (a.kind == RemoteFileKind::Directory)
            .cmp(&(b.kind == RemoteFileKind::Directory))
            .reverse();
        if folders != std::cmp::Ordering::Equal {
            return folders;
        }
        let order = match field {
            FileSortField::Name => a.name.cmp(&b.name),
            FileSortField::Type => format!("{:?}", a.kind).cmp(&format!("{:?}", b.kind)),
            FileSortField::Size => a.size.cmp(&b.size),
            FileSortField::Modified => a.modified_at.cmp(&b.modified_at),
        };
        if matches!(direction, SortDirection::Desc) {
            order.reverse()
        } else {
            order
        }
    });
}
fn path_string(path: &Path) -> WorkspaceResult<String> {
    path.to_str().map(str::to_owned).ok_or_else(|| {
        WorkspaceError::new(
            "unsupported-path-encoding",
            "This remote path is not valid UTF-8 and is read-only.",
        )
    })
}
fn safe_child_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

/// SFTP may return self and parent entries; never turn them into child paths.
fn is_dot_directory_entry(name: &OsStr) -> bool {
    name == OsStr::new(".") || name == OsStr::new("..")
}

fn ensure_plain_directory(metadata: &MetaData, code: &'static str) -> WorkspaceResult<()> {
    match metadata.file_type() {
        Some(kind) if kind.is_dir() && !kind.is_symlink() => Ok(()),
        _ => Err(WorkspaceError::new(
            code,
            "Workspace refuses to use a symlink or non-directory as a safety boundary.",
        )),
    }
}
fn owner_only_permissions() -> Permissions {
    let mut permissions = Permissions::new();
    permissions
        .set_read_by_owner(true)
        .set_write_by_owner(true)
        .set_execute_by_owner(true);
    permissions
}
pub(crate) fn is_prohibited_path(path: &str) -> bool {
    path.contains("/.ssh/")
        || path.ends_with("/.ssh")
        || path.contains("credential")
        || path.ends_with("/.codex-hub/env")
}
fn mime_for(name: &str) -> String {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "html" | "htm" => "text/html",
        _ => "text/plain",
    }
    .into()
}
fn is_image(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}
fn sftp_error(code: &'static str) -> impl FnOnce(openssh_sftp_client::Error) -> WorkspaceError {
    move |error| {
        let message = error.to_string();
        if is_network_sftp_error(&message) {
            WorkspaceError::retryable(code, message)
        } else {
            WorkspaceError::new(code, message)
        }
    }
}

fn is_network_sftp_error(message: &str) -> bool {
    let normalized = message.to_ascii_lowercase();
    [
        "broken pipe",
        "connection reset",
        "connection aborted",
        "connection closed",
        "connection lost",
        "network is unreachable",
        "no route to host",
        "timed out",
        "timeout",
        "unexpected eof",
        "channel closed",
    ]
    .iter()
    .any(|marker| normalized.contains(marker))
}

fn is_managed_recovery_root(root: &str, recovery_id: &str) -> bool {
    // Remote paths remain POSIX paths even when the desktop app runs on
    // Windows. Validate strings directly; `Path::is_absolute` rejects `/srv`
    // on Windows and would block an otherwise safe recovery purge.
    if !root.starts_with('/')
        || root.contains(['\\', '\0'])
        || !recovery_id.starts_with("recovery-")
        || recovery_id.contains(['/', '\\', '\0'])
    {
        return false;
    }
    let parts = root
        .strip_prefix('/')
        .unwrap_or_default()
        .split('/')
        .collect::<Vec<_>>();
    parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && *part != "." && *part != "..")
        && parts[parts.len() - 2] == ".codexhub-workspace-backups"
        && parts[parts.len() - 1] == recovery_id
}
fn lock_error<T>(_: std::sync::PoisonError<T>) -> WorkspaceError {
    WorkspaceError::new(
        "workspace-lock-poisoned",
        "Workspace file state is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::{
        format_remote_modified_at, is_dot_directory_entry, is_managed_recovery_root,
        remote_entry_fingerprint,
    };
    use crate::workspace::types::RemoteFileKind;
    use std::ffi::OsStr;

    #[test]
    fn dot_directory_entries_are_never_used_as_child_paths() {
        assert!(is_dot_directory_entry(OsStr::new(".")));
        assert!(is_dot_directory_entry(OsStr::new("..")));
        assert!(!is_dot_directory_entry(OsStr::new(".config")));
        assert!(!is_dot_directory_entry(OsStr::new("workspace")));
    }

    #[test]
    fn remote_modified_time_is_rfc3339_but_fingerprint_keeps_unix_seconds() {
        let seconds = 1_720_000_000;
        assert_eq!(
            format_remote_modified_at(seconds).as_deref(),
            Some("2024-07-03T09:46:40Z")
        );
        assert_eq!(
            remote_entry_fingerprint(42, Some(seconds), RemoteFileKind::File),
            "42:1720000000:File"
        );
    }

    #[test]
    fn recovery_purge_root_requires_exact_managed_boundary() {
        let recovery_id = "recovery-7a1a";
        assert!(is_managed_recovery_root(
            "/srv/work/.codexhub-workspace-backups/recovery-7a1a",
            recovery_id,
        ));
        for path in [
            "/srv/work/.codexhub-workspace-backups/recovery-other",
            "/srv/work/.codexhub-workspace-backups/recovery-7a1a/../payload",
            "/srv/work/not-workspace-backups/recovery-7a1a",
            "relative/.codexhub-workspace-backups/recovery-7a1a",
        ] {
            assert!(
                !is_managed_recovery_root(path, recovery_id),
                "{path} must not be purgeable"
            );
        }
    }
}
