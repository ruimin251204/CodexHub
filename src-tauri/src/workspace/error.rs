use serde::Serialize;
use ts_rs::TS;

/// Workspace errors use stable codes so the frontend can choose recovery UI
/// without matching localized messages.
#[derive(Clone, Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(rename = "WorkspaceErrorDto")]
pub struct WorkspaceError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl WorkspaceError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn retryable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: true,
        }
    }
}

impl std::fmt::Display for WorkspaceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for WorkspaceError {}

pub type WorkspaceResult<T> = Result<T, WorkspaceError>;

pub(crate) fn internal(error: impl std::fmt::Display) -> WorkspaceError {
    WorkspaceError::new("workspace-internal", error.to_string())
}
