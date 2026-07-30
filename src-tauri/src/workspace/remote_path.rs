use super::error::{WorkspaceError, WorkspaceResult};

/// Workspace remote paths are POSIX protocol values even when CodexHub runs
/// on Windows. Keep all structural operations independent from host `Path`.
pub(crate) fn join(parent: &str, child: &str) -> WorkspaceResult<String> {
    validate_absolute(parent)?;
    if child.is_empty() || child == "." || child == ".." || child.contains(['/', '\0']) {
        return Err(WorkspaceError::new(
            "invalid-remote-path",
            "Remote child names must be one safe path segment.",
        ));
    }
    let parent = trim_trailing_slashes(parent);
    Ok(if parent == "/" {
        format!("/{child}")
    } else {
        format!("{parent}/{child}")
    })
}

pub(crate) fn parent(path: &str) -> WorkspaceResult<&str> {
    validate_absolute(path)?;
    let path = trim_trailing_slashes(path);
    if path == "/" {
        return Err(WorkspaceError::new(
            "invalid-remote-path",
            "The remote root has no parent.",
        ));
    }
    let separator = path
        .rfind('/')
        .ok_or_else(|| WorkspaceError::new("invalid-remote-path", "Remote path has no parent."))?;
    Ok(if separator == 0 {
        "/"
    } else {
        &path[..separator]
    })
}

pub(crate) fn file_name(path: &str) -> WorkspaceResult<&str> {
    validate_absolute(path)?;
    let path = trim_trailing_slashes(path);
    if path == "/" {
        return Err(WorkspaceError::new(
            "invalid-remote-path",
            "The remote root has no file name.",
        ));
    }
    path.rsplit('/')
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| WorkspaceError::new("invalid-remote-path", "Remote path has no file name."))
}

pub(crate) fn validate_absolute(path: &str) -> WorkspaceResult<()> {
    if !path.starts_with('/')
        || path.contains('\0')
        || path.split('/').any(|part| part == "." || part == "..")
    {
        return Err(WorkspaceError::new(
            "invalid-remote-path",
            "Remote paths must be absolute normalized POSIX paths.",
        ));
    }
    Ok(())
}

fn trim_trailing_slashes(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        "/"
    } else {
        trimmed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_keep_posix_separators_on_every_desktop_platform() {
        assert_eq!(
            join("/home/user", "projects").unwrap(),
            "/home/user/projects"
        );
        assert_eq!(join("/", "projects").unwrap(), "/projects");
        assert_eq!(parent("/home/user/projects").unwrap(), "/home/user");
        assert_eq!(parent("/projects").unwrap(), "/");
        assert_eq!(file_name("/home/user/projects").unwrap(), "projects");
    }

    #[test]
    fn remote_paths_reject_host_and_traversal_shapes() {
        for path in [
            "relative/path",
            "/home/../secret",
            "/home/./item",
            "/bad\0path",
        ] {
            assert!(validate_absolute(path).is_err(), "{path} must be rejected");
        }
        for child in ["", ".", "..", "nested/name"] {
            assert!(
                join("/home/user", child).is_err(),
                "{child} must be rejected"
            );
        }
    }
}
