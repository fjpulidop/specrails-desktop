//! Independent loop editors and Plugins managers. No mission ownership transfer or sidecar privileges.
use std::{collections::HashMap, sync::{Mutex, OnceLock}};
use tauri::{Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

/// Main-window event: show this mission there (Loops ▸ Fix PR CI ▸ Run on a PR).
pub const OPEN_MISSION_EVENT: &str = "specrails://open-mission";
/// Main-window event: open this device's window from there (Loops ▸ Test in Mobile Device), so the main
/// interface that releases a device when its window closes also knows it.
pub const OPEN_DEVICE_EVENT: &str = "specrails://open-device";

fn registry() -> &'static Mutex<HashMap<String, String>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}
pub fn permits_command(label: &str, command: &str) -> bool {
    registry().lock().map(|entries| entries.values().any(|entry| entry == label)).unwrap_or(false)
        && matches!(command, "desktop_reveal_path" | "desktop_save_text" | "desktop_save_bytes" | "loop_window_open_mission" | "loop_window_open_device")
}
fn allowed_navigation(origin: &tauri::Url, target: &tauri::Url, surface: &str) -> bool {
    target.scheme() == origin.scheme() && target.host_str() == origin.host_str()
        && target.port_or_known_default() == origin.port_or_known_default()
        && matches!(target.path(), "/" | "/index.html")
        && target.query_pairs().any(|(key, value)| key == surface && value == "1")
}
// Async on purpose: building a window inside a synchronous command deadlocks
// on Windows (see `surface_window_open`).
#[tauri::command]
pub async fn loop_window_open(app: tauri::AppHandle, webview: Webview, project_id: Option<String>, loop_id: Option<String>) -> Result<(), String> {
    open_editor_window(app, webview, project_id, loop_id, "loopsWindow", "Loops")
}
#[tauri::command]
pub async fn plugin_window_open(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    open_editor_window(app, webview, None, None, "pluginsWindow", "Plugins")
}
/// The loop/plugin editor's requested and minimum content size (logical).
const EDITOR_SIZE: (f64, f64) = (1400.0, 900.0);
const EDITOR_MIN: (f64, f64) = (800.0, 600.0);
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
        .title(format!("Specrails — {title}")).inner_size(EDITOR_SIZE.0, EDITOR_SIZE.1).min_inner_size(EDITOR_MIN.0, EDITOR_MIN.1).center().visible(false)
        .on_navigation(move |url| allowed_navigation(&origin, url, surface))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    #[cfg(target_os = "macos")]
    let builder = builder.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    let window = builder.build().map_err(|err| err.to_string())?;
    // `center()` alone centers the requested size on the screen before AppKit shrinks it to a
    // smaller screen, which leaves the window hanging off the left edge. Like every surface
    // window, place it (fitted to the work area) on the window that opened it, then show it.
    if let Some(parent) = app.get_webview_window(webview.label()) {
        let _ = crate::surface_windows::center_on_opener(&parent, &window, EDITOR_SIZE, EDITOR_MIN);
    }
    window.show().map_err(|err| err.to_string())?;
    let _ = window.set_focus();
    entries.insert(key, label);
    Ok(())
}
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenMission { conversation_id: String }

/// A loop editor shows a mission in the main window (where missions live) and brings it forward.
#[tauri::command]
pub fn loop_window_open_mission(app: tauri::AppHandle, webview: Webview, conversation_id: String) -> Result<(), String> {
    let caller = webview.label().to_string();
    if caller != webview.window().label() || !registry().lock().map(|entries| entries.values().any(|label| *label == caller)).unwrap_or(false) {
        return Err("Only a loop editor window can do this.".into());
    }
    if conversation_id.is_empty() || conversation_id.len() > 64 || !conversation_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("Invalid mission.".into());
    }
    let main = app.get_webview_window("main").ok_or("The main window is unavailable.")?;
    app.emit_to("main", OPEN_MISSION_EVENT, OpenMission { conversation_id }).map_err(|err| err.to_string())?;
    main.show().and_then(|_| main.unminimize()).and_then(|_| main.set_focus()).map_err(|err| err.to_string())
}
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTarget { device_id: String, session_id: String, build_id: u64, platform: String, name: String }

fn valid_device_target(target: &DeviceTarget) -> bool {
    crate::device_windows::valid_key(&target.device_id) && crate::device_windows::valid_key(&target.session_id)
        && target.build_id > 0 && matches!(target.platform.as_str(), "ios" | "android")
        && target.name.chars().count() <= 120 && !target.name.chars().any(|c| c.is_control())
}

/// A loop editor asks the main window to open a device's window (it holds the release on close).
#[tauri::command]
pub fn loop_window_open_device(app: tauri::AppHandle, webview: Webview, target: DeviceTarget) -> Result<(), String> {
    let caller = webview.label().to_string();
    if caller != webview.window().label() || !registry().lock().map(|entries| entries.values().any(|label| *label == caller)).unwrap_or(false) {
        return Err("Only a loop editor window can do this.".into());
    }
    if !valid_device_target(&target) { return Err("Invalid device.".into()); }
    app.emit_to("main", OPEN_DEVICE_EVENT, target).map_err(|err| err.to_string())
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
        assert!(permits_command("loops-unit-test", "desktop_save_text") && permits_command("loops-unit-test", "loop_window_open_mission") && permits_command("loops-unit-test", "loop_window_open_device"));
        // A loop editor never opens a device window itself: the main window does (it releases it on close).
        assert!(!permits_command("loops-unit-test", "device_window_open"));
        for command in ["restart_app", "loop_window_open", "browser_create", "mission_window_detach", "desktop_notify", "desktop_set_badge", "desktop_focus_state"] {
            assert!(!permits_command("loops-unit-test", command));
        }
        assert!(!permits_command("loops-unregistered", "desktop_save_text"));
        registry().lock().unwrap().remove("unit-test");
    }
    #[test]
    fn device_targets_are_validated_before_reaching_the_main_window() {
        let target = |device_id: &str, build_id: u64, platform: &str, name: &str| DeviceTarget { device_id: device_id.into(), session_id: "20f2f71b-4485".into(), build_id, platform: platform.into(), name: name.into() };
        assert!(valid_device_target(&target("avd:tapflow-phone", 6, "android", "tapflow-phone")));
        assert!(valid_device_target(&target("D656F70B-FFE8-46C9", 3, "ios", "iPhone 17 Pro")));
        assert!(!valid_device_target(&target("../x", 3, "ios", "x")) && !valid_device_target(&target("a", 0, "ios", "x")));
        assert!(!valid_device_target(&target("a", 1, "web", "x")) && !valid_device_target(&target("a", 1, "ios", "bad\nname")));
    }
}
