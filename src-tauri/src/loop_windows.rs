//! Independent loop editors and Plugins managers. No mission ownership transfer or sidecar privileges.
use std::{collections::HashMap, sync::{Mutex, OnceLock}};
use tauri::{Manager, Webview, WebviewUrl, WebviewWindowBuilder};

fn registry() -> &'static Mutex<HashMap<String, String>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn permits_command(label: &str, command: &str) -> bool {
    registry().lock().map(|entries| entries.values().any(|entry| entry == label)).unwrap_or(false)
        && matches!(command, "desktop_reveal_path" | "desktop_save_text")
}
fn allowed_navigation(origin: &tauri::Url, target: &tauri::Url, surface: &str) -> bool {
    target.scheme() == origin.scheme() && target.host_str() == origin.host_str()
        && target.port_or_known_default() == origin.port_or_known_default()
        && matches!(target.path(), "/" | "/index.html")
        && target.query_pairs().any(|(key, value)| key == surface && value == "1")
}
#[tauri::command]
pub fn loop_window_open(app: tauri::AppHandle, webview: Webview, project_id: Option<String>, loop_id: Option<String>) -> Result<(), String> {
    open_editor_window(app, webview, project_id, loop_id, "loopsWindow", "Loops")
}
#[tauri::command]
pub fn plugin_window_open(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    open_editor_window(app, webview, None, None, "pluginsWindow", "Plugins")
}
fn open_editor_window(app: tauri::AppHandle, webview: Webview, project_id: Option<String>, loop_id: Option<String>, surface: &'static str, title: &str) -> Result<(), String> {
    if webview.label() != webview.window().label() || !crate::mission_windows::is_trusted_interface(webview.label()) {
        return Err("This action belongs to a registered Specrails interface.".into());
    }
    if project_id.iter().chain(loop_id.iter()).any(|id| id.is_empty() || id.len() > 256 || id.chars().any(char::is_control)) {
        return Err("Invalid editor window target.".into());
    }
    let key = serde_json::to_string(&(surface, &project_id, &loop_id)).map_err(|err| err.to_string())?;
    let mut entries = registry().lock().map_err(|_| "Editor window state is unavailable.")?;
    if let Some(window) = entries.get(&key).and_then(|label| app.get_webview_window(label)) {
        return window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()).map_err(|err| err.to_string());
    }
    entries.retain(|_, label| app.get_webview_window(label).is_some());
    if entries.len() >= 16 { return Err("Close an editor window before opening another.".into()); }
    let label = format!("{}-{:032x}", title.to_lowercase(), rand::random::<u128>());
    let mut capability = tauri::ipc::CapabilityBuilder::new(format!("{label}-interface")).webview(&label);
    for permission in ["core:event:default", "core:window:default", "core:window:allow-close", "core:window:allow-minimize",
        "core:window:allow-maximize", "core:window:allow-toggle-maximize", "core:window:allow-unmaximize", "core:window:allow-start-dragging",
        "dialog:allow-open", "dialog:allow-message", "dialog:allow-confirm", "clipboard-manager:allow-read-text", "clipboard-manager:allow-write-text"] {
        capability = capability.permission(permission);
    }
    app.add_capability(capability).map_err(|err| err.to_string())?;
    let origin = app.get_webview_window("main").ok_or("The main window is unavailable.")?.url().map_err(|err| err.to_string())?;
    let mut target = origin.join("index.html").map_err(|err| err.to_string())?;
    { let mut query = target.query_pairs_mut(); query.clear().append_pair(surface, "1");
      if let Some(id) = &project_id { query.append_pair("projectId", id); }
      if let Some(id) = &loop_id { query.append_pair("loopId", id); }
    }
    let path = format!("index.html?{}", target.query().unwrap_or_default());
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(path.into()))
        .title(format!("Specrails — {title}")).inner_size(1400.0, 900.0).min_inner_size(800.0, 600.0).center()
        .on_navigation(move |url| allowed_navigation(&origin, url, surface))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    #[cfg(target_os = "macos")]
    let builder = builder.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    builder.build().map_err(|err| err.to_string())?;
    entries.insert(key, label);
    Ok(())
}
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if matches!(event, tauri::WindowEvent::Destroyed) {
        if let Ok(mut entries) = registry().lock() { entries.retain(|_, label| label != window.label()); }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn editor_navigation_stays_on_the_local_surface() {
        for url in ["http://localhost:5173/", "tauri://localhost/"] {
            let origin = tauri::Url::parse(url).unwrap();
            assert!(allowed_navigation(&origin, &origin.join("index.html?loopsWindow=1&loopId=custom").unwrap(), "loopsWindow"));
            assert!(allowed_navigation(&origin, &origin.join("index.html?pluginsWindow=1").unwrap(), "pluginsWindow"));
            assert!(!allowed_navigation(&origin, &origin.join("index.html?loopsWindow=1").unwrap(), "pluginsWindow"));
            assert!(!allowed_navigation(&origin, &origin.join("index.html?pluginsWindow=1").unwrap(), "loopsWindow"));
            for path in ["index.html", "evil.html?loopsWindow=1", "index.html?missionWindow=1"] {
                assert!(!allowed_navigation(&origin, &origin.join(path).unwrap(), "loopsWindow"));
            }
            assert!(!allowed_navigation(&origin, &tauri::Url::parse("https://example.org/?loopsWindow=1").unwrap(), "loopsWindow"));
        }
    }
    #[test]
    fn loop_editors_have_no_host_or_browser_privileges() {
        registry().lock().unwrap().insert("unit-test".into(), "loops-unit-test".into());
        assert!(permits_command("loops-unit-test", "desktop_save_text"));
        for command in ["restart_app", "loop_window_open", "browser_create", "mission_window_detach"] {
            assert!(!permits_command("loops-unit-test", command));
        }
        assert!(!permits_command("loops-unregistered", "desktop_save_text"));
        registry().lock().unwrap().remove("unit-test");
    }
}
