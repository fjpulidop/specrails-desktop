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

#[tauri::command]
pub fn desktop_notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    if title.is_empty() || title.len() > 512 || body.len() > 4096 { return Err("invalid notification size".into()); }
    app.notification().builder().title(title).body(body).show().map_err(|_| "desktop notifications are unavailable".into())
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
