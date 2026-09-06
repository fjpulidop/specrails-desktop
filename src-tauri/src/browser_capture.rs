//! macOS capture uses WKWebView's public snapshot API on the same interactive
//! page. No Screen Recording permission, CDP session or second navigation.
use super::{CaptureViewport, NativeCapture, SelectedElement};
#[cfg(test)]
use super::PaneBounds;
use block2::RcBlock;
use objc2::{runtime::AnyObject, sel, ClassType, MainThreadMarker};
use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
use objc2_foundation::{NSDataBase64EncodingOptions, NSDictionary, NSError, NSPoint, NSRect, NSSize, NSString, NSObjectProtocol};
use objc2_web_kit::{WKContentWorld, WKSnapshotConfiguration, WKWebView};
use super::capture_common::{CaptureMetadata, validate_element, capture_rect};
use std::time::Duration;
use tauri::Webview;

const SCRIPT: &str = include_str!("browser_capture.js");
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);
const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_IMAGE_BYTES: usize = 24 * 1024 * 1024;
const MAX_IMAGE_PIXELS: f64 = 32_000_000.0;

pub fn supported() -> bool {
    WKWebView::class().instance_method(sel!(evaluateJavaScript:inFrame:inContentWorld:completionHandler:)).is_some()
}

pub fn enable_gestures(pane: &Webview) -> Result<(), String> {
    pane.with_webview(|platform| unsafe {
        let view: &WKWebView = &*platform.inner().cast();
        view.setAllowsBackForwardNavigationGestures(true);
    }).map_err(|error| error.to_string())
}

/// Only our fixed capture program is evaluated. An isolated client world keeps
/// its state/functions out of reach of arbitrary page scripts. Older WebKit
/// installations fail clearly and the caller keeps the compatible browser path.
async fn evaluate(pane: &Webview, action: &'static str) -> Result<String, String> {
    let script = format!("JSON.stringify(({})({}))", SCRIPT, serde_json::to_string(action).map_err(|e| e.to_string())?);
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    pane.with_webview(move |platform| unsafe {
        let view: &WKWebView = &*platform.inner().cast();
        if !view.respondsToSelector(sel!(evaluateJavaScript:inFrame:inContentWorld:completionHandler:)) {
            let _ = send.try_send(Err("this version of WebKit does not support native capture".into()));
            return;
        }
        let Some(main_thread) = MainThreadMarker::new() else { let _ = send.try_send(Err("native script must run on the main thread".into())); return; };
        let completion = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            let result = if !error.is_null() {
                let error = &*error;
                let detail = error.userInfo().objectForKey(&NSString::from_str("WKJavaScriptExceptionMessage"))
                    .and_then(|value| value.downcast::<NSString>().ok())
                    .map(|value| value.to_string()).unwrap_or_else(|| error.localizedDescription().to_string());
                Err(format!("native browser script failed: {}", detail.chars().take(2000).collect::<String>()))
            } else if let Some(value) = value.as_ref().and_then(|value| value.downcast_ref::<NSString>()) {
                if value.length() > 65_536 { Err("native browser result exceeds size limit".into()) }
                else { Ok(value.to_string()) }
            } else { Err("native browser returned an invalid result".into()) };
            let _ = send.try_send(result);
        });
        let world = WKContentWorld::defaultClientWorld(main_thread);
        view.evaluateJavaScript_inFrame_inContentWorld_completionHandler(&NSString::from_str(&script), None, &world, Some(&completion));
    }).map_err(|error| error.to_string())?;
    tokio::time::timeout(EVAL_TIMEOUT, receive.recv()).await
        .map_err(|_| "native browser script timed out".to_string())?
        .ok_or_else(|| "native browser closed during script evaluation".to_string())?
}

pub async fn set_select_mode(pane: &Webview, enabled: bool) -> Result<(), String> {
    evaluate(pane, if enabled { "enable" } else { "disable" }).await?;
    Ok(())
}
pub async fn selection(pane: &Webview) -> Result<Option<SelectedElement>, String> {
    let value = evaluate(pane, "selection").await?;
    let selected: Option<SelectedElement> = serde_json::from_str(&value).map_err(|_| "invalid native selection result")?;
    if let Some(element) = &selected { validate_element(element)?; }
    Ok(selected)
}


fn encode_image(image: &NSImage) -> Result<(String, f64), String> {
    // Snapshots normally carry a bitmap representation already. Keep its backing
    // pixels (Retina) and avoid the expensive TIFF round-trip in the common case.
    let representations = image.representations();
    let best = representations.iter().filter_map(|rep| rep.downcast::<NSBitmapImageRep>().ok())
        .max_by_key(|rep| rep.pixelsWide() * rep.pixelsHigh());
    let fallback;
    let bitmap = if let Some(bitmap) = best.as_deref() { bitmap } else {
        let data = image.TIFFRepresentation().ok_or("native snapshot has no image data")?;
        fallback = NSBitmapImageRep::imageRepWithData(&data).ok_or("native snapshot bitmap conversion failed")?;
        &fallback
    };
    let pixels = bitmap.pixelsWide() as f64 * bitmap.pixelsHigh() as f64;
    if pixels < 1.0 || pixels > MAX_IMAGE_PIXELS { return Err("native snapshot exceeds pixel limit".into()); }
    let data = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }
        .ok_or("native snapshot PNG encoding failed")?;
    if data.len() > MAX_IMAGE_BYTES { return Err("native snapshot exceeds 24 MB image limit".into()); }
    Ok((format!("data:image/png;base64,{}", data.base64EncodedStringWithOptions(NSDataBase64EncodingOptions::empty())), bitmap.pixelsWide() as f64))
}

pub async fn capture(pane: &Webview, selection_only: bool) -> Result<NativeCapture, String> {
    let value = evaluate(pane, if selection_only { "capture-selection" } else { "capture-page" }).await?;
    let metadata: CaptureMetadata = serde_json::from_str(&value).map_err(|_| "invalid native capture metadata")?;
    if !super::is_allowed_url(&metadata.url) || metadata.url.len() > 16_384 || metadata.title.len() > 16_384 {
        return Err("invalid native capture page metadata".into());
    }
    if selection_only && metadata.element.is_none() { return Err("select an element before capturing".into()); }
    let rect = capture_rect(&metadata.viewport, metadata.element.as_ref())?;
    let expected_url = pane.url().map_err(|e| e.to_string())?.to_string();
    if metadata.url != expected_url { return Err("page navigated while preparing the capture; try again".into()); }
    let selection_snapshot = metadata.element.is_some();
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    pane.with_webview(move |platform| unsafe {
        let view: &WKWebView = &*platform.inner().cast();
        let Some(main_thread) = MainThreadMarker::new() else { let _ = send.try_send(Err("native snapshot must run on the main thread".into())); return; };
        // DOM geometry is CSS pixels; WKSnapshotConfiguration takes view points.
        // pageZoom changes the ratio, while screen backing scale stays native.
        let bounds = view.bounds();
        let zoom = view.pageZoom();
        let screen_scale = view.window().map(|window| window.backingScaleFactor()).unwrap_or(1.0);
        let view_rect = if selection_snapshot {
            NSRect::new(NSPoint::new(rect.x * zoom, rect.y * zoom), NSSize::new(rect.width * zoom, rect.height * zoom))
        } else { bounds };
        let physical_pixels = view_rect.size.width * view_rect.size.height * screen_scale * screen_scale;
        if !physical_pixels.is_finite() || physical_pixels < 1.0 || physical_pixels > MAX_IMAGE_PIXELS {
            let _ = send.try_send(Err("native snapshot exceeds pixel limit".into())); return;
        }
        let config = WKSnapshotConfiguration::new(main_thread);
        config.setRect(view_rect);
        // Nil snapshotWidth keeps the view's natural width and backing density.
        config.setAfterScreenUpdates(true);
        let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            let result = if !error.is_null() { Err(format!("native snapshot failed: {}", (&*error).localizedDescription())) }
                else if let Some(image) = image.as_ref() { encode_image(image) }
                else { Err("native snapshot returned no image".into()) };
            let _ = send.try_send(result);
        });
        view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &completion);
    }).map_err(|error| error.to_string())?;
    let (screenshot_data_url, pixel_width) = tokio::time::timeout(SNAPSHOT_TIMEOUT, receive.recv()).await
        .map_err(|_| "native browser snapshot timed out".to_string())?
        .ok_or_else(|| "native browser closed during snapshot".to_string())??;
    if pane.url().map_err(|e| e.to_string())?.to_string() != expected_url { return Err("page navigated during the capture; try again".into()); }
    Ok(NativeCapture {
        screenshot_data_url,
        url: metadata.url,
        title: metadata.title,
        viewport: CaptureViewport { device_scale_factor: pixel_width / rect.width, ..metadata.viewport },
        element: metadata.element.map(|element| SelectedElement { rect, ..element }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn viewport() -> CaptureViewport { CaptureViewport { width: 1000.0, height: 700.0, device_scale_factor: 2.0 } }
    fn element(rect: PaneBounds) -> SelectedElement { SelectedElement { selector: "#hero".into(), tag_name: "section".into(), text: "Hello".into(), rect } }
    #[test]
    fn clips_selection_to_visible_viewport_without_losing_css_scale() {
        let selected = element(PaneBounds { x: -50.0, y: 650.0, width: 200.0, height: 100.0 });
        let rect = capture_rect(&viewport(), Some(&selected)).unwrap();
        assert_eq!((rect.x, rect.y, rect.width, rect.height), (0.0, 650.0, 150.0, 50.0));
        assert_eq!(capture_rect(&viewport(), None).unwrap().width, 1000.0);
    }
    #[test]
    fn rejects_offscreen_corrupt_and_unbounded_capture_data() {
        let offscreen = element(PaneBounds { x: 1100.0, y: 0.0, width: 100.0, height: 50.0 });
        assert!(capture_rect(&viewport(), Some(&offscreen)).is_err());
        let corrupt = element(PaneBounds { x: f64::NAN, y: 0.0, width: 100.0, height: 50.0 });
        assert!(capture_rect(&viewport(), Some(&corrupt)).is_err());
        assert!(capture_rect(&CaptureViewport { device_scale_factor: f64::INFINITY, ..viewport() }, None).is_err());
        assert!(capture_rect(&CaptureViewport { width: 50_000.0, ..viewport() }, None).is_err());
    }
}
