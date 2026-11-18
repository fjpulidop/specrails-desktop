//! Small, explicit desktop integrations. Only the main interface can invoke
//! these commands; remote browser content never receives filesystem access.
use std::{path::{Path, PathBuf}, process::Command};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

const MAX_TEXT_BYTES: usize = 16 * 1024 * 1024;

fn save_name(name: &str) -> Result<&str, String> {
    if name.is_empty() || name.len() > 200 || name.contains(['/', '\\']) || name.chars().any(char::is_control) || matches!(name, "." | "..") {
        return Err("invalid suggested filename".into());
    }
    Ok(name)
}

fn reveal_command(path: &Path, platform: &str) -> (String, Vec<String>) {
    let value = path.to_string_lossy().into_owned();
    match platform {
        "windows" => {
            // canonicalize adds the extended Win32 namespace; Explorer expects
            // ordinary drive/UNC paths even though filesystem APIs accept it.
            let value = if let Some(unc) = value.strip_prefix(r"\\?\UNC\") { format!(r"\\{unc}") }
                else { value.strip_prefix(r"\\?\").unwrap_or(&value).to_string() };
            ("explorer.exe".into(), vec!["/select,".into(), value])
        },
        "macos" => ("open".into(), vec!["-R".into(), value]),
        _ => ("xdg-open".into(), vec![path.parent().unwrap_or(path).to_string_lossy().into_owned()]),
    }
}

#[tauri::command]
pub async fn desktop_reveal_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        if !path.is_absolute() { return Err("an absolute path is required".into()); }
        let path = path.canonicalize().map_err(|_| "the path no longer exists".to_string())?;
        let (program, arguments) = reveal_command(&path, std::env::consts::OS);
        let mut command = Command::new(program);
        command.args(arguments);
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        command.spawn().map(|_| ()).map_err(|_| "the file manager could not be opened".into())
    }).await.map_err(|_| "the desktop action was interrupted".to_string())?
}

#[tauri::command]
pub async fn desktop_save_text(app: tauri::AppHandle, webview: tauri::Webview, suggested_name: String, text: String) -> Result<bool, String> {
    save_name(&suggested_name)?;
    if text.len() > MAX_TEXT_BYTES { return Err("the text exceeds the 16 MB export limit".into()); }
    let parent = webview.window();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app.dialog().file().set_parent(&parent).set_file_name(suggested_name).blocking_save_file() else { return Ok(false); };
        let path = file.into_path().map_err(|_| "the selected save location is unavailable".to_string())?;
        std::fs::write(path, text).map_err(|_| "the text could not be saved to the selected file".to_string())?;
        Ok(true)
    }).await.map_err(|_| "the save action was interrupted".to_string())?
}

/// The platform's own "default" notification sound name: macOS maps this exact
/// string to `NSUserNotificationDefaultSoundName`, WinRT parses `Default`, and
/// freedesktop servers look the name up in the sound theme.
fn default_sound_name(platform: &str) -> &'static str {
    match platform {
        "macos" => "NSUserNotificationDefaultSoundName",
        "windows" => "Default",
        _ => "message-new-instant",
    }
}

fn notification_size_ok(title: &str, body: &str) -> bool {
    !title.is_empty() && title.len() <= 512 && body.len() <= 4096
}

/// `sound` is optional so older callers (terminal notifications) keep the silent default.
#[tauri::command]
pub fn desktop_notify(app: tauri::AppHandle, title: String, body: String, sound: Option<bool>) -> Result<(), String> {
    if !notification_size_ok(&title, &body) { return Err("invalid notification size".into()); }
    let mut builder = app.notification().builder().title(title).body(body);
    if sound == Some(true) { builder = builder.sound(default_sound_name(std::env::consts::OS)); }
    builder.show().map_err(|_| "desktop notifications are unavailable".into())
}

/// Largest number the Dock/launcher badge is asked to show; the client already
/// sends a small count, this only bounds a hostile or buggy value.
const MAX_BADGE_COUNT: i64 = 9_999;

/// `None`, zero or a negative count clear the badge.
fn badge_value(count: Option<i64>) -> Option<i64> {
    count.filter(|value| *value > 0).map(|value| value.min(MAX_BADGE_COUNT))
}

/// Dock (macOS) / launcher (Linux, Unity-compatible) badge of the main window.
/// Windows has no count badge (only overlay icons): a deliberate no-op there.
#[tauri::command]
pub fn desktop_set_badge(app: tauri::AppHandle, count: Option<i64>) -> Result<(), String> {
    let value = badge_value(count);
    #[cfg(not(windows))]
    {
        use tauri::Manager;
        let Some(window) = app.get_webview_window("main") else { return Err("the main window is unavailable".into()); };
        window.set_badge_count(value).map_err(|_| "the badge could not be updated".to_string())
    }
    #[cfg(windows)]
    { let _ = (app, value); Ok(()) }
}

/// Label of the app window that has the keyboard focus, or `None` when another
/// application is in front. The attention policy needs it to tell "the person is
/// looking at this mission's own window" from "the person is away".
#[tauri::command]
pub fn desktop_focus_state(app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    app.windows().into_iter().find(|(_, window)| window.is_focused().unwrap_or(false)).map(|(label, _)| label)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn save_suggestion_is_a_filename_not_a_path() {
        assert_eq!(save_name("terminal-scrollback.txt").unwrap(), "terminal-scrollback.txt");
        for name in ["", "../secret", "C:\\secret", "../", "..", "x\ny"] { assert!(save_name(name).is_err()); }
    }
    #[test]
    fn notification_sizes_and_sound_names_are_bounded() {
        assert!(notification_size_ok("Review ready", "Acme · PR #12"));
        assert!(!notification_size_ok("", "body"));
        assert!(!notification_size_ok(&"t".repeat(513), "body"));
        assert!(!notification_size_ok("title", &"b".repeat(4097)));
        assert_eq!(default_sound_name("macos"), "NSUserNotificationDefaultSoundName");
        assert_eq!(default_sound_name("windows"), "Default");
        assert_eq!(default_sound_name("linux"), "message-new-instant");
    }
    #[test]
    fn badge_counts_are_clamped_and_zero_clears() {
        assert_eq!(badge_value(None), None);
        assert_eq!(badge_value(Some(0)), None);
        assert_eq!(badge_value(Some(-4)), None);
        assert_eq!(badge_value(Some(3)), Some(3));
        assert_eq!(badge_value(Some(i64::MAX)), Some(MAX_BADGE_COUNT));
    }
    #[test]
    fn file_manager_paths_are_single_arguments_never_shell_code() {
        let path = Path::new("C:\\Users\\A B\\file & test.txt");
        let (program, args) = reveal_command(path, "windows");
        assert_eq!(program, "explorer.exe");
        assert_eq!(args, vec!["/select,", "C:\\Users\\A B\\file & test.txt"]);
        assert_eq!(reveal_command(Path::new("/tmp/a b"), "macos").1, vec!["-R", "/tmp/a b"]);
        assert_eq!(reveal_command(Path::new(r"\\?\C:\A B\file.txt"), "windows").1[1], r"C:\A B\file.txt");
        assert_eq!(reveal_command(Path::new(r"\\?\UNC\server\A B\file.txt"), "windows").1[1], r"\\server\A B\file.txt");
    }
}
