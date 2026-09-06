//! Two independent native browsers and authenticated popups, with a live
//! browser reparented between app windows. Local fixtures only; no sidecar/DB.
#[allow(dead_code)]
#[path = "../src/browser.rs"] mod browser;
#[path = "../src/invoke_guard.rs"] mod invoke_guard;
#[allow(dead_code)]
#[path = "../src/mission_windows.rs"] mod mission_windows;
#[cfg(target_os = "macos")] use block2::RcBlock;
#[cfg(target_os = "macos")] use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")] use objc2_foundation::{NSError, NSString};
#[cfg(target_os = "macos")] use objc2_web_kit::WKWebView;
use serde_json::Value;
use std::{io::{Read, Write}, net::TcpListener, sync::{Arc, Mutex, atomic::{AtomicI32, Ordering}}, time::Duration};
use tauri::{Listener, Manager, Webview, WebviewUrl, WebviewWindowBuilder};
static EXIT_CODE: AtomicI32 = AtomicI32::new(0);
const FIRST: &str = "mission-browser-one";
const SECOND: &str = "mission-browser-two";

fn server() -> u16 {
    let listener=TcpListener::bind("127.0.0.1:0").unwrap();
    let port=listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut request=[0;4096]; let _=stream.read(&mut request);
            let body=r#"<!doctype html><title>Browser mission fixture</title><style>body{font:24px system-ui;background:#ecfeff;color:#082f49}button{padding:24px}</style><h1>Independent mission browser</h1><button id=target>Native resolution</button><script>window.fixture={sentinel:'initial',messages:[]};addEventListener('message',event=>fixture.messages.push(event.data));</script>"#;
            let response=format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
            let _=stream.write_all(response.as_bytes());
        }
    });
    port
}
#[cfg(target_os = "macos")]
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

#[cfg(windows)]
async fn evaluate(view: &Webview, source: &str) -> Result<Value, String> {
    let source = format!("JSON.stringify((()=>{{{source}}})())");
    let (send, mut receive) = tokio::sync::mpsc::channel(1);
    view.with_webview(move |platform| unsafe {
        let callback_send = send.clone();
        let handler = webview2_com::ExecuteScriptCompletedHandler::create(Box::new(move |status, text| {
            let result = status.map_err(|_| "fixture script failed".to_string()).and_then(|_| {
                let text: String = serde_json::from_str(&text).map_err(|e| e.to_string())?;
                serde_json::from_str(&text).map_err(|e| e.to_string())
            });
            let _ = callback_send.try_send(result);
            Ok(())
        }));
        if platform.controller().CoreWebView2().and_then(|view| view.ExecuteScript(&windows::core::HSTRING::from(source), &handler)).is_err() {
            let _ = send.try_send(Err("fixture script could not start".to_string()));
        }
    }).map_err(|e| e.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), receive.recv()).await.map_err(|_| "script timeout")?.ok_or("script channel closed")?
}

async fn pane_visible(view: &Webview) -> Result<bool, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    view.with_webview(move |platform| unsafe {
        #[cfg(target_os = "macos")]
        let result = {
            let view: &WKWebView = &*platform.inner().cast();
            let hidden: bool = objc2::msg_send![view, isHidden];
            Ok(!hidden)
        };
        #[cfg(windows)]
        let result = {
            let mut visible = windows::Win32::Foundation::BOOL::default();
            platform.controller().IsVisible(&mut visible).map(|_| visible.as_bool()).map_err(|error| error.to_string())
        };
        let _ = send.send(result);
    }).map_err(|error| error.to_string())?;
    tokio::time::timeout(Duration::from_secs(5), receive).await.map_err(|_| "native visibility timeout")?.map_err(|_| "native visibility channel closed")?
}

async fn eventually(view: &Webview, expression: &str) -> Result<Value, String> {
    for _ in 0..100 {
        let value = evaluate(view, &format!("return ({expression});")).await?;
        if value != Value::Null && value != Value::Bool(false) { return Ok(value); }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err(format!("condition timed out: {expression}"))
}


fn watch(app:&tauri::AppHandle,label:&str)->Arc<Mutex<Vec<Value>>> {
    let events=Arc::new(Mutex::new(Vec::new())); let received=events.clone();
    app.get_webview(label).unwrap().listen("native-browser:event",move |event| {
        received.lock().unwrap().push(serde_json::from_str(event.payload()).unwrap());
    });
    events
}
async fn popup_for(app:&tauri::AppHandle,pane:&Webview)->Result<tauri::WebviewWindow,String> {
    let prefix=format!("{}-popup-",pane.label());
    for _ in 0..100 {
        if let Some((_,window))=app.webview_windows().into_iter().find(|(label,_)|label.starts_with(&prefix)){return Ok(window)}
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("popup did not open".into())
}
async fn gone(app:&tauri::AppHandle,label:&str)->Result<(),String> {
    for _ in 0..100 {
        if app.get_webview_window(label).is_none(){return Ok(())}
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("popup did not close".into())
}
async fn run(app:tauri::AppHandle,port:u16)->Result<(),String> {
    let main=app.get_webview("main").ok_or("main interface missing")?;
    let first=app.get_webview(FIRST).ok_or("mission interface missing")?;
    let second=app.get_webview(SECOND).ok_or("second interface missing")?;
    let main_events=watch(&app,"main"); let first_events=watch(&app,FIRST); let second_events=watch(&app,SECOND);
    let owner="same-owner-id".to_string();
    let url=format!("http://127.0.0.1:{port}/");
    let bounds=browser::PaneBounds{x:0.0,y:40.0,width:800.0,height:480.0};
    browser::browser_open_smoke(app.clone(),owner.clone(),url.clone(),bounds).await?;
    browser::browser_open_smoke_in_window(app.clone(),SECOND.into(),owner.clone(),url.clone(),bounds).await?;
    let pane_a=browser::browser_pane_for_window(&app,"main",&owner)?;
    let pane_b=browser::browser_pane_for_window(&app,SECOND,&owner)?;
    assert_ne!(pane_a.label(),pane_b.label());
    eventually(&pane_a,"!!window.fixture").await?; eventually(&pane_b,"!!window.fixture").await?;
    evaluate(&pane_a,"fixture.sentinel='preserved';document.cookie='session=one;path=/';window.auth=window.open('about:blank','auth-one');return !!auth;").await?;
    evaluate(&pane_b,"fixture.sentinel='second';window.auth=window.open('about:blank','auth-two');return !!auth;").await?;
    let popup_a=popup_for(&app,&pane_a).await?; let popup_b=popup_for(&app,&pane_b).await?;
    assert!(browser::browser_reload(app.clone(),pane_a.clone(),owner.clone()).await.is_err(),"remote child must never act as its trusted parent");
    assert!(browser::transfer_browser_window(&app,"main",SECOND,&owner).await.is_err(),"occupied target must retain its own browser");
    let parked_owner = "previous-target-owner".to_string();
    browser::browser_open_smoke_in_window(app.clone(),FIRST.into(),parked_owner.clone(),url.clone(),bounds).await?;
    let parked_pane=browser::browser_pane_for_window(&app,FIRST,&parked_owner)?;
    eventually(&parked_pane,"!!window.fixture").await?;
    evaluate(&parked_pane,"fixture.sentinel='parked-session';window.auth=window.open('about:blank','auth-parked');return !!auth;").await?;
    let parked_popup=popup_for(&app,&parked_pane).await?;
    browser::transfer_browser_window(&app,"main",FIRST,&owner).await?;
    assert!(!parked_popup.is_visible().map_err(|error|error.to_string())?);
    browser::browser_close(app.clone(),first.clone(),parked_owner.clone()).await?;
    assert!(app.get_webview(parked_pane.label()).is_some(),"stale cleanup preserves the parked session");
    assert_eq!(pane_a.window().label(),FIRST);
    // Old renderer cleanup cannot close the transferred pane or authentication popup.
    browser::browser_close(app.clone(),main.clone(),owner.clone()).await?;
    browser::browser_hide(app.clone(),main.clone(),owner.clone()).await?;
    assert!(app.get_webview(pane_a.label()).is_some()); assert!(app.get_webview_window(popup_a.label()).is_some());
    assert!(browser::browser_reload(app.clone(),main.clone(),owner.clone()).await.is_err());
    let moved=browser::PaneBounds{x:0.0,y:44.0,width:620.0,height:410.0};
    browser::browser_open_smoke_in_window(app.clone(),FIRST.into(),owner.clone(),format!("{url}must-not-navigate"),moved).await?;
    let adopted=browser::browser_pane_for_window(&app,FIRST,&owner)?;
    assert_eq!(adopted.label(),pane_a.label());
    assert_eq!(evaluate(&adopted,"return fixture.sentinel;").await?,"preserved");
    assert_eq!(evaluate(&adopted,"return location.pathname;").await?,"/");
    assert_eq!(evaluate(&pane_b,"return fixture.sentinel;").await?,"second");
    evaluate(&popup_a.as_ref().clone(),"window.opener.postMessage('after-move','*');return true;").await?;
    eventually(&adopted,"fixture.messages.includes('after-move')").await?;
    // Explicit adoption can alternate retained sessions without a navigation.
    browser::browser_open_smoke_in_window(app.clone(),FIRST.into(),parked_owner.clone(),url.clone(),moved).await?;
    assert_eq!(evaluate(&parked_pane,"return fixture.sentinel;").await?,"parked-session");
    assert!(parked_popup.is_visible().map_err(|error|error.to_string())?);
    browser::browser_open_smoke_in_window(app.clone(),FIRST.into(),owner.clone(),url.clone(),moved).await?;
    assert!(!parked_popup.is_visible().map_err(|error|error.to_string())?);
    let capture=browser::browser_capture(app.clone(),first.clone(),owner.clone(),false).await?;
    assert!((capture.viewport.width-620.0).abs()<1.0);
    let dpr=app.get_window(FIRST).unwrap().scale_factor().map_err(|e|e.to_string())?;
    assert!((capture.viewport.device_scale_factor-dpr).abs()<0.02,"capture must use destination screen scale");
    evaluate(&adopted,"document.title='event-after-transfer';return true;").await?;
    for _ in 0..100 {
        if first_events.lock().unwrap().iter().any(|event|event["title"]=="event-after-transfer"){break}
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(first_events.lock().unwrap().iter().any(|event|event["title"]=="event-after-transfer"));
    assert!(!main_events.lock().unwrap().iter().any(|event|event["title"]=="event-after-transfer"));
    assert!(!second_events.lock().unwrap().iter().any(|event|event["title"]=="event-after-transfer"));
    popup_a.eval("window.close()").map_err(|e|e.to_string())?;
    gone(&app,popup_a.label()).await?;
    assert!(app.get_webview_window(popup_b.label()).is_some());
    // This popup is created while the browser is hosted by FIRST. It must not
    // acquire FIRST as an OS owner: that source window is destroyed below.
    evaluate(&adopted,"window.returnAuth=window.open('about:blank','auth-before-reattach');return !!returnAuth;").await?;
    let source_popup=popup_for(&app,&adopted).await?;
    browser::transfer_browser_window(&app,FIRST,"main",&owner).await?;
    browser::transfer_browser_window(&app,FIRST,"main",&owner).await?; // retry is idempotent
    assert!(browser::browser_pane_for_window(&app,FIRST,&parked_owner).is_err(),"parked candidate is not active until UI adoption");
    browser::browser_close(app.clone(),first.clone(),parked_owner.clone()).await?;
    assert!(app.get_webview(parked_pane.label()).is_some(),"late source cleanup must preserve the still-parked session");
    assert_eq!(evaluate(&parked_pane,"return fixture.sentinel;").await?,"parked-session");
    assert!(!pane_visible(&parked_pane).await?,"promoting an old session cannot expose a browser without mounted UI controls");
    assert!(!parked_popup.is_visible().map_err(|error|error.to_string())?,"promoted session popups must wait for renderer adoption too");
    assert!(first_events.lock().unwrap().iter().any(|event|event["kind"]=="resume" && event["ownerId"]==parked_owner),"only the previous owner receives a resume request");
    assert!(!main_events.lock().unwrap().iter().any(|event|event["kind"]=="resume" && event["ownerId"]==parked_owner));
    // Scripts can continue while a parked page is hidden. A newly opened popup
    // must not steal focus or create an orphan overlay before UI adoption.
    evaluate(&parked_pane,"window.lateAuth=window.open('about:blank','late-hidden-popup');return !!lateAuth;").await?;
    let late_prefix=format!("{}-popup-",parked_pane.label());
    let mut late_popup=None;
    for _ in 0..100 {
        late_popup=app.webview_windows().into_iter().find(|(label,_)|label.starts_with(&late_prefix) && label != parked_popup.label()).map(|(_,window)|window);
        if late_popup.is_some(){break}
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let late_popup=late_popup.ok_or("hidden session popup missing")?;
    assert!(!late_popup.is_visible().map_err(|error|error.to_string())?,"hidden session cannot present a new popup");
    // A still-mounted UI can handle resume by explicitly adopting this owner.
    browser::browser_open_smoke_in_window(app.clone(),FIRST.into(),parked_owner.clone(),url.clone(),bounds).await?;
    assert!(pane_visible(&parked_pane).await?);
    assert!(parked_popup.is_visible().map_err(|error|error.to_string())?);
    assert!(late_popup.is_visible().map_err(|error|error.to_string())?);
    browser::close_owned_for_window(&app,FIRST);
    gone(&app,parked_popup.label()).await?;
    mission_windows::unregister_smoke_interface(FIRST);
    app.get_webview_window(FIRST).ok_or("source mission window missing")?.destroy().map_err(|error|error.to_string())?;
    gone(&app,FIRST).await?;
    assert!(app.get_webview_window(source_popup.label()).is_some(),"destroying the previous host must preserve the moved browser's OAuth popup");
    browser::browser_open_smoke(app.clone(),owner.clone(),url,bounds).await?;
    assert_eq!(evaluate(&pane_a,"return fixture.sentinel;").await?,"preserved");
    evaluate(&source_popup.as_ref().clone(),"window.opener.postMessage('after-source-destroy','*');return true;").await?;
    eventually(&pane_a,"fixture.messages.includes('after-source-destroy')").await?;
    source_popup.eval("window.close()").map_err(|error|error.to_string())?;
    gone(&app,source_popup.label()).await?;
    browser::browser_close(app.clone(),main,owner.clone()).await?;
    assert!(app.get_webview(pane_b.label()).is_some());
    assert!(app.get_webview_window(popup_b.label()).is_some());
    browser::browser_close(app.clone(),second,owner).await?;
    gone(&app,popup_b.label()).await?;
    mission_windows::unregister_smoke_interface(FIRST); mission_windows::unregister_smoke_interface(SECOND);
    Ok(())
}
fn main() {
    let port=server();
    let mut context=tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().identifier="sh.specrails.native-browser-multiwindow-smoke".into();
    let app=tauri::Builder::default().invoke_handler(|invoke|invoke_guard::dispatch(invoke,tauri::generate_handler![browser::browser_supported]))
        .setup(move |app| {
            for (index,label) in ["main",FIRST,SECOND].iter().enumerate() {
                if *label!="main" {mission_windows::register_smoke_interface(label)}
                WebviewWindowBuilder::new(app,*label,WebviewUrl::External("about:blank".parse().unwrap()))
                    .title(format!("Specrails browser window {index}")).inner_size(850.0,620.0).position(80.0+index as f64*120.0,80.0+index as f64*70.0).incognito(true).build()?;
            }
            let handle=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result=tauri::async_runtime::spawn(run(handle.clone(),port)).await.map_err(|error|error.to_string()).and_then(|result|result);
                match result {
                    Ok(())=>{println!("PASS native multiwindow browser: independent same-owner panes, popups, remote denial, transfer/adoption, parked target/rollback without orphan overlays, source destruction with live OAuth popup, event target, destination DPI and stale cleanup");handle.exit(0)},
                    Err(error)=>{eprintln!("FAIL native multiwindow browser: {error}");EXIT_CODE.store(1,Ordering::Relaxed);handle.exit(1)},
                }
            });
            Ok(())
        }).build(context).expect("multiwindow native fixture");
    app.run(|_, event| { if matches!(event, tauri::RunEvent::Exit) { std::process::exit(EXIT_CODE.load(Ordering::Relaxed)); } });
    std::process::exit(EXIT_CODE.load(Ordering::Relaxed));
}
