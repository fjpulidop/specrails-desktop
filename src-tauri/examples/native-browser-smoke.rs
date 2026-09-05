//! Isolated native WKWebView smoke. Never starts Specrails' sidecar or opens its
//! databases. Run with `cargo run --offline --example native-browser-smoke --features native-browser-smoke`.
#[allow(dead_code)]
#[path = "../src/browser.rs"]
mod browser;
#[path = "../src/invoke_guard.rs"]
mod invoke_guard;
use std::{io::{Read, Write}, net::TcpListener, time::Duration};
use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

fn main() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("fixture listener");
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = [0; 2048]; let _ = stream.read(&mut request);
            let body = r#"<!doctype html><html><head><title>Native Retina fixture</title><style>body{margin:0;background:white;color:#111;font:20px system-ui}#target{position:absolute;left:100px;top:80px;width:260px;height:140px;background:#00aa44;color:white;display:grid;place-items:center}#other{position:absolute;top:300px}button{font:inherit}</style></head><body><button id="target" onclick="document.title='CLICK LEAKED'">Retina native selection</button><p id="other">Deterministic local fixture. No Specrails database.</p></body></html>"#;
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes());
        }
    });
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier = "sh.specrails.native-browser-smoke".into();
    let app = tauri::Builder::default().invoke_handler(|invoke| invoke_guard::dispatch(invoke, tauri::generate_handler![browser::browser_supported])).setup(move |app| {
        WebviewWindowBuilder::new(app, "main", WebviewUrl::External("about:blank".parse().unwrap()))
            .title("Specrails native browser fixture").inner_size(900.0, 650.0).incognito(true).build()?;
        let handle = app.handle().clone();
        tauri::async_runtime::spawn(async move {
            let result = run(handle.clone(), port).await;
            match result {
                Ok(()) => { println!("Native browser smoke passed: ownership, navigation, remote command denial, native Retina snapshot, exact DOM selection, long press, selection persistence, Shadow DOM, overlay removal, zoom, close."); handle.exit(0); }
                Err(error) => { eprintln!("Native browser smoke failed: {error}"); handle.exit(1); }
            }
        });
        Ok(())
    }).build(context).expect("native smoke app");
    app.run(|_, _| {});
}

async fn run(app: tauri::AppHandle, port: u16) -> Result<(), String> {
    assert!(browser::browser_supported());
    assert!(browser::browser_capture_supported());
    let url = format!("http://127.0.0.1:{port}/");
    let owner = "native-smoke-one".to_string();
    let (send, mut receive) = tokio::sync::mpsc::channel(8);
    app.listen_any("native-browser:event", move |event| {
        let payload: serde_json::Value = serde_json::from_str(event.payload()).unwrap();
        if payload["kind"] == "load-finished" || payload["title"].as_str().is_some_and(|title| title.starts_with("IPC_")) { let _ = send.try_send(payload); }
    });
    let bounds = browser::PaneBounds { x: 0.0, y: 50.0, width: 900.0, height: 550.0 };
    browser::browser_open(app.clone(), owner.clone(), url.clone(), bounds).await?;
    tokio::time::timeout(Duration::from_secs(15), receive.recv()).await.map_err(|_| "fixture page did not finish loading")?.ok_or("load listener closed")?;
    let first = browser::browser_capture(app.clone(), owner.clone(), false).await?;
    assert_eq!(first.title, "Native Retina fixture");
    assert_eq!(first.viewport.width, 900.0);
    assert!(first.viewport.device_scale_factor >= 1.0);
    std::fs::create_dir_all("/tmp/specrails-native-browser-smoke").map_err(|e| e.to_string())?;
    std::fs::write("/tmp/specrails-native-browser-smoke/full.json", serde_json::to_vec(&first).unwrap()).map_err(|e| e.to_string())?;
    let probe_pane = app.get_webview(&format!("native-browser-{owner}")).ok_or("missing owned pane")?;
    probe_pane.eval("window.__TAURI_INTERNALS__.invoke('browser_supported').then(value=>document.title='IPC_ALLOWED:'+value).catch(error=>document.title='IPC_DENIED:'+error)").map_err(|e| e.to_string())?;
    let ipc_result=tokio::time::timeout(Duration::from_secs(5),receive.recv()).await.map_err(|_|"remote IPC probe timed out")?.ok_or("IPC probe channel closed")?;
    eprintln!("Remote harmless custom-command probe: {}", ipc_result["title"]);
    if !ipc_result["title"].as_str().is_some_and(|title|title.starts_with("IPC_DENIED:")) { return Err("remote page can invoke app commands".into()); }
    probe_pane.eval("document.title='Native Retina fixture'").map_err(|e|e.to_string())?;
    browser::browser_set_select_mode(app.clone(), owner.clone(), true).await?;
    let pane = app.get_webview(&format!("native-browser-{owner}")).ok_or("missing owned pane")?;
    // Programmatic fixture input still passes through the real page's DOM and
    // isolated-world capture listeners. No OS input or user page is touched.
    pane.eval("document.querySelector('#target').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,clientX:150,clientY:120}));").map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(browser::browser_selection(app.clone(), owner.clone()).await?.is_none(), "holding pointer down must not finish selection before click is suppressed");
    pane.eval("document.querySelector('#target').dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,clientX:150,clientY:120}));document.querySelector('#target').dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,clientX:150,clientY:120}));").map_err(|e| e.to_string())?;
    let mut selected = None;
    for _ in 0..20 {
        selected = browser::browser_selection(app.clone(), owner.clone()).await?;
        if selected.is_some() { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let selected = selected.ok_or("element was not selected")?;
    assert_eq!(selected.selector, "#target");
    assert_eq!((selected.rect.x, selected.rect.y, selected.rect.width, selected.rect.height), (100.0, 80.0, 260.0, 140.0));
    browser::browser_set_select_mode(app.clone(), owner.clone(), false).await?;
    let capture = browser::browser_capture(app.clone(), owner.clone(), true).await?;
    assert_eq!(capture.title, "Native Retina fixture", "selection must suppress the page click");
    assert_eq!(capture.element.as_ref().unwrap().selector, "#target");
    std::fs::write("/tmp/specrails-native-browser-smoke/selection.json", serde_json::to_vec(&capture).unwrap()).map_err(|e| e.to_string())?;
    browser::browser_zoom(app.clone(), owner.clone(), 1.5).await?;
    let zoomed = browser::browser_capture(app.clone(), owner.clone(), true).await?;
    assert!(zoomed.viewport.device_scale_factor > capture.viewport.device_scale_factor);
    std::fs::write("/tmp/specrails-native-browser-smoke/zoomed.json", serde_json::to_vec(&zoomed).unwrap()).map_err(|e| e.to_string())?;
    browser::browser_zoom(app.clone(), owner.clone(), 1.0).await?;
    pane.eval("{const host=document.createElement('div');host.id='shadow-host';host.style.cssText='position:absolute;left:420px;top:80px';host.attachShadow({mode:'open'}).innerHTML='<button id=shadow-child style=\"width:220px;height:90px;background:green\">Shadow child</button>';document.body.append(host);}").map_err(|e|e.to_string())?;
    browser::browser_set_select_mode(app.clone(), owner.clone(), true).await?;
    pane.eval("document.querySelector('#shadow-host').shadowRoot.querySelector('#shadow-child').dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true,cancelable:true,clientX:450,clientY:110}))").map_err(|e|e.to_string())?;
    let mut shadow = None;
    for _ in 0..20 {
        shadow = browser::browser_selection(app.clone(), owner.clone()).await?;
        if shadow.is_some() { break; }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let shadow = shadow.ok_or("shadow child was not selected")?;
    assert_eq!(shadow.selector, "#shadow-child");
    assert_eq!(shadow.tag_name, "button", "must select the child, not the shadow host");
    assert_eq!((shadow.rect.width,shadow.rect.height),(220.0,90.0));
    let shadow_capture=browser::browser_capture(app.clone(), owner.clone(), true).await?;
    assert_eq!(shadow_capture.element.unwrap().selector,"#shadow-child");
    let newer = "native-smoke-two".to_string();
    browser::browser_open(app.clone(), newer.clone(), url, bounds).await?;
    browser::browser_close(app.clone(), owner.clone()).await?;
    browser::browser_hide(app.clone(), owner.clone()).await?;
    assert!(app.get_webview(&format!("native-browser-{newer}")).is_some());
    assert!(browser::browser_reload(app.clone(), owner).await.is_err());
    assert!(browser::browser_navigate(app.clone(), newer.clone(), "file:///etc/passwd".into()).await.is_err());
    assert!(browser::browser_zoom(app.clone(), newer.clone(), f64::NAN).await.is_err());
    browser::browser_close(app.clone(), newer.clone()).await?;
    assert!(app.get_webview(&format!("native-browser-{newer}")).is_none());
    app.emit("native-smoke-finished", true).map_err(|e| e.to_string())?;
    Ok(())
}
