use crate::workspace::operations::RecoveryPersistence;
use crate::workspace::transfer_io::{LocalRecoveryPersistence, LocalRecoveryRecord};
use crate::workspace::transfers::TransferPersistence;
use crate::workspace::types::{
    ConflictStrategy, FileOperationKind, RecoveryDto, RecoveryState, TransferDirection,
    TransferDto, TransferState,
};
use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::fmt;
use std::path::Path;
use std::sync::Mutex;

pub(crate) const CURRENT_WORKSPACE_SCHEMA_VERSION: i64 = 2;
const WORKSPACE_MIGRATION_NAME: &str = "workspace-core";
const WORKSPACE_MIGRATION_CHECKSUM: &str = "workspace-core-v1";
const WORKSPACE_MIGRATION_V2_NAME: &str = "workspace-local-recoveries";
const WORKSPACE_MIGRATION_V2_CHECKSUM: &str = "workspace-local-recoveries-v1";
const MAX_LIST_LIMIT: usize = 1_000;

/// Workspace uses a private migration ledger so it does not change TaskStore's
/// `PRAGMA user_version` or claim versions from the shared task schema.
pub(crate) const WORKSPACE_SCHEMA_V1_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_transfers (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    host_name TEXT NOT NULL,
    host_alias TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('upload', 'download')),
    source_locator TEXT NOT NULL,
    target_locator TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
        'queued', 'running', 'pausing', 'paused', 'waiting-conflict',
        'verifying', 'finalizing', 'completed', 'failed', 'cancelled', 'interrupted'
    )),
    conflict_policy TEXT NOT NULL CHECK(conflict_policy IN (
        'ask', 'skip', 'keep-both', 'replace-with-backup'
    )),
    conflict_revision INTEGER NOT NULL DEFAULT 0 CHECK(conflict_revision >= 0),
    bytes_transferred INTEGER NOT NULL DEFAULT 0 CHECK(bytes_transferred >= 0),
    total_bytes INTEGER CHECK(total_bytes IS NULL OR total_bytes >= 0),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
    resumable INTEGER NOT NULL DEFAULT 0 CHECK(resumable IN (0, 1)),
    partial_locator TEXT,
    source_fingerprint TEXT,
    target_fingerprint TEXT,
    checksum_sha256 TEXT,
    error_code TEXT,
    error_detail TEXT,
    task_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
CREATE INDEX IF NOT EXISTS idx_workspace_transfers_state_updated
    ON workspace_transfers(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_transfers_host_state
    ON workspace_transfers(host_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_transfers_task
    ON workspace_transfers(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_transfer_items (
    id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL REFERENCES workspace_transfers(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    entry_kind TEXT NOT NULL CHECK(entry_kind IN ('file', 'directory', 'symlink')),
    source_locator TEXT NOT NULL,
    target_locator TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN (
        'queued', 'running', 'pausing', 'paused', 'waiting-conflict',
        'verifying', 'finalizing', 'completed', 'failed', 'cancelled', 'interrupted'
    )),
    bytes_transferred INTEGER NOT NULL DEFAULT 0 CHECK(bytes_transferred >= 0),
    total_bytes INTEGER CHECK(total_bytes IS NULL OR total_bytes >= 0),
    partial_locator TEXT,
    source_fingerprint TEXT,
    target_fingerprint TEXT,
    checksum_sha256 TEXT,
    error_code TEXT,
    error_detail TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
    UNIQUE(transfer_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_workspace_transfer_items_transfer
    ON workspace_transfer_items(transfer_id, ordinal);
CREATE INDEX IF NOT EXISTS idx_workspace_transfer_items_state
    ON workspace_transfer_items(state, updated_at DESC);

CREATE TABLE IF NOT EXISTS workspace_recoveries (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL,
    host_alias TEXT NOT NULL,
    operation_kind TEXT NOT NULL CHECK(operation_kind IN (
        'delete', 'overwrite', 'rename', 'partial-cleanup'
    )),
    state TEXT NOT NULL CHECK(state IN (
        'prepared', 'available', 'restoring', 'restored',
        'purge-prepared', 'purged', 'failed'
    )),
    source_locator TEXT NOT NULL,
    target_locator TEXT,
    backup_locator TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    target_fingerprint TEXT,
    journal_json TEXT NOT NULL,
    error_code TEXT,
    error_detail TEXT,
    task_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0)
);
CREATE INDEX IF NOT EXISTS idx_workspace_recoveries_state_updated
    ON workspace_recoveries(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_recoveries_host_state
    ON workspace_recoveries(host_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_recoveries_task
    ON workspace_recoveries(task_id) WHERE task_id IS NOT NULL;
"#;

const WORKSPACE_SCHEMA_V2_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS workspace_local_recoveries (
    id TEXT PRIMARY KEY,
    transfer_id TEXT NOT NULL,
    destination_path TEXT NOT NULL,
    backup_path TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared', 'available', 'restored', 'purged', 'failed')),
    created_at TEXT NOT NULL,
    restored_at TEXT,
    purged_at TEXT,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workspace_local_recoveries_state_updated
    ON workspace_local_recoveries(state, updated_at DESC);
"#;

const TRANSFER_COLUMNS: &str = "id, batch_id, host_id, host_name, host_alias, direction, \
source_locator, target_locator, state, conflict_policy, conflict_revision, \
bytes_transferred, total_bytes, attempt, resumable, partial_locator, \
source_fingerprint, target_fingerprint, checksum_sha256, error_code, error_detail, \
task_id, created_at, updated_at, revision";

const TRANSFER_ITEM_COLUMNS: &str = "id, transfer_id, ordinal, entry_kind, \
source_locator, target_locator, state, bytes_transferred, total_bytes, partial_locator, \
source_fingerprint, target_fingerprint, checksum_sha256, error_code, error_detail, \
created_at, updated_at, revision";

const RECOVERY_COLUMNS: &str = "id, host_id, host_alias, operation_kind, state, \
source_locator, target_locator, backup_locator, source_fingerprint, target_fingerprint, \
journal_json, error_code, error_detail, task_id, created_at, updated_at, revision";

#[derive(Debug)]
pub(crate) enum WorkspaceStoreError {
    Sqlite(rusqlite::Error),
    InvalidInput(String),
    NotFound {
        entity: &'static str,
        id: String,
    },
    RevisionConflict {
        entity: &'static str,
        id: String,
        expected: i64,
        actual: i64,
    },
    UnsupportedSchema(i64),
}

impl fmt::Display for WorkspaceStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "Workspace database error: {error}"),
            Self::InvalidInput(message) => write!(formatter, "Invalid workspace storage input: {message}"),
            Self::NotFound { entity, id } => write!(formatter, "Workspace {entity} {id} was not found."),
            Self::RevisionConflict {
                entity,
                id,
                expected,
                actual,
            } => write!(
                formatter,
                "Workspace {entity} {id} changed concurrently (expected revision {expected}, current revision {actual})."
            ),
            Self::UnsupportedSchema(version) => write!(
                formatter,
                "Workspace schema {version} is newer than supported schema {CURRENT_WORKSPACE_SCHEMA_VERSION}."
            ),
        }
    }
}

impl std::error::Error for WorkspaceStoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for WorkspaceStoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

pub(crate) type WorkspaceStoreResult<T> = Result<T, WorkspaceStoreError>;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceTransfer {
    pub(crate) id: String,
    pub(crate) batch_id: String,
    pub(crate) host_id: String,
    pub(crate) host_name: String,
    pub(crate) host_alias: String,
    pub(crate) direction: String,
    pub(crate) source_locator: String,
    pub(crate) target_locator: String,
    pub(crate) state: String,
    pub(crate) conflict_policy: String,
    pub(crate) conflict_revision: i64,
    pub(crate) bytes_transferred: i64,
    pub(crate) total_bytes: Option<i64>,
    pub(crate) attempt: i64,
    pub(crate) resumable: bool,
    pub(crate) partial_locator: Option<String>,
    pub(crate) source_fingerprint: Option<String>,
    pub(crate) target_fingerprint: Option<String>,
    pub(crate) checksum_sha256: Option<String>,
    pub(crate) error_code: Option<String>,
    pub(crate) error_detail: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceTransferUpdate {
    pub(crate) expected_revision: i64,
    pub(crate) state: String,
    pub(crate) conflict_policy: String,
    pub(crate) conflict_revision: i64,
    pub(crate) bytes_transferred: i64,
    pub(crate) total_bytes: Option<i64>,
    pub(crate) attempt: i64,
    pub(crate) resumable: bool,
    pub(crate) partial_locator: Option<String>,
    pub(crate) source_fingerprint: Option<String>,
    pub(crate) target_fingerprint: Option<String>,
    pub(crate) checksum_sha256: Option<String>,
    pub(crate) error_code: Option<String>,
    pub(crate) error_detail: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceTransferItem {
    pub(crate) id: String,
    pub(crate) transfer_id: String,
    pub(crate) ordinal: i64,
    pub(crate) entry_kind: String,
    pub(crate) source_locator: String,
    pub(crate) target_locator: String,
    pub(crate) state: String,
    pub(crate) bytes_transferred: i64,
    pub(crate) total_bytes: Option<i64>,
    pub(crate) partial_locator: Option<String>,
    pub(crate) source_fingerprint: Option<String>,
    pub(crate) target_fingerprint: Option<String>,
    pub(crate) checksum_sha256: Option<String>,
    pub(crate) error_code: Option<String>,
    pub(crate) error_detail: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceTransferItemUpdate {
    pub(crate) expected_revision: i64,
    pub(crate) state: String,
    pub(crate) bytes_transferred: i64,
    pub(crate) total_bytes: Option<i64>,
    pub(crate) partial_locator: Option<String>,
    pub(crate) source_fingerprint: Option<String>,
    pub(crate) target_fingerprint: Option<String>,
    pub(crate) checksum_sha256: Option<String>,
    pub(crate) error_code: Option<String>,
    pub(crate) error_detail: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceRecovery {
    pub(crate) id: String,
    pub(crate) host_id: String,
    pub(crate) host_alias: String,
    pub(crate) operation_kind: String,
    pub(crate) state: String,
    pub(crate) source_locator: String,
    pub(crate) target_locator: Option<String>,
    pub(crate) backup_locator: String,
    pub(crate) source_fingerprint: String,
    pub(crate) target_fingerprint: Option<String>,
    pub(crate) journal_json: String,
    pub(crate) error_code: Option<String>,
    pub(crate) error_detail: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) revision: i64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceRecoveryUpdate {
    pub(crate) expected_revision: i64,
    pub(crate) state: String,
    pub(crate) target_locator: Option<String>,
    pub(crate) backup_locator: String,
    pub(crate) source_fingerprint: String,
    pub(crate) target_fingerprint: Option<String>,
    pub(crate) journal_json: String,
    pub(crate) error_code: Option<String>,
    pub(crate) error_detail: Option<String>,
    pub(crate) task_id: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct WorkspaceStartupRecovery {
    pub(crate) transfers_interrupted: usize,
    pub(crate) items_interrupted: usize,
}

/// Durable transfer repository. It has its own short SQLite transactions so
/// transfer progress never enters the Job Manager's audit log.
pub(crate) struct WorkspaceSqliteTransferPersistence {
    connection: Mutex<Connection>,
}

impl WorkspaceSqliteTransferPersistence {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or_else(|| "Workspace database path has no parent directory.".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| {
            format!("Could not create the workspace database directory: {error}")
        })?;
        let mut connection = Connection::open(path)
            .map_err(|error| format!("Could not open the workspace database: {error}"))?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
            )
            .map_err(|error| format!("Could not configure the workspace database: {error}"))?;
        WorkspaceStore::migrate(&mut connection, &Local::now().to_rfc3339())
            .map_err(|error| error.to_string())?;
        WorkspaceStore::new(&connection)
            .initialize(&Local::now().to_rfc3339())
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        let mut connection = Connection::open_in_memory().expect("open workspace database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON; CREATE TABLE task_runs (id TEXT PRIMARY KEY);",
            )
            .expect("create task fixture");
        WorkspaceStore::migrate(&mut connection, "test").expect("migrate workspace database");
        Self {
            connection: Mutex::new(connection),
        }
    }
}

impl TransferPersistence for WorkspaceSqliteTransferPersistence {
    fn load_all(&self) -> Result<Vec<TransferDto>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        WorkspaceStore::new(&connection)
            .list_transfers(MAX_LIST_LIMIT)
            .map(|values| values.iter().map(transfer_to_dto).collect())
            .map_err(|error| error.to_string())
    }

    fn upsert(&self, transfer: &TransferDto) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        let store = WorkspaceStore::new(&connection);
        match store
            .get_transfer(&transfer.transfer_id)
            .map_err(|error| error.to_string())?
        {
            Some(existing) => store
                .update_transfer(
                    &transfer.transfer_id,
                    &dto_to_transfer_update(transfer, &existing)?,
                )
                .map(|_| ())
                .map_err(|error| error.to_string()),
            None => {
                let created = store
                    .create_transfer(&dto_to_transfer(transfer)?)
                    .map_err(|error| error.to_string())?;
                // Queue-created DTOs start at revision 1. Persist one CAS
                // update so a restart never reintroduces an older revision.
                if transfer.revision == 0 {
                    Ok(())
                } else {
                    store
                        .update_transfer(
                            &transfer.transfer_id,
                            &dto_to_transfer_update(transfer, &created)?,
                        )
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                }
            }
        }
    }
}

/// Durable metadata repository for recoverable remote file mutations.  The
/// recovery payload itself remains on the remote host beside its original
/// parent directory; SQLite stores only the journal required to find it again.
pub(crate) struct WorkspaceSqliteRecoveryPersistence {
    connection: Mutex<Connection>,
}

impl WorkspaceSqliteRecoveryPersistence {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or_else(|| "Workspace database path has no parent directory.".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| {
            format!("Could not create the workspace database directory: {error}")
        })?;
        let mut connection = Connection::open(path)
            .map_err(|error| format!("Could not open the workspace database: {error}"))?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;",
            )
            .map_err(|error| format!("Could not configure the workspace database: {error}"))?;
        WorkspaceStore::migrate(&mut connection, &Local::now().to_rfc3339())
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Lists retained recovery journals.  Purged journals remain visible so
    /// the UI can truthfully show that the user permanently removed a backup.
    pub(crate) fn list_recoveries(&self) -> Result<Vec<RecoveryDto>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        WorkspaceStore::new(&connection)
            .list_recoveries(MAX_LIST_LIMIT)
            .map(|values| values.iter().map(recovery_to_dto).collect())
            .map_err(|error| error.to_string())
    }

    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        let mut connection = Connection::open_in_memory().expect("open workspace database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON; CREATE TABLE task_runs (id TEXT PRIMARY KEY);",
            )
            .expect("create task fixture");
        WorkspaceStore::migrate(&mut connection, "test").expect("migrate workspace database");
        Self {
            connection: Mutex::new(connection),
        }
    }
}

impl RecoveryPersistence for WorkspaceSqliteRecoveryPersistence {
    fn upsert(&self, recovery: &RecoveryDto) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        let store = WorkspaceStore::new(&connection);
        match store
            .get_recovery(&recovery.recovery_id)
            .map_err(|error| error.to_string())?
        {
            Some(existing) => store
                .update_recovery(
                    &recovery.recovery_id,
                    &dto_to_recovery_update(recovery, &existing),
                )
                .map(|_| ())
                .map_err(|error| error.to_string()),
            None => store
                .create_recovery(&dto_to_recovery(recovery))
                .map(|_| ())
                .map_err(|error| error.to_string()),
        }
    }

    fn get(&self, recovery_id: &str) -> Result<Option<RecoveryDto>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        WorkspaceStore::new(&connection)
            .get_recovery(recovery_id)
            .map(|value| value.as_ref().map(recovery_to_dto))
            .map_err(|error| error.to_string())
    }

    fn list(&self) -> Result<Vec<RecoveryDto>, String> {
        self.list_recoveries()
    }
}

/// Absolute local paths remain in SQLite and are never mapped into a TS DTO.
pub(crate) struct WorkspaceSqliteLocalRecoveryPersistence {
    connection: Mutex<Connection>,
}

impl WorkspaceSqliteLocalRecoveryPersistence {
    pub(crate) fn open(path: &Path) -> Result<Self, String> {
        let parent = path
            .parent()
            .ok_or_else(|| "Workspace database path has no parent directory.".to_string())?;
        std::fs::create_dir_all(parent).map_err(|error| {
            format!("Could not create the workspace database directory: {error}")
        })?;
        let mut connection = Connection::open(path)
            .map_err(|error| format!("Could not open the workspace database: {error}"))?;
        connection.execute_batch("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;").map_err(|error| format!("Could not configure the workspace database: {error}"))?;
        WorkspaceStore::migrate(&mut connection, &Local::now().to_rfc3339())
            .map_err(|error| error.to_string())?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        let mut connection = Connection::open_in_memory().expect("open workspace database");
        WorkspaceStore::migrate(&mut connection, "test").expect("migrate workspace database");
        Self {
            connection: Mutex::new(connection),
        }
    }
}

impl LocalRecoveryPersistence for WorkspaceSqliteLocalRecoveryPersistence {
    fn create(&self, recovery: &LocalRecoveryRecord) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        let destination_path = recovery.destination_path.to_str().ok_or_else(|| {
            "Workspace local recovery destination path must be UTF-8.".to_string()
        })?;
        let backup_path = recovery
            .backup_path
            .to_str()
            .ok_or_else(|| "Workspace local recovery backup path must be UTF-8.".to_string())?;
        connection.execute("INSERT INTO workspace_local_recoveries(id, transfer_id, destination_path, backup_path, state, created_at, restored_at, purged_at, updated_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?6)", params![&recovery.recovery_id, &recovery.transfer_id, destination_path, backup_path, &recovery.state, &recovery.created_at, &recovery.restored_at, &recovery.purged_at]).map(|_| ()).map_err(|error| error.to_string())
    }
    fn get(&self, recovery_id: &str) -> Result<Option<LocalRecoveryRecord>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        connection.query_row("SELECT id, transfer_id, destination_path, backup_path, state, created_at, restored_at, purged_at FROM workspace_local_recoveries WHERE id = ?1", [recovery_id], |row| Ok(LocalRecoveryRecord { recovery_id: row.get(0)?, transfer_id: row.get(1)?, destination_path: std::path::PathBuf::from(row.get::<_, String>(2)?), backup_path: std::path::PathBuf::from(row.get::<_, String>(3)?), state: row.get(4)?, created_at: row.get(5)?, restored_at: row.get(6)?, purged_at: row.get(7)? })).optional().map_err(|error| error.to_string())
    }
    fn list(&self) -> Result<Vec<LocalRecoveryRecord>, String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        let mut statement = connection.prepare("SELECT id, transfer_id, destination_path, backup_path, state, created_at, restored_at, purged_at FROM workspace_local_recoveries ORDER BY created_at DESC LIMIT 1000").map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(LocalRecoveryRecord {
                    recovery_id: row.get(0)?,
                    transfer_id: row.get(1)?,
                    destination_path: std::path::PathBuf::from(row.get::<_, String>(2)?),
                    backup_path: std::path::PathBuf::from(row.get::<_, String>(3)?),
                    state: row.get(4)?,
                    created_at: row.get(5)?,
                    restored_at: row.get(6)?,
                    purged_at: row.get(7)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }
    fn update(&self, recovery: &LocalRecoveryRecord) -> Result<(), String> {
        let connection = self
            .connection
            .lock()
            .map_err(|_| "Workspace database mutex was poisoned.".to_string())?;
        connection.execute("UPDATE workspace_local_recoveries SET state = ?2, restored_at = ?3, purged_at = ?4, updated_at = ?5 WHERE id = ?1", params![recovery.recovery_id, recovery.state, recovery.restored_at, recovery.purged_at, Local::now().to_rfc3339()]).and_then(|changed| if changed == 1 { Ok(()) } else { Err(rusqlite::Error::QueryReturnedNoRows) }).map_err(|error| error.to_string())
    }
}

/// Thin repository over the app's shared SQLite connection. Callers must keep
/// their existing connection mutex held for the lifetime of this value.
pub(crate) struct WorkspaceStore<'connection> {
    connection: &'connection Connection,
}

impl<'connection> WorkspaceStore<'connection> {
    pub(crate) fn new(connection: &'connection Connection) -> Self {
        Self { connection }
    }

    pub(crate) fn migrate(
        connection: &mut Connection,
        applied_at: &str,
    ) -> WorkspaceStoreResult<()> {
        require_non_empty("applied_at", applied_at)?;
        let transaction = connection.transaction()?;
        transaction.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS workspace_schema_migrations (
                version INTEGER PRIMARY KEY CHECK(version > 0),
                name TEXT NOT NULL UNIQUE,
                checksum TEXT NOT NULL,
                applied_at TEXT NOT NULL
            );
            "#,
        )?;
        let current = transaction.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM workspace_schema_migrations",
            [],
            |row| row.get::<_, i64>(0),
        )?;
        if current > CURRENT_WORKSPACE_SCHEMA_VERSION {
            return Err(WorkspaceStoreError::UnsupportedSchema(current));
        }
        if current < 1 {
            transaction.execute_batch(WORKSPACE_SCHEMA_V1_SQL)?;
            transaction.execute(
                "INSERT INTO workspace_schema_migrations(version, name, checksum, applied_at) \
                 VALUES(?1, ?2, ?3, ?4)",
                params![
                    1,
                    WORKSPACE_MIGRATION_NAME,
                    WORKSPACE_MIGRATION_CHECKSUM,
                    applied_at
                ],
            )?;
        }
        if current < 2 {
            transaction.execute_batch(WORKSPACE_SCHEMA_V2_SQL)?;
            transaction.execute(
                "INSERT INTO workspace_schema_migrations(version, name, checksum, applied_at) VALUES(?1, ?2, ?3, ?4)",
                params![2, WORKSPACE_MIGRATION_V2_NAME, WORKSPACE_MIGRATION_V2_CHECKSUM, applied_at],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Marks transfer work that cannot still own a live worker after app restart.
    pub(crate) fn initialize(
        &self,
        interrupted_at: &str,
    ) -> WorkspaceStoreResult<WorkspaceStartupRecovery> {
        require_non_empty("interrupted_at", interrupted_at)?;
        let transaction = self.connection.unchecked_transaction()?;
        let transfers_interrupted = transaction.execute(
            "UPDATE workspace_transfers \
             SET state = 'interrupted', error_code = 'app-restarted', error_detail = NULL, \
                 updated_at = ?1, revision = revision + 1 \
             WHERE state IN ('running', 'finalizing')",
            [interrupted_at],
        )?;
        let items_interrupted = transaction.execute(
            "UPDATE workspace_transfer_items \
             SET state = 'interrupted', error_code = 'app-restarted', error_detail = NULL, \
                 updated_at = ?1, revision = revision + 1 \
             WHERE state IN ('running', 'finalizing')",
            [interrupted_at],
        )?;
        transaction.commit()?;
        Ok(WorkspaceStartupRecovery {
            transfers_interrupted,
            items_interrupted,
        })
    }

    pub(crate) fn create_transfer(
        &self,
        transfer: &WorkspaceTransfer,
    ) -> WorkspaceStoreResult<WorkspaceTransfer> {
        validate_transfer(transfer)?;
        if transfer.revision != 0 {
            return Err(WorkspaceStoreError::InvalidInput(
                "new transfer revision must be zero".into(),
            ));
        }
        self.connection.execute(
            "INSERT INTO workspace_transfers(\
                id, batch_id, host_id, host_name, host_alias, direction, source_locator, target_locator, state, \
                conflict_policy, conflict_revision, bytes_transferred, total_bytes, attempt, resumable, \
                partial_locator, source_fingerprint, target_fingerprint, checksum_sha256, error_code, \
                error_detail, task_id, created_at, updated_at, revision\
             ) VALUES(\
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, \
                ?18, ?19, ?20, ?21, ?22, ?23, ?24, 0\
             )",
            params![
                transfer.id,
                transfer.batch_id,
                transfer.host_id,
                transfer.host_name,
                transfer.host_alias,
                transfer.direction,
                transfer.source_locator,
                transfer.target_locator,
                transfer.state,
                transfer.conflict_policy,
                transfer.conflict_revision,
                transfer.bytes_transferred,
                transfer.total_bytes,
                transfer.attempt,
                transfer.resumable,
                transfer.partial_locator,
                transfer.source_fingerprint,
                transfer.target_fingerprint,
                transfer.checksum_sha256,
                transfer.error_code,
                transfer.error_detail,
                transfer.task_id,
                transfer.created_at,
                transfer.updated_at,
            ],
        )?;
        self.require_transfer(&transfer.id)
    }

    pub(crate) fn get_transfer(&self, id: &str) -> WorkspaceStoreResult<Option<WorkspaceTransfer>> {
        require_non_empty("transfer id", id)?;
        let sql = format!("SELECT {TRANSFER_COLUMNS} FROM workspace_transfers WHERE id = ?1");
        self.connection
            .query_row(&sql, [id], map_transfer)
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn list_transfers(
        &self,
        limit: usize,
    ) -> WorkspaceStoreResult<Vec<WorkspaceTransfer>> {
        let limit = checked_limit(limit)?;
        let sql = format!(
            "SELECT {TRANSFER_COLUMNS} FROM workspace_transfers \
             ORDER BY updated_at DESC, id DESC LIMIT ?1"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map([limit], map_transfer)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(crate) fn update_transfer(
        &self,
        id: &str,
        update: &WorkspaceTransferUpdate,
    ) -> WorkspaceStoreResult<WorkspaceTransfer> {
        validate_transfer_update(id, update)?;
        let changed = self.connection.execute(
            "UPDATE workspace_transfers SET \
                state = ?2, conflict_policy = ?3, conflict_revision = ?4, bytes_transferred = ?5, \
                total_bytes = ?6, attempt = ?7, resumable = ?8, partial_locator = ?9, \
                source_fingerprint = ?10, target_fingerprint = ?11, checksum_sha256 = ?12, \
                error_code = ?13, error_detail = ?14, task_id = ?15, updated_at = ?16, \
                revision = revision + 1 \
             WHERE id = ?1 AND revision = ?17",
            params![
                id,
                update.state,
                update.conflict_policy,
                update.conflict_revision,
                update.bytes_transferred,
                update.total_bytes,
                update.attempt,
                update.resumable,
                update.partial_locator,
                update.source_fingerprint,
                update.target_fingerprint,
                update.checksum_sha256,
                update.error_code,
                update.error_detail,
                update.task_id,
                update.updated_at,
                update.expected_revision,
            ],
        )?;
        ensure_revision_write(
            self.connection,
            "transfer",
            "workspace_transfers",
            id,
            update.expected_revision,
            changed,
        )?;
        self.require_transfer(id)
    }

    pub(crate) fn delete_transfer(
        &self,
        id: &str,
        expected_revision: i64,
    ) -> WorkspaceStoreResult<()> {
        validate_revision(id, expected_revision, "transfer")?;
        let changed = self.connection.execute(
            "DELETE FROM workspace_transfers WHERE id = ?1 AND revision = ?2",
            params![id, expected_revision],
        )?;
        ensure_revision_write(
            self.connection,
            "transfer",
            "workspace_transfers",
            id,
            expected_revision,
            changed,
        )
    }

    pub(crate) fn create_transfer_item(
        &self,
        item: &WorkspaceTransferItem,
    ) -> WorkspaceStoreResult<WorkspaceTransferItem> {
        validate_transfer_item(item)?;
        if item.revision != 0 {
            return Err(WorkspaceStoreError::InvalidInput(
                "new transfer item revision must be zero".into(),
            ));
        }
        self.connection.execute(
            "INSERT INTO workspace_transfer_items(\
                id, transfer_id, ordinal, entry_kind, source_locator, target_locator, state, \
                bytes_transferred, total_bytes, partial_locator, source_fingerprint, target_fingerprint, \
                checksum_sha256, error_code, error_detail, created_at, updated_at, revision\
             ) VALUES(\
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 0\
             )",
            params![
                item.id,
                item.transfer_id,
                item.ordinal,
                item.entry_kind,
                item.source_locator,
                item.target_locator,
                item.state,
                item.bytes_transferred,
                item.total_bytes,
                item.partial_locator,
                item.source_fingerprint,
                item.target_fingerprint,
                item.checksum_sha256,
                item.error_code,
                item.error_detail,
                item.created_at,
                item.updated_at,
            ],
        )?;
        self.require_transfer_item(&item.id)
    }

    pub(crate) fn get_transfer_item(
        &self,
        id: &str,
    ) -> WorkspaceStoreResult<Option<WorkspaceTransferItem>> {
        require_non_empty("transfer item id", id)?;
        let sql =
            format!("SELECT {TRANSFER_ITEM_COLUMNS} FROM workspace_transfer_items WHERE id = ?1");
        self.connection
            .query_row(&sql, [id], map_transfer_item)
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn list_transfer_items(
        &self,
        transfer_id: &str,
        limit: usize,
    ) -> WorkspaceStoreResult<Vec<WorkspaceTransferItem>> {
        require_non_empty("transfer id", transfer_id)?;
        let limit = checked_limit(limit)?;
        let sql = format!(
            "SELECT {TRANSFER_ITEM_COLUMNS} FROM workspace_transfer_items \
             WHERE transfer_id = ?1 ORDER BY ordinal, id LIMIT ?2"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map(params![transfer_id, limit], map_transfer_item)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(crate) fn update_transfer_item(
        &self,
        id: &str,
        update: &WorkspaceTransferItemUpdate,
    ) -> WorkspaceStoreResult<WorkspaceTransferItem> {
        validate_transfer_item_update(id, update)?;
        let changed = self.connection.execute(
            "UPDATE workspace_transfer_items SET \
                state = ?2, bytes_transferred = ?3, total_bytes = ?4, partial_locator = ?5, \
                source_fingerprint = ?6, target_fingerprint = ?7, checksum_sha256 = ?8, \
                error_code = ?9, error_detail = ?10, updated_at = ?11, revision = revision + 1 \
             WHERE id = ?1 AND revision = ?12",
            params![
                id,
                update.state,
                update.bytes_transferred,
                update.total_bytes,
                update.partial_locator,
                update.source_fingerprint,
                update.target_fingerprint,
                update.checksum_sha256,
                update.error_code,
                update.error_detail,
                update.updated_at,
                update.expected_revision,
            ],
        )?;
        ensure_revision_write(
            self.connection,
            "transfer item",
            "workspace_transfer_items",
            id,
            update.expected_revision,
            changed,
        )?;
        self.require_transfer_item(id)
    }

    pub(crate) fn delete_transfer_item(
        &self,
        id: &str,
        expected_revision: i64,
    ) -> WorkspaceStoreResult<()> {
        validate_revision(id, expected_revision, "transfer item")?;
        let changed = self.connection.execute(
            "DELETE FROM workspace_transfer_items WHERE id = ?1 AND revision = ?2",
            params![id, expected_revision],
        )?;
        ensure_revision_write(
            self.connection,
            "transfer item",
            "workspace_transfer_items",
            id,
            expected_revision,
            changed,
        )
    }

    pub(crate) fn create_recovery(
        &self,
        recovery: &WorkspaceRecovery,
    ) -> WorkspaceStoreResult<WorkspaceRecovery> {
        validate_recovery(recovery)?;
        if recovery.revision != 0 {
            return Err(WorkspaceStoreError::InvalidInput(
                "new recovery revision must be zero".into(),
            ));
        }
        self.connection.execute(
            "INSERT INTO workspace_recoveries(\
                id, host_id, host_alias, operation_kind, state, source_locator, target_locator, \
                backup_locator, source_fingerprint, target_fingerprint, journal_json, error_code, \
                error_detail, task_id, created_at, updated_at, revision\
             ) VALUES(\
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0\
             )",
            params![
                recovery.id,
                recovery.host_id,
                recovery.host_alias,
                recovery.operation_kind,
                recovery.state,
                recovery.source_locator,
                recovery.target_locator,
                recovery.backup_locator,
                recovery.source_fingerprint,
                recovery.target_fingerprint,
                recovery.journal_json,
                recovery.error_code,
                recovery.error_detail,
                recovery.task_id,
                recovery.created_at,
                recovery.updated_at,
            ],
        )?;
        self.require_recovery(&recovery.id)
    }

    pub(crate) fn get_recovery(&self, id: &str) -> WorkspaceStoreResult<Option<WorkspaceRecovery>> {
        require_non_empty("recovery id", id)?;
        let sql = format!("SELECT {RECOVERY_COLUMNS} FROM workspace_recoveries WHERE id = ?1");
        self.connection
            .query_row(&sql, [id], map_recovery)
            .optional()
            .map_err(Into::into)
    }

    pub(crate) fn list_recoveries(
        &self,
        limit: usize,
    ) -> WorkspaceStoreResult<Vec<WorkspaceRecovery>> {
        let limit = checked_limit(limit)?;
        let sql = format!(
            "SELECT {RECOVERY_COLUMNS} FROM workspace_recoveries \
             ORDER BY updated_at DESC, id DESC LIMIT ?1"
        );
        let mut statement = self.connection.prepare(&sql)?;
        let rows = statement.query_map([limit], map_recovery)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    pub(crate) fn update_recovery(
        &self,
        id: &str,
        update: &WorkspaceRecoveryUpdate,
    ) -> WorkspaceStoreResult<WorkspaceRecovery> {
        validate_recovery_update(id, update)?;
        let changed = self.connection.execute(
            "UPDATE workspace_recoveries SET \
                state = ?2, target_locator = ?3, backup_locator = ?4, source_fingerprint = ?5, \
                target_fingerprint = ?6, journal_json = ?7, error_code = ?8, error_detail = ?9, \
                task_id = ?10, updated_at = ?11, revision = revision + 1 \
             WHERE id = ?1 AND revision = ?12",
            params![
                id,
                update.state,
                update.target_locator,
                update.backup_locator,
                update.source_fingerprint,
                update.target_fingerprint,
                update.journal_json,
                update.error_code,
                update.error_detail,
                update.task_id,
                update.updated_at,
                update.expected_revision,
            ],
        )?;
        ensure_revision_write(
            self.connection,
            "recovery",
            "workspace_recoveries",
            id,
            update.expected_revision,
            changed,
        )?;
        self.require_recovery(id)
    }

    pub(crate) fn delete_recovery(
        &self,
        id: &str,
        expected_revision: i64,
    ) -> WorkspaceStoreResult<()> {
        validate_revision(id, expected_revision, "recovery")?;
        let changed = self.connection.execute(
            "DELETE FROM workspace_recoveries WHERE id = ?1 AND revision = ?2",
            params![id, expected_revision],
        )?;
        ensure_revision_write(
            self.connection,
            "recovery",
            "workspace_recoveries",
            id,
            expected_revision,
            changed,
        )
    }

    fn require_transfer(&self, id: &str) -> WorkspaceStoreResult<WorkspaceTransfer> {
        self.get_transfer(id)?
            .ok_or_else(|| WorkspaceStoreError::NotFound {
                entity: "transfer",
                id: id.into(),
            })
    }

    fn require_transfer_item(&self, id: &str) -> WorkspaceStoreResult<WorkspaceTransferItem> {
        self.get_transfer_item(id)?
            .ok_or_else(|| WorkspaceStoreError::NotFound {
                entity: "transfer item",
                id: id.into(),
            })
    }

    fn require_recovery(&self, id: &str) -> WorkspaceStoreResult<WorkspaceRecovery> {
        self.get_recovery(id)?
            .ok_or_else(|| WorkspaceStoreError::NotFound {
                entity: "recovery",
                id: id.into(),
            })
    }
}

fn map_transfer(row: &Row<'_>) -> rusqlite::Result<WorkspaceTransfer> {
    Ok(WorkspaceTransfer {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        host_id: row.get(2)?,
        host_name: row.get(3)?,
        host_alias: row.get(4)?,
        direction: row.get(5)?,
        source_locator: row.get(6)?,
        target_locator: row.get(7)?,
        state: row.get(8)?,
        conflict_policy: row.get(9)?,
        conflict_revision: row.get(10)?,
        bytes_transferred: row.get(11)?,
        total_bytes: row.get(12)?,
        attempt: row.get(13)?,
        resumable: row.get(14)?,
        partial_locator: row.get(15)?,
        source_fingerprint: row.get(16)?,
        target_fingerprint: row.get(17)?,
        checksum_sha256: row.get(18)?,
        error_code: row.get(19)?,
        error_detail: row.get(20)?,
        task_id: row.get(21)?,
        created_at: row.get(22)?,
        updated_at: row.get(23)?,
        revision: row.get(24)?,
    })
}

fn map_transfer_item(row: &Row<'_>) -> rusqlite::Result<WorkspaceTransferItem> {
    Ok(WorkspaceTransferItem {
        id: row.get(0)?,
        transfer_id: row.get(1)?,
        ordinal: row.get(2)?,
        entry_kind: row.get(3)?,
        source_locator: row.get(4)?,
        target_locator: row.get(5)?,
        state: row.get(6)?,
        bytes_transferred: row.get(7)?,
        total_bytes: row.get(8)?,
        partial_locator: row.get(9)?,
        source_fingerprint: row.get(10)?,
        target_fingerprint: row.get(11)?,
        checksum_sha256: row.get(12)?,
        error_code: row.get(13)?,
        error_detail: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
        revision: row.get(17)?,
    })
}

fn map_recovery(row: &Row<'_>) -> rusqlite::Result<WorkspaceRecovery> {
    Ok(WorkspaceRecovery {
        id: row.get(0)?,
        host_id: row.get(1)?,
        host_alias: row.get(2)?,
        operation_kind: row.get(3)?,
        state: row.get(4)?,
        source_locator: row.get(5)?,
        target_locator: row.get(6)?,
        backup_locator: row.get(7)?,
        source_fingerprint: row.get(8)?,
        target_fingerprint: row.get(9)?,
        journal_json: row.get(10)?,
        error_code: row.get(11)?,
        error_detail: row.get(12)?,
        task_id: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
        revision: row.get(16)?,
    })
}

fn ensure_revision_write(
    connection: &Connection,
    entity: &'static str,
    table: &'static str,
    id: &str,
    expected: i64,
    changed: usize,
) -> WorkspaceStoreResult<()> {
    if changed == 1 {
        return Ok(());
    }
    let sql = format!("SELECT revision FROM {table} WHERE id = ?1");
    let actual = connection
        .query_row(&sql, [id], |row| row.get::<_, i64>(0))
        .optional()?;
    match actual {
        Some(actual) => Err(WorkspaceStoreError::RevisionConflict {
            entity,
            id: id.into(),
            expected,
            actual,
        }),
        None => Err(WorkspaceStoreError::NotFound {
            entity,
            id: id.into(),
        }),
    }
}

fn require_non_empty(name: &str, value: &str) -> WorkspaceStoreResult<()> {
    if value.trim().is_empty() {
        Err(WorkspaceStoreError::InvalidInput(format!(
            "{name} must not be empty"
        )))
    } else {
        Ok(())
    }
}

fn require_non_negative(name: &str, value: i64) -> WorkspaceStoreResult<()> {
    if value < 0 {
        Err(WorkspaceStoreError::InvalidInput(format!(
            "{name} must be non-negative"
        )))
    } else {
        Ok(())
    }
}

fn validate_revision(id: &str, revision: i64, entity: &str) -> WorkspaceStoreResult<()> {
    require_non_empty(&format!("{entity} id"), id)?;
    require_non_negative("expected revision", revision)
}

fn checked_limit(limit: usize) -> WorkspaceStoreResult<i64> {
    if !(1..=MAX_LIST_LIMIT).contains(&limit) {
        return Err(WorkspaceStoreError::InvalidInput(format!(
            "list limit must be between 1 and {MAX_LIST_LIMIT}"
        )));
    }
    Ok(limit as i64)
}

fn validate_transfer(transfer: &WorkspaceTransfer) -> WorkspaceStoreResult<()> {
    for (name, value) in [
        ("transfer id", transfer.id.as_str()),
        ("batch id", transfer.batch_id.as_str()),
        ("host id", transfer.host_id.as_str()),
        ("host name", transfer.host_name.as_str()),
        ("host alias", transfer.host_alias.as_str()),
        ("source locator", transfer.source_locator.as_str()),
        ("target locator", transfer.target_locator.as_str()),
        ("created_at", transfer.created_at.as_str()),
        ("updated_at", transfer.updated_at.as_str()),
    ] {
        require_non_empty(name, value)?;
    }
    require_non_negative("conflict revision", transfer.conflict_revision)?;
    require_non_negative("bytes transferred", transfer.bytes_transferred)?;
    require_optional_non_negative("total bytes", transfer.total_bytes)?;
    require_non_negative("attempt", transfer.attempt)
}

fn validate_transfer_update(
    id: &str,
    update: &WorkspaceTransferUpdate,
) -> WorkspaceStoreResult<()> {
    validate_revision(id, update.expected_revision, "transfer")?;
    require_non_empty("updated_at", &update.updated_at)?;
    require_non_negative("conflict revision", update.conflict_revision)?;
    require_non_negative("bytes transferred", update.bytes_transferred)?;
    require_optional_non_negative("total bytes", update.total_bytes)?;
    require_non_negative("attempt", update.attempt)
}

fn validate_transfer_item(item: &WorkspaceTransferItem) -> WorkspaceStoreResult<()> {
    for (name, value) in [
        ("transfer item id", item.id.as_str()),
        ("transfer id", item.transfer_id.as_str()),
        ("source locator", item.source_locator.as_str()),
        ("target locator", item.target_locator.as_str()),
        ("created_at", item.created_at.as_str()),
        ("updated_at", item.updated_at.as_str()),
    ] {
        require_non_empty(name, value)?;
    }
    require_non_negative("ordinal", item.ordinal)?;
    require_non_negative("bytes transferred", item.bytes_transferred)?;
    require_optional_non_negative("total bytes", item.total_bytes)
}

fn validate_transfer_item_update(
    id: &str,
    update: &WorkspaceTransferItemUpdate,
) -> WorkspaceStoreResult<()> {
    validate_revision(id, update.expected_revision, "transfer item")?;
    require_non_empty("updated_at", &update.updated_at)?;
    require_non_negative("bytes transferred", update.bytes_transferred)?;
    require_optional_non_negative("total bytes", update.total_bytes)
}

fn validate_recovery(recovery: &WorkspaceRecovery) -> WorkspaceStoreResult<()> {
    for (name, value) in [
        ("recovery id", recovery.id.as_str()),
        ("host id", recovery.host_id.as_str()),
        ("host alias", recovery.host_alias.as_str()),
        ("source locator", recovery.source_locator.as_str()),
        ("backup locator", recovery.backup_locator.as_str()),
        ("source fingerprint", recovery.source_fingerprint.as_str()),
        ("journal", recovery.journal_json.as_str()),
        ("created_at", recovery.created_at.as_str()),
        ("updated_at", recovery.updated_at.as_str()),
    ] {
        require_non_empty(name, value)?;
    }
    Ok(())
}

fn validate_recovery_update(
    id: &str,
    update: &WorkspaceRecoveryUpdate,
) -> WorkspaceStoreResult<()> {
    validate_revision(id, update.expected_revision, "recovery")?;
    require_non_empty("backup locator", &update.backup_locator)?;
    require_non_empty("source fingerprint", &update.source_fingerprint)?;
    require_non_empty("journal", &update.journal_json)?;
    require_non_empty("updated_at", &update.updated_at)
}

fn require_optional_non_negative(name: &str, value: Option<i64>) -> WorkspaceStoreResult<()> {
    match value {
        Some(value) => require_non_negative(name, value),
        None => Ok(()),
    }
}

fn transfer_to_dto(value: &WorkspaceTransfer) -> TransferDto {
    TransferDto {
        transfer_id: value.id.clone(),
        batch_id: value.batch_id.clone(),
        task_id: value.task_id.clone(),
        direction: parse_direction(&value.direction),
        host_id: value.host_id.clone(),
        host_name: value.host_name.clone(),
        host_alias: value.host_alias.clone(),
        source_ref: value.source_locator.clone(),
        destination_path: value.target_locator.clone(),
        state: parse_transfer_state(&value.state),
        revision: value.revision as u64,
        bytes: value.bytes_transferred as u64,
        total: value.total_bytes.map(|value| value as u64),
        speed: None,
        eta_seconds: None,
        attempt: value.attempt.min(u8::MAX as i64) as u8,
        resumable: value.resumable,
        resume_offset: value
            .partial_locator
            .as_ref()
            .and_then(|_| Some(value.bytes_transferred as u64)),
        conflict_strategy: parse_conflict_strategy(&value.conflict_policy),
        conflict_revision: if value.state == "waiting-conflict" {
            Some(value.conflict_revision as u64)
        } else {
            None
        },
        error_code: value.error_code.clone(),
        fingerprint_status: value
            .source_fingerprint
            .as_ref()
            .map(|_| "source-verified".to_string()),
        durable_source_fingerprint: value.source_fingerprint.clone(),
        durable_partial_locator: value.partial_locator.clone(),
    }
}

fn dto_to_transfer(value: &TransferDto) -> Result<WorkspaceTransfer, String> {
    let now = Local::now().to_rfc3339();
    Ok(WorkspaceTransfer {
        id: value.transfer_id.clone(),
        batch_id: value.batch_id.clone(),
        host_id: value.host_id.clone(),
        host_name: value.host_name.clone(),
        host_alias: value.host_alias.clone(),
        direction: direction_label(value.direction).into(),
        source_locator: value.source_ref.clone(),
        target_locator: value.destination_path.clone(),
        state: transfer_state_label(value.state).into(),
        conflict_policy: conflict_strategy_label(value.conflict_strategy).into(),
        conflict_revision: optional_u64_to_i64(value.conflict_revision, "conflict revision")?
            .unwrap_or(0),
        bytes_transferred: u64_to_i64(value.bytes, "bytes")?,
        total_bytes: optional_u64_to_i64(value.total, "total bytes")?,
        attempt: i64::from(value.attempt),
        resumable: value.resumable,
        partial_locator: value.durable_partial_locator.clone(),
        source_fingerprint: value.durable_source_fingerprint.clone(),
        target_fingerprint: None,
        checksum_sha256: None,
        error_code: value.error_code.clone(),
        error_detail: None,
        task_id: value.task_id.clone(),
        created_at: now.clone(),
        updated_at: now,
        revision: 0,
    })
}

fn dto_to_transfer_update(
    value: &TransferDto,
    existing: &WorkspaceTransfer,
) -> Result<WorkspaceTransferUpdate, String> {
    Ok(WorkspaceTransferUpdate {
        expected_revision: existing.revision,
        state: transfer_state_label(value.state).into(),
        conflict_policy: conflict_strategy_label(value.conflict_strategy).into(),
        conflict_revision: optional_u64_to_i64(value.conflict_revision, "conflict revision")?
            .unwrap_or(0),
        bytes_transferred: u64_to_i64(value.bytes, "bytes")?,
        total_bytes: optional_u64_to_i64(value.total, "total bytes")?,
        attempt: i64::from(value.attempt),
        resumable: value.resumable,
        partial_locator: value.durable_partial_locator.clone(),
        source_fingerprint: value.durable_source_fingerprint.clone(),
        target_fingerprint: existing.target_fingerprint.clone(),
        checksum_sha256: existing.checksum_sha256.clone(),
        error_code: value.error_code.clone(),
        error_detail: None,
        task_id: value.task_id.clone(),
        updated_at: Local::now().to_rfc3339(),
    })
}

fn recovery_to_dto(value: &WorkspaceRecovery) -> RecoveryDto {
    let journal = recovery_journal(&value.journal_json);
    RecoveryDto {
        recovery_id: value.id.clone(),
        host_id: value.host_id.clone(),
        host_alias: value.host_alias.clone(),
        kind: parse_file_operation_kind(&value.operation_kind),
        original_path: value.source_locator.clone(),
        current_path: value.target_locator.clone(),
        backup_path: if value.state == "purged" {
            None
        } else {
            Some(value.backup_locator.clone())
        },
        state: parse_recovery_state(&value.state),
        task_id: value.task_id.clone(),
        reason: value.error_code.clone(),
        created_at: value.created_at.clone(),
        restored_at: journal.restored_at,
        purged_at: journal.purged_at,
    }
}

fn dto_to_recovery(value: &RecoveryDto) -> WorkspaceRecovery {
    let now = Local::now().to_rfc3339();
    WorkspaceRecovery {
        id: value.recovery_id.clone(),
        host_id: value.host_id.clone(),
        host_alias: value.host_alias.clone(),
        operation_kind: file_operation_kind_label(value.kind).into(),
        state: recovery_state_label(value.state).into(),
        source_locator: value.original_path.clone(),
        target_locator: value.current_path.clone(),
        backup_locator: value.backup_path.clone().unwrap_or_default(),
        source_fingerprint: "recovery-journal".into(),
        target_fingerprint: None,
        journal_json: serialize_recovery_journal(value),
        error_code: value.reason.clone(),
        error_detail: None,
        task_id: value.task_id.clone(),
        created_at: value.created_at.clone(),
        updated_at: now,
        revision: 0,
    }
}

fn dto_to_recovery_update(
    value: &RecoveryDto,
    existing: &WorkspaceRecovery,
) -> WorkspaceRecoveryUpdate {
    WorkspaceRecoveryUpdate {
        expected_revision: existing.revision,
        state: recovery_state_label(value.state).into(),
        target_locator: value.current_path.clone(),
        backup_locator: value
            .backup_path
            .clone()
            .unwrap_or_else(|| existing.backup_locator.clone()),
        source_fingerprint: existing.source_fingerprint.clone(),
        target_fingerprint: existing.target_fingerprint.clone(),
        journal_json: serialize_recovery_journal(value),
        error_code: value.reason.clone(),
        error_detail: existing.error_detail.clone(),
        task_id: value.task_id.clone().or_else(|| existing.task_id.clone()),
        updated_at: Local::now().to_rfc3339(),
    }
}

#[derive(serde::Deserialize)]
struct RecoveryJournal {
    #[serde(default, rename = "restoredAt")]
    restored_at: Option<String>,
    #[serde(default, rename = "purgedAt")]
    purged_at: Option<String>,
}

fn recovery_journal(value: &str) -> RecoveryJournal {
    serde_json::from_str(value).unwrap_or(RecoveryJournal {
        restored_at: None,
        purged_at: None,
    })
}

fn serialize_recovery_journal(value: &RecoveryDto) -> String {
    serde_json::json!({
        "restoredAt": value.restored_at,
        "purgedAt": value.purged_at,
    })
    .to_string()
}

fn recovery_state_label(value: RecoveryState) -> &'static str {
    match value {
        RecoveryState::Prepared => "prepared",
        RecoveryState::Available => "available",
        RecoveryState::Restoring => "restoring",
        RecoveryState::Restored => "restored",
        RecoveryState::PurgePrepared => "purge-prepared",
        RecoveryState::Purged => "purged",
        RecoveryState::Failed => "failed",
    }
}

fn parse_recovery_state(value: &str) -> RecoveryState {
    match value {
        "prepared" => RecoveryState::Prepared,
        "available" => RecoveryState::Available,
        "restoring" => RecoveryState::Restoring,
        "restored" => RecoveryState::Restored,
        "purge-prepared" => RecoveryState::PurgePrepared,
        "purged" => RecoveryState::Purged,
        _ => RecoveryState::Failed,
    }
}

fn file_operation_kind_label(value: FileOperationKind) -> &'static str {
    match value {
        FileOperationKind::Delete => "delete",
        FileOperationKind::Rename => "rename",
        FileOperationKind::Overwrite => "overwrite",
    }
}

fn parse_file_operation_kind(value: &str) -> FileOperationKind {
    match value {
        "rename" => FileOperationKind::Rename,
        "overwrite" => FileOperationKind::Overwrite,
        _ => FileOperationKind::Delete,
    }
}

fn u64_to_i64(value: u64, label: &str) -> Result<i64, String> {
    i64::try_from(value)
        .map_err(|_| format!("Workspace {label} exceeds SQLite signed integer range."))
}

fn optional_u64_to_i64(value: Option<u64>, label: &str) -> Result<Option<i64>, String> {
    value.map(|value| u64_to_i64(value, label)).transpose()
}

fn direction_label(value: TransferDirection) -> &'static str {
    match value {
        TransferDirection::Upload => "upload",
        TransferDirection::Download => "download",
    }
}
fn parse_direction(value: &str) -> TransferDirection {
    match value {
        "download" => TransferDirection::Download,
        _ => TransferDirection::Upload,
    }
}
fn transfer_state_label(value: TransferState) -> &'static str {
    match value {
        TransferState::Queued => "queued",
        TransferState::Running => "running",
        TransferState::Pausing => "pausing",
        TransferState::Paused => "paused",
        TransferState::WaitingConflict => "waiting-conflict",
        TransferState::Verifying => "verifying",
        TransferState::Finalizing => "finalizing",
        TransferState::Completed => "completed",
        TransferState::Failed => "failed",
        TransferState::Cancelled => "cancelled",
        TransferState::Interrupted => "interrupted",
    }
}
fn parse_transfer_state(value: &str) -> TransferState {
    match value {
        "running" => TransferState::Running,
        "pausing" => TransferState::Pausing,
        "paused" => TransferState::Paused,
        "waiting-conflict" => TransferState::WaitingConflict,
        "verifying" => TransferState::Verifying,
        "finalizing" => TransferState::Finalizing,
        "completed" => TransferState::Completed,
        "failed" => TransferState::Failed,
        "cancelled" => TransferState::Cancelled,
        "interrupted" => TransferState::Interrupted,
        _ => TransferState::Queued,
    }
}
fn conflict_strategy_label(value: ConflictStrategy) -> &'static str {
    match value {
        ConflictStrategy::Ask => "ask",
        ConflictStrategy::Skip => "skip",
        ConflictStrategy::KeepBoth => "keep-both",
        ConflictStrategy::ReplaceWithBackup => "replace-with-backup",
    }
}
fn parse_conflict_strategy(value: &str) -> ConflictStrategy {
    match value {
        "skip" => ConflictStrategy::Skip,
        "keep-both" => ConflictStrategy::KeepBoth,
        "replace-with-backup" => ConflictStrategy::ReplaceWithBackup,
        _ => ConflictStrategy::Ask,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch(
                r#"
                PRAGMA foreign_keys = ON;
                CREATE TABLE task_runs (
                    id TEXT PRIMARY KEY,
                    host_id TEXT NOT NULL,
                    host_name TEXT NOT NULL,
                    action TEXT NOT NULL,
                    status TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    summary TEXT NOT NULL,
                    acknowledged_at TEXT
                );
                PRAGMA user_version = 4;
                "#,
            )
            .expect("create task fixture");
        WorkspaceStore::migrate(&mut connection, "2026-07-30T00:00:00Z")
            .expect("migrate workspace schema");
        connection
    }

    fn task(connection: &Connection, id: &str) {
        connection
            .execute(
                "INSERT INTO task_runs(\
                    id, host_id, host_name, action, status, started_at, summary\
                 ) VALUES(?1, 'host-1', 'Server', 'Transfer', 'running', 'now', 'Transfer')",
                [id],
            )
            .expect("insert task");
    }

    fn transfer(id: &str, state: &str, task_id: Option<&str>) -> WorkspaceTransfer {
        WorkspaceTransfer {
            id: id.into(),
            batch_id: "batch-1".into(),
            host_id: "host-1".into(),
            host_name: "Server".into(),
            host_alias: "server".into(),
            direction: "upload".into(),
            source_locator: "local-grant:1".into(),
            target_locator: "/tmp/file".into(),
            state: state.into(),
            conflict_policy: "ask".into(),
            conflict_revision: 0,
            bytes_transferred: 0,
            total_bytes: Some(10),
            attempt: 1,
            resumable: true,
            partial_locator: Some("/tmp/.codexhub-part-transfer-1".into()),
            source_fingerprint: Some("source-v1".into()),
            target_fingerprint: None,
            checksum_sha256: None,
            error_code: None,
            error_detail: None,
            task_id: task_id.map(str::to_string),
            created_at: "2026-07-30T00:00:00Z".into(),
            updated_at: "2026-07-30T00:00:00Z".into(),
            revision: 0,
        }
    }

    fn item(id: &str, transfer_id: &str, state: &str) -> WorkspaceTransferItem {
        WorkspaceTransferItem {
            id: id.into(),
            transfer_id: transfer_id.into(),
            ordinal: 0,
            entry_kind: "file".into(),
            source_locator: "local-grant:1".into(),
            target_locator: "/tmp/file".into(),
            state: state.into(),
            bytes_transferred: 0,
            total_bytes: Some(10),
            partial_locator: Some("/tmp/.codexhub-part-transfer-1".into()),
            source_fingerprint: Some("source-v1".into()),
            target_fingerprint: None,
            checksum_sha256: None,
            error_code: None,
            error_detail: None,
            created_at: "2026-07-30T00:00:00Z".into(),
            updated_at: "2026-07-30T00:00:00Z".into(),
            revision: 0,
        }
    }

    fn recovery(id: &str, task_id: Option<&str>) -> WorkspaceRecovery {
        WorkspaceRecovery {
            id: id.into(),
            host_id: "host-1".into(),
            host_alias: "server".into(),
            operation_kind: "delete".into(),
            state: "available".into(),
            source_locator: "/tmp/file".into(),
            target_locator: None,
            backup_locator: "/tmp/.codexhub-workspace-backups/recovery-1/file".into(),
            source_fingerprint: "source-v1".into(),
            target_fingerprint: None,
            journal_json: "{}".into(),
            error_code: None,
            error_detail: None,
            task_id: task_id.map(str::to_string),
            created_at: "2026-07-30T00:00:00Z".into(),
            updated_at: "2026-07-30T00:00:00Z".into(),
            revision: 0,
        }
    }

    #[test]
    fn migration_is_idempotent_and_does_not_claim_task_schema_version() {
        let mut connection = connection();
        WorkspaceStore::migrate(&mut connection, "later").expect("repeat migration");
        let user_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .expect("read user version");
        let migration_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM workspace_schema_migrations",
                [],
                |row| row.get(0),
            )
            .expect("count workspace migrations");
        assert_eq!(user_version, 4);
        assert_eq!(migration_count, 2);
    }

    #[test]
    fn task_retention_clears_links_without_removing_workspace_records() {
        let connection = connection();
        task(&connection, "task-1");
        let store = WorkspaceStore::new(&connection);
        store
            .create_transfer(&transfer("transfer-1", "queued", Some("task-1")))
            .expect("create transfer");
        store
            .create_recovery(&recovery("recovery-1", Some("task-1")))
            .expect("create recovery");
        connection
            .execute("DELETE FROM task_runs WHERE id = 'task-1'", [])
            .expect("delete retained task");
        assert_eq!(
            store.get_transfer("transfer-1").unwrap().unwrap().task_id,
            None
        );
        assert_eq!(
            store.get_recovery("recovery-1").unwrap().unwrap().task_id,
            None
        );
    }

    #[test]
    fn startup_converges_only_unrecoverable_active_states() {
        let connection = connection();
        let store = WorkspaceStore::new(&connection);
        store
            .create_transfer(&transfer("transfer-running", "running", None))
            .unwrap();
        store
            .create_transfer_item(&item("item-running", "transfer-running", "running"))
            .unwrap();
        store
            .create_transfer(&transfer("transfer-queued", "queued", None))
            .unwrap();
        let result = store.initialize("2026-07-30T01:00:00Z").unwrap();
        assert_eq!(
            result,
            WorkspaceStartupRecovery {
                transfers_interrupted: 1,
                items_interrupted: 1
            }
        );
        let running = store.get_transfer("transfer-running").unwrap().unwrap();
        assert_eq!(running.state, "interrupted");
        assert_eq!(running.error_code.as_deref(), Some("app-restarted"));
        assert_eq!(running.revision, 1);
        assert_eq!(
            store
                .get_transfer("transfer-queued")
                .unwrap()
                .unwrap()
                .state,
            "queued"
        );
    }

    #[test]
    fn transfer_updates_use_revision_optimistic_concurrency() {
        let connection = connection();
        let store = WorkspaceStore::new(&connection);
        store
            .create_transfer(&transfer("transfer-1", "queued", None))
            .unwrap();
        let update = WorkspaceTransferUpdate {
            expected_revision: 0,
            state: "running".into(),
            conflict_policy: "ask".into(),
            conflict_revision: 0,
            bytes_transferred: 4,
            total_bytes: Some(10),
            attempt: 1,
            resumable: true,
            partial_locator: Some("partial".into()),
            source_fingerprint: Some("source-v1".into()),
            target_fingerprint: None,
            checksum_sha256: None,
            error_code: None,
            error_detail: None,
            task_id: None,
            updated_at: "2026-07-30T00:00:01Z".into(),
        };
        let updated = store.update_transfer("transfer-1", &update).unwrap();
        assert_eq!(updated.revision, 1);
        assert_eq!(updated.bytes_transferred, 4);
        assert!(matches!(
            store.update_transfer("transfer-1", &update),
            Err(WorkspaceStoreError::RevisionConflict {
                expected: 0,
                actual: 1,
                ..
            })
        ));
    }

    #[test]
    fn transfer_delete_cascades_items_and_checks_revision() {
        let connection = connection();
        let store = WorkspaceStore::new(&connection);
        store
            .create_transfer(&transfer("transfer-1", "queued", None))
            .unwrap();
        store
            .create_transfer_item(&item("item-1", "transfer-1", "queued"))
            .unwrap();
        assert!(matches!(
            store.delete_transfer("transfer-1", 1),
            Err(WorkspaceStoreError::RevisionConflict {
                expected: 1,
                actual: 0,
                ..
            })
        ));
        store.delete_transfer("transfer-1", 0).unwrap();
        assert!(store.get_transfer_item("item-1").unwrap().is_none());
    }

    #[test]
    fn recovery_crud_preserves_explicit_purge_state() {
        let connection = connection();
        let store = WorkspaceStore::new(&connection);
        store
            .create_recovery(&recovery("recovery-1", None))
            .unwrap();
        let updated = store
            .update_recovery(
                "recovery-1",
                &WorkspaceRecoveryUpdate {
                    expected_revision: 0,
                    state: "purge-prepared".into(),
                    target_locator: None,
                    backup_locator: "/tmp/.codexhub-workspace-backups/recovery-1/file".into(),
                    source_fingerprint: "source-v1".into(),
                    target_fingerprint: None,
                    journal_json: "{\"purgeToken\":\"opaque\"}".into(),
                    error_code: None,
                    error_detail: None,
                    task_id: None,
                    updated_at: "2026-07-30T00:00:01Z".into(),
                },
            )
            .unwrap();
        assert_eq!(updated.state, "purge-prepared");
        assert_eq!(updated.revision, 1);
        store.delete_recovery("recovery-1", 1).unwrap();
        assert!(store.get_recovery("recovery-1").unwrap().is_none());
    }

    #[test]
    fn sqlite_transfer_persistence_round_trips_without_task_logs() {
        let persistence = WorkspaceSqliteTransferPersistence::in_memory();
        let dto = TransferDto {
            transfer_id: "transfer-persisted".into(),
            batch_id: "batch-persisted".into(),
            task_id: None,
            direction: TransferDirection::Upload,
            host_id: "host-1".into(),
            host_name: "Server".into(),
            host_alias: "server".into(),
            source_ref: "grant-1".into(),
            destination_path: "/tmp/file".into(),
            state: TransferState::Interrupted,
            revision: 1,
            bytes: 4,
            total: Some(10),
            speed: Some(100),
            eta_seconds: Some(1),
            attempt: 1,
            resumable: true,
            resume_offset: Some(4),
            conflict_strategy: ConflictStrategy::Ask,
            conflict_revision: None,
            error_code: Some("network".into()),
            fingerprint_status: Some("source-v1".into()),
            durable_source_fingerprint: Some("source-v1".into()),
            durable_partial_locator: Some("/tmp/.codexhub-part-transfer-persisted".into()),
        };
        persistence.upsert(&dto).expect("persist transfer");
        let loaded = persistence.load_all().expect("load transfer");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].batch_id, "batch-persisted");
        assert_eq!(loaded[0].host_name, "Server");
        assert_eq!(loaded[0].bytes, 4);
        assert_eq!(loaded[0].state, TransferState::Interrupted);
        assert_eq!(loaded[0].speed, None);
        assert_eq!(loaded[0].eta_seconds, None);
    }

    #[test]
    fn sqlite_recovery_persistence_round_trips_restore_and_purge_states() {
        let persistence = WorkspaceSqliteRecoveryPersistence::in_memory();
        persistence
            .connection
            .lock()
            .expect("lock recovery fixture")
            .execute("INSERT INTO task_runs(id) VALUES (?1)", ["task-123"])
            .expect("create task fixture");
        let mut recovery = RecoveryDto {
            recovery_id: "recovery-persisted".into(),
            host_id: "host-123".into(),
            host_alias: "server".into(),
            kind: FileOperationKind::Overwrite,
            original_path: "/srv/report.txt".into(),
            current_path: Some("/srv/report.txt".into()),
            backup_path: Some("/srv/.codexhub-workspace-backups/recovery-persisted/payload".into()),
            state: RecoveryState::Available,
            task_id: Some("task-123".into()),
            reason: None,
            created_at: "2026-07-30T00:00:00Z".into(),
            restored_at: None,
            purged_at: None,
        };
        persistence.upsert(&recovery).expect("persist recovery");
        let available = persistence
            .get("recovery-persisted")
            .expect("load recovery")
            .expect("stored recovery");
        assert_eq!(available.host_id, "host-123");
        assert_eq!(available.kind, FileOperationKind::Overwrite);
        assert_eq!(available.state, RecoveryState::Available);
        assert_eq!(available.task_id.as_deref(), Some("task-123"));
        assert_eq!(available.backup_path, recovery.backup_path);

        recovery.restored_at = Some("2026-07-30T00:01:00Z".into());
        recovery.state = RecoveryState::Restored;
        persistence
            .upsert(&recovery)
            .expect("persist restored recovery");
        let restored = persistence
            .get("recovery-persisted")
            .expect("load restored recovery")
            .expect("stored restored recovery");
        assert_eq!(restored.restored_at, recovery.restored_at);
        assert_eq!(restored.state, RecoveryState::Restored);
        assert!(restored.purged_at.is_none());

        recovery.purged_at = Some("2026-07-30T00:02:00Z".into());
        recovery.state = RecoveryState::Purged;
        persistence
            .upsert(&recovery)
            .expect("persist purged recovery");
        let listed = persistence.list_recoveries().expect("list recoveries");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].purged_at, recovery.purged_at);
        assert_eq!(listed[0].state, RecoveryState::Purged);
        assert_eq!(listed[0].backup_path, None);
    }
}
