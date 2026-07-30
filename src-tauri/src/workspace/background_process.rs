#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Background SSH metadata channels must never open a console window from the
/// GUI process. Interactive terminals use portable-pty and bypass this helper.
pub(crate) fn configure_tokio_command(command: &mut tokio::process::Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    #[cfg(not(windows))]
    let _ = command;
}

pub(crate) fn configure_std_command(command: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}
