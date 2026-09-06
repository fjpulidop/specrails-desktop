//! Real, independent WKWebView/WebView2 windows with production registry/ACL and
//! close policy. All HTML is an in-memory fixture: no sidecar, database or model.
#[allow(dead_code)]
#[path = "../src/browser.rs"]
mod browser;
#[allow(dead_code)]
#[path = "../src/mission_windows.rs"]
mod mission_windows;
#[path = "../src/invoke_guard.rs"]
mod invoke_guard;
use std::{borrow::Cow, sync::atomic::{AtomicI32, Ordering}, time::Duration};
use serde_json::{json, Value};
use tauri::{Assets, Listener, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
static EXIT: AtomicI32 = AtomicI32::new(0);
struct FixtureAssets;
impl<R: Runtime> Assets<R> for FixtureAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> { Some(Cow::Borrowed(b"<!doctype html><html><head><title>Mission window fixture</title></head><body style='background:#10121a;color:white;font:20px system-ui'><h1>Independent mission fixture</h1><p>No backend or model is running.</p></body></html>")) }
    fn iter(&self) -> Box<AssetsIter<'_>> { Box::new(std::iter::empty()) }
    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item=CspHash<'_>> + '_> { Box::new(std::iter::empty()) }
}
fn snapshot(id: &str, project: Option<&str>, text: &str) -> Value { json!({"version":1,"projectId":project,"conversationId":id,"composer":{"text":text,"references":[],"attachments":[]},"workspace":{},"capturedAt":1}) }
async fn run(app: tauri::AppHandle) -> Result<(), String> {
    let main=app.get_webview_window("main").ok_or("main missing")?;
    let main_view=app.get_webview("main").ok_or("main webview missing")?;
    let first=mission_windows::detach(&app,Some("project-a".into()),"conversation-a".into(),snapshot("conversation-a",Some("project-a"),"draft A #1")).await?;
    let a=app.get_webview_window(&first.window_label).ok_or("child missing")?;
    assert!(!a.is_visible().map_err(|e| e.to_string())?, "unacknowledged destination stays hidden");
    // Exercise the actual renderer IPC identity, not only Rust helper calls.
    // The denied command cannot restart anything: the fixture has no backend
    // and production's invoke guard rejects it before dispatching a handler.
    tokio::time::sleep(Duration::from_millis(300)).await;
    a.eval("(async()=>{try{const i=window.__TAURI_INTERNALS__.invoke;const supported=await i('mission_windows_supported');const state=await i('mission_window_current');let denied=false;try{await i('restart_app')}catch(e){denied=String(e).includes('not available')}location.hash=supported&&state.conversationId==='conversation-a'&&denied?'native-ipc-ok':'native-ipc-failed'}catch(e){location.hash='native-ipc-error'}})()").map_err(|e|e.to_string())?;
    let mut ipc_ok=false;
    for _ in 0..60 {
        if a.url().map_err(|e|e.to_string())?.fragment()==Some("native-ipc-ok") {ipc_ok=true;break;}
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(ipc_ok,"registered mission must load the application origin, obtain only its context and be denied restart IPC");
    let duplicate=mission_windows::detach(&app,Some("project-a".into()),"conversation-a".into(),snapshot("conversation-a",Some("project-a"),"must not overwrite")).await?;
    assert_eq!(duplicate.window_label,first.window_label); assert_eq!(duplicate.snapshot,first.snapshot);
    let home=mission_windows::detach(&app,None,"conversation-home".into(),snapshot("conversation-home",None,"Home draft")).await?;
    mission_windows::ready(&app,&first.window_label,first.revision).await?;
    mission_windows::ready(&app,&home.window_label,home.revision).await?;
    let current=mission_windows::mission_window_current(app.get_webview(&first.window_label).unwrap(),None).await?.ok_or("current missing")?;
    assert_eq!(current.snapshot.as_ref().unwrap()["composer"]["text"],"draft A #1");
    assert_eq!(mission_windows::mission_windows_list(main_view.clone())?.len(),2);
    assert!(mission_windows::mission_window_current(app.get_webview(&first.window_label).unwrap(),Some(home.window_label.clone())).await.is_err());
    main.minimize().map_err(|e| e.to_string())?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(a.is_visible().map_err(|e| e.to_string())? && !a.is_minimized().map_err(|e| e.to_string())?,"main minimize must not minimize independent mission");
    main.unminimize().map_err(|e| e.to_string())?;
    a.maximize().map_err(|e| e.to_string())?; tokio::time::sleep(Duration::from_millis(100)).await;
    a.unmaximize().map_err(|e| e.to_string())?;
    println!("PASS independent native windows, Home scope, hidden hydration, duplicate focus and draft identity");

    let (send,mut receive)=tokio::sync::mpsc::unbounded_channel();
    let listener=app.listen_any(mission_windows::EVENT,move |event| { if let Ok(value)=serde_json::from_str::<Value>(event.payload()) { let _=send.send(value); } });
    a.close().map_err(|e| e.to_string())?;
    let request=tokio::time::timeout(Duration::from_secs(3),async { loop { let event=receive.recv().await.ok_or("event listener closed")?; if event["kind"]=="attach-requested" { return Ok::<Value,String>(event); } } }).await.map_err(|_|"close did not request reintegration")??;
    assert_eq!(request["transfer"]["windowLabel"],first.window_label);
    assert!(app.get_webview_window(&first.window_label).is_some());
    let attaching=mission_windows::attach(&app,&first.window_label,snapshot("conversation-a",Some("project-a"),"latest draft A")).await?;
    assert!(mission_windows::acknowledge(&app,&first.window_label,first.revision).await.is_err());
    assert!(app.get_webview_window(&first.window_label).is_some(),"stale ACK cannot close child");
    let acknowledged=mission_windows::acknowledge(&app,&first.window_label,attaching.revision).await?;
    assert_eq!(acknowledged.snapshot.as_ref().unwrap()["composer"]["text"],"latest draft A");
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!mission_windows::is_trusted_interface(&first.window_label));
    assert!(app.get_webview_window(&home.window_label).is_some());
    println!("PASS native close requests reattach, latest revision ACK commits, other mission survives");

    let timed=mission_windows::detach(&app,Some("project-a".into()),"conversation-timeout".into(),snapshot("conversation-timeout",Some("project-a"),"recover opening")).await?;
    mission_windows::expire_transfer(&app,&timed.window_label,timed.revision).await;
    assert!(!mission_windows::is_trusted_interface(&timed.window_label));
    assert!(mission_windows::ready(&app,&timed.window_label,timed.revision).await.is_err());
    let home_attach=mission_windows::attach(&app,&home.window_label,snapshot("conversation-home",None,"recover attaching")).await?;
    mission_windows::expire_transfer(&app,&home.window_label,home_attach.revision).await;
    let restored=mission_windows::mission_window_current(app.get_webview(&home.window_label).unwrap(),None).await?.unwrap();
    assert_eq!(restored.state,mission_windows::Placement::Detached); assert!(restored.revision>home_attach.revision);
    assert_eq!(restored.snapshot.as_ref().unwrap()["composer"]["text"],"recover attaching");
    assert!(mission_windows::acknowledge(&app,&home.window_label,home_attach.revision).await.is_err());
    println!("PASS timeout rollback retains source snapshots and rejects delayed acknowledgements");

    let popup=WebviewWindowBuilder::new(&app,"fixture-popup",WebviewUrl::External("about:blank".parse().unwrap())).incognito(true).build().map_err(|e|e.to_string())?;
    popup.close().map_err(|e|e.to_string())?; tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(app.get_webview_window("fixture-popup").is_none(),"production close classification must destroy popups");
    main.close().map_err(|e|e.to_string())?; tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(app.get_webview_window("main").is_some()); assert!(!main.is_visible().map_err(|e|e.to_string())?);
    main.show().map_err(|e|e.to_string())?;
    mission_windows::mission_window_discard(app.clone(),main_view,"conversation-home".into()).await?;
    assert!(!mission_windows::is_trusted_interface(&home.window_label));
    println!("PASS popup actual destruction, main hide-to-tray and deleted mission discard");
    app.unlisten(listener);
    Ok(())
}
fn main() {
    let mut context=tauri::generate_context!();
    context.set_assets(Box::new(FixtureAssets));
    context.config_mut().identifier="sh.specrails.mission-window-smoke".into();
    context.config_mut().app.windows.clear(); context.config_mut().build.dev_url=None;
    let app=tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init()).plugin(tauri_plugin_shell::init()).plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(|invoke| invoke_guard::dispatch(invoke,tauri::generate_handler![mission_windows::mission_windows_supported,mission_windows::mission_window_current]))
        .on_window_event(mission_windows::handle_window_event)
        .setup(|app| {
            WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into())).title("Specrails mission fixture").inner_size(1100.0,800.0).incognito(true).build()?;
            let app=app.handle().clone(); tauri::async_runtime::spawn(async move {
                match tauri::async_runtime::spawn(run(app.clone())).await {Ok(Ok(()))=>println!("Native mission window smoke passed"),other=>{eprintln!("Native mission window smoke failed: {other:?}");EXIT.store(1,Ordering::Relaxed);}}
                app.exit(EXIT.load(Ordering::Relaxed));
            }); Ok(())
        }).build(context).expect("native mission fixture");
    app.run(|_,event| { if matches!(event,tauri::RunEvent::Exit) { std::process::exit(EXIT.load(Ordering::Relaxed)); } });
    std::process::exit(EXIT.load(Ordering::Relaxed));
}
