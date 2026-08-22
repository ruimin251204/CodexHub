//! Launches a verified Workspace directory in the local VS Code client.
//!
//! Remote folders are passed as VS Code Remote-SSH folder URIs. The path and
//! host alias are never accepted directly from the WebView here; callers must
//! canonicalize them through the owning Files session first.

use super::background_process::configure_tokio_command;
use super::error::{WorkspaceError, WorkspaceResult};
use super::remote_path;
use crate::{platform, ssh};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::process::Command;
use url::Url;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum VscodeFolder {
    Local(PathBuf),
    Remote { host_alias: String, path: String },
}

pub(crate) async fn open_folder(folder: VscodeFolder) -> WorkspaceResult<()> {
    let uri = folder_uri(&folder)?;
    let program = vscode_cli().ok_or_else(|| {
        WorkspaceError::new(
            "vscode-not-found",
            "VS Code command-line launcher was not found on PATH.",
        )
    })?;
    let mut command = if is_batch_file(&program) {
        #[cfg(windows)]
        {
            let mut command = Command::new("cmd");
            command.args(["/D", "/C"]).arg(&program);
            command
        }
        #[cfg(not(windows))]
        {
            Command::new(&program)
        }
    } else {
        Command::new(&program)
    };
    configure_tokio_command(&mut command);
    command.arg("--new-window");
    #[cfg(windows)]
    command.arg(format!("--folder-uri={uri}"));
    #[cfg(not(windows))]
    command.arg("--folder-uri").arg(uri);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| WorkspaceError::new("vscode-launch-failed", error.to_string()))?;
    Ok(())
}

pub(crate) fn folder_uri(folder: &VscodeFolder) -> WorkspaceResult<String> {
    match folder {
        VscodeFolder::Local(path) => Url::from_file_path(path)
            .map(|url| url.to_string())
            .map_err(|_| {
                WorkspaceError::new(
                    "invalid-local-path",
                    "The local folder path cannot be converted to a VS Code URI.",
                )
            }),
        VscodeFolder::Remote { host_alias, path } => {
            let alias = ssh::validate_ssh_alias(host_alias).map_err(|_| {
                WorkspaceError::new("invalid-host-alias", "The SSH host alias is invalid.")
            })?;
            remote_path::validate_absolute(path)?;
            let encoded_path = encode_uri_path(path);
            // POSIX paths already begin with '/', while SFTP servers on
            // Windows may return a drive-qualified path such as 'C:/src'.
            // Keep the path outside the URI authority in both cases.
            let encoded_path = if encoded_path.starts_with('/') {
                encoded_path
            } else {
                format!("/{encoded_path}")
            };
            Ok(format!(
                "vscode-remote://ssh-remote+{}/{}",
                encode_uri_component(&alias),
                encoded_path.trim_start_matches('/')
            ))
        }
    }
}

fn encode_uri_path(path: &str) -> String {
    path.split('/')
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push('%');
            encoded.push(hex_digit(byte >> 4));
            encoded.push(hex_digit(byte & 0x0f));
        }
    }
    encoded
}

fn hex_digit(value: u8) -> char {
    match value {
        0..=9 => (b'0' + value) as char,
        _ => (b'A' + value - 10) as char,
    }
}

fn is_batch_file(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "cmd" | "bat"))
        .unwrap_or(false)
}

fn vscode_cli() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for command in ["code", "code-insiders"] {
        if let Some(path) = platform::command_path(command) {
            candidates.push(path);
        }
    }
    let home = platform::get_home_dir().ok();
    match platform::get_platform() {
        platform::RuntimePlatform::Windows => {
            if let Some(local_app_data) = env::var_os("LOCALAPPDATA") {
                for (directory, name) in [
                    ("Microsoft VS Code", "code.cmd"),
                    ("Microsoft VS Code Insiders", "code-insiders.cmd"),
                ] {
                    candidates.push(
                        PathBuf::from(&local_app_data)
                            .join("Programs")
                            .join(directory)
                            .join("bin")
                            .join(name),
                    );
                }
            }
            if let Some(program_files) = env::var_os("ProgramFiles") {
                for (directory, name) in [
                    ("Microsoft VS Code", "code.cmd"),
                    ("Microsoft VS Code Insiders", "code-insiders.cmd"),
                ] {
                    candidates.push(
                        PathBuf::from(&program_files)
                            .join(directory)
                            .join("bin")
                            .join(name),
                    );
                }
            }
            if let Some(program_files_x86) = env::var_os("ProgramFiles(x86)") {
                for (directory, name) in [
                    ("Microsoft VS Code", "code.cmd"),
                    ("Microsoft VS Code Insiders", "code-insiders.cmd"),
                ] {
                    candidates.push(
                        PathBuf::from(&program_files_x86)
                            .join(directory)
                            .join("bin")
                            .join(name),
                    );
                }
            }
        }
        platform::RuntimePlatform::MacOS => {
            candidates.extend([
                PathBuf::from("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
                PathBuf::from("/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code-insiders"),
            ]);
        }
        platform::RuntimePlatform::Linux => {
            candidates.extend([
                PathBuf::from("/usr/bin/code"),
                PathBuf::from("/usr/share/code/bin/code"),
                PathBuf::from("/snap/bin/code"),
            ]);
        }
    }
    if let Some(home) = home {
        candidates.extend([
            home.join(".local/bin/code"),
            home.join(".local/bin/code-insiders"),
        ]);
    }
    candidates.into_iter().find_map(resolve_cli_program)
}

fn resolve_cli_program(path: PathBuf) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    #[cfg(windows)]
    if path.extension().is_none() {
        // `where code` reports VS Code's POSIX shell script before code.cmd.
        // Windows CreateProcess cannot execute that extensionless script, even
        // though PowerShell can dispatch it through its own command resolver.
        // Resolve a native/batch sibling instead of returning a path that will
        // fail later with ERROR_BAD_EXE_FORMAT.
        for extension in ["exe", "cmd", "bat"] {
            if let Some(program) = resolve_cli_program(path.with_extension(extension)) {
                return Some(program);
            }
        }
        return None;
    }
    #[cfg(windows)]
    if is_batch_file(&path) {
        let executable_name = if path
            .file_stem()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("code-insiders"))
            .unwrap_or(false)
        {
            "Code - Insiders.exe"
        } else {
            "Code.exe"
        };
        if let Some(install_root) = path.parent().and_then(Path::parent) {
            let executable = install_root.join(executable_name);
            if executable.is_file() {
                return Some(executable);
            }
        }
    }
    Some(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn windows_extensionless_code_shim_resolves_to_native_launcher() {
        let root = std::env::temp_dir().join(format!("codexhub-vscode-{}", uuid::Uuid::new_v4()));
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).expect("create VS Code fixture");
        std::fs::write(bin.join("code"), b"#!/bin/sh\n").expect("write shell shim");
        std::fs::write(bin.join("code.cmd"), b"@echo off\r\n").expect("write batch shim");
        std::fs::write(root.join("Code.exe"), b"fixture").expect("write native launcher");

        let resolved = resolve_cli_program(bin.join("code")).expect("resolve native launcher");

        assert_eq!(resolved, root.join("Code.exe"));
        std::fs::remove_dir_all(root).expect("remove VS Code fixture");
    }

    #[test]
    fn remote_folder_uri_encodes_alias_and_path_segments() {
        let uri = folder_uri(&VscodeFolder::Remote {
            host_alias: "dev@box".into(),
            path: "/srv/my project".into(),
        })
        .expect("remote uri");
        assert_eq!(uri, "vscode-remote://ssh-remote+dev%40box/srv/my%20project");
    }

    #[test]
    fn remote_folder_uri_keeps_windows_drive_paths_outside_authority() {
        let uri = folder_uri(&VscodeFolder::Remote {
            host_alias: "dev".into(),
            path: "C:/workspace/project".into(),
        })
        .expect("remote uri");
        assert_eq!(uri, "vscode-remote://ssh-remote+dev/C%3A/workspace/project");
    }

    #[test]
    fn local_folder_uri_uses_file_scheme() {
        #[cfg(windows)]
        let path = PathBuf::from(r"C:\tmp\project");
        #[cfg(not(windows))]
        let path = PathBuf::from("/tmp/project");
        let uri = folder_uri(&VscodeFolder::Local(path)).expect("local uri");
        assert!(uri.starts_with("file:"));
        assert!(uri.contains("project"));
    }

    #[test]
    fn remote_folder_uri_rejects_traversal() {
        assert!(folder_uri(&VscodeFolder::Remote {
            host_alias: "dev".into(),
            path: "/srv/../secret".into(),
        })
        .is_err());
    }
}
