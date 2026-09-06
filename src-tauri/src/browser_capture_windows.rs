//! Same-page WebView2 capture through the host's private DevTools API. There is
//! no debugging port, browser process replacement, or command bridge in page JS.
use super::{capture_common::{CaptureMetadata, validate_element, capture_rect, png_pixel_width, capture_scale_adjustment}, CaptureViewport, NativeCapture, SelectedElement};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Webview;
use webview2_com::CallDevToolsProtocolMethodCompletedHandler;
use windows::core::HSTRING;

const SCRIPT: &str = include_str!("browser_capture.js");
const MAX_IMAGE_RESPONSE: usize = 34 * 1024 * 1024;

pub fn supported() -> bool { true }

async fn protocol(pane: &Webview, method: &'static str, parameters: Value, max_bytes: usize) -> Result<Value, String> {
    let parameters = parameters.to_string();
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    pane.with_webview(move |platform| unsafe {
        let callback_send = send.clone();
        let callback = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(move |status, text| {
            let result = if status.is_err() { Err("native browser operation failed".to_string()) }
                else if text.len() > max_bytes { Err("native browser response exceeds size limit".to_string()) }
                else { serde_json::from_str(&text).map_err(|_| "invalid native browser response".to_string()) };
            let _ = callback_send.try_send(result);
            Ok(())
        }));
        let started = platform.controller().CoreWebView2().and_then(|webview| {
            webview.CallDevToolsProtocolMethod(&HSTRING::from(method), &HSTRING::from(parameters), &callback)
        });
        if started.is_err() { let _ = send.try_send(Err("native browser operation could not start".into())); }
    }).map_err(|_| "native browser is unavailable".to_string())?;
    tokio::time::timeout(Duration::from_secs(15), receive.recv()).await
        .map_err(|_| "native browser operation timed out".to_string())?
        .ok_or_else(|| "native browser closed during operation".to_string())?
}

async fn evaluate(pane: &Webview, action: &'static str) -> Result<String, String> {
    let tree = protocol(pane, "Page.getFrameTree", json!({}), 1024 * 1024).await?;
    let frame = tree.pointer("/frameTree/frame/id").and_then(Value::as_str).ok_or("native browser frame is unavailable")?;
    let world = protocol(pane, "Page.createIsolatedWorld", json!({ "frameId": frame, "worldName": "specrails-native-capture-v1", "grantUniveralAccess": false }), 4096).await?;
    let context = world.get("executionContextId").and_then(Value::as_u64).ok_or("native browser capture context is unavailable")?;
    let expression = format!("JSON.stringify(({})({}))", SCRIPT, serde_json::to_string(action).map_err(|_| "invalid capture action")?);
    let value = protocol(pane, "Runtime.evaluate", json!({ "contextId": context, "expression": expression, "returnByValue": true }), 128 * 1024).await?;
    if value.get("exceptionDetails").is_some() { return Err("native capture script failed; the page may have navigated".into()); }
    let value = value.pointer("/result/value").and_then(Value::as_str).ok_or("invalid native capture result")?;
    if value.len() > 65_536 { return Err("native capture metadata exceeds size limit".into()); }
    Ok(value.to_string())
}

pub async fn set_select_mode(pane: &Webview, enabled: bool) -> Result<(), String> {
    evaluate(pane, if enabled { "enable" } else { "disable" }).await?;
    Ok(())
}
pub async fn selection(pane: &Webview) -> Result<Option<SelectedElement>, String> {
    let selected: Option<SelectedElement> = serde_json::from_str(&evaluate(pane, "selection").await?).map_err(|_| "invalid native selection result")?;
    if let Some(element) = &selected { validate_element(element)?; }
    Ok(selected)
}

pub async fn capture(pane: &Webview, selection_only: bool) -> Result<NativeCapture, String> {
    let metadata: CaptureMetadata = serde_json::from_str(&evaluate(pane, if selection_only { "capture-selection" } else { "capture-page" }).await?)
        .map_err(|_| "invalid native capture metadata")?;
    if !super::is_allowed_url(&metadata.url) || metadata.url.len() > 16_384 || metadata.title.len() > 16_384 { return Err("invalid native capture page metadata".into()); }
    if selection_only && metadata.element.is_none() { return Err("select an element before capturing".into()); }
    let rect = capture_rect(&metadata.viewport, metadata.element.as_ref())?;
    let pixels = rect.width * rect.height * metadata.viewport.device_scale_factor.powi(2);
    if !pixels.is_finite() || pixels > 32_000_000.0 { return Err("native snapshot exceeds pixel limit".into()); }
    let expected_url = pane.url().map_err(|_| "native browser is unavailable")?.to_string();
    if metadata.url != expected_url { return Err("page navigated while preparing the capture; try again".into()); }
    // DOM rects are viewport-relative; CDP clip coordinates include page scroll.
    let metrics = protocol(pane, "Page.getLayoutMetrics", json!({}), 65_536).await?;
    let visual = metrics.get("cssVisualViewport").ok_or("native browser viewport is unavailable")?;
    let x = visual.get("pageX").and_then(Value::as_f64).ok_or("invalid native browser scroll offset")?;
    let y = visual.get("pageY").and_then(Value::as_f64).ok_or("invalid native browser scroll offset")?;
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 { return Err("invalid native browser scroll offset".into()); }
    let mut scale = 1.0;
    let mut data = String::new();
    let mut pixel_width = 0.0;
    for attempt in 0..2 {
        let screenshot = protocol(pane, "Page.captureScreenshot", json!({
            "format": "png", "fromSurface": true, "captureBeyondViewport": false,
            "clip": { "x": x + rect.x, "y": y + rect.y, "width": rect.width, "height": rect.height, "scale": scale }
        }), MAX_IMAGE_RESPONSE).await?;
        data = screenshot.get("data").and_then(Value::as_str).ok_or("native snapshot has no image data")?.to_string();
        pixel_width = png_pixel_width(&data)?;
        let Some(adjustment) = capture_scale_adjustment(rect.width, metadata.viewport.device_scale_factor, pixel_width) else { break; };
        if attempt == 1 { return Err("native browser scale changed during capture; try again".into()); }
        scale *= adjustment;
        if !scale.is_finite() || scale <= 0.0 || scale > 8.0 { return Err("invalid native browser capture scale".into()); }
    }
    if pane.url().map_err(|_| "native browser closed during capture")?.to_string() != expected_url { return Err("page navigated during the capture; try again".into()); }
    Ok(NativeCapture {
        screenshot_data_url: format!("data:image/png;base64,{data}"), url: metadata.url, title: metadata.title,
        viewport: CaptureViewport { device_scale_factor: pixel_width / rect.width, ..metadata.viewport },
        element: metadata.element.map(|element| SelectedElement { rect, ..element }),
    })
}
