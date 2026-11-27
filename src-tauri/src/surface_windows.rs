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
    SurfaceSpec { id: "project-settings", singleton: false, title: "Project settings", width: 1100.0, height: 760.0, min_width: 720.0, min_height: 520.0, params: &["projectId", "section", "settingId", "anchor"],
        commands: &[], permissions: &["dialog:allow-open"], focus_opener_on_result: false },
    SurfaceSpec { id: "job-detail", singleton: false, title: "Run", width: 1280.0, height: 860.0, min_width: 720.0, min_height: 480.0, params: &["jobId", "projectId"],
        commands: &[], permissions: &[], focus_opener_on_result: false },
    // The live board on a second screen: its cards' actions run in the main
    // window (open a mission, a review, resume a run), which comes forward.
    SurfaceSpec { id: "live-board", singleton: true, title: "Live board", width: 1400.0, height: 880.0, min_width: 760.0, min_height: 480.0, params: &[],
        commands: &[], permissions: &[], focus_opener_on_result: true },
];

#[derive(Clone)]
struct Entry {
    key: String, surface: &'static str, owner: String, request_id: String,
    /// Reserved while its window is built: a second open of the same key focuses it instead.
    opening: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SurfaceEvent<'a> { kind: &'a str, surface: &'a str, request_id: &'a str, window_label: &'a str, #[serde(skip_serializing_if = "Option::is_none")] result: Option<Value> }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened { window_label: String, request_id: String, reused: bool }

/// A remembered logical size. A position sent by an older client is ignored:
/// new windows are centered on their opener (`center_on_opener`).
#[derive(serde::Deserialize, Default, Clone, Copy)]
pub struct Geometry { width: Option<f64>, height: Option<f64> }

fn registry() -> &'static Mutex<HashMap<String, Entry>> {
    static WINDOWS: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
    WINDOWS.get_or_init(Default::default)
}
fn spec(id: &str) -> Option<&'static SurfaceSpec> { SURFACES.iter().find(|spec| spec.id == id) }
fn entry(label: &str) -> Option<Entry> { registry().lock().ok()?.get(label).cloned() }
/// Windows/Linux surfaces are owned by their opener; macOS ones have no parent (see `surface_window_open`).
fn surface_has_parent(is_macos: bool) -> bool { !is_macos }
fn safe_token(value: &str, max: usize) -> bool { !value.is_empty() && value.len() <= max && value.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.') }


/// Surface windows may report a result, plus the few host commands their content
/// needs. They can never open other windows, browsers or missions.
pub fn permits_command(label: &str, command: &str) -> bool {
    let Some(entry) = entry(label) else { return command == "surface_window_spare_ready" && is_spare(label) };
    matches!(command, "surface_window_result" | "surface_window_toast" | "desktop_reveal_path" | "desktop_save_text" | "desktop_save_bytes" | "surface_window_spare_ready")
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

/// Every surface window gets these; a surface adds its own (`SurfaceSpec::permissions`).
const BASE_PERMISSIONS: &[&str] = &["core:event:default", "core:window:default", "core:window:allow-close", "core:window:allow-minimize",
    "core:window:allow-toggle-maximize", "core:window:allow-start-dragging", "core:window:allow-set-title",
    "core:window:allow-show", "core:window:allow-set-focus",
    "dialog:allow-message", "dialog:allow-confirm", "dialog:allow-ask", "clipboard-manager:allow-read-text", "clipboard-manager:allow-write-text"];

/// A capability bound to this exact window label: the base set (with `shell:allow-open` for web
/// and editor links) when `base`, plus `extra`.
fn add_capability(app: &tauri::AppHandle, identifier: String, label: &str, base: bool, extra: &[&str]) -> Result<(), String> {
    let mut capability = tauri::ipc::CapabilityBuilder::new(identifier).webview(label);
    let base_permissions: &[&str] = if base { BASE_PERMISSIONS } else { &[] };
    for permission in base_permissions.iter().chain(extra) { capability = capability.permission(*permission); }
    if base {
        capability = capability.permission_scoped("shell:allow-open", vec![serde_json::json!({"url":"https://**"}), serde_json::json!({"url":"http://**"}), serde_json::json!({"url":"vscode://file/**"}), serde_json::json!({"url":"cursor://file/**"}), serde_json::json!({"url":"idea://open**"})], Vec::<Value>::new());
    }
    app.add_capability(capability).map_err(|_| "The window permissions could not be initialized.".into())
}

fn focus(window: &tauri::WebviewWindow) -> Result<(), String> {
    window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()).map_err(|err| err.to_string())
}

/// A rectangle in the desktop's uniform coordinate space (see `DESKTOP_IS_LOGICAL`).
#[derive(Clone, Copy, Debug, PartialEq)]
struct Frame { x: f64, y: f64, width: f64, height: f64 }

/// The unit in which every monitor shares one coordinate space: points on macOS
/// (AppKit's global space; tao's physical values are per-window-scaled there),
/// physical pixels elsewhere (Windows per-monitor DPI virtual screen, X11).
const DESKTOP_IS_LOGICAL: bool = cfg!(target_os = "macos");

fn desktop_frame(x: f64, y: f64, width: f64, height: f64, scale: f64) -> Frame {
    let unit = if DESKTOP_IS_LOGICAL && scale > 0.0 { scale } else { 1.0 };
    Frame { x: x / unit, y: y / unit, width: width / unit, height: height / unit }
}

/// Where a new surface window goes: centered on its opener's frame (`anchor`),
/// both axes, then kept inside the opener monitor's work area. A window larger
/// than the work area shrinks to it (never below its minimum) and is pinned to
/// the work area's top-left; a frame that would spill over an edge slides in.
fn centered_frame(anchor: Frame, size: (f64, f64), min: (f64, f64), work: Frame) -> Frame {
    let fit = |want: f64, min: f64, room: f64| want.min(room).max(min.min(want));
    let (width, height) = (fit(size.0, min.0, work.width), fit(size.1, min.1, work.height));
    let place = |center: f64, len: f64, start: f64, room: f64| {
        let origin = center - len / 2.0;
        if len >= room { start } else { origin.clamp(start, start + room - len) }
    };
    Frame {
        x: place(anchor.x + anchor.width / 2.0, width, work.x, work.width),
        y: place(anchor.y + anchor.height / 2.0, height, work.y, work.height),
        width,
        height,
    }
}

/// Centers a freshly built (still hidden) surface window on its opener. The
/// opener's monitor bounds it; a minimized opener (no meaningful frame) centers
/// it on that monitor's work area instead, a fullscreen one on the monitor. On
/// any failure (e.g. Wayland, which forbids positioning) the builder's
/// `center()` stands.
fn center_on_opener(parent: &tauri::WebviewWindow, window: &tauri::WebviewWindow, inner: (f64, f64), min_inner: (f64, f64)) -> Option<()> {
    let monitor = parent.current_monitor().ok().flatten().or_else(|| parent.primary_monitor().ok().flatten())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let work = desktop_frame(area.position.x as f64, area.position.y as f64, area.size.width as f64, area.size.height as f64, scale);
    let anchor = if parent.is_minimized().unwrap_or(false) { work } else {
        let (position, size, parent_scale) = (parent.outer_position().ok()?, parent.outer_size().ok()?, parent.scale_factor().ok()?);
        desktop_frame(position.x as f64, position.y as f64, size.width as f64, size.height as f64, parent_scale)
    };
    // Title bar / borders around the content (zero for macOS's overlay title bar), in logical units.
    let (outer, content, own_scale) = (window.outer_size().ok()?, window.inner_size().ok()?, window.scale_factor().ok()?);
    let deco = ((outer.width.saturating_sub(content.width)) as f64 / own_scale, (outer.height.saturating_sub(content.height)) as f64 / own_scale);
    // Logical → desktop units at the monitor the window lands on.
    let unit = if DESKTOP_IS_LOGICAL { 1.0 } else { scale };
    let want = ((inner.0 + deco.0) * unit, (inner.1 + deco.1) * unit);
    let frame = centered_frame(anchor, want, ((min_inner.0 + deco.0) * unit, (min_inner.1 + deco.1) * unit), work);
    if frame.width + 0.5 < want.0 || frame.height + 0.5 < want.1 {
        let _ = window.set_size(tauri::LogicalSize::new(frame.width / unit - deco.0, frame.height / unit - deco.1));
    }
    let placed = if DESKTOP_IS_LOGICAL {
        window.set_position(tauri::LogicalPosition::new(frame.x, frame.y))
    } else {
        window.set_position(tauri::PhysicalPosition::new(frame.x.round() as i32, frame.y.round() as i32))
    };
    placed.ok()
}

/// The page URL of a surface window: its surface (or `spare`) and, once it has one, the request.
fn surface_page(origin: &tauri::Url, surface: &str, request_id: Option<&str>, params: &[(&String, &String)]) -> Result<String, String> {
    let mut target = origin.join("index.html").map_err(|err| err.to_string())?;
    {
        let mut query = target.query_pairs_mut();
        query.clear().append_pair("surfaceWindow", surface);
        if let Some(request_id) = request_id { query.append_pair("requestId", request_id); }
        for (key, value) in params { query.append_pair(key, value); }
    }
    Ok(format!("index.html?{}", target.query().unwrap_or_default()))
}

/// Builds a hidden surface window (shown by its page once its content has painted) on the
/// opener's panel color, so no empty or half-drawn window is ever seen. `route` is the surface it
/// loads; a spare also accepts the surface it is later assigned.
fn build_window(app: &tauri::AppHandle, parent: &tauri::WebviewWindow, label: &str, route: &'static str, path: String, title: &str, size: (f64, f64), min: (f64, f64), background: Option<[u8; 3]>, focused: bool) -> Result<tauri::WebviewWindow, String> {
    let origin = parent.url().map_err(|err| err.to_string())?;
    let nav_label = label.to_string();
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(path.into()))
        .title(format!("Specrails — {title}"))
        .inner_size(size.0, size.1).min_inner_size(min.0, min.1)
        .focused(focused)
        .visible(false)
        .on_navigation(move |url| allowed_navigation(&origin, url, route) || entry(&nav_label).is_some_and(|entry| allowed_navigation(&origin, url, entry.surface)))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        // WebKit throttles a hidden page, suspends it and unloads it after ~5 minutes. A surface
        // window boots hidden, and the spare waits hidden: both must keep running (macOS 14+).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled);
    // Windows/Linux: an owned window stays above its opener and minimizes with it, while
    // minimizing the owned window alone leaves the opener up. Never blocks the opener.
    // macOS: no parent. `parent()` makes a child NSWindow, and macOS minimizes a parent and
    // its children as one group, so minimizing a surface window would minimize the whole app.
    // It stays above its opener through `keep_above_opener` instead.
    if surface_has_parent(cfg!(target_os = "macos")) { builder = builder.parent(parent).map_err(|err| err.to_string())?; }
    // Screen-centered until `center_on_opener` moves it (before it is ever shown).
    builder = builder.center();
    // Native window controls only (the page renders no close button of its own).
    // macOS: traffic lights at their standard place over our header; the header
    // puts its title row on their line (`surfaceHeaderInset` in dialog.tsx).
    // Elsewhere: the OS title bar.
    #[cfg(target_os = "macos")]
    let builder = builder.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(true);
    let builder = match background { Some([r, g, b]) => builder.background_color(tauri::window::Color(r, g, b, 255)), None => builder };
    builder.build().map_err(|err| err.to_string())
}

/// The page shows its window once its content has painted; this shows it anyway if it never does.
fn show_fallback(app: &tauri::AppHandle, label: &str) {
    let (app, label) = (app.clone(), label.to_string());
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_FALLBACK).await;
        if let Some(window) = app.get_webview_window(&label) {
            if !window.is_visible().unwrap_or(true) { let _ = focus(&window); }
        }
    });
}

// ─── Spare window: instant open ─────────────────────────────────────────────
//
// A new webview needs ~0.8 s before its content shows (create the window, load and run the
// bundle, mount the app). One hidden window is kept loaded with the surface shell (providers,
// surface chunks) but no surface. Opening a surface takes it: the host sizes and centers it and
// tells the page which surface to render, and the page shows it once painted. A spare is used once:
// it becomes that surface's window and closes with it, so no state carries over between opens. A
// new spare is prepared shortly after.

pub const ASSIGN_EVENT: &str = "surface-window:assign";
const SPARE_ROUTE: &str = "spare";
/// How long a spare has to confirm it took the surface; a spare that does not (its page died)
/// is discarded and the window opens the cold way.
const SPARE_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);
/// Leaves the just-opened window's first frames alone before loading the next spare.
const SPARE_RESPAWN_DELAY: std::time::Duration = std::time::Duration::from_millis(1500);

#[derive(Clone, Debug, PartialEq)]
struct Spare { label: String, owner: String, ready: bool, background: Option<[u8; 3]> }

/// Assigned spares waiting for their page's acknowledgement.
fn spare_acks() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    static ACKS: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>> = OnceLock::new();
    ACKS.get_or_init(Default::default)
}

fn spare_slot() -> &'static Mutex<Option<Spare>> {
    static SPARE: OnceLock<Mutex<Option<Spare>>> = OnceLock::new();
    SPARE.get_or_init(Default::default)
}
fn is_spare(label: &str) -> bool { spare_slot().lock().ok().is_some_and(|spare| spare.as_ref().is_some_and(|spare| spare.label == label)) }

/// A ready spare this opener may use. On Windows/Linux a spare is owned by the window that asked
/// for it (the parent is fixed at creation), so only that window may take it; on macOS surface
/// windows have no parent and any opener may.
fn take_spare(slot: &mut Option<Spare>, owner: &str, any_owner: bool) -> Option<Spare> {
    if slot.as_ref().is_some_and(|spare| spare.ready && (any_owner || spare.owner == owner)) { slot.take() } else { None }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Assign<'a> { surface: &'a str, request_id: &'a str, params: HashMap<String, String> }

/// Loads a spare for `owner` unless one exists. Its page reports `surface_window_spare_ready`
/// once it can render any surface at once.
fn prepare_spare(app: &tauri::AppHandle, owner: &str, background: Option<[u8; 3]>) -> Result<(), String> {
    let parent = app.get_webview_window(owner).ok_or("The opening window is unavailable.")?;
    let label = format!("surface-spare-{:032x}", rand::random::<u128>());
    {
        let mut slot = spare_slot().lock().map_err(|_| "Surface window state is unavailable.")?;
        if slot.as_ref().is_some_and(|spare| app.get_webview_window(&spare.label).is_some()) { return Ok(()); }
        *slot = Some(Spare { label: label.clone(), owner: owner.to_string(), ready: false, background });
    }
    let built = add_capability(app, format!("{label}-interface"), &label, true, &[])
        .and_then(|_| surface_page(&parent.url().map_err(|err| err.to_string())?, SPARE_ROUTE, None, &[]))
        .and_then(|path| build_window(app, &parent, &label, SPARE_ROUTE, path, "Specrails", (1100.0, 760.0), (480.0, 320.0), background, false));
    if let Err(error) = built {
        if let Ok(mut slot) = spare_slot().lock() { if slot.as_ref().is_some_and(|spare| spare.label == label) { *slot = None; } }
        return Err(error);
    }
    Ok(())
}

fn prepare_spare_later(app: &tauri::AppHandle, owner: String, background: Option<[u8; 3]>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SPARE_RESPAWN_DELAY).await;
        let _ = prepare_spare(&app, &owner, background);
    });
}

/// The main window (or a mission window) asks for a spare once it is idle after startup.
#[tauri::command]
pub async fn surface_window_prewarm(app: tauri::AppHandle, webview: Webview, background: Option<[u8; 3]>) -> Result<(), String> {
    let owner = webview.label().to_string();
    if owner != webview.window().label() || !crate::mission_windows::is_trusted_interface(&owner) {
        return Err("Only a Specrails interface can prepare a surface window.".into());
    }
    prepare_spare(&app, &owner, background)
}

/// The spare page is loaded and listening for its surface; called again, once assigned, it
/// confirms it took the surface.
#[tauri::command]
pub fn surface_window_spare_ready(webview: Webview) -> Result<(), String> {
    if let Some(ack) = spare_acks().lock().ok().and_then(|mut acks| acks.remove(webview.label())) {
        let _ = ack.send(());
        return Ok(());
    }
    let mut slot = spare_slot().lock().map_err(|_| "Surface window state is unavailable.")?;
    match slot.as_mut() {
        Some(spare) if spare.label == webview.label() => { spare.ready = true; Ok(()) }
        _ => Err("This window is not the spare surface window.".into()),
    }
}

/// Turns the spare into the surface's window: permissions, title, size and place, then the page
/// renders the surface and shows the window.
async fn assign_spare(app: &tauri::AppHandle, window: &tauri::WebviewWindow, parent: &tauri::WebviewWindow, spec: &SurfaceSpec, request_id: &str, params: &HashMap<String, String>, size: (f64, f64)) -> Result<(), String> {
    let label = window.label().to_string();
    if !spec.permissions.is_empty() { add_capability(app, format!("{label}-{}-interface", spec.id), &label, false, spec.permissions)?; }
    window.set_title(&format!("Specrails — {}", spec.title)).map_err(|err| err.to_string())?;
    window.set_min_size(Some(tauri::LogicalSize::new(spec.min_width, spec.min_height))).map_err(|err| err.to_string())?;
    window.set_size(tauri::LogicalSize::new(size.0, size.1)).map_err(|err| err.to_string())?;
    let _ = center_on_opener(parent, window, size, (spec.min_width, spec.min_height));
    let (ack, acked) = tokio::sync::oneshot::channel();
    spare_acks().lock().map_err(|_| "Surface window state is unavailable.")?.insert(label.clone(), ack);
    let sent = app.emit_to(label.as_str(), ASSIGN_EVENT, &Assign { surface: spec.id, request_id, params: params.clone() });
    let confirmed = sent.is_ok() && matches!(tokio::time::timeout(SPARE_ACK_TIMEOUT, acked).await, Ok(Ok(())));
    if let Ok(mut acks) = spare_acks().lock() { acks.remove(&label); }
    if confirmed { Ok(()) } else { Err("The spare window did not take the surface.".into()) }
}

// `async`: a synchronous command runs on the main thread, and building a
// webview window there deadlocks on Windows (WebView2 needs that thread's
// event loop), so the window never appears. Async commands run off it.
#[tauri::command]
pub async fn surface_window_open(app: tauri::AppHandle, webview: Webview, surface: String, request_id: String, params: Option<HashMap<String, String>>, geometry: Option<Geometry>, background: Option<[u8; 3]>) -> Result<Opened, String> {
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

    // The registry lock is never held across a window call: those run on the main thread, whose
    // window events (focus, close, navigation) take this lock too.
    let reuse = {
        let mut entries = registry().lock().map_err(|_| "Surface window state is unavailable.")?;
        entries.retain(|label, entry| entry.opening || app.get_webview_window(label).is_some());
        if let Some((label, existing)) = entries.iter().find(|(_, entry)| entry.key == key) {
            Some((label.clone(), existing.request_id.clone(), existing.opening))
        } else {
            if entries.len() >= MAX_WINDOWS { return Err("Close a window before opening another.".into()); }
            None
        }
    };
    if let Some((label, existing_request, opening)) = reuse {
        // Still opening (a double click): the first request's window answers both, and shows
        // itself once painted.
        if !opening { if let Some(window) = app.get_webview_window(&label) { focus(&window)?; } }
        return Ok(Opened { window_label: label, request_id: existing_request, reused: true });
    }

    let parent = app.get_webview_window(&owner).ok_or("The opening window is unavailable.")?;
    let geometry = geometry.unwrap_or_default();
    let clamp = |value: Option<f64>, min: f64, fallback: f64| value.filter(|v| v.is_finite()).map(|v| v.clamp(min, 8000.0)).unwrap_or(fallback);
    let size = (clamp(geometry.width, spec.min_width, spec.width), clamp(geometry.height, spec.min_height, spec.height));
    let register = |label: &str, opening: bool| -> Result<(), String> {
        let mut entries = registry().lock().map_err(|_| "Surface window state is unavailable.")?;
        entries.insert(label.to_string(), Entry { key: key.clone(), surface: spec.id, owner: owner.clone(), request_id: request_id.clone(), opening });
        Ok(())
    };
    let unregister = |label: &str| { if let Ok(mut entries) = registry().lock() { entries.remove(label); } };

    // Instant path: the loaded spare becomes this surface's window.
    let spare = spare_slot().lock().ok().and_then(|mut slot| take_spare(&mut slot, &owner, cfg!(target_os = "macos")));
    if let Some(spare) = spare {
        if let Some(window) = app.get_webview_window(&spare.label) {
            register(&spare.label, true)?;
            match assign_spare(&app, &window, &parent, spec, &request_id, &params, size).await {
                Ok(()) => {
                    register(&spare.label, false)?;
                    show_fallback(&app, &spare.label);
                    prepare_spare_later(&app, spare.owner.clone(), background.or(spare.background));
                    return Ok(Opened { window_label: spare.label, request_id, reused: false });
                }
                // A spare that cannot take the surface is discarded; the window opens the cold way.
                Err(_) => { unregister(&spare.label); let _ = window.destroy(); }
            }
        }
    }

    let label = format!("surface-{}-{:032x}", spec.id, rand::random::<u128>());
    // Reserved while it is built, so a second click focuses this window instead of opening another.
    register(&label, true)?;
    let built = add_capability(&app, format!("{label}-interface"), &label, true, spec.permissions)
        .and_then(|_| surface_page(&parent.url().map_err(|err| err.to_string())?, spec.id, Some(&request_id), &sorted))
        .and_then(|path| build_window(&app, &parent, &label, spec.id, path, spec.title, size, (spec.min_width, spec.min_height), background, true));
    let window = match built { Ok(window) => window, Err(error) => { unregister(&label); return Err(error); } };
    // Every new surface window opens centered on the window that opened it
    // (its remembered size kept), never at a remembered or screen position.
    let _ = center_on_opener(&parent, &window, size, (spec.min_width, spec.min_height));
    register(&label, false)?;
    show_fallback(&app, &label);
    // The next open is instant: load a spare if none is waiting.
    if spare_slot().lock().map(|slot| slot.is_none()).unwrap_or(false) { prepare_spare_later(&app, owner.clone(), background); }
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

/// The surface windows a window opened that stay above it: its modals. A surface whose results
/// bring the opener forward (the live board, a second-screen window) does not, or it would cover
/// the very place the opener just showed.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn kept_above(owner: &str) -> Vec<String> {
    registry().lock().map(|entries| entries.iter()
        .filter(|(_, entry)| entry.owner == owner && spec(entry.surface).is_some_and(|spec| !spec.focus_opener_on_result))
        .map(|(label, _)| label.clone()).collect()).unwrap_or_default()
}

/// macOS: a surface window has no parent (see `surface_window_open`), so clicking its opener used
/// to bury it behind the opener. When the opener comes forward, its open surface windows are put
/// right above it again, as an owned window behaves on Windows: above its opener only (other apps'
/// windows keep their place), not key, not moved, minimized on its own.
#[cfg(target_os = "macos")]
fn keep_above_opener(opener: &tauri::Window) {
    use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
    let Ok(opener_ns) = opener.ns_window() else { return };
    // SAFETY: Tauri runs window events on the main thread and these pointers are live NSWindows.
    let opener_number = unsafe { (*(opener_ns as *const NSWindow)).windowNumber() };
    let app = opener.app_handle();
    for label in kept_above(opener.label()) {
        let Some(window) = app.get_webview_window(&label) else { continue };
        if !window.is_visible().unwrap_or(false) || window.is_minimized().unwrap_or(true) { continue; }
        let Ok(ns) = window.ns_window() else { continue };
        unsafe { (*(ns as *const NSWindow)).orderWindow_relativeTo(NSWindowOrderingMode::Above, opener_number) };
    }
}

/// Closure always reaches the opener (Escape, close button, Cmd-W, crash), and
/// focus goes back to it so the opener can restore focus to its trigger.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(target_os = "macos")]
    if matches!(event, tauri::WindowEvent::Focused(true)) { keep_above_opener(window); return; }
    if !matches!(event, tauri::WindowEvent::Destroyed) { return; }
    if let Ok(mut slot) = spare_slot().lock() { if slot.as_ref().is_some_and(|spare| spare.label == window.label()) { *slot = None; } }
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
    const fn frame(x: f64, y: f64, width: f64, height: f64) -> Frame { Frame { x, y, width, height } }
    const WORK: Frame = frame(0.0, 25.0, 1920.0, 1055.0);

    #[test]
    fn spec_native_surface_windows_minimizing_a_native_modal_leaves_the_main_window_up() {
        // [spec:native-surface-windows/minimizing-a-native-modal-leaves-the-main-window-up]
        assert!(!surface_has_parent(true), "macOS surfaces must have no parent or minimizing one minimizes the app");
        assert!(surface_has_parent(false), "Windows/Linux surfaces stay owned by their opener");
    }
    #[test]
    fn a_new_surface_centers_on_its_opener_not_the_screen() {
        // Opener in the top-left quarter of the screen.
        let placed = centered_frame(frame(100.0, 100.0, 1200.0, 800.0), (600.0, 400.0), (300.0, 200.0), WORK);
        assert_eq!(placed, frame(400.0, 300.0, 600.0, 400.0));
        // Both axes: the window's center is the opener's center.
        assert_eq!(placed.x + placed.width / 2.0, 700.0);
        assert_eq!(placed.y + placed.height / 2.0, 500.0);
    }

    #[test]
    fn a_surface_larger_than_its_opener_still_centers_and_stays_in_the_work_area() {
        // Bigger than the opener: centered on it all the same.
        assert_eq!(centered_frame(frame(600.0, 300.0, 700.0, 500.0), (1100.0, 760.0), (720.0, 520.0), WORK), frame(400.0, 170.0, 1100.0, 760.0));
        // Opener against the right/bottom edges: slides in rather than spilling off.
        assert_eq!(centered_frame(frame(1500.0, 800.0, 400.0, 250.0), (1100.0, 760.0), (720.0, 520.0), WORK), frame(820.0, 320.0, 1100.0, 760.0));
        // Opener partly off the left/top: pinned to the work area (below the menu bar).
        assert_eq!(centered_frame(frame(-500.0, -200.0, 600.0, 400.0), (1100.0, 760.0), (720.0, 520.0), WORK), frame(0.0, 25.0, 1100.0, 760.0));
    }

    #[test]
    fn a_surface_larger_than_the_work_area_shrinks_to_it_but_not_below_its_minimum() {
        let small = frame(0.0, 0.0, 1280.0, 720.0);
        assert_eq!(centered_frame(frame(0.0, 0.0, 1280.0, 720.0), (1400.0, 880.0), (760.0, 480.0), small), frame(0.0, 0.0, 1280.0, 720.0));
        let tiny = frame(0.0, 0.0, 640.0, 400.0);
        assert_eq!(centered_frame(frame(0.0, 0.0, 640.0, 400.0), (1100.0, 760.0), (720.0, 520.0), tiny), frame(0.0, 0.0, 720.0, 520.0));
    }

    #[test]
    fn secondary_monitors_and_scale_factors_use_one_desktop_space() {
        // A secondary display left of the primary (negative origin): centering happens there.
        let left = frame(-2560.0, 0.0, 2560.0, 1415.0);
        assert_eq!(centered_frame(frame(-2000.0, 200.0, 1400.0, 900.0), (1000.0, 600.0), (720.0, 480.0), left), frame(-1800.0, 350.0, 1000.0, 600.0));
        // Physical values divide by their own scale only where the desktop is logical (macOS).
        let converted = desktop_frame(2880.0, 100.0, 2400.0, 1600.0, 2.0);
        if DESKTOP_IS_LOGICAL { assert_eq!(converted, frame(1440.0, 50.0, 1200.0, 800.0)); }
        else { assert_eq!(converted, frame(2880.0, 100.0, 2400.0, 1600.0)); }
    }
    #[test]
    fn window_opening_commands_are_async_so_windows_does_not_deadlock() {
        let surfaces = include_str!("surface_windows.rs");
        assert!(surfaces.contains("pub async fn surface_window_open(") && surfaces.contains("pub async fn surface_window_prewarm("));
        let loops = include_str!("loop_windows.rs");
        assert!(loops.contains("pub async fn loop_window_open(") && loops.contains("pub async fn plugin_window_open("));
    }
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
        let settings = spec("project-settings").unwrap();
        let target = [("projectId".into(), "p1".into()), ("settingId".into(), "recentlyDeleted".into())].into();
        assert!(validate_params(settings, &target).is_ok());
        assert_eq!(settings.permissions, &["dialog:allow-open"]);
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
    fn modals_stay_above_their_opener_but_the_live_board_does_not() {
        let insert = |label: &str, surface: &'static str, owner: &str| registry().lock().unwrap().insert(label.into(), Entry { key: label.into(), surface, owner: owner.into(), request_id: "r".into(), opening: false });
        insert("surface-above-settings", "app-settings", "main-above");
        insert("surface-above-job", "job-detail", "main-above");
        insert("surface-above-board", "live-board", "main-above");
        insert("surface-above-other", "job-detail", "mission-above");
        let mut above = kept_above("main-above");
        above.sort();
        assert_eq!(above, vec!["surface-above-job".to_string(), "surface-above-settings".to_string()]);
        for label in ["surface-above-settings", "surface-above-job", "surface-above-board", "surface-above-other"] { registry().lock().unwrap().remove(label); }
    }
    #[test]
    fn a_spare_is_taken_once_when_ready_and_only_by_its_owner_off_macos() {
        let spare = |ready: bool| Some(Spare { label: "surface-spare-1".into(), owner: "main".into(), ready, background: None });
        // Still loading: the window opens the cold way.
        let mut loading = spare(false);
        assert_eq!(take_spare(&mut loading, "main", false), None);
        assert!(loading.is_some());
        // Windows/Linux: a spare's parent is its owner, so another opener cannot use it.
        let mut owned = spare(true);
        assert_eq!(take_spare(&mut owned, "mission-1", false), None);
        // macOS: no parent, any opener may take it. Taken once: the slot is empty after.
        let mut any = spare(true);
        assert_eq!(take_spare(&mut any, "mission-1", true).map(|spare| spare.label), Some("surface-spare-1".into()));
        assert!(any.is_none());
        let mut mine = spare(true);
        assert!(take_spare(&mut mine, "main", false).is_some());
    }
    #[test]
    fn a_spare_may_only_report_ready_until_it_is_a_surface() {
        *spare_slot().lock().unwrap() = Some(Spare { label: "surface-spare-test".into(), owner: "main".into(), ready: false, background: None });
        assert!(permits_command("surface-spare-test", "surface_window_spare_ready"));
        for command in ["surface_window_result", "surface_window_toast", "surface_window_open", "surface_window_prewarm", "check_app_update", "desktop_save_text"] {
            assert!(!permits_command("surface-spare-test", command), "{command}");
        }
        assert!(!permits_command("surface-other", "surface_window_spare_ready"));
        // Assigned: it answers as the surface it became.
        registry().lock().unwrap().insert("surface-spare-test".into(), Entry { key: "app-settings".into(), surface: "app-settings", owner: "main".into(), request_id: "r".into(), opening: false });
        assert!(permits_command("surface-spare-test", "surface_window_result"));
        assert!(permits_command("surface-spare-test", "check_app_update"));
        registry().lock().unwrap().remove("surface-spare-test");
        *spare_slot().lock().unwrap() = None;
    }
    #[test]
    fn a_spare_loads_its_own_page_and_a_surface_page_keeps_its_request() {
        let origin = tauri::Url::parse("tauri://localhost/").unwrap();
        let spare = surface_page(&origin, SPARE_ROUTE, None, &[]).unwrap();
        assert_eq!(spare, "index.html?surfaceWindow=spare");
        assert!(allowed_navigation(&origin, &origin.join(&spare).unwrap(), SPARE_ROUTE));
        assert!(!allowed_navigation(&origin, &origin.join(&spare).unwrap(), "app-settings"));
        let (key, value) = ("jobId".to_string(), "j1".to_string());
        assert_eq!(surface_page(&origin, "job-detail", Some("req-1"), &[(&key, &value)]).unwrap(), "index.html?surfaceWindow=job-detail&requestId=req-1&jobId=j1");
    }
    #[test]
    fn surface_windows_get_only_their_declared_commands() {
        let insert = |label: &str, surface: &'static str| registry().lock().unwrap().insert(label.into(), Entry { key: label.into(), surface, owner: "main".into(), request_id: "r".into(), opening: false });
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
