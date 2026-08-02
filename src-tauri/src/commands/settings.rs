use crate::settings::{AppSettings, CloseButtonBehavior, SettingsSaveResult};
use crate::{
    detect_network_proxy_status, hide_main_window, read_settings, run_durable_local,
    write_settings, AppState, NetworkProxyStatus,
};
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;

trait LoginLaunchController {
    fn is_enabled(&self) -> Result<bool, String>;
    fn set_enabled(&self, enabled: bool) -> Result<(), String>;
}

/// Bridges Settings to the native startup registration supplied by Tauri.
struct TauriLoginLaunchController<'a> {
    app: &'a AppHandle,
}

impl LoginLaunchController for TauriLoginLaunchController<'_> {
    fn is_enabled(&self) -> Result<bool, String> {
        self.app
            .autolaunch()
            .is_enabled()
            .map_err(|error| format!("Could not inspect the system startup entry: {error}"))
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), String> {
        let result = if enabled {
            self.app.autolaunch().enable()
        } else {
            self.app.autolaunch().disable()
        };
        let action = if enabled { "enable" } else { "disable" };
        result.map_err(|error| format!("Could not {action} the system startup entry: {error}"))
    }
}

fn read_settings_with_login_launch(
    state: &AppState,
    login_launch: &impl LoginLaunchController,
) -> Result<AppSettings, String> {
    let mut settings = read_settings(&state.paths)?;
    // The OS registration is authoritative when it was changed outside CodexHub.
    settings.launch_at_login = login_launch.is_enabled()?;
    Ok(settings)
}

fn save_after_login_launch_change<T>(
    login_launch: &impl LoginLaunchController,
    desired_enabled: bool,
    save_settings: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let previously_enabled = login_launch.is_enabled()?;
    if previously_enabled != desired_enabled {
        // Enable/disable the native registration before committing the durable preference.
        login_launch.set_enabled(desired_enabled)?;
    }

    match save_settings() {
        Ok(saved) => Ok(saved),
        Err(error) => {
            if previously_enabled != desired_enabled {
                if let Err(rollback_error) = login_launch.set_enabled(previously_enabled) {
                    return Err(format!(
                        "{error} The system startup entry could not be restored: {rollback_error}"
                    ));
                }
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub(crate) fn get_settings(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AppSettings, String> {
    read_settings_with_login_launch(&state, &TauriLoginLaunchController { app: &app })
}

#[tauri::command]
pub(crate) fn save_settings(
    state: State<'_, AppState>,
    mut settings: AppSettings,
) -> Result<SettingsSaveResult, String> {
    // Only the dedicated command may alter this preference or the native registration.
    settings.launch_at_login = read_settings(&state.paths)?.launch_at_login;
    run_durable_local(&state, "Save settings", "settings", || {
        write_settings(&state.paths, &state.task_store, &settings)
    })
}

#[tauri::command]
pub(crate) fn set_launch_at_login(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<SettingsSaveResult, String> {
    let login_launch = TauriLoginLaunchController { app: &app };
    run_durable_local(&state, "Set launch at login", "settings", || {
        let mut settings = read_settings(&state.paths)?;
        settings.launch_at_login = enabled;
        save_after_login_launch_change(&login_launch, enabled, || {
            write_settings(&state.paths, &state.task_store, &settings)
        })
    })
}

#[tauri::command]
pub(crate) fn detect_network_proxy(
    state: State<'_, AppState>,
) -> Result<NetworkProxyStatus, String> {
    let settings = read_settings(&state.paths)?;
    Ok(detect_network_proxy_status(&settings))
}

#[tauri::command]
pub(crate) fn choose_close_button_behavior(
    app: AppHandle,
    state: State<'_, AppState>,
    behavior: CloseButtonBehavior,
) -> Result<SettingsSaveResult, String> {
    let saved = run_durable_local(&state, "Choose close button behavior", "settings", || {
        let mut settings = read_settings(&state.paths)?;
        settings.close_button_behavior = behavior.clone();
        write_settings(&state.paths, &state.task_store, &settings)
    })?;

    match behavior {
        CloseButtonBehavior::Ask => {}
        CloseButtonBehavior::Exit => app.exit(0),
        CloseButtonBehavior::MinimizeToTray => hide_main_window(&app),
    }
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeLoginLaunchController {
        enabled: RefCell<bool>,
        fail_change: bool,
        operations: RefCell<Vec<String>>,
    }

    impl FakeLoginLaunchController {
        fn new(enabled: bool) -> Self {
            Self {
                enabled: RefCell::new(enabled),
                fail_change: false,
                operations: RefCell::new(Vec::new()),
            }
        }
    }

    impl LoginLaunchController for FakeLoginLaunchController {
        fn is_enabled(&self) -> Result<bool, String> {
            Ok(*self.enabled.borrow())
        }

        fn set_enabled(&self, enabled: bool) -> Result<(), String> {
            self.operations
                .borrow_mut()
                .push(format!("system:{enabled}"));
            if self.fail_change {
                return Err("system startup entry rejected the change".into());
            }
            *self.enabled.borrow_mut() = enabled;
            Ok(())
        }
    }

    #[test]
    fn startup_registration_changes_before_settings_are_saved() {
        let controller = FakeLoginLaunchController::new(false);
        let result = save_after_login_launch_change(&controller, true, || {
            controller
                .operations
                .borrow_mut()
                .push("settings:save".into());
            Ok(())
        });

        assert!(result.is_ok());
        assert_eq!(
            controller.operations.borrow().clone(),
            vec!["system:true", "settings:save"]
        );
        assert!(controller
            .is_enabled()
            .expect("startup state should be readable"));
    }

    #[test]
    fn startup_registration_failure_does_not_save_settings() {
        let mut controller = FakeLoginLaunchController::new(false);
        controller.fail_change = true;
        let result = save_after_login_launch_change(&controller, true, || {
            controller
                .operations
                .borrow_mut()
                .push("settings:save".into());
            Ok(())
        });

        assert!(result.is_err());
        assert_eq!(controller.operations.borrow().clone(), vec!["system:true"]);
        assert!(!controller
            .is_enabled()
            .expect("startup state should be readable"));
    }

    #[test]
    fn settings_failure_restores_the_previous_startup_registration() {
        let controller = FakeLoginLaunchController::new(false);
        let result = save_after_login_launch_change(&controller, true, || {
            controller
                .operations
                .borrow_mut()
                .push("settings:save".into());
            Err::<(), _>("settings file write failed".to_string())
        });

        assert_eq!(
            result.expect_err("save should fail"),
            "settings file write failed"
        );
        assert_eq!(
            controller.operations.borrow().clone(),
            vec!["system:true", "settings:save", "system:false"]
        );
        assert!(!controller
            .is_enabled()
            .expect("startup state should be readable"));
    }
}
