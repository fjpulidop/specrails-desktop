//! Native windows for modal surfaces (App Settings, Job detail, …).
//! See docs/internals/native-window-surfaces.md.
//!
//! A surface window is an owned child of the window that opened it: it loads the
//! same client bundle at `index.html?surfaceWindow=<id>&…`, gets a capability
//! bound to its exact random label, and reports results and its closure back to
//! the opener only (never broadcast). One window per (surface, target).
use std::{collections::HashMap, sync::{Mutex, OnceLock}};
use serde::Serialize;
use serde_json::Value;
use tauri::{Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

pub const EVENT: &str = "surface-window:event";
/// Toasts raised in a surface window show in its opener (the surface renders none).
pub const TOAST_EVENT: &str = "surface-window:toast";
const MAX_TOAST_BYTES: usize = 16 * 1024;
const MAX_WINDOWS: usize = 16;
const MAX_RESULT_BYTES: usize = 64 * 1024;
/// The page shows its window once its content has painted; this is the
/// fallback when it never does (a crashed or very slow page).
const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_millis(2500);

/// The surfaces that may open natively, with their window chrome and the extra
/// host permissions their content needs. Anything else stays an in-page modal.
/// `focus_opener_on_result`: a result asks the opener to act (navigate, show a
/// dialog), so the opener is brought to the front with it.
struct SurfaceSpec { id: &'static str, singleton: bool, title: &'static str, width: f64, height: f64, min_width: f64, min_height: f64, params: &'static [&'static str], commands: &'static [&'static str], permissions: &'static [&'static str], focus_opener_on_result: bool }

const SURFACES: &[SurfaceSpec] = &[
    // Settings hosts the app-update section: check, download/install, restart.
    SurfaceSpec { id: "app-settings", singleton: true, title: "Settings", width: 1100.0, height: 760.0, min_width: 720.0, min_height: 520.0, params: &["section", "settingId", "onboarding"],
        commands: &["check_app_update", "restart_app"], permissions: &["updater:default", "process:allow-restart"], focus_opener_on_result: false },
    SurfaceSpec { id: "job-detail", singleton: false, title: "Run", width: 1280.0, height: 860.0, min_width: 720.0, min_height: 480.0, params: &["jobId", "projectId"],
        commands: &[], permissions: &[], focus_opener_on_result: false },
    // The live board on a second screen: its cards' actions run in the main
    // window (open a mission, a review, resume a run), which comes forward.
    SurfaceSpec { id: "live-board", singleton: true, title: "Live board", width: 1400.0, height: 880.0, min_width: 760.0, min_height: 480.0, params: &[],
        commands: &[], permissions: &[], focus_opener_on_result: true },
];

#[derive(Clone)]
struct Entry { key: String, surface: &'static str, owner: String, request_id: String }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceEvent<'a> { kind: &'a str, surface: &'a str, request_id: &'a str, window_label: &'a str, #[serde(skip_serializing_if = "Option::is_none")] result: Option<Value> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened { window_label: String, request_id: String, reused: bool }

#[derive(serde::Deserialize, Default, Clone, Copy)]
pub struct Geometry { x: Option<f64>, y: Option<f64>, width: Option<f64>, height: Option<f64> }

fn registry() -> &'static Mutex<HashMap<String, Entry>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    WINDOWS.get_or_init(Default::default)
}
fn spec(id: &str) -> Option<&'static SurfaceSpec> { SURFACES.iter().find(|spec| spec.id == id) }
fn entry(label: &str) -> Option<Entry> { registry().lock().ok()?.get(label).cloned() }
fn safe_token(value: &str, max: usize) -> bool { !value.is_empty() && value.len() <= max && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') }


/// Surface windows may report a result, plus the few host commands their content
/// needs. They can never open other windows, browsers or missions.
pub fn permits_command(label: &str, command: &str) -> bool {
    let Some(entry) = entry(label) else { return false };
    matches!(command, "surface_window_result" | "surface_window_toast" | "desktop_reveal_path" | "desktop_save_text" | "desktop_save_bytes")
        || spec(entry.surface).is_some_and(|spec| spec.commands.contains(&command))
}

/// Only declared, short, printable parameters reach the URL.
fn validate_params(spec: &SurfaceSpec, params: &HashMap<String, String>) -> Result<(), String> {
    for (key, value) in params {
        if !spec.params.contains(&key.as_str()) { return Err(format!("Unknown surface parameter: {key}")); }
        if value.len() > 256 || value.chars().any(char::is_control) { return Err("Invalid surface parameter.".into()); }
    }
    Ok(())
}

fn allowed_navigation(origin: &tauri::Url, target: &tauri::Url, surface: &str) -> bool {
    target.scheme() == origin.scheme() && target.host_str() == origin.host_str()
        && target.port_or_known_default() == origin.port_or_known_default()
        && matches!(target.path(), "/" | "/index.html")
        && target.query_pairs().any(|(key, value)| key == "surfaceWindow" && value == surface)
}

fn add_capability(app: &tauri::AppHandle, label: &str, spec: &SurfaceSpec) -> Result<(), String> {
    let mut capability = tauri::ipc::CapabilityBuilder::new(format!("{label}-interface")).webview(label);
    for permission in ["core:event:default", "core:window:default", "core:window:allow-close", "core:window:allow-minimize",
        "core:window:allow-toggle-maximize", "core:window:allow-start-dragging", "core:window:allow-set-title",
        "core:window:allow-show", "core:window:allow-set-focus",
        "dialog:allow-message", "dialog:allow-confirm", "dialog:allow-ask", "clipboard-manager:allow-read-text", "clipboard-manager:allow-write-text"]
        .iter().chain(spec.permissions) { capability = capability.permission(*permission); }
    capability = capability.permission_scoped("shell:allow-open", vec![serde_json::json!({"url":"https://**"}), serde_json::json!({"url":"http://**"}), serde_json::json!({"url":"vscode://file/**"}), serde_json::json!({"url":"cursor://file/**"}), serde_json::json!({"url":"idea://open**"})], Vec::<Value>::new());
    app.add_capability(capability).map_err(|_| "The window permissions could not be initialized.".into())
}

fn focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()).map_err(|err| err.to_string())
}

/// Saved geometry is used only while it still lands on a connected monitor.
fn on_screen(app: &tauri::AppHandle, x: f64, y: f64, width: f64) -> bool {
    app.available_monitors().map(|monitors| monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let (mx, my) = (monitor.position().x as f64 / scale, monitor.position().y as f64 / scale);
        let (mw, mh) = (monitor.size().width as f64 / scale, monitor.size().height as f64 / scale);
        x + width > mx + 40.0 && x < mx + mw - 40.0 && y >= my - 10.0 && y < my + mh - 40.0
    })).unwrap_or(false)
}

#[tauri::command]
pub fn surface_window_open(app: tauri::AppHandle, webview: Webview, surface: String, request_id: String, params: Option<HashMap<String, String>>, geometry: Option<Geometry>, background: Option<[u8; 3]>) -> Result<Opened, String> {
    let owner = webview.label().to_string();
    if owner != webview.window().label() || !crate::mission_windows::is_trusted_interface(&owner) {
        return Err("Only a Specrails interface can open a surface window.".into());
    }
    let spec = spec(&surface).ok_or("This surface does not open in its own window.")?;
    if !safe_token(&request_id, 64) { return Err("Invalid surface request.".into()); }
    let params = params.unwrap_or_default();
    validate_params(spec, &params)?;
    let mut sorted: Vec<_> = params.iter().collect();
    sorted.sort();
    // One Settings window app-wide; one window per job for entity surfaces.
    let key = if spec.singleton { spec.id.to_string() } else { serde_json::to_string(&(spec.id, &sorted)).map_err(|err| err.to_string())? };

    let mut entries = registry().lock().map_err(|_| "Surface window state is unavailable.")?;
    entries.retain(|label, _| app.get_webview_window(label).is_some());
    if let Some((label, existing)) = entries.iter().find(|(_, entry)| entry.key == key) {
        if let Some(window) = app.get_webview_window(label) {
            focus(&window)?;
            return Ok(Opened { window_label: label.clone(), request_id: existing.request_id.clone(), reused: true });
        }
    }
    if entries.len() >= MAX_WINDOWS { return Err("Close a window before opening another.".into()); }

    let label = format!("surface-{}-{:032x}", spec.id, rand::random::<u128>());
    add_capability(&app, &label, spec)?;
    let parent = app.get_webview_window(&owner).ok_or("The opening window is unavailable.")?;
    let origin = parent.url().map_err(|err| err.to_string())?;
    let mut target = origin.join("index.html").map_err(|err| err.to_string())?;
    {
        let mut query = target.query_pairs_mut();
        query.clear().append_pair("surfaceWindow", spec.id).append_pair("requestId", &request_id);
        for (key, value) in &sorted { query.append_pair(key, value); }
    }
    let path = format!("index.html?{}", target.query().unwrap_or_default());
    let geometry = geometry.unwrap_or_default();
    let clamp = |value: Option<f64>, min: f64, fallback: f64| value.filter(|v| v.is_finite()).map(|v| v.clamp(min, 8000.0)).unwrap_or(fallback);
    let (width, height) = (clamp(geometry.width, spec.min_width, spec.width), clamp(geometry.height, spec.min_height, spec.height));
    let nav_origin = origin.clone();
    let surface_id = spec.id;
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(path.into()))
        .title(format!("Specrails — {}", spec.title))
        .inner_size(width, height).min_inner_size(spec.min_width, spec.min_height)
        // Owned window: stays above its opener, minimizes with it (Windows/Linux)
        // and moves with it on macOS (child NSWindow). Never blocks the opener.
        .parent(&parent).map_err(|err| err.to_string())?
        .focused(true)
        // Hidden until the page paints its content (it calls `show()`), on the
        // opener's panel color, so no empty or half-drawn window is ever seen.
        .visible(false)
        .on_navigation(move |url| allowed_navigation(&nav_origin, url, surface_id))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    builder = match (geometry.x, geometry.y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() && on_screen(&app, x, y, width) => builder.position(x, y),
        _ => builder.center(),
    };
    // Native window controls only (the page renders no close button of its own).
    // macOS: traffic lights at their standard place over our header; the header
    // puts its title row on their line (`surfaceHeaderInset` in dialog.tsx).
    // Elsewhere: the OS title bar.
    #[cfg(target_os = "macos")]
    let builder = builder.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);
    let builder = match background { Some([r, g, b]) => builder.background_color(tauri::window::Color(r, g, b, 255)), None => builder };
    builder.build().map_err(|err| err.to_string())?;
    entries.insert(label.clone(), Entry { key, surface: spec.id, owner, request_id: request_id.clone() });
    let (fallback_app, fallback_label) = (app.clone(), label.clone());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_FALLBACK).await;
        if let Some(window) = fallback_app.get_webview_window(&fallback_label) {
            if !window.is_visible().unwrap_or(true) { let _ = focus(&window); }
        }
    });
    Ok(Opened { window_label: label, request_id, reused: false })
}

/// The surface reports a serializable result to its opener. The caller's label
/// comes from the IPC message, so a window can only answer its own request.
#[tauri::command]
pub fn surface_window_result(app: tauri::AppHandle, webview: Webview, result: Value) -> Result<(), String> {
    let label = webview.label();
    let entry = entry(label).ok_or("This window has no surface request.")?;
    if serde_json::to_vec(&result).map_err(|err| err.to_string())?.len() > MAX_RESULT_BYTES { return Err("The surface result is too large.".into()); }
    let event = SurfaceEvent { kind: "result", surface: entry.surface, request_id: &entry.request_id, window_label: label, result: Some(result) };
    app.emit_to(entry.owner.as_str(), EVENT, &event).map_err(|err| err.to_string())?;
    if spec(entry.surface).is_some_and(|spec| spec.focus_opener_on_result) {
        if let Some(owner) = app.get_webview_window(&entry.owner) { let _ = focus(&owner); }
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceToast<'a> { window_label: &'a str, toast: Value }

/// Relays a toast (or its update/dismissal) from a surface window to its
/// opener, which shows it. Plain text only; the opener validates the shape.
#[tauri::command]
pub fn surface_window_toast(app: tauri::AppHandle, webview: Webview, toast: Value) -> Result<(), String> {
    let label = webview.label();
    let entry = entry(label).ok_or("This window has no surface request.")?;
    if !toast.is_object() || serde_json::to_vec(&toast).map_err(|err| err.to_string())?.len() > MAX_TOAST_BYTES {
        return Err("Invalid surface toast.".into());
    }
    app.emit_to(entry.owner.as_str(), TOAST_EVENT, &SurfaceToast { window_label: label, toast }).map_err(|err| err.to_string())
}

/// Closure always reaches the opener (Escape, close button, Cmd-W, crash), and
/// focus goes back to it so the opener can restore focus to its trigger.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if !matches!(event, tauri::WindowEvent::Destroyed) { return; }
    let removed = registry().lock().ok().and_then(|mut entries| entries.remove(window.label()));
    if let Some(entry) = removed {
        let app = window.app_handle();
        let payload = SurfaceEvent { kind: "closed", surface: entry.surface, request_id: &entry.request_id, window_label: window.label(), result: None };
        let _ = app.emit_to(entry.owner.as_str(), EVENT, &payload);
        if let Some(owner) = app.get_webview_window(&entry.owner) { let _ = owner.set_focus(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn surface_navigation_stays_on_its_own_surface() {
        for url in ["http://localhost:4201/", "tauri://localhost/"] {
            let origin = tauri::Url::parse(url).unwrap();
            assert!(allowed_navigation(&origin, &origin.join("index.html?surfaceWindow=app-settings&requestId=r1").unwrap(), "app-settings"));
            assert!(!allowed_navigation(&origin, &origin.join("index.html?surfaceWindow=job-detail").unwrap(), "app-settings"));
            assert!(allowed_navigation(&origin, &origin.join("index.html?surfaceWindow=live-board&requestId=r2").unwrap(), "live-board"));
            assert!(!allowed_navigation(&origin, &origin.join("index.html?surfaceWindow=app-settings").unwrap(), "live-board"));
            assert!(!allowed_navigation(&origin, &origin.join("evil.html?surfaceWindow=app-settings").unwrap(), "app-settings"));
            assert!(!allowed_navigation(&origin, &origin.join("index.html?loopsWindow=1").unwrap(), "app-settings"));
            assert!(!allowed_navigation(&origin, &tauri::Url::parse("https://example.org/?surfaceWindow=app-settings").unwrap(), "app-settings"));
        }
    }
    #[test]
    fn only_declared_surfaces_and_params_are_accepted() {
        assert!(spec("app-settings").is_some() && spec("job-detail").is_some() && spec("live-board").is_some() && spec("loops").is_none());
        // The live board takes no parameters: every card is read from the API.
        let board = spec("live-board").unwrap();
        assert!(board.singleton && board.focus_opener_on_result);
        let any: HashMap<String, String> = [("projectId".into(), "p1".into())].into();
        assert!(validate_params(board, &any).is_err());
        assert!(validate_params(board, &HashMap::new()).is_ok());
        let job = spec("job-detail").unwrap();
        let ok: HashMap<String, String> = [("jobId".into(), "abc".into()), ("projectId".into(), "p1".into())].into();
        assert!(validate_params(job, &ok).is_ok());
        let unknown: HashMap<String, String> = [("url".into(), "https://x".into())].into();
        assert!(validate_params(job, &unknown).is_err());
        let control: HashMap<String, String> = [("jobId".into(), "a\nb".into())].into();
        assert!(validate_params(job, &control).is_err());
        assert!(safe_token("req-1_a", 64) && !safe_token("", 64) && !safe_token("a b", 64));
    }
    #[test]
    fn surface_windows_get_only_their_declared_commands() {
        let insert = |label: &str, surface: &'static str| registry().lock().unwrap().insert(label.into(), Entry { key: label.into(), surface, owner: "main".into(), request_id: "r".into() });
        insert("surface-app-settings-test", "app-settings");
        insert("surface-job-detail-test", "job-detail");
        insert("surface-live-board-test", "live-board");
        assert!(permits_command("surface-app-settings-test", "surface_window_result"));
        assert!(permits_command("surface-live-board-test", "surface_window_result"));
        assert!(permits_command("surface-live-board-test", "surface_window_toast"));
        assert!(!permits_command("surface-live-board-test", "check_app_update"));
        assert!(!permits_command("surface-live-board-test", "restart_app"));
        assert!(permits_command("surface-job-detail-test", "surface_window_toast"));
        assert!(permits_command("surface-app-settings-test", "check_app_update"));
        assert!(!permits_command("surface-job-detail-test", "check_app_update"));
        for command in ["surface_window_open", "loop_window_open", "browser_open", "mission_window_detach", "set_tray_labels", "desktop_notify", "desktop_set_badge", "desktop_focus_state"] {
            assert!(!permits_command("surface-app-settings-test", command));
            assert!(!permits_command("surface-job-detail-test", command));
            assert!(!permits_command("surface-live-board-test", command));
        }
        assert!(!permits_command("surface-unregistered", "surface_window_result"));
        registry().lock().unwrap().remove("surface-app-settings-test");
        registry().lock().unwrap().remove("surface-job-detail-test");
        registry().lock().unwrap().remove("surface-live-board-test");
    }
}
