//! Device windows: a native window showing a Tapflow device (iOS Simulator / Android emulator), live and
//! interactive. Its content is Tapflow's own device view, an EXTERNAL page on loopback, so the window
//! gets no capability and no host command (the invoke guard admits only the main and mission
//! interfaces), may only navigate within `http://127.0.0.1`, and never opens another window.
//!
//! It opens at the server's single-use `/tapflow-window/<ticket>` link (signs in to Tapflow, then
//! redirects to the device). One window per device: opening it again focuses it with a fresh link.
//! Closing it emits `device-window-closed` (the device key) to the main interface, which asks the server
//! to release the device (shut down after a grace period, server/modules/tapflow).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use tauri::{Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent};

// Tapflow's device view carries its own sidebar and toolbar beside the device.
const SIZE: (f64, f64) = (1180.0, 900.0);
const MIN: (f64, f64) = (720.0, 600.0);
pub const CLOSED_EVENT: &str = "device-window-closed";

fn registry() -> &'static Mutex<HashMap<String, String>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Only Specrails' own single-use link on loopback opens a device window.
pub fn is_device_window_link(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port().is_some()
        && url.path().starts_with("/tapflow-window/") && url.query().is_none() && url.fragment().is_none()
}

/// Navigation inside a device window: loopback HTTP only (Specrails' link, then Tapflow's dashboard).
pub fn allowed_navigation(url: &tauri::Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1")
}

/// A device key: the Tapflow device id (a simulator UDID, or `avd:<name>` for an Android emulator).
pub fn valid_key(key: &str) -> bool {
    !key.is_empty() && key.len() <= 128 && !key.contains("..")
        && key.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | ':' | '_' | '.'))
}

#[tauri::command]
pub async fn device_window_open(app: tauri::AppHandle, webview: Webview, url: String, title: String, key: String) -> Result<(), String> {
    if webview.label() != webview.window().label() || !crate::mission_windows::is_trusted_interface(webview.label()) {
        return Err("This action belongs to a registered Specrails interface.".into());
    }
    let link = tauri::Url::parse(&url).map_err(|_| "Invalid device link.".to_string())?;
    if !is_device_window_link(&link) { return Err("Invalid device link.".into()); }
    if !valid_key(&key) { return Err("Invalid device.".into()); }
    let title: String = title.chars().filter(|c| !c.is_control()).take(120).collect();

    let mut entries = registry().lock().map_err(|_| "Device window state is unavailable.")?;
    if let Some(window) = entries.get(&key).and_then(|label| app.get_webview_window(label)) {
        window.navigate(link).map_err(|err| err.to_string())?;
        return window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()).map_err(|err| err.to_string());
    }
    entries.retain(|_, label| app.get_webview_window(label).is_some());
    if entries.len() >= 8 { return Err("Close a device window before opening another.".into()); }
    let label = format!("device-{:032x}", rand::random::<u128>());
    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(link))
        .title(if title.is_empty() { "Device".to_string() } else { title })
        .inner_size(SIZE.0, SIZE.1).min_inner_size(MIN.0, MIN.1).center()
        .on_navigation(allowed_navigation)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build().map_err(|err| err.to_string())?;
    let closed_app = app.clone();
    let closed_key = key.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            if let Ok(mut entries) = registry().lock() { entries.remove(&closed_key); }
            let _ = closed_app.emit_to("main", CLOSED_EVENT, closed_key.clone());
        }
    });
    entries.insert(key, label);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(value: &str) -> tauri::Url { tauri::Url::parse(value).unwrap() }

    #[test]
    fn opens_only_specrails_single_use_link_on_loopback() {
        assert!(is_device_window_link(&url("http://127.0.0.1:4300/tapflow-window/abc_DEF-123")));
        for bad in ["https://127.0.0.1:4300/tapflow-window/x", "http://localhost:4300/tapflow-window/x", "http://127.0.0.1/tapflow-window/x",
            "http://127.0.0.1:4300/app-center/build?id=1", "http://127.0.0.1:4300/tapflow-window/x?next=evil", "http://evil.example/tapflow-window/x",
            "file:///tapflow-window/x"] {
            assert!(!is_device_window_link(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn navigates_only_within_loopback_http() {
        assert!(allowed_navigation(&url("http://127.0.0.1:4310/app-center/build?id=2&session=s&device=d")));
        for bad in ["https://example.com", "http://192.168.1.10:4310/", "javascript:alert(1)", "tauri://localhost/index.html"] {
            assert!(!allowed_navigation(&url(bad)), "{bad}");
        }
    }

    #[test]
    fn accepts_device_ids_only() {
        assert!(valid_key("A1B1366D-EDEF-4CB9-9355-9D2CDBB942F4"));
        assert!(valid_key("emulator-5554"));
        assert!(valid_key("avd:tapflow-phone") && valid_key("avd:Pixel_8_API_35"));
        assert!(!valid_key("") && !valid_key("../x") && !valid_key("a b") && !valid_key(&"a".repeat(129)));
    }
}
