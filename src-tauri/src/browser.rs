//! Native browser: an OS-composited child webview, never a video stream.
//!
//! Every pane is owned by a client mount. Commands and events carry that owner
//! so a delayed cleanup cannot close a newer pane. Remote content receives no
//! Tauri capability; capture uses fixed scripts evaluated by the host.

use serde::{Deserialize, Serialize};
use std::sync::{atomic::{AtomicU64, Ordering}, Mutex};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
#[path = "browser_capture.rs"]
mod capture;
#[cfg(windows)]
#[path = "browser_capture_windows.rs"]
mod capture;
#[cfg(any(target_os = "macos", windows))]
#[path = "browser_capture_common.rs"]
mod capture_common;
#[cfg(target_os = "macos")]
#[path = "browser_popup.rs"]
mod popup;
#[cfg(windows)]
#[path = "browser_popup_windows.rs"]
mod popup;

const EVENT_NAME: &str = "native-browser:event";
#[path = "browser_ownership.rs"]
mod ownership;
use ownership::{BrowserOwners, PaneOwner};
static PANE_SEQ: AtomicU64 = AtomicU64::new(0);
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);
static OPEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static OWNERS: Mutex<Option<BrowserOwners>> = Mutex::new(None);
const MAX_POPUPS: usize = 8;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct PaneBounds { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }

impl PaneBounds {
    fn validate(self) -> Result<Self, String> {
        if ![self.x, self.y, self.width, self.height].iter().all(|n| n.is_finite())
            || self.x < 0.0 || self.y < 0.0 || self.width < 1.0 || self.height < 1.0
            || self.width > 16_384.0 || self.height > 16_384.0 {
            return Err("invalid native browser bounds".into());
        }
        Ok(self)
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PaneEvent { owner_id: String, kind: String, url: Option<String>, title: Option<String> }

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedElement {
    pub selector: String,
    pub tag_name: String,
    pub text: String,
    pub rect: PaneBounds,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureViewport { pub width: f64, pub height: f64, pub device_scale_factor: f64 }

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeCapture {
    pub screenshot_data_url: String,
    pub url: String,
    pub title: String,
    pub viewport: CaptureViewport,
    pub element: Option<SelectedElement>,
}

fn validate_owner(owner: &str) -> Result<(), String> {
    if owner.is_empty() || owner.len() > 64 || !owner.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_') {
        return Err("invalid native browser owner".into());
    }
    Ok(())
}
fn with_owners<T>(action: impl FnOnce(&mut BrowserOwners) -> T) -> Result<T, String> {
    let mut owners = OWNERS.lock().map_err(|_| "native browser state unavailable")?;
    Ok(action(owners.get_or_insert_with(BrowserOwners::default)))
}
fn pane_label(owner: &str) -> String { format!("native-browser-{}-{owner}", PANE_SEQ.fetch_add(1, Ordering::Relaxed)) }
fn popup_prefix(pane: &str) -> String { format!("{pane}-popup-") }
fn owner_for_pane(pane: &str) -> Option<PaneOwner> { with_owners(|owners| owners.for_pane(pane)).ok().flatten() }
fn is_owner(pane: &str) -> bool { owner_for_pane(pane).is_some() }
fn caller_window(webview: &tauri::Webview) -> Result<String, String> {
    let label = webview.label();
    if label != webview.window().label() || !crate::mission_windows::is_trusted_interface(label) {
        return Err("Native browser commands require a registered Specrails interface".into());
    }
    Ok(label.into())
}
fn close_owned(app: &AppHandle, pane_label: &str) {
    let labels = with_owners(|owners| owners.take_popups(pane_label)).unwrap_or_default();
    for label in labels { if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); } }
    if let Some(pane) = app.get_webview(pane_label) { let _ = pane.close(); }
}
/// Window teardown can never reclaim another window's transferred browser.
pub(crate) fn close_owned_for_window(app: &AppHandle, window_label: &str) {
    if let Ok(panes) = with_owners(|owners| owners.remove_window(window_label)) {
        for pane in panes { close_owned(app, &pane.pane_label); }
    }
}
fn release_popup(label: &str) { let _ = with_owners(|owners| owners.release_popup(label)); }
fn set_session_visible(app: &AppHandle, pane: &PaneOwner, visible: bool) -> Result<(), String> {
    let webview = app.get_webview(&pane.pane_label).ok_or("native browser pane not open")?;
    if visible { webview.show() } else { webview.hide() }.map_err(|error| error.to_string())?;
    with_owners(|owners| owners.set_presented(&pane.pane_label, visible))?;
    for label in with_owners(|owners| owners.popups_for(&pane.pane_label))? {
        if let Some(popup) = app.get_webview_window(&label) {
            if visible { popup.show() } else { popup.hide() }.map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}


fn popup_size(size: Option<LogicalSize<f64>>) -> LogicalSize<f64> {
    let requested = size.unwrap_or(LogicalSize::new(560.0, 720.0));
    LogicalSize::new(
        if requested.width.is_finite() { requested.width.clamp(360.0, 1280.0) } else { 560.0 },
        if requested.height.is_finite() { requested.height.clamp(320.0, 960.0) } else { 720.0 },
    )
}

fn open_popup(app: &AppHandle, owner: &str, url: Url, features: NewWindowFeatures, incognito: bool) -> NewWindowResponse<tauri::Wry> {
    if !is_owner(owner) { return NewWindowResponse::Deny; }
    if !is_allowed_url(url.as_str()) {
        emit_pane_event(app, owner, "popup-error", None, None);
        return NewWindowResponse::Deny;
    }
    let label = format!("{}{}", popup_prefix(owner), POPUP_SEQ.fetch_add(1, Ordering::Relaxed));
    let reserved = with_owners(|owners| owners.reserve_popup(label.clone(), owner, MAX_POPUPS)).unwrap_or(false);
    if !reserved {
        emit_pane_event(app, owner, "popup-error", None, None);
        return NewWindowResponse::Deny;
    }
    let size = popup_size(features.size());
    let nav_owner = owner.to_string();
    let nav_app = app.clone();
    let child_owner = owner.to_string();
    let child_app = app.clone();
    // The engine-supplied configuration is essential: recreating the URL in an
    // unrelated webview breaks opener, postMessage, shared cookies and SSO.
    // WebView2 attaches and navigates the requested content via SetNewWindow
    // after this callback returns. Start blank so immediate self-close cannot
    // race host callback installation while building the window.
    #[cfg(windows)]
    let initial_url = Url::parse("about:blank").expect("static URL");
    #[cfg(not(windows))]
    let initial_url = url;
    // Keep the top-level popup independent: no parent()/owner() HWND binding.
    // window_features shares the engine environment/configuration, not OS
    // window ownership. The opener can move to another app window and the old
    // host can then be destroyed without taking the authentication popup down.
    let presented = with_owners(|owners| owners.is_presented(owner)).unwrap_or(false);
    let result = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(initial_url))
        .title("Sign in").window_features(features).incognito(incognito)
        .inner_size(size.width, size.height).center().visible(presented).focused(presented)
        .on_navigation(move |next| {
            if !is_owner(&nav_owner) { return false; }
            let allowed = is_allowed_url(next.as_str());
            if !allowed { emit_pane_event(&nav_app, &nav_owner, "popup-error", None, None); }
            allowed
        })
        .on_new_window(move |next, features| open_popup(&child_app, &child_owner, next, features, incognito))
        .build();
    match result {
        Ok(window) => {
            let close_label = label.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) { release_popup(&close_label); }
            });
            #[cfg(any(target_os = "macos", windows))]
            if popup::install_close_handler(&window).is_err() {
                release_popup(&label);
                let _ = window.close();
                emit_pane_event(app, owner, "popup-error", None, None);
                return NewWindowResponse::Deny;
            }
            if !is_owner(owner) {
                release_popup(&label);
                let _ = window.close();
                return NewWindowResponse::Deny;
            }
            if !with_owners(|owners| owners.is_presented(owner)).unwrap_or(false) { let _ = window.hide(); }
            emit_pane_event(app, owner, "popup-opened", None, None);
            NewWindowResponse::Create { window }
        }
        Err(_) => {
            release_popup(&label);
            // Do not log OAuth URLs or raw errors that may contain credentials.
            emit_pane_event(app, owner, "popup-error", None, None);
            NewWindowResponse::Deny
        }
    }
}

/// Local preview URLs are allowed: this is the user's browser, not a server fetch.
/// The exact same policy applies to typed addresses, in-page links and popups.
pub fn is_allowed_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed == "about:blank" || Url::parse(trimmed).map(|u| matches!(u.scheme(), "http" | "https")).unwrap_or(false)
}
fn parse_allowed(url: &str) -> Result<Url, String> {
    if !is_allowed_url(url) { return Err("url scheme not allowed".into()); }
    Url::parse(url.trim()).map_err(|e| e.to_string())
}
fn emit_pane_event(app: &AppHandle, pane_label: &str, kind: &str, url: Option<String>, title: Option<String>) {
    if let Some(owner) = owner_for_pane(pane_label) {
        let _ = app.emit_to(&owner.window_label, EVENT_NAME, PaneEvent { owner_id: owner.owner_id, kind: kind.into(), url, title });
    }
}
fn with_pane(app: &AppHandle, window_label: &str, owner: &str) -> Result<tauri::Webview, String> {
    validate_owner(owner)?;
    let entry = with_owners(|owners| owners.for_window(window_label, owner))?.ok_or("native browser owner is no longer active")?;
    let pane = app.get_webview(&entry.pane_label).ok_or("native browser pane not open")?;
    if pane.window().label() != window_label { return Err("native browser is being transferred".into()); }
    Ok(pane)
}
#[cfg(feature = "native-browser-smoke")]
pub fn browser_pane_for_window(app: &AppHandle, window: &str, owner: &str) -> Result<tauri::Webview, String> { with_pane(app, window, owner) }

#[tauri::command]
pub fn browser_supported() -> bool { cfg!(any(target_os = "macos", target_os = "windows")) }
#[tauri::command]
pub fn browser_capture_supported() -> bool {
    #[cfg(any(target_os = "macos", windows))]
    { capture::supported() }
    #[cfg(not(any(target_os = "macos", windows)))]
    { false }
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, webview: tauri::Webview, owner_id: String, url: String, bounds: PaneBounds) -> Result<(), String> {
    open_browser(app, caller_window(&webview)?, owner_id, url, bounds, false).await
}

/// Local smoke fixtures must never share the normal browser's cookie store.
#[cfg(feature = "native-browser-smoke")]
#[allow(dead_code)]
pub async fn browser_open_smoke(app: AppHandle, owner_id: String, url: String, bounds: PaneBounds) -> Result<(), String> {
    open_browser(app, "main".into(), owner_id, url, bounds, true).await
}
#[cfg(feature = "native-browser-smoke")]
pub async fn browser_open_smoke_in_window(app: AppHandle, window_label: String, owner_id: String, url: String, bounds: PaneBounds) -> Result<(), String> {
    open_browser(app, window_label, owner_id, url, bounds, true).await
}

async fn open_browser(app: AppHandle, window_label: String, owner_id: String, url: String, bounds: PaneBounds, incognito: bool) -> Result<(), String> {
    validate_owner(&owner_id)?;
    if !crate::mission_windows::is_trusted_interface(&window_label) { return Err("Unregistered browser window".into()); }
    let parsed = parse_allowed(&url)?;
    let bounds = bounds.validate()?;
    let _opening = OPEN_LOCK.lock().await;
    if let Some(existing) = with_owners(|owners| owners.mount(&window_label, &owner_id))? {
        // A transferred mount is adopted without reloading its history, DOM,
        // cookies, authentication state or active popup opener relationships.
        let pane = app.get_webview(&existing.pane_label).ok_or("native browser pane not open")?;
        if pane.window().label() != window_label { return Err("native browser is being transferred".into()); }
        let previous = with_owners(|owners| owners.active(&window_label))?.filter(|active| active.pane_label != existing.pane_label);
        pane.set_bounds(tauri::Rect { position: LogicalPosition::new(bounds.x, bounds.y).into(), size: LogicalSize::new(bounds.width, bounds.height).into() }).map_err(|error| error.to_string())?;
        if let Some(previous) = &previous { set_session_visible(&app, previous, false)?; }
        if let Err(error) = set_session_visible(&app, &existing, true) {
            if let Some(previous) = &previous { let _ = set_session_visible(&app, previous, true); }
            return Err(error);
        }
        with_owners(|owners| owners.activate(&window_label, &owner_id))??;
        emit_pane_event(&app, &existing.pane_label, "nav", pane.url().ok().map(|url| url.to_string()), None);
        return Ok(());
    }
    let label = pane_label(&owner_id);
    let previous = with_owners(|owners| owners.install(PaneOwner { window_label: window_label.clone(), owner_id: owner_id.clone(), pane_label: label.clone() }))?;
    if let Some(previous) = previous { close_owned(&app, &previous.pane_label); }
    let result = (|| {
        let window = app.get_window(&window_label).ok_or_else(|| "browser window not found".to_string())?;
        let nav_app = app.clone(); let nav_owner = label.clone();
        let load_app = app.clone(); let load_owner = label.clone();
        let title_app = app.clone(); let title_owner = label.clone();
        let popup_app = app.clone(); let popup_owner = label.clone();
        #[allow(unused_mut)]
        let mut builder = WebviewBuilder::new(label.clone(), WebviewUrl::External(parsed))
            .incognito(incognito)
            .on_navigation(move |url: &Url| {
                let allowed = is_allowed_url(url.as_str());
                if allowed { emit_pane_event(&nav_app, &nav_owner, "nav", Some(url.to_string()), None); }
                allowed
            })
            .on_page_load(move |_webview, payload| {
                let kind = match payload.event() { PageLoadEvent::Started => "load-started", PageLoadEvent::Finished => "load-finished" };
                emit_pane_event(&load_app, &load_owner, kind, Some(payload.url().to_string()), None);
            })
            .on_document_title_changed(move |_webview, title| emit_pane_event(&title_app, &title_owner, "title", None, Some(title)))
            .on_new_window(move |url: Url, features| open_popup(&popup_app, &popup_owner, url, features, incognito));
        #[cfg(target_os = "windows")]
        {
            let profile = if incognito {
                // A smoke/ephemeral owner must never touch the user's profile,
                // even for WebView2 cache files or environment initialization.
                std::env::temp_dir().join(format!("specrails-browser-{}-{label}", std::process::id()))
            } else {
                app.path().home_dir().map_err(|_| "native browser profile is unavailable")?.join(".specrails").join("native-browser-profile")
            };
            std::fs::create_dir_all(&profile).map_err(|_| "native browser profile could not be created")?;
            builder = builder.data_directory(profile);
        }
        let pane = window.add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height)).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        capture::enable_gestures(&pane)?;
        #[cfg(not(target_os = "macos"))]
        let _ = pane;
        Ok(())
    })();
    if result.is_err() || !is_owner(&label) {
        let _ = with_owners(|owners| {
            if owners.for_window(&window_label, &owner_id).is_some_and(|current| current.pane_label == label) { owners.remove(&window_label, Some(&owner_id)); }
        });
        close_owned(&app, &label);
        return result.and(Err("native browser opening was cancelled".into()));
    }
    result
}

/// Called only by the trusted mission handoff coordinator, before hydration.
/// Popups stay attached to the same native opener, while events follow the new
/// application window through the stable pane identity.
pub(crate) async fn transfer_browser_window(app: &AppHandle, source: &str, target: &str, owner_id: &str) -> Result<(), String> {
    validate_owner(owner_id)?;
    if !crate::mission_windows::is_trusted_interface(source) || !crate::mission_windows::is_trusted_interface(target) {
        return Err("Cannot transfer a browser to an unregistered mission window".into());
    }
    let _opening = OPEN_LOCK.lock().await;
    let entry = with_owners(|owners| owners.transfer_candidate(source, target, owner_id))??;
    if entry.window_label == target { return Ok(()); }
    let source_window = app.get_window(source).ok_or("source browser window not found")?;
    let target_window = app.get_window(target).ok_or("destination browser window not found")?;
    let pane = app.get_webview(&entry.pane_label).ok_or("native browser pane not open")?;
    if pane.window().label() != source { return Err("native browser is being transferred".into()); }
    let source_active = with_owners(|owners| owners.active(source))?;
    let previous_target = with_owners(|owners| owners.active(target))?;
    set_session_visible(app, &entry, false)?;
    if let Some(previous) = &previous_target {
        if let Err(error) = set_session_visible(app, previous, false) {
            if source_active.as_ref() == Some(&entry) { let _ = set_session_visible(app, &entry, true); }
            return Err(error);
        }
    }
    // Tauri updates its cached window before dispatching reparent, so rollback
    // must restore the original parent even when the first call reports error.
    if let Err(error) = pane.reparent(&target_window) {
        let _ = pane.reparent(&source_window);
        if source_active.as_ref() == Some(&entry) { let _ = set_session_visible(app, &entry, true); }
        if let Some(previous) = &previous_target { let _ = set_session_visible(app, previous, true); }
        return Err(format!("Could not move the native browser: {error}"));
    }
    if let Err(error) = with_owners(|owners| owners.transfer(source, target, owner_id)).and_then(|result| result) {
        let _ = pane.reparent(&source_window);
        if source_active.as_ref() == Some(&entry) { let _ = set_session_visible(app, &entry, true); }
        if let Some(previous) = &previous_target { let _ = set_session_visible(app, previous, true); }
        return Err(error);
    }
    // A promoted parked session may have no mounted renderer controls. Keep
    // both it and the moved browser hidden until the owning UI explicitly
    // adopts them; only a still-mounted owner should respond to resume.
    if let Some(restored) = with_owners(|owners| owners.resume_candidate(source))? {
        if source_active.as_ref().is_none_or(|previous| previous.pane_label != restored.pane_label) {
            emit_pane_event(app, &restored.pane_label, "resume", app.get_webview(&restored.pane_label).and_then(|pane| pane.url().ok()).map(|url| url.to_string()), None);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, webview: tauri::Webview, owner_id: String, url: String) -> Result<(), String> { with_pane(&app, &caller_window(&webview)?, &owner_id)?.navigate(parse_allowed(&url)?).map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_back(app: AppHandle, webview: tauri::Webview, owner_id: String) -> Result<(), String> { with_pane(&app, &caller_window(&webview)?, &owner_id)?.eval("history.back()").map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_forward(app: AppHandle, webview: tauri::Webview, owner_id: String) -> Result<(), String> { with_pane(&app, &caller_window(&webview)?, &owner_id)?.eval("history.forward()").map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_reload(app: AppHandle, webview: tauri::Webview, owner_id: String) -> Result<(), String> { with_pane(&app, &caller_window(&webview)?, &owner_id)?.reload().map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, webview: tauri::Webview, owner_id: String, bounds: PaneBounds) -> Result<(), String> {
    let bounds = bounds.validate()?;
    with_pane(&app, &caller_window(&webview)?, &owner_id)?.set_bounds(tauri::Rect { position: LogicalPosition::new(bounds.x, bounds.y).into(), size: LogicalSize::new(bounds.width, bounds.height).into() }).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn browser_show(app: AppHandle, webview: tauri::Webview, owner_id: String) -> Result<(), String> {
    let window = caller_window(&webview)?;
    let pane = with_pane(&app, &window, &owner_id)?;
    let owner = owner_for_pane(pane.label()).ok_or("native browser owner is no longer active")?;
    set_session_visible(&app, &owner, true)
}
#[tauri::command]
pub async fn browser_hide(app: AppHandle, webview: tauri::Webview, owner_id: String) -> Result<(), String> {
    let window = caller_window(&webview)?; validate_owner(&owner_id)?;
    if with_owners(|owners| owners.for_window(&window, &owner_id))?.is_none() { return Ok(()); }
    let pane = with_pane(&app, &window, &owner_id)?;
    let owner = owner_for_pane(pane.label()).ok_or("native browser owner is no longer active")?;
    set_session_visible(&app, &owner, false)
}
#[tauri::command]
pub async fn browser_close(app: AppHandle, webview: tauri::Webview, owner_id: String) -> Result<(), String> {
    let window = caller_window(&webview)?; validate_owner(&owner_id)?;
    let _opening = OPEN_LOCK.lock().await;
    if let Some(pane) = with_owners(|owners| owners.remove(&window, Some(&owner_id)))? {
        close_owned(&app, &pane.pane_label);
        let _ = app.emit_to(&window, EVENT_NAME, PaneEvent { owner_id, kind: "closed".into(), url: None, title: None });
    }
    Ok(())
}
#[tauri::command]
pub async fn browser_devtools(app: AppHandle, webview: tauri::Webview, owner_id: String) -> Result<(), String> { with_pane(&app, &caller_window(&webview)?, &owner_id)?.open_devtools(); Ok(()) }
#[tauri::command]
pub async fn browser_zoom(app: AppHandle, webview: tauri::Webview, owner_id: String, factor: f64) -> Result<(), String> {
    if !factor.is_finite() { return Err("invalid native browser zoom".into()); }
    with_pane(&app, &caller_window(&webview)?, &owner_id)?.set_zoom(factor.clamp(0.25, 5.0)).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn browser_set_select_mode(app: AppHandle, webview: tauri::Webview, owner_id: String, enabled: bool) -> Result<(), String> {
    let pane = with_pane(&app, &caller_window(&webview)?, &owner_id)?;
    #[cfg(any(target_os = "macos", windows))]
    { capture::set_select_mode(&pane, enabled).await }
    #[cfg(not(any(target_os = "macos", windows)))]
    { let _ = (pane, enabled); Err("native capture is unavailable on this platform".into()) }
}
#[tauri::command]
pub async fn browser_selection(app: AppHandle, webview: tauri::Webview, owner_id: String) -> Result<Option<SelectedElement>, String> {
    let pane = with_pane(&app, &caller_window(&webview)?, &owner_id)?;
    #[cfg(any(target_os = "macos", windows))]
    { let selection = capture::selection(&pane).await?; with_pane(&app, &caller_window(&webview)?, &owner_id)?; Ok(selection) }
    #[cfg(not(any(target_os = "macos", windows)))]
    { let _ = pane; Err("native capture is unavailable on this platform".into()) }
}
#[tauri::command]
pub async fn browser_capture(app: AppHandle, webview: tauri::Webview, owner_id: String, selection_only: bool) -> Result<NativeCapture, String> {
    let pane = with_pane(&app, &caller_window(&webview)?, &owner_id)?;
    #[cfg(any(target_os = "macos", windows))]
    { let result = capture::capture(&pane, selection_only).await?; with_pane(&app, &caller_window(&webview)?, &owner_id)?; Ok(result) }
    #[cfg(not(any(target_os = "macos", windows)))]
    { let _ = (pane, selection_only); Err("native capture is unavailable on this platform".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn allows_web_previews_and_blank() {
        for url in ["https://example.com", "http://localhost:4201/path?q=1", "http://192.168.1.10:3000", "about:blank", "  https://example.com  "] { assert!(is_allowed_url(url), "{url}"); }
    }
    #[test]
    fn rejects_non_web_navigation_consistently() {
        for url in ["file:///etc/passwd", "data:text/html,hi", "javascript:alert(1)", "chrome://settings", "about:config", "about:blank#x", "not a url", ""] { assert!(!is_allowed_url(url), "{url}"); assert!(parse_allowed(url).is_err()); }
    }
    #[test]
    fn owner_labels_cannot_overlap_or_escape() {
        assert!(validate_owner("a-123_ABC").is_ok());
        for owner in ["", "a/b", "a b", "<x>"] { assert!(validate_owner(owner).is_err()); }
        assert!(validate_owner(&"a".repeat(65)).is_err());
        assert_ne!(pane_label("one"), pane_label("two"));
        assert!(!popup_prefix("one-more").starts_with(&popup_prefix("one")));
    }
    #[test]
    fn bounds_reject_non_finite_and_unbounded_surfaces() {
        let valid = PaneBounds { x: 1.5, y: 2.5, width: 1280.0, height: 720.0 };
        assert!(valid.validate().is_ok());
        for width in [0.0, -1.0, f64::INFINITY, f64::NAN, 20_000.0] { assert!(PaneBounds { width, ..valid }.validate().is_err()); }
        assert!(PaneBounds { x: f64::NAN, ..valid }.validate().is_err());
    }
    #[test]
    fn popup_geometry_stays_visible_and_finite() {
        let defaults = popup_size(None);
        assert_eq!((defaults.width, defaults.height), (560.0, 720.0));
        let invalid = popup_size(Some(LogicalSize::new(f64::NAN, f64::INFINITY)));
        assert_eq!(invalid, defaults);
        let small = popup_size(Some(LogicalSize::new(0.0, -10.0)));
        assert_eq!((small.width, small.height), (360.0, 320.0));
        let large = popup_size(Some(LogicalSize::new(1e12, 1e12)));
        assert_eq!((large.width, large.height), (1280.0, 960.0));
    }
}
