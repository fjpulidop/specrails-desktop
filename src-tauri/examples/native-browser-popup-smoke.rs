//! Real WKWebView OAuth mechanics, using only loopback fixtures and an ephemeral
//! browser session. No Specrails sidecar, user database, credentials or accounts.
#[cfg(target_os = "macos")]
#[allow(dead_code)]
#[path = "../src/browser.rs"]
mod browser;
#[cfg(target_os = "macos")]
#[path = "../src/invoke_guard.rs"]
mod invoke_guard;
#[cfg(target_os = "macos")]
mod fixture_app {
use super::{browser, invoke_guard};
use block2::RcBlock;
use objc2::runtime::AnyObject;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::WKWebView;
use serde_json::{json, Value};
use std::{io::{Read, Write}, net::TcpListener, time::Duration, sync::{Arc, Mutex, atomic::{AtomicI32, Ordering}}};
use tauri::{Listener, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

static EXIT_CODE: AtomicI32 = AtomicI32::new(0);

fn fixture() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request = [0; 4096]; let size = stream.read(&mut request).unwrap_or(0);
            let request = String::from_utf8_lossy(&request[..size]);
            let route = request.split_whitespace().nth(1).unwrap_or("/");
            let body = if route.starts_with("/immediate") {
                r#"<!doctype html><script>window.opener?.postMessage({type:'immediate'},'*');window.close();</script>"#.to_string()
            } else if route.starts_with("/callback") {
                r#"<!doctype html><title>Callback</title><script>document.cookie='fixture_session=authenticated; SameSite=Lax; path=/'; window.opener?.postMessage({type:'authenticated',cookie:document.cookie},'*');</script>Callback fixture"#.to_string()
            } else if route.starts_with("/frame") {
                r#"<!doctype html><title>Iframe fixture</title><script>addEventListener('message',event=>{if(event.data.type==='open-auth'){Promise.resolve().then(()=>{window.auth=window.open(event.data.url,'iframe-auth');parent.postMessage({type:'iframe-opened',opened:!!auth},'*');});}else if(event.data.type==='authenticated'){parent.postMessage({type:'iframe-authenticated',payload:event.data},'*');}});</script>Iframe fixture"#.to_string()
            } else {
                r#"<!doctype html><title>Popup fixture</title><script>window.messages=[];addEventListener('message',event=>messages.push({data:event.data,origin:event.origin}));document.cookie='fixture_initial=present; SameSite=Lax; path=/';</script><h1>Local SSO fixture</h1>"#.to_string()
            };
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let _ = stream.write_all(response.as_bytes());
        }
    });
    port
}

async fn evaluate(view: &Webview, source: &str) -> Result<Value, String> {
    let source = format!("JSON.stringify((()=>{{{source}}})())");
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    view.with_webview(move |platform| unsafe {
        let view: &WKWebView = &*platform.inner().cast();
        let callback = RcBlock::new(move |value: *mut AnyObject, error: *mut NSError| {
            let result = if let Some(error) = error.as_ref() { Err(error.localizedDescription().to_string()) }
                else if let Some(value) = value.as_ref().and_then(|value| value.downcast_ref::<NSString>()) { serde_json::from_str(&value.to_string()).map_err(|e| e.to_string()) }
                else { Err("missing script value".into()) };
            let _ = send.try_send(result);
        });
        view.evaluateJavaScript_completionHandler(&NSString::from_str(&source), Some(&callback));
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), receive.recv()).await.map_err(|_|"script timeout")?.ok_or("script channel closed")?
}

async fn eventually(view: &Webview, expression: &str) -> Result<Value, String> {
    for _ in 0..100 {
        let value = evaluate(view, &format!("return ({expression});")).await?;
        if value != Value::Null && value != Value::Bool(false) { return Ok(value); }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(format!("condition timed out: {expression}"))
}

fn popup_windows(app: &tauri::AppHandle, owner: &str) -> Vec<tauri::WebviewWindow> {
    let prefix = format!("native-browser-{owner}-popup-");
    app.webview_windows().into_iter().filter(|(label, _)| label.starts_with(&prefix)).map(|(_, window)| window).collect()
}
async fn no_popups(app: &tauri::AppHandle, owner: &str) -> Result<(), String> {
    for _ in 0..100 {
        if popup_windows(app, owner).is_empty() { return Ok(()); }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("popup window.close did not remove native windows".into())
}
async fn close_popups(app: &tauri::AppHandle, owner: &str) -> Result<(), String> {
    for window in popup_windows(app, owner) {
        evaluate(window.as_ref(), "setTimeout(()=>window.close(),20);return true;").await?;
    }
    no_popups(app, owner).await
}

async fn run(app: tauri::AppHandle, port: u16, other: u16) -> Result<(), String> {
    let owner = "popup-fixture".to_string();
    let origin = format!("http://127.0.0.1:{port}");
    let other_origin = format!("http://127.0.0.1:{other}");
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let received = events.clone();
    app.listen_any("native-browser:event", move |event| {
        let data: Value = serde_json::from_str(event.payload()).unwrap();
        if data["kind"].as_str().is_some_and(|kind| kind.starts_with("popup-")) { received.lock().unwrap().push(data); }
    });
    let bounds = browser::PaneBounds {x:0.0,y:40.0,width:800.0,height:550.0};
    browser::browser_open_smoke(app.clone(), owner.clone(), origin.clone(), bounds).await?;
    let pane = app.get_webview(&format!("native-browser-{owner}")).ok_or("pane missing")?;
    eventually(&pane,"document.title==='Popup fixture'").await?;
    // Okta-style async SDK work before opening; WebKit must still call the
    // native handler after a Promise/timer, without a second user click.
    evaluate(&pane, "Promise.resolve().then(()=>setTimeout(()=>{window.auth=window.open('about:blank','auth','width=560,height=720');window.asyncOpened=!!auth;},40));return true;").await?;
    eventually(&pane,"window.asyncOpened===true").await?;
    evaluate(&pane, &format!("setTimeout(()=>auth.location.href={},60);return true;", json!(format!("{other_origin}/callback")))).await?;
    let message = eventually(&pane,"messages.find(m=>m.data.type==='authenticated') || null").await?;
    assert_eq!(message["origin"],other_origin);
    assert!(message["data"]["cookie"].as_str().unwrap().contains("fixture_initial=present"));
    eventually(&pane,"document.cookie.includes('fixture_session=authenticated')").await?;
    let popup = popup_windows(&app,&owner).pop().ok_or("popup missing")?;
    assert!(popup.is_visible().map_err(|e|e.to_string())?);
    assert!(popup.is_focused().map_err(|e|e.to_string())?);
    assert_eq!(evaluate(popup.as_ref(),"return !!window.opener;").await?,true);
    println!("PASS async window.open, about:blank redirect, cross-origin postMessage, shared cookies, visible/focused native window");

    evaluate(popup.as_ref(), "window.__fixtureIpc=null;window.__TAURI_INTERNALS__.invoke('browser_supported').then(()=>window.__fixtureIpc='allowed').catch(()=>window.__fixtureIpc='denied');return true;").await?;
    assert_eq!(eventually(popup.as_ref(),"window.__fixtureIpc || null").await?,"denied");
    println!("PASS remote popup cannot invoke harmless app command");

    evaluate(popup.as_ref(), &format!("window.messages=[];addEventListener('message',e=>messages.push(e.data));Promise.resolve().then(()=>setTimeout(()=>{{window.second=window.open({},'second');window.__secondOpened=!!second;}},60));return true;", json!(format!("{origin}/callback")))).await?;
    eventually(popup.as_ref(),"window.__secondOpened===true").await?;
    eventually(popup.as_ref(),"messages.some(m=>m.type==='authenticated')").await?;
    assert_eq!(popup_windows(&app,&owner).len(),2);
    close_popups(&app,&owner).await?;
    assert!(app.get_window("main").is_some() && app.get_webview("main").is_some());
    eventually(&pane,"auth.closed").await?;
    println!("PASS chained popup, delegated Wry creation, native window.close and opener.closed");

    evaluate(&pane,&format!("const link=document.createElement('a');link.href={};link.target='_blank';link.rel='opener';document.body.append(link);link.click();return true;",json!(format!("{other_origin}/callback")))).await?;
    eventually(&pane,"messages.filter(m=>m.data.type==='authenticated').length===2").await?;
    assert_eq!(popup_windows(&app,&owner).len(),1);
    close_popups(&app,&owner).await?;
    println!("PASS target=_blank keeps source page and opens a real related window");

    evaluate(&pane,&format!("window.frame=document.createElement('iframe');frame.src={};frame.onload=()=>window.frameReady=true;document.body.append(frame);return true;",json!(format!("{other_origin}/frame")))).await?;
    eventually(&pane,"window.frameReady===true").await?;
    evaluate(&pane,&format!("frame.contentWindow.postMessage({{type:'open-auth',url:{}}},{});return true;",json!(format!("{origin}/callback")),json!(other_origin))).await?;
    eventually(&pane,"messages.some(m=>m.data.type==='iframe-opened'&&m.data.opened)").await?;
    eventually(&pane,"messages.some(m=>m.data.type==='iframe-authenticated')").await?;
    close_popups(&app,&owner).await?;
    println!("PASS cross-origin iframe opener and postMessage callback");

    evaluate(&pane,&format!("window.quick=window.open({},'immediate');return true;",json!(format!("{origin}/immediate")))).await?;
    eventually(&pane,"messages.some(m=>m.data.type==='immediate')").await?;
    no_popups(&app,&owner).await?;
    eventually(&pane,"quick.closed").await?;
    println!("PASS immediate self-close on initial callback page");

    // Saturate only temporary about:blank windows. Errors intentionally contain
    // no navigation URL, raw engine error or OAuth parameters.
    let opened = evaluate(&pane,"window.many=[];for(let i=0;i<9;i++)many.push(window.open('about:blank','limited-'+i));return many.map(Boolean);").await?;
    assert_eq!(opened.as_array().unwrap().iter().filter(|value|**value==true).count(),8);
    assert_eq!(popup_windows(&app,&owner).len(),8);
    let error_count = events.lock().unwrap().iter().filter(|event|event["kind"]=="popup-error").count();
    assert!(error_count>=1);
    for event in events.lock().unwrap().iter() { assert!(event["url"].is_null());assert!(event["title"].is_null());assert_eq!(event["ownerId"],owner); }
    close_popups(&app,&owner).await?;
    evaluate(&pane,"window.retry=window.open('about:blank','retry');return !!retry;").await?;
    assert_eq!(popup_windows(&app,&owner).len(),1);
    assert_eq!(events.lock().unwrap().last().unwrap()["kind"],"popup-opened");
    println!("PASS popup limit, slot release, retry and token-free error/recovery events");

    // An owner whose name starts with an old popup prefix must remain isolated.
    let newer = format!("{owner}-popup-newer");
    browser::browser_open_smoke(app.clone(),newer.clone(),origin,bounds).await?;
    let newer_pane = app.get_webview(&format!("native-browser-{newer}")).ok_or("newer pane missing")?;
    eventually(&newer_pane,"document.title==='Popup fixture'").await?;
    assert_eq!(evaluate(&newer_pane,"return document.cookie.includes('fixture_session=authenticated');").await?,false,"new ephemeral pane must not reuse the previous cookie store");
    evaluate(&newer_pane,"window.auth=window.open('about:blank','new-owner-auth');return !!auth;").await?;
    browser::browser_close(app.clone(),owner.clone()).await?;
    browser::browser_hide(app.clone(),owner).await?;
    assert_eq!(popup_windows(&app,&newer).len(),1,"stale owner cleanup closed a newer owner's popup");
    browser::browser_close(app.clone(),newer.clone()).await?;
    no_popups(&app,&newer).await?;
    assert!(app.get_window("main").is_some() && app.get_webview("main").is_some());
    println!("PASS exact owner isolation and teardown of all owned satellites");
    Ok(())
}

pub fn main() {
    let port=fixture(); let other=fixture();
    let mut context=tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier="sh.specrails.native-browser-popup-smoke".into();
    let app=tauri::Builder::default().invoke_handler(|invoke|invoke_guard::dispatch(invoke,tauri::generate_handler![browser::browser_supported]))
        .setup(move |app| {
            WebviewWindowBuilder::new(app,"main",WebviewUrl::External("about:blank".parse().unwrap())).title("Specrails popup fixture").inner_size(800.0,640.0).incognito(true).build()?;
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match tauri::async_runtime::spawn(run(handle.clone(),port,other)).await {
                    Ok(Ok(()))=>{println!("Native popup smoke passed");handle.exit(0);}
                    Ok(Err(error))=>{eprintln!("Native popup smoke failed: {error}");EXIT_CODE.store(1,Ordering::Relaxed);handle.exit(1);}
                    Err(error)=>{eprintln!("Native popup smoke assertion failed: {error}");EXIT_CODE.store(1,Ordering::Relaxed);handle.exit(1);}
                }
            });
            Ok(())
        }).build(context).unwrap();
    app.run(|_,_|{});
    std::process::exit(EXIT_CODE.load(Ordering::Relaxed));
}

}

#[cfg(target_os = "macos")]
fn main() { fixture_app::main(); }

#[cfg(not(target_os = "macos"))]
fn main() { eprintln!("This WKWebView smoke requires macOS."); std::process::exit(2); }
