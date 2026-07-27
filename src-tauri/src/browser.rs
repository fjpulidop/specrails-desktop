// Native embedded browser pane (Cursor-class in-window browsing).
//
// A single Tauri child webview (label `native-browser`) composited inside the
// main window: WKWebView on macOS, WebView2 on Windows. The React app renders
// only the browser chrome plus a measured "hole" div and keeps this pane's
// bounds in sync via `browser_set_bounds`. Navigation/load/title events are
// emitted to the main webview as `native-browser:event`.
//
// Security boundary: the pane label is NOT listed in any capability and no
// remote-domain IPC access is granted, so web content loaded here cannot
// invoke app commands. Scheme policy (http/https/about:blank) is enforced on
// open, on navigate, and on every in-page navigation via `on_navigation`.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::webview::{NewWindowResponse, PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl,
    WebviewWindowBuilder,
};

pub const PANE_LABEL: &str = "native-browser";
const POPUP_LABEL_PREFIX: &str = "native-browser-popup-";
const EVENT_NAME: &str = "native-browser:event";
const MAIN_LABEL: &str = "main";

static POPUP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Close every popup window the pane spawned (login windows). Popups belong to
/// the pane's browsing session — they never outlive it.
fn close_popups(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with(POPUP_LABEL_PREFIX) {
            let _ = window.close();
        }
    }
}

/// Logical-pixel rectangle of the reserved hole element, as measured by the
/// client (`getBoundingClientRect`) — logical coords match the window content
/// area 1:1 because the main webview fills the undecorated window.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct PaneBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Serialize, Clone)]
struct PaneEvent {
    kind: String,
    url: Option<String>,
    title: Option<String>,
}

/// Scheme allow-list shared by every navigation door. `about:blank` is the
/// harmless empty page; everything that is not plain http(s) — `file:`,
/// `data:`, `javascript:`, custom app schemes — is rejected. Unlike the
/// server-side screencast SSRF guard, loopback/private hosts are ALLOWED:
/// this is client-side browsing in the user's own webview (dev-server preview
/// is a first-class use case).
pub fn is_allowed_url(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed == "about:blank" {
        return true;
    }
    match Url::parse(trimmed) {
        Ok(u) => matches!(u.scheme(), "http" | "https"),
        Err(_) => false,
    }
}

fn emit_pane_event(app: &AppHandle, kind: &str, url: Option<String>, title: Option<String>) {
    let _ = app.emit_to(
        MAIN_LABEL,
        EVENT_NAME,
        PaneEvent { kind: kind.to_string(), url, title },
    );
}

fn parse_allowed(url: &str) -> Result<Url, String> {
    if !is_allowed_url(url) {
        return Err("url scheme not allowed".into());
    }
    Url::parse(url.trim()).map_err(|e| e.to_string())
}

/// Whether the native pane is supported on this platform. Child webviews are
/// solid on macOS (NSView subview) and Windows (child HWND); Linux is X11-only
/// upstream and not a shipped desktop target — keep it on the screencast path.
#[tauri::command]
pub fn browser_supported() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows"))
}

#[tauri::command]
pub async fn browser_open(app: AppHandle, url: String, bounds: PaneBounds) -> Result<(), String> {
    let parsed = parse_allowed(&url)?;

    // Singleton pane: drop any previous instance (and its popups) first.
    close_popups(&app);
    if let Some(existing) = app.get_webview(PANE_LABEL) {
        let _ = existing.close();
    }

    let window = app
        .get_window(MAIN_LABEL)
        .ok_or_else(|| "main window not found".to_string())?;

    let nav_app = app.clone();
    let load_app = app.clone();
    let title_app = app.clone();
    let popup_app = app.clone();

    #[allow(unused_mut)]
    let mut builder = WebviewBuilder::new(PANE_LABEL, WebviewUrl::External(parsed))
        .on_navigation(move |url: &Url| {
            let allowed = matches!(url.scheme(), "http" | "https" | "about");
            if allowed {
                emit_pane_event(&nav_app, "nav", Some(url.to_string()), None);
            }
            allowed
        })
        .on_page_load(move |_webview, payload| {
            let kind = match payload.event() {
                PageLoadEvent::Started => "load-started",
                PageLoadEvent::Finished => "load-finished",
            };
            emit_pane_event(&load_app, kind, Some(payload.url().to_string()), None);
        })
        .on_document_title_changed(move |_webview, title| {
            emit_pane_event(&title_app, "title", None, Some(title));
        })
        // Popups (window.open / OAuth login windows — Okta et al) open as REAL
        // satellite windows. `window_features(features)` wires the opener's
        // WKWebViewConfiguration (macOS) / WebView2 environment (Windows) into
        // the new window, which is what keeps `window.opener` + postMessage +
        // session cookies working — the whole point of an IdP login popup. The
        // popup label is never listed in any capability → no IPC for web
        // content. Non-web schemes are denied.
        .on_new_window(move |url: Url, features| {
            if !matches!(url.scheme(), "http" | "https") {
                return NewWindowResponse::Deny;
            }
            let seq = POPUP_SEQ.fetch_add(1, Ordering::Relaxed);
            let label = format!("{POPUP_LABEL_PREFIX}{seq}");
            let title = url.host_str().map(str::to_string).unwrap_or_else(|| "Sign in".to_string());
            let builder = WebviewWindowBuilder::new(&popup_app, &label, WebviewUrl::External(url))
                .title(title)
                .inner_size(560.0, 720.0)
                .center()
                // After the defaults so a site-requested size/position wins.
                .window_features(features);
            match builder.build() {
                Ok(window) => NewWindowResponse::Create { window },
                Err(e) => {
                    eprintln!("[native-browser] popup window failed: {e}");
                    NewWindowResponse::Deny
                }
            }
        });

    // Windows: persistent profile under ~/.specrails/ (WebView2 user-data dir).
    // macOS: WKWebView always uses the app's default persistent data store —
    // logins persist without a per-webview directory.
    #[cfg(target_os = "windows")]
    {
        if let Ok(home) = app.path().home_dir() {
            let profile = home.join(".specrails").join("native-browser-profile");
            if std::fs::create_dir_all(&profile).is_ok() {
                builder = builder.data_directory(profile);
            }
        }
    }

    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn with_pane(app: &AppHandle) -> Result<tauri::Webview, String> {
    app.get_webview(PANE_LABEL)
        .ok_or_else(|| "native browser pane not open".to_string())
}

#[tauri::command]
pub async fn browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = parse_allowed(&url)?;
    with_pane(&app)?.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_back(app: AppHandle) -> Result<(), String> {
    with_pane(&app)?.eval("history.back()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_forward(app: AppHandle) -> Result<(), String> {
    with_pane(&app)?.eval("history.forward()").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_reload(app: AppHandle) -> Result<(), String> {
    with_pane(&app)?.reload().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_set_bounds(app: AppHandle, bounds: PaneBounds) -> Result<(), String> {
    with_pane(&app)?
        .set_bounds(tauri::Rect {
            position: LogicalPosition::new(bounds.x, bounds.y).into(),
            size: LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)).into(),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_show(app: AppHandle) -> Result<(), String> {
    with_pane(&app)?.show().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_hide(app: AppHandle) -> Result<(), String> {
    with_pane(&app)?.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_close(app: AppHandle) -> Result<(), String> {
    close_popups(&app);
    if let Some(pane) = app.get_webview(PANE_LABEL) {
        pane.close().map_err(|e| e.to_string())?;
        emit_pane_event(&app, "closed", None, None);
    }
    Ok(())
}

#[tauri::command]
pub async fn browser_devtools(app: AppHandle) -> Result<(), String> {
    with_pane(&app)?.open_devtools();
    Ok(())
}

#[tauri::command]
pub async fn browser_zoom(app: AppHandle, factor: f64) -> Result<(), String> {
    let clamped = factor.clamp(0.25, 5.0);
    with_pane(&app)?.set_zoom(clamped).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_http_https_and_about_blank() {
        assert!(is_allowed_url("https://example.com"));
        assert!(is_allowed_url("http://localhost:4201/path?q=1"));
        assert!(is_allowed_url("http://192.168.1.10:3000"));
        assert!(is_allowed_url("about:blank"));
        assert!(is_allowed_url("  https://example.com  "));
    }

    #[test]
    fn rejects_non_web_schemes_and_garbage() {
        assert!(!is_allowed_url("file:///etc/passwd"));
        assert!(!is_allowed_url("data:text/html,hi"));
        assert!(!is_allowed_url("javascript:alert(1)"));
        assert!(!is_allowed_url("chrome://settings"));
        assert!(!is_allowed_url("about:config"));
        assert!(!is_allowed_url("not a url"));
        assert!(!is_allowed_url(""));
    }

    #[test]
    fn parse_allowed_errors_carry_message() {
        assert!(parse_allowed("file:///x").is_err());
        assert!(parse_allowed("https://ok.example").is_ok());
    }
}
