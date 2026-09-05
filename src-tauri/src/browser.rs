//! Native browser: an OS-composited child webview, never a video stream.
//!
//! Every pane is owned by a client mount. Commands and events carry that owner
//! so a delayed cleanup cannot close a newer pane. Remote content receives no
//! Tauri capability; capture uses fixed scripts evaluated by the host.

use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::{atomic::{AtomicU64, Ordering}, Mutex}};
use tauri::webview::{NewWindowFeatures, NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
#[path = "browser_capture.rs"]
mod capture;
#[cfg(target_os = "macos")]
#[path = "browser_popup.rs"]
mod popup;

const EVENT_NAME: &str = "native-browser:event";
const MAIN_LABEL: &str = "main";
static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);
static OPEN_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static PANE_OWNER: Mutex<Option<String>> = Mutex::new(None);
static POPUP_OWNERS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
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
fn pane_label(owner: &str) -> String { format!("native-browser-{owner}") }
fn popup_prefix(owner: &str) -> String { format!("{}-popup-", pane_label(owner)) }
fn is_owner(owner: &str) -> bool { PANE_OWNER.lock().map(|current| current.as_deref() == Some(owner)).unwrap_or(false) }

fn close_owned(app: &AppHandle, owner: &str) {
    // Match ownership explicitly: an old owner's textual prefix must never
    // match a newer owner's label or close its authentication windows.
    let labels = POPUP_OWNERS.lock().map(|mut entries| {
        let entries = entries.get_or_insert_with(HashMap::new);
        let labels: Vec<_> = entries.iter().filter(|(_, value)| value.as_str() == owner).map(|(label, _)| label.clone()).collect();
        for label in &labels { entries.remove(label); }
        labels
    }).unwrap_or_default();
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); }
    }
    if let Some(pane) = app.get_webview(&pane_label(owner)) { let _ = pane.close(); }
}

fn release_popup(label: &str) {
    if let Ok(mut entries) = POPUP_OWNERS.lock() {
        if let Some(entries) = entries.as_mut() { entries.remove(label); }
    }
}

fn popup_size(size: Option<LogicalSize<f64>>) -> LogicalSize<f64> {
    let requested = size.unwrap_or(LogicalSize::new(560.0, 720.0));
    LogicalSize::new(
        if requested.width.is_finite() { requested.width.clamp(360.0, 1280.0) } else { 560.0 },
        if requested.height.is_finite() { requested.height.clamp(320.0, 960.0) } else { 720.0 },
    )
}

fn open_popup(app: &AppHandle, owner: &str, url: Url, features: NewWindowFeatures) -> NewWindowResponse<tauri::Wry> {
    if !is_owner(owner) { return NewWindowResponse::Deny; }
    if !is_allowed_url(url.as_str()) {
        emit_pane_event(app, owner, "popup-error", None, None);
        return NewWindowResponse::Deny;
    }
    let label = format!("{}{}", popup_prefix(owner), POPUP_SEQ.fetch_add(1, Ordering::Relaxed));
    let reserved = POPUP_OWNERS.lock().map(|mut entries| {
        let entries = entries.get_or_insert_with(HashMap::new);
        if entries.values().filter(|value| value.as_str() == owner).count() >= MAX_POPUPS { return false; }
        entries.insert(label.clone(), owner.into());
        true
    }).unwrap_or(false);
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
    let result = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title("Sign in").window_features(features)
        .inner_size(size.width, size.height).center().focused(true)
        .on_navigation(move |next| {
            if !is_owner(&nav_owner) { return false; }
            let allowed = is_allowed_url(next.as_str());
            if !allowed { emit_pane_event(&nav_app, &nav_owner, "popup-error", None, None); }
            allowed
        })
        .on_new_window(move |next, features| open_popup(&child_app, &child_owner, next, features))
        .build();
    match result {
        Ok(window) => {
            let close_label = label.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::Destroyed) { release_popup(&close_label); }
            });
            #[cfg(target_os = "macos")]
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
fn emit_pane_event(app: &AppHandle, owner: &str, kind: &str, url: Option<String>, title: Option<String>) {
    let _ = app.emit_to(MAIN_LABEL, EVENT_NAME, PaneEvent { owner_id: owner.into(), kind: kind.into(), url, title });
}
fn with_pane(app: &AppHandle, owner: &str) -> Result<tauri::Webview, String> {
    validate_owner(owner)?;
    if !is_owner(owner) { return Err("native browser owner is no longer active".into()); }
    app.get_webview(&pane_label(owner)).ok_or_else(|| "native browser pane not open".into())
}

#[tauri::command]
pub fn browser_supported() -> bool { cfg!(any(target_os = "macos", target_os = "windows")) }
#[tauri::command]
pub fn browser_capture_supported() -> bool {
    #[cfg(target_os = "macos")]
    { capture::supported() }
    #[cfg(not(target_os = "macos"))]
    { false }
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, owner_id: String, url: String, bounds: PaneBounds) -> Result<(), String> {
    open_browser(app, owner_id, url, bounds, false).await
}

/// Local smoke fixtures must never share the normal browser's cookie store.
#[cfg(feature = "native-browser-smoke")]
#[allow(dead_code)]
pub async fn browser_open_smoke(app: AppHandle, owner_id: String, url: String, bounds: PaneBounds) -> Result<(), String> {
    open_browser(app, owner_id, url, bounds, true).await
}

async fn open_browser(app: AppHandle, owner_id: String, url: String, bounds: PaneBounds, incognito: bool) -> Result<(), String> {
    validate_owner(&owner_id)?;
    let parsed = parse_allowed(&url)?;
    let bounds = bounds.validate()?;
    let _opening = OPEN_LOCK.lock().await;
    let previous = PANE_OWNER.lock().map_err(|_| "native browser state unavailable")?.replace(owner_id.clone());
    if let Some(previous) = previous { close_owned(&app, &previous); }
    let result = (|| {
        let window = app.get_window(MAIN_LABEL).ok_or_else(|| "main window not found".to_string())?;
        let nav_app = app.clone(); let nav_owner = owner_id.clone();
        let load_app = app.clone(); let load_owner = owner_id.clone();
        let title_app = app.clone(); let title_owner = owner_id.clone();
        let popup_app = app.clone(); let popup_owner = owner_id.clone();
        #[allow(unused_mut)]
        let mut builder = WebviewBuilder::new(pane_label(&owner_id), WebviewUrl::External(parsed))
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
            .on_new_window(move |url: Url, features| open_popup(&popup_app, &popup_owner, url, features));
        #[cfg(target_os = "windows")]
        if let Ok(home) = app.path().home_dir() {
            let profile = home.join(".specrails").join("native-browser-profile");
            if std::fs::create_dir_all(&profile).is_ok() { builder = builder.data_directory(profile); }
        }
        let pane = window.add_child(builder, LogicalPosition::new(bounds.x, bounds.y), LogicalSize::new(bounds.width, bounds.height)).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        capture::enable_gestures(&pane)?;
        #[cfg(not(target_os = "macos"))]
        let _ = pane;
        Ok(())
    })();
    if result.is_err() || !is_owner(&owner_id) {
        close_owned(&app, &owner_id);
        if let Ok(mut current) = PANE_OWNER.lock() { if current.as_deref() == Some(&owner_id) { *current = None; } }
        return result.and(Err("native browser opening was cancelled".into()));
    }
    result
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, owner_id: String, url: String) -> Result<(), String> { with_pane(&app, &owner_id)?.navigate(parse_allowed(&url)?).map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_back(app: AppHandle, owner_id: String) -> Result<(), String> { with_pane(&app, &owner_id)?.eval("history.back()").map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_forward(app: AppHandle, owner_id: String) -> Result<(), String> { with_pane(&app, &owner_id)?.eval("history.forward()").map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_reload(app: AppHandle, owner_id: String) -> Result<(), String> { with_pane(&app, &owner_id)?.reload().map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, owner_id: String, bounds: PaneBounds) -> Result<(), String> {
    let bounds = bounds.validate()?;
    with_pane(&app, &owner_id)?.set_bounds(tauri::Rect { position: LogicalPosition::new(bounds.x, bounds.y).into(), size: LogicalSize::new(bounds.width, bounds.height).into() }).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn browser_show(app: AppHandle, owner_id: String) -> Result<(), String> { with_pane(&app, &owner_id)?.show().map_err(|e| e.to_string()) }
#[tauri::command]
pub async fn browser_hide(app: AppHandle, owner_id: String) -> Result<(), String> {
    if !is_owner(&owner_id) { return Ok(()); }
    with_pane(&app, &owner_id)?.hide().map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn browser_close(app: AppHandle, owner_id: String) -> Result<(), String> {
    validate_owner(&owner_id)?;
    { let mut current = PANE_OWNER.lock().map_err(|_| "native browser state unavailable")?;
      if current.as_deref() == Some(&owner_id) { *current = None; } }
    // Closing one's own old label is safe even when a newer pane is active.
    close_owned(&app, &owner_id);
    emit_pane_event(&app, &owner_id, "closed", None, None);
    Ok(())
}
#[tauri::command]
pub async fn browser_devtools(app: AppHandle, owner_id: String) -> Result<(), String> { with_pane(&app, &owner_id)?.open_devtools(); Ok(()) }
#[tauri::command]
pub async fn browser_zoom(app: AppHandle, owner_id: String, factor: f64) -> Result<(), String> {
    if !factor.is_finite() { return Err("invalid native browser zoom".into()); }
    with_pane(&app, &owner_id)?.set_zoom(factor.clamp(0.25, 5.0)).map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn browser_set_select_mode(app: AppHandle, owner_id: String, enabled: bool) -> Result<(), String> {
    let pane = with_pane(&app, &owner_id)?;
    #[cfg(target_os = "macos")]
    { capture::set_select_mode(&pane, enabled).await }
    #[cfg(not(target_os = "macos"))]
    { let _ = (pane, enabled); Err("native capture is unavailable on this platform".into()) }
}
#[tauri::command]
pub async fn browser_selection(app: AppHandle, owner_id: String) -> Result<Option<SelectedElement>, String> {
    let pane = with_pane(&app, &owner_id)?;
    #[cfg(target_os = "macos")]
    { let selection = capture::selection(&pane).await?; with_pane(&app, &owner_id)?; Ok(selection) }
    #[cfg(not(target_os = "macos"))]
    { let _ = pane; Err("native capture is unavailable on this platform".into()) }
}
#[tauri::command]
pub async fn browser_capture(app: AppHandle, owner_id: String, selection_only: bool) -> Result<NativeCapture, String> {
    let pane = with_pane(&app, &owner_id)?;
    #[cfg(target_os = "macos")]
    { let result = capture::capture(&pane, selection_only).await?; with_pane(&app, &owner_id)?; Ok(result) }
    #[cfg(not(target_os = "macos"))]
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
