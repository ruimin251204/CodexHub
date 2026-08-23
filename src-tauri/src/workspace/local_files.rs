//! Local filesystem implementation for Workspace Files. Paths never leave
//! Rust as durable authority: mutations still require fresh opaque entry refs.

use super::error::{WorkspaceError, WorkspaceResult};
use super::events::{
    emit, FileSearchState, FileSearchUpdatedEvent, WorkspaceEventSink, FILE_SEARCH_UPDATED_EVENT,
};
use super::files::{OperationPathSnapshot, TransferFingerprint, TransferStreamStop};
use super::types::*;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, SecondsFormat, Utc};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::SeekFrom;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::RwLock;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const LOCAL_SESSION_ID: &str = "local-files";
const PAGE_SIZE: usize = 500;
const MAX_ENTRIES: usize = 50_000;
const MAX_SEARCH_RESULTS: usize = 10_000;
const TEXT_PREVIEW_LIMIT: u64 = 1024 * 1024;
const IMAGE_PREVIEW_LIMIT: u64 = 10 * 1024 * 1024;
const COPY_CHUNK_BYTES: usize = 128 * 1024;

#[derive(Clone)]
struct Snapshot {
    path: String,
    entries: Vec<RemoteFileEntry>,
    truncated: bool,
}

pub(crate) struct LocalFileSessions {
    entries: Arc<RwLock<HashMap<String, RemoteFileEntry>>>,
    snapshots: Mutex<HashMap<String, Snapshot>>,
    searches: Mutex<HashMap<String, CancellationToken>>,
    event_sink: Option<WorkspaceEventSink>,
}

impl LocalFileSessions {
    pub(crate) fn new(event_sink: Option<WorkspaceEventSink>) -> Self {
        Self {
            entries: Arc::new(RwLock::new(HashMap::new())),
            snapshots: Mutex::new(HashMap::new()),
            searches: Mutex::new(HashMap::new()),
            event_sink,
        }
    }

    pub(crate) fn owns(id: &str) -> bool {
        id == LOCAL_SESSION_ID
    }

    pub(crate) fn roots(&self) -> WorkspaceResult<Vec<String>> {
        available_local_roots()
    }

    pub(crate) fn open(&self) -> WorkspaceResult<FileSessionDto> {
        let home = default_local_root()?;
        Ok(FileSessionDto {
            file_session_id: LOCAL_SESSION_ID.into(),
            host_id: "local".into(),
            host_name: "Local files".into(),
            host_alias: String::new(),
            home_path: display_path(&home)?,
            supports_fsync: true,
            supports_hardlink: true,
            supports_posix_rename: true,
            target_kind: FileTargetKind::Local,
        })
    }

    pub(crate) async fn list_directory(
        &self,
        request: ListDirectoryRequest,
    ) -> WorkspaceResult<ListDirectoryResult> {
        let canonical = canonical_existing(&request.path).await?;
        let canonical_path = display_path(&canonical)?;
        let (snapshot_id, snapshot) = if let Some(id) = request.snapshot_id.as_deref() {
            let snapshot = self
                .snapshots
                .lock()
                .map_err(lock_error)?
                .get(id)
                .cloned()
                .ok_or_else(|| {
                    WorkspaceError::new(
                        "directory-snapshot-expired",
                        "Refresh the directory and try again.",
                    )
                })?;
            if snapshot.path != canonical_path {
                return Err(WorkspaceError::new(
                    "directory-snapshot-path-mismatch",
                    "The directory snapshot belongs to a different path.",
                ));
            }
            (id.to_string(), snapshot)
        } else {
            let mut reader = tokio::fs::read_dir(&canonical)
                .await
                .map_err(|e| WorkspaceError::new("directory-open-failed", e.to_string()))?;
            let mut entries = Vec::new();
            let mut truncated = false;
            while let Some(item) = reader
                .next_entry()
                .await
                .map_err(|e| WorkspaceError::new("directory-read-failed", e.to_string()))?
            {
                if entries.len() >= MAX_ENTRIES {
                    truncated = true;
                    break;
                }
                entries.push(entry_from_path(&item.path()).await?);
            }
            sort_entries(
                &mut entries,
                request.sort.unwrap_or(FileSortField::Name),
                request.direction.unwrap_or(SortDirection::Asc),
            );
            let id = format!("local-snapshot-{}", Uuid::new_v4());
            let snapshot = Snapshot {
                path: canonical_path.clone(),
                entries,
                truncated,
            };
            let mut snapshots = self.snapshots.lock().map_err(lock_error)?;
            if snapshots.len() >= 16 {
                if let Some(oldest) = snapshots.keys().next().cloned() {
                    snapshots.remove(&oldest);
                }
            }
            snapshots.insert(id.clone(), snapshot.clone());
            (id, snapshot)
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
        let end = (offset + PAGE_SIZE).min(snapshot.entries.len());
        let page = snapshot.entries[offset..end].to_vec();
        let mut refs = self.entries.write().await;
        for entry in &page {
            refs.insert(entry.entry_ref.clone(), entry.clone());
        }
        Ok(ListDirectoryResult {
            canonical_path,
            snapshot_id,
            entries: page,
            next_page_token: (end < snapshot.entries.len()).then(|| end.to_string()),
            total_entries: snapshot.entries.len() as u32,
            truncated: snapshot.truncated,
        })
    }

    pub(crate) async fn preview(
        &self,
        request: PreviewFileRequest,
    ) -> WorkspaceResult<FilePreview> {
        let entry = self.resolve_entry(&request.entry_ref).await?;
        if entry.kind != RemoteFileKind::File {
            return Err(WorkspaceError::new(
                "preview-not-file",
                "Only regular files can be previewed.",
            ));
        }
        let mime = mime_for(&entry.name);
        let limit = if mime.starts_with("image/") {
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
        let bytes = tokio::fs::read(path_from_display(&entry.path)?)
            .await
            .map_err(|e| WorkspaceError::new("preview-read-failed", e.to_string()))?;
        if mime.starts_with("image/") {
            Ok(FilePreview {
                entry,
                kind: PreviewKind::Image,
                mime_type: mime,
                text: None,
                data_base64: Some(STANDARD.encode(bytes)),
                truncated: false,
            })
        } else {
            let text = String::from_utf8(bytes).map_err(|_| {
                WorkspaceError::new(
                    "unsupported-file-encoding",
                    "Only UTF-8 text preview is supported.",
                )
            })?;
            Ok(FilePreview {
                entry,
                kind: PreviewKind::Text,
                mime_type: mime,
                text: Some(text),
                data_base64: None,
                truncated: false,
            })
        }
    }

    pub(crate) async fn start_search(
        &self,
        request: StartFileSearchRequest,
    ) -> WorkspaceResult<FileSearchStarted> {
        if request.query.trim().is_empty() {
            return Err(WorkspaceError::new(
                "empty-search-query",
                "Search query is required.",
            ));
        }
        let start = canonical_existing(&request.path).await?;
        let id = format!("local-search-{}", Uuid::new_v4());
        let cancel = CancellationToken::new();
        self.searches
            .lock()
            .map_err(lock_error)?
            .insert(id.clone(), cancel.clone());
        let event_sink = self.event_sink.clone();
        let entry_refs = self.entries.clone();
        let search_id = id.clone();
        let file_session_id = request.file_session_id;
        let query = request.query.to_lowercase();
        tokio::spawn(async move {
            let started = Instant::now();
            let mut stack = vec![start];
            let mut results = Vec::new();
            let mut scanned = 0u32;
            let mut visited = HashSet::new();
            while let Some(directory) = stack.pop() {
                if started.elapsed() >= Duration::from_secs(30) {
                    break;
                }
                if cancel.is_cancelled() {
                    break;
                }
                let Ok(canonical) = tokio::fs::canonicalize(&directory).await else {
                    continue;
                };
                if !visited.insert(canonical.clone()) {
                    continue;
                }
                let Ok(mut reader) = tokio::fs::read_dir(&canonical).await else {
                    continue;
                };
                while let Ok(Some(item)) = reader.next_entry().await {
                    if started.elapsed() >= Duration::from_secs(30) {
                        break;
                    }
                    if cancel.is_cancelled() {
                        break;
                    }
                    scanned = scanned.saturating_add(1);
                    let Ok(meta) = tokio::fs::symlink_metadata(item.path()).await else {
                        continue;
                    };
                    let name = item.file_name().to_string_lossy().to_string();
                    if name.to_lowercase().contains(&query) {
                        if let Ok(entry) = entry_from_path(&item.path()).await {
                            entry_refs
                                .write()
                                .await
                                .insert(entry.entry_ref.clone(), entry.clone());
                            results.push(entry);
                        }
                    }
                    if meta.is_dir() && !meta.file_type().is_symlink() {
                        stack.push(item.path());
                    }
                    if results.len() >= MAX_SEARCH_RESULTS {
                        break;
                    }
                }
                if results.len() >= MAX_SEARCH_RESULTS {
                    break;
                }
            }
            let truncated =
                results.len() >= MAX_SEARCH_RESULTS || started.elapsed() >= Duration::from_secs(30);
            emit(
                event_sink.as_ref(),
                FILE_SEARCH_UPDATED_EVENT,
                &FileSearchUpdatedEvent {
                    search_id,
                    file_session_id,
                    revision: 1,
                    state: if cancel.is_cancelled() {
                        FileSearchState::Cancelled
                    } else {
                        FileSearchState::Completed
                    },
                    entries: results,
                    scanned,
                    truncated,
                    error_code: None,
                },
            );
        });
        Ok(FileSearchStarted { search_id: id })
    }

    pub(crate) fn cancel_search(&self, request: CancelFileSearchRequest) -> WorkspaceResult<()> {
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

    pub(crate) async fn create_directory(
        &self,
        request: CreateDirectoryRequest,
    ) -> WorkspaceResult<RemoteFileEntry> {
        if !safe_name(&request.name) {
            return Err(WorkspaceError::new(
                "invalid-directory-name",
                "Directory names cannot contain separators or dot segments.",
            ));
        }
        let parent = canonical_existing(&request.parent_path).await?;
        let target = parent.join(&request.name);
        tokio::fs::create_dir(&target)
            .await
            .map_err(|e| WorkspaceError::new("directory-create-failed", e.to_string()))?;
        let entry = entry_from_path(&target).await?;
        self.entries
            .write()
            .await
            .insert(entry.entry_ref.clone(), entry.clone());
        Ok(entry)
    }

    pub(crate) async fn canonicalize(&self, path: &str) -> WorkspaceResult<String> {
        display_path(&canonical_existing(path).await?)
    }

    pub(crate) async fn vscode_folder(
        &self,
        path: &str,
        entry_ref: Option<&str>,
    ) -> WorkspaceResult<super::vscode::VscodeFolder> {
        let canonical = canonical_existing(path).await?;
        let canonical_path = display_path(&canonical)?;
        let metadata = tokio::fs::symlink_metadata(&canonical)
            .await
            .map_err(|error| WorkspaceError::new("vscode-folder-stale", error.to_string()))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(WorkspaceError::new(
                "vscode-folder-not-directory",
                "VS Code can only open a plain directory.",
            ));
        }
        if let Some(entry_ref) = entry_ref {
            let entry = self.operation_stat(entry_ref).await?;
            if entry.kind != RemoteFileKind::Directory || entry.path != canonical_path {
                return Err(WorkspaceError::new(
                    "vscode-folder-entry-mismatch",
                    "Refresh the directory before opening this folder in VS Code.",
                ));
            }
        }
        Ok(super::vscode::VscodeFolder::Local(canonical))
    }

    pub(crate) async fn copy_entry(
        &self,
        source_ref: &str,
        destination: &str,
    ) -> WorkspaceResult<RemoteFileEntry> {
        let source = self.operation_stat(source_ref).await?;
        let source_path = path_from_display(&source.path)?;
        let target = path_from_display(destination)?;
        if tokio::fs::symlink_metadata(&target).await.is_ok() {
            return Err(WorkspaceError::new(
                "destination-exists",
                "The copy destination already exists.",
            ));
        }
        let parent = target.parent().ok_or_else(|| {
            WorkspaceError::new("invalid-destination", "The copy destination has no parent.")
        })?;
        let parent_meta = tokio::fs::symlink_metadata(parent)
            .await
            .map_err(|e| WorkspaceError::new("destination-parent-stale", e.to_string()))?;
        if !parent_meta.is_dir() || parent_meta.file_type().is_symlink() {
            return Err(WorkspaceError::new(
                "destination-parent-unsafe",
                "The copy destination parent is not a plain directory.",
            ));
        }
        match source.kind {
            RemoteFileKind::File => {
                tokio::fs::copy(source_path, &target)
                    .await
                    .map_err(|e| WorkspaceError::new("local-copy-failed", e.to_string()))?;
            }
            RemoteFileKind::Directory => copy_directory_no_links(&source_path, &target).await?,
            _ => {
                return Err(WorkspaceError::new(
                    "unsafe-local-entry",
                    "Only regular files and plain directories can be copied.",
                ))
            }
        }
        let entry = entry_from_path(&target).await?;
        self.entries
            .write()
            .await
            .insert(entry.entry_ref.clone(), entry.clone());
        Ok(entry)
    }

    pub(crate) async fn write_text_staging(&self, path: &str, bytes: &[u8]) -> WorkspaceResult<()> {
        let target = path_from_display(path)?;
        let parent = target.parent().ok_or_else(|| {
            WorkspaceError::new(
                "unsafe-staging-path",
                "The editor staging path has no parent.",
            )
        })?;
        let parent_meta = tokio::fs::symlink_metadata(parent)
            .await
            .map_err(|e| WorkspaceError::new("edit-staging-parent-stale", e.to_string()))?;
        if !parent_meta.is_dir() || parent_meta.file_type().is_symlink() {
            return Err(WorkspaceError::new(
                "edit-staging-parent-unsafe",
                "The editor staging parent is not a plain directory.",
            ));
        }
        let mut options = tokio::fs::OpenOptions::new();
        options.create_new(true).write(true);
        let mut file = options
            .open(&target)
            .await
            .map_err(|e| WorkspaceError::new("edit-staging-open-failed", e.to_string()))?;
        file.write_all(bytes)
            .await
            .map_err(|e| WorkspaceError::new("edit-staging-write-failed", e.to_string()))?;
        file.sync_all()
            .await
            .map_err(|e| WorkspaceError::new("edit-staging-sync-failed", e.to_string()))
    }

    pub(crate) async fn remove_staging_file(&self, path: &str) -> WorkspaceResult<()> {
        let target = path_from_display(path)?;
        match tokio::fs::remove_file(target).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(WorkspaceError::new(
                "edit-staging-remove-failed",
                error.to_string(),
            )),
        }
    }

    pub(crate) async fn operation_stat(&self, entry_ref: &str) -> WorkspaceResult<RemoteFileEntry> {
        let entry = self.resolve_entry(entry_ref).await?;
        let fresh = entry_from_path(&path_from_display(&entry.path)?).await?;
        if fresh.fingerprint != entry.fingerprint {
            return Err(WorkspaceError::new(
                "stale-preview",
                "The local file changed after it was previewed.",
            ));
        }
        Ok(entry)
    }

    pub(crate) async fn operation_internal_entry(
        &self,
        path: &str,
    ) -> WorkspaceResult<RemoteFileEntry> {
        let entry = entry_from_path(&path_from_display(path)?).await?;
        self.entries
            .write()
            .await
            .insert(entry.entry_ref.clone(), entry.clone());
        Ok(entry)
    }

    pub(crate) async fn operation_snapshot_overwrite_destination(
        &self,
        path: &str,
    ) -> WorkspaceResult<OperationPathSnapshot> {
        let target = canonical_existing(path).await?;
        let meta = tokio::fs::symlink_metadata(&target)
            .await
            .map_err(|e| WorkspaceError::new("destination-missing", e.to_string()))?;
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(WorkspaceError::new(
                "unsafe-overwrite-destination",
                "Workspace overwrites only regular, non-symlink files.",
            ));
        }
        let entry = entry_from_path(&target).await?;
        Ok(OperationPathSnapshot {
            path: entry.path,
            fingerprint: entry.fingerprint,
        })
    }

    pub(crate) async fn operation_exists(&self, path: &str) -> WorkspaceResult<bool> {
        Ok(tokio::fs::symlink_metadata(path_from_display(path)?)
            .await
            .is_ok())
    }

    pub(crate) async fn operation_mkdir(&self, path: &str) -> WorkspaceResult<()> {
        tokio::fs::create_dir(path_from_display(path)?)
            .await
            .map_err(|e| WorkspaceError::new("backup-create-failed", e.to_string()))
    }

    pub(crate) async fn operation_create_recovery_dir(&self, path: &str) -> WorkspaceResult<()> {
        let recovery = path_from_display(path)?;
        let name = recovery
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or_default();
        let root = recovery.parent().ok_or_else(|| {
            WorkspaceError::new("unsafe-recovery-path", "Recovery path has no parent.")
        })?;
        if !name.starts_with("recovery-")
            || root.file_name().and_then(|v| v.to_str()) != Some(".codexhub-workspace-backups")
        {
            return Err(WorkspaceError::new(
                "unsafe-recovery-path",
                "Only a Workspace recovery directory may be created.",
            ));
        }
        if tokio::fs::symlink_metadata(&recovery).await.is_ok() {
            return Err(WorkspaceError::new(
                "recovery-already-exists",
                "Recovery path already exists.",
            ));
        }
        tokio::fs::create_dir_all(root)
            .await
            .map_err(|e| WorkspaceError::new("backup-create-failed", e.to_string()))?;
        let root_meta = tokio::fs::symlink_metadata(root)
            .await
            .map_err(|e| WorkspaceError::new("backup-create-stale", e.to_string()))?;
        if root_meta.file_type().is_symlink() || !root_meta.is_dir() {
            return Err(WorkspaceError::new(
                "backup-root-unsafe",
                "Workspace backup root is not a plain directory.",
            ));
        }
        tokio::fs::create_dir(&recovery)
            .await
            .map_err(|e| WorkspaceError::new("backup-create-failed", e.to_string()))
    }

    pub(crate) async fn operation_rename(&self, from: &str, to: &str) -> WorkspaceResult<()> {
        tokio::fs::rename(path_from_display(from)?, path_from_display(to)?)
            .await
            .map_err(|e| WorkspaceError::new("local-rename-failed", e.to_string()))
    }

    pub(crate) async fn operation_rename_no_replace(
        &self,
        from: &str,
        to: &str,
    ) -> WorkspaceResult<()> {
        let source = path_from_display(from)?;
        let target = path_from_display(to)?;
        if tokio::fs::symlink_metadata(&target).await.is_ok() {
            return Err(WorkspaceError::new(
                "destination-exists",
                "The destination already exists.",
            ));
        }
        let meta = tokio::fs::symlink_metadata(&source)
            .await
            .map_err(|e| WorkspaceError::new("source-stale", e.to_string()))?;
        if meta.is_file() && !meta.file_type().is_symlink() {
            tokio::fs::hard_link(&source, &target)
                .await
                .map_err(|e| WorkspaceError::new("destination-create-failed", e.to_string()))?;
            tokio::fs::remove_file(&source)
                .await
                .map_err(|e| WorkspaceError::new("source-remove-failed", e.to_string()))?;
            return Ok(());
        }
        if meta.is_dir() && !meta.file_type().is_symlink() {
            copy_directory_no_links(&source, &target).await?;
            tokio::fs::remove_dir_all(&source)
                .await
                .map_err(|e| WorkspaceError::new("source-remove-failed", e.to_string()))?;
            return Ok(());
        }
        Err(WorkspaceError::new(
            "unsafe-local-entry",
            "Symbolic links and special files cannot be moved by Workspace.",
        ))
    }

    pub(crate) async fn operation_purge_recovery(
        &self,
        root: &str,
        recovery_id: &str,
    ) -> WorkspaceResult<()> {
        let path = path_from_display(root)?;
        if path.file_name().and_then(|v| v.to_str()) != Some(recovery_id)
            || !recovery_id.starts_with("recovery-")
            || path
                .parent()
                .and_then(|v| v.file_name())
                .and_then(|v| v.to_str())
                != Some(".codexhub-workspace-backups")
        {
            return Err(WorkspaceError::new(
                "unsafe-recovery-path",
                "Only a prepared Workspace recovery may be purged.",
            ));
        }
        let meta = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|e| WorkspaceError::new("recovery-purge-stale", e.to_string()))?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err(WorkspaceError::new(
                "recovery-purge-unsafe",
                "Recovery root is not a plain directory.",
            ));
        }
        tokio::fs::remove_dir_all(path)
            .await
            .map_err(|e| WorkspaceError::new("recovery-purge-failed", e.to_string()))
    }

    pub(crate) async fn transfer_upload(
        &self,
        local_path: &Path,
        destination: &str,
        offset: u64,
        cancel: &CancellationToken,
        progress: &mut (dyn FnMut(u64) -> WorkspaceResult<()> + Send),
    ) -> WorkspaceResult<TransferStreamStop> {
        copy_file_stream(
            local_path,
            &path_from_display(destination)?,
            offset,
            cancel,
            progress,
        )
        .await
    }

    pub(crate) async fn transfer_download(
        &self,
        source: &str,
        local_path: &Path,
        offset: u64,
        cancel: &CancellationToken,
        progress: &mut (dyn FnMut(u64) -> WorkspaceResult<()> + Send),
    ) -> WorkspaceResult<TransferStreamStop> {
        copy_file_stream(
            &path_from_display(source)?,
            local_path,
            offset,
            cancel,
            progress,
        )
        .await
    }

    pub(crate) async fn transfer_fingerprint(
        &self,
        path: &str,
    ) -> WorkspaceResult<TransferFingerprint> {
        let meta = tokio::fs::metadata(path_from_display(path)?)
            .await
            .map_err(|e| WorkspaceError::new("transfer-stat-failed", e.to_string()))?;
        Ok(TransferFingerprint {
            size: meta.len(),
            modified: modified_text(&meta),
        })
    }

    pub(crate) async fn transfer_sha256(&self, path: &str) -> WorkspaceResult<String> {
        hash_prefix(&path_from_display(path)?, None).await
    }

    pub(crate) async fn transfer_prefix_sha256(
        &self,
        path: &str,
        length: u64,
    ) -> WorkspaceResult<String> {
        hash_prefix(&path_from_display(path)?, Some(length)).await
    }

    async fn resolve_entry(&self, entry_ref: &str) -> WorkspaceResult<RemoteFileEntry> {
        self.entries
            .read()
            .await
            .get(entry_ref)
            .cloned()
            .ok_or_else(|| {
                WorkspaceError::new("stale-entry-ref", "Refresh the directory and try again.")
            })
    }
}

fn default_local_root() -> WorkspaceResult<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        Ok(PathBuf::from("C:\\"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(PathBuf::from("/"))
    }
}

fn available_local_roots() -> WorkspaceResult<Vec<String>> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Storage::FileSystem::GetLogicalDrives;

        // SAFETY: GetLogicalDrives accepts no pointers and only returns the
        // process-visible logical-drive bitmask.
        let mask = unsafe { GetLogicalDrives() };
        if mask == 0 {
            return Err(WorkspaceError::new(
                "local-roots-unavailable",
                "Windows did not return any local drive roots.",
            ));
        }
        Ok(windows_drive_roots_from_mask(mask))
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(vec!["/".into()])
    }
}

#[cfg(target_os = "windows")]
fn windows_drive_roots_from_mask(mask: u32) -> Vec<String> {
    (0..26)
        .filter(|index| mask & (1 << index) != 0)
        .map(|index| format!("{}:/", (b'A' + index as u8) as char))
        .collect()
}

fn path_from_display(path: &str) -> WorkspaceResult<PathBuf> {
    if path.contains('\0') {
        return Err(WorkspaceError::new(
            "invalid-local-path",
            "Local paths must be absolute and normalized.",
        ));
    }
    // Windows commonly accepts `E:` as a drive-root shortcut in location
    // fields. Resolve it as `E:/` instead of treating it as a relative path.
    #[cfg(target_os = "windows")]
    let normalized;
    #[cfg(target_os = "windows")]
    let path = if is_windows_drive_designator(path) {
        normalized = format!("{path}/");
        normalized.as_str()
    } else {
        path
    };
    let value = PathBuf::from(path);
    if !value.is_absolute()
        || value
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(WorkspaceError::new(
            "invalid-local-path",
            "Local paths must be absolute.",
        ));
    }
    Ok(value)
}

#[cfg(target_os = "windows")]
fn is_windows_drive_designator(path: &str) -> bool {
    path.len() == 2 && path.as_bytes()[0].is_ascii_alphabetic() && path.as_bytes()[1] == b':'
}

fn display_path(path: &Path) -> WorkspaceResult<String> {
    path.to_str()
        .map(|value| {
            let value = value.strip_prefix(r"\\?\").unwrap_or(value);
            value.replace('\\', "/")
        })
        .ok_or_else(|| {
            WorkspaceError::new(
                "unsupported-local-path-encoding",
                "The local path cannot be represented safely.",
            )
        })
}

async fn canonical_existing(path: &str) -> WorkspaceResult<PathBuf> {
    tokio::fs::canonicalize(path_from_display(path)?)
        .await
        .map_err(|e| WorkspaceError::new("local-path-unavailable", e.to_string()))
}

async fn entry_from_path(path: &Path) -> WorkspaceResult<RemoteFileEntry> {
    let meta = tokio::fs::symlink_metadata(path)
        .await
        .map_err(|e| WorkspaceError::new("local-entry-stale", e.to_string()))?;
    let canonical_parent = if let Some(parent) = path.parent() {
        tokio::fs::canonicalize(parent)
            .await
            .unwrap_or_else(|_| parent.to_path_buf())
    } else {
        path.to_path_buf()
    };
    let canonical = path
        .file_name()
        .map(|name| canonical_parent.join(name))
        .unwrap_or_else(|| path.to_path_buf());
    let name_utf8 = path.file_name().and_then(|value| value.to_str());
    let name = name_utf8
        .unwrap_or_else(|| path.to_str().unwrap_or("/"))
        .to_string();
    let kind = if meta.file_type().is_symlink() {
        RemoteFileKind::Symlink
    } else if meta.is_dir() {
        RemoteFileKind::Directory
    } else if meta.is_file() {
        RemoteFileKind::File
    } else {
        RemoteFileKind::Unknown
    };
    let modified = meta
        .modified()
        .ok()
        .map(DateTime::<Utc>::from)
        .map(|v| v.to_rfc3339_opts(SecondsFormat::Secs, true));
    let fingerprint = format!(
        "{}:{}:{}",
        kind_code(kind),
        meta.len(),
        modified.clone().unwrap_or_default()
    );
    let symlink_target = if meta.file_type().is_symlink() {
        tokio::fs::read_link(path)
            .await
            .ok()
            .and_then(|v| display_path(&v).ok())
    } else {
        None
    };
    Ok(RemoteFileEntry {
        entry_ref: format!("local-entry-{}", Uuid::new_v4()),
        path: display_path(&canonical)?,
        name,
        kind,
        size: meta.is_file().then(|| meta.len().to_string()),
        modified_at: modified,
        permissions: Some(
            if meta.permissions().readonly() {
                "read-only"
            } else {
                "read-write"
            }
            .into(),
        ),
        uid: None,
        gid: None,
        symlink_target,
        fingerprint,
        writable_name: name_utf8.is_some() && !meta.file_type().is_symlink(),
    })
}

fn kind_code(kind: RemoteFileKind) -> &'static str {
    match kind {
        RemoteFileKind::File => "f",
        RemoteFileKind::Directory => "d",
        RemoteFileKind::Symlink => "l",
        _ => "o",
    }
}

fn sort_entries(entries: &mut [RemoteFileEntry], field: FileSortField, direction: SortDirection) {
    entries.sort_by(|a, b| {
        let ordering = match field {
            FileSortField::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            // Type is the primary key; names keep the same ascending semantics within each type.
            FileSortField::Type => kind_code(a.kind)
                .cmp(kind_code(b.kind))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name)),
            FileSortField::Size => a
                .size
                .as_deref()
                .unwrap_or("0")
                .parse::<u64>()
                .unwrap_or(0)
                .cmp(&b.size.as_deref().unwrap_or("0").parse::<u64>().unwrap_or(0)),
            FileSortField::Modified => a.modified_at.cmp(&b.modified_at),
        };
        if matches!(direction, SortDirection::Desc) {
            ordering.reverse()
        } else {
            ordering
        }
    });
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

fn mime_for(name: &str) -> String {
    let ext = name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "json" => "application/json",
        "md" | "txt" | "rs" | "ts" | "tsx" | "js" | "css" | "html" | "toml" | "yaml" | "yml" => {
            "text/plain"
        }
        _ => "application/octet-stream",
    }
    .into()
}

fn modified_text(meta: &std::fs::Metadata) -> Option<String> {
    meta.modified()
        .ok()
        .map(DateTime::<Utc>::from)
        .map(|v| v.to_rfc3339_opts(SecondsFormat::Secs, true))
}

async fn copy_file_stream(
    source: &Path,
    target: &Path,
    offset: u64,
    cancel: &CancellationToken,
    progress: &mut (dyn FnMut(u64) -> WorkspaceResult<()> + Send),
) -> WorkspaceResult<TransferStreamStop> {
    let mut input = tokio::fs::File::open(source)
        .await
        .map_err(|e| WorkspaceError::new("local-source-unavailable", e.to_string()))?;
    let meta = input
        .metadata()
        .await
        .map_err(|e| WorkspaceError::new("local-source-unavailable", e.to_string()))?;
    if !meta.is_file() || offset > meta.len() {
        return Err(WorkspaceError::new(
            "invalid-resume-offset",
            "The local source cannot resume at this offset.",
        ));
    }
    input
        .seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| WorkspaceError::new("local-source-read-failed", e.to_string()))?;
    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true).truncate(offset == 0);
    let mut output = options
        .open(target)
        .await
        .map_err(|e| WorkspaceError::new("local-target-open-failed", e.to_string()))?;
    output
        .seek(SeekFrom::Start(offset))
        .await
        .map_err(|e| WorkspaceError::new("local-target-seek-failed", e.to_string()))?;
    let mut copied = offset;
    let mut buffer = vec![0u8; COPY_CHUNK_BYTES];
    loop {
        if cancel.is_cancelled() {
            output.sync_all().await.ok();
            return Ok(TransferStreamStop::Cancelled);
        }
        let read = input
            .read(&mut buffer)
            .await
            .map_err(|e| WorkspaceError::new("local-source-read-failed", e.to_string()))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .await
            .map_err(|e| WorkspaceError::new("local-target-write-failed", e.to_string()))?;
        copied += read as u64;
        progress(copied)?;
    }
    output
        .sync_all()
        .await
        .map_err(|e| WorkspaceError::new("local-target-sync-failed", e.to_string()))?;
    Ok(TransferStreamStop::Complete)
}

async fn hash_prefix(path: &Path, length: Option<u64>) -> WorkspaceResult<String> {
    let mut file = tokio::fs::File::open(path)
        .await
        .map_err(|e| WorkspaceError::new("transfer-verify-open-failed", e.to_string()))?;
    let mut remaining = length.unwrap_or(u64::MAX);
    let mut buffer = vec![0u8; COPY_CHUNK_BYTES];
    let mut hash = Sha256::new();
    while remaining > 0 {
        let request = buffer.len().min(remaining as usize);
        let read = file
            .read(&mut buffer[..request])
            .await
            .map_err(|e| WorkspaceError::new("transfer-verify-read-failed", e.to_string()))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
        remaining -= read as u64;
    }
    if length.is_some() && remaining > 0 {
        return Err(WorkspaceError::new(
            "transfer-prefix-short",
            "The local file is shorter than the saved offset.",
        ));
    }
    Ok(format!("{:x}", hash.finalize()))
}

async fn copy_directory_no_links(source: &Path, target: &Path) -> WorkspaceResult<()> {
    let mut stack = vec![(source.to_path_buf(), target.to_path_buf())];
    tokio::fs::create_dir(target)
        .await
        .map_err(|e| WorkspaceError::new("destination-create-failed", e.to_string()))?;
    while let Some((from, to)) = stack.pop() {
        let mut reader = tokio::fs::read_dir(&from)
            .await
            .map_err(|e| WorkspaceError::new("local-copy-failed", e.to_string()))?;
        while let Some(item) = reader
            .next_entry()
            .await
            .map_err(|e| WorkspaceError::new("local-copy-failed", e.to_string()))?
        {
            let meta = tokio::fs::symlink_metadata(item.path())
                .await
                .map_err(|e| WorkspaceError::new("local-copy-failed", e.to_string()))?;
            if meta.file_type().is_symlink() {
                return Err(WorkspaceError::new(
                    "directory-link-not-supported",
                    "Folders containing symbolic links cannot be copied safely.",
                ));
            }
            let destination = to.join(item.file_name());
            if meta.is_dir() {
                tokio::fs::create_dir(&destination)
                    .await
                    .map_err(|e| WorkspaceError::new("local-copy-failed", e.to_string()))?;
                stack.push((item.path(), destination));
            } else if meta.is_file() {
                tokio::fs::copy(item.path(), destination)
                    .await
                    .map_err(|e| WorkspaceError::new("local-copy-failed", e.to_string()))?;
            } else {
                return Err(WorkspaceError::new(
                    "special-file-not-supported",
                    "Special files cannot be copied by Workspace.",
                ));
            }
        }
    }
    Ok(())
}

fn lock_error<T>(_error: std::sync::PoisonError<T>) -> WorkspaceError {
    WorkspaceError::new(
        "workspace-lock-poisoned",
        "Workspace local file state is unavailable.",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sort_entry(name: &str, kind: RemoteFileKind) -> RemoteFileEntry {
        RemoteFileEntry {
            entry_ref: format!("entry-{name}"),
            path: format!("/tmp/{name}"),
            name: name.into(),
            kind,
            size: Some("0".into()),
            modified_at: None,
            permissions: None,
            uid: None,
            gid: None,
            symlink_target: None,
            fingerprint: format!("fingerprint-{name}"),
            writable_name: true,
        }
    }

    #[test]
    fn local_type_sort_uses_name_as_the_secondary_key() {
        let mut entries = vec![
            sort_entry("zeta.txt", RemoteFileKind::File),
            sort_entry("folder", RemoteFileKind::Directory),
            sort_entry("Alpha.txt", RemoteFileKind::File),
        ];

        sort_entries(&mut entries, FileSortField::Type, SortDirection::Asc);

        let names = entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect::<Vec<_>>();
        assert_eq!(names, ["folder", "Alpha.txt", "zeta.txt"]);
    }

    #[test]
    fn local_paths_reject_traversal_and_relative_values() {
        assert!(path_from_display("relative/path").is_err());
        assert!(path_from_display("C:/safe/../secret").is_err());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_local_paths_accept_any_drive_root_shape() {
        assert_eq!(path_from_display("E:").unwrap(), PathBuf::from("E:/"));
        assert_eq!(path_from_display("E:/").unwrap(), PathBuf::from("E:/"));
        assert_eq!(path_from_display(r"E:\").unwrap(), PathBuf::from(r"E:\"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_local_roots_follow_the_logical_drive_mask() {
        let mask = (1 << 2) | (1 << 4) | (1 << 5);
        assert_eq!(windows_drive_roots_from_mask(mask), ["C:/", "E:/", "F:/"]);
    }

    #[cfg(target_os = "windows")]
    #[tokio::test]
    async fn windows_local_session_can_navigate_to_an_available_non_default_drive() {
        let available = (b'D'..=b'Z')
            .map(|letter| format!("{}:/", letter as char))
            .find(|root| Path::new(root).is_dir());
        let Some(root) = available else { return };

        let sessions = LocalFileSessions::new(None);
        let page = sessions
            .list_directory(ListDirectoryRequest {
                file_session_id: LOCAL_SESSION_ID.into(),
                path: root.clone(),
                snapshot_id: None,
                page_token: None,
                sort: Some(FileSortField::Name),
                direction: Some(SortDirection::Asc),
            })
            .await
            .unwrap();

        assert_eq!(page.canonical_path, root);
    }

    #[test]
    fn local_names_reject_separators_and_dot_segments() {
        for value in ["", ".", "..", "a/b", "a\\b"] {
            assert!(!safe_name(value));
        }
        assert!(safe_name("project"));
    }

    #[tokio::test]
    async fn local_session_lists_and_copies_regular_files_with_opaque_refs() {
        let root = std::env::temp_dir().join(format!("codexhub-local-files-{}", Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        tokio::fs::write(root.join("source.txt"), b"local workspace")
            .await
            .unwrap();
        let sessions = LocalFileSessions::new(None);
        let page = sessions
            .list_directory(ListDirectoryRequest {
                file_session_id: LOCAL_SESSION_ID.into(),
                path: display_path(&root).unwrap(),
                snapshot_id: None,
                page_token: None,
                sort: Some(FileSortField::Name),
                direction: Some(SortDirection::Asc),
            })
            .await
            .unwrap();
        let source = page
            .entries
            .iter()
            .find(|entry| entry.name == "source.txt")
            .unwrap();
        let copied = sessions
            .copy_entry(
                &source.entry_ref,
                &display_path(&root.join("copy.txt")).unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(copied.name, "copy.txt");
        assert_eq!(
            tokio::fs::read(root.join("copy.txt")).await.unwrap(),
            b"local workspace"
        );
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_local_files_start_at_c_drive_root() {
        assert_eq!(display_path(&default_local_root().unwrap()).unwrap(), "C:/");
    }
}
