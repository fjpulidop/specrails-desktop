//! Wry closes only its child HWND on window.close(). Close the actual popup
//! window too so the empty host and its owner's popup slot do not survive SSO.
use tauri::{Manager, WebviewWindow};
use webview2_com::WindowCloseRequestedEventHandler;

pub fn install_close_handler(window: &WebviewWindow) -> Result<(), String> {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    let (send, receive) = std::sync::mpsc::channel();
    window.with_webview(move |platform| unsafe {
        let result = (|| {
            let webview = platform.controller().CoreWebView2()?;
            let handler = WindowCloseRequestedEventHandler::create(Box::new(move |_, _| {
                // Close through Tauri, after returning from the WebView2 event.
                let app = app.clone(); let label = label.clone();
                tauri::async_runtime::spawn(async move {
                    if let Some(window) = app.get_webview_window(&label) { let _ = window.close(); }
                });
                Ok(())
            }));
            let mut token = 0;
            webview.add_WindowCloseRequested(&handler, &mut token)?;
            Ok::<(), windows::core::Error>(())
        })().map_err(|_| "popup close handler could not be installed".to_string());
        let _ = send.send(result);
    }).map_err(|_| "popup webview is unavailable".to_string())?;
    // Wry dispatches Windows new-window callbacks on a worker; registration is
    // queued to the UI thread. Never return its webview until the handler exists.
    receive.recv_timeout(std::time::Duration::from_secs(5)).map_err(|_| "popup close handler timed out".to_string())?
}
