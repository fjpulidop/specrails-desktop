//! Trusted, independent mission windows. The backend belongs to the application,
//! never to one of these views. Ownership changes only after restoration is acked.
use std::{collections::HashMap, sync::{atomic::{AtomicU64, Ordering}, Mutex, OnceLock}, time::Duration};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Emitter, Manager, Webview, WebviewUrl, WebviewWindowBuilder};

const MAIN: &str = "main";
pub const EVENT: &str = "mission-window:event";
const MAX_SNAPSHOT_BYTES: usize = 2 * 1024 * 1024;
const MAX_WINDOWS: usize = 16;
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30);
static REVISION: AtomicU64 = AtomicU64::new(0);
static REGISTRY: OnceLock<Mutex<HashMap<String, Entry>>> = OnceLock::new();
static TRANSFERS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Placement { Opening, Detached, Attaching }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MissionTransfer {
    pub window_label: String,
    pub project_id: Option<String>,
    pub conversation_id: String,
    pub revision: u64,
    pub state: Placement,
    pub snapshot: Option<Value>,
}

#[derive(Clone)]
struct Entry { transfer: MissionTransfer, preparing: bool }

#[derive(Clone, Serialize)]
pub struct MissionEvent { kind: String, transfer: MissionTransfer, registered: bool, #[serde(skip_serializing_if = "Option::is_none")] error: Option<String> }

fn registry() -> &'static Mutex<HashMap<String, Entry>> { REGISTRY.get_or_init(Default::default) }
fn next_revision() -> u64 { REVISION.fetch_add(1, Ordering::SeqCst) + 1 }
fn safe_id(id: &str) -> bool { !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') }

fn validate_snapshot(snapshot: &Value, project: Option<&str>, conversation: &str) -> Result<(), String> {
    if !snapshot.is_object() || snapshot["version"] != 1 || snapshot.get("projectId") != Some(&project.map(|id| Value::String(id.into())).unwrap_or(Value::Null)) || snapshot["conversationId"] != conversation {
        return Err("The mission snapshot has an invalid version or conversation scope.".into());
    }
    if serde_json::to_vec(snapshot).map_err(|_| "The mission snapshot could not be encoded.")?.len() > MAX_SNAPSHOT_BYTES {
        return Err("The mission view exceeds the 2 MB transfer limit. Finish or remove pending captures and retry.".into());
    }
    Ok(())
}

pub fn is_trusted_interface(label: &str) -> bool {
    label == MAIN || registry().lock().map(|entries| entries.contains_key(label)).unwrap_or(false)
}

pub fn is_mission_window(label: &str) -> bool {
    label != MAIN && registry().lock().map(|entries| entries.contains_key(label)).unwrap_or(false)
}

/// Deliberately narrower than the main interface. Plugin permissions are checked
/// by Tauri's ACL before the application's custom-command dispatcher is reached.
pub fn permits_command(label: &str, command: &str) -> bool {
    if label == MAIN { return true; }
    is_mission_window(label) && (command.starts_with("browser_") || matches!(command,
        "mission_windows_supported" | "mission_windows_list" | "mission_window_current" |
        "mission_window_ready" | "mission_window_attach" | "mission_window_cancel" |
        "mission_window_focus" | "mission_window_discard" | "desktop_reveal_path" | "desktop_save_text"))
}

fn ensure_caller(caller: &Webview) -> Result<(), String> {
    if caller.label() != caller.window().label() || !is_trusted_interface(caller.label()) {
        return Err("This webview is not a registered Specrails interface.".into());
    }
    Ok(())
}
fn ensure_main(caller: &Webview) -> Result<(), String> { ensure_caller(caller)?; if caller.label() != MAIN { return Err("This action belongs to the main interface.".into()); } Ok(()) }
fn get_entry(label: &str) -> Result<Entry, String> { registry().lock().map_err(|_| "Mission window state is unavailable.")?.get(label).cloned().ok_or_else(|| "The mission window is no longer registered.".into()) }
fn check_revision(entry: &Entry, revision: u64, placement: Placement) -> Result<(), String> {
    if entry.preparing || entry.transfer.revision != revision || entry.transfer.state != placement { return Err("This mission transfer is no longer current.".into()); }
    Ok(())
}
fn publish(app: &tauri::AppHandle, kind: &str, transfer: MissionTransfer, error: Option<String>) {
    let registered = registry().lock().map(|entries| entries.contains_key(&transfer.window_label)).unwrap_or(false);
    let payload = MissionEvent { kind: kind.into(), transfer, registered, error };
    let mut labels: Vec<String> = registry().lock().map(|entries| entries.keys().cloned().collect()).unwrap_or_default();
    labels.push(MAIN.into());
    if !labels.contains(&payload.transfer.window_label) { labels.push(payload.transfer.window_label.clone()); }
    for label in labels {
        let mut scoped = payload.clone();
        if label != MAIN && label != scoped.transfer.window_label { scoped.transfer.snapshot = None; }
        let _ = app.emit_to(label, EVENT, &scoped);
    }
}

fn focus(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let window = app.get_webview_window(label).ok_or("The mission window is unavailable.")?;
    window.show().and_then(|_| window.unminimize()).and_then(|_| window.set_focus()).map_err(|_| "The window could not be focused.".into())
}

fn browser_owner(transfer: &MissionTransfer) -> Option<&str> {
    let workspace = transfer.snapshot.as_ref()?.get("workspace")?;
    if workspace.get("browserOpen") != Some(&Value::Bool(true)) { return None; }
    workspace.get("browserOwnerId")?.as_str().filter(|id| !id.is_empty())
}
async fn move_browser(app: &tauri::AppHandle, transfer: &MissionTransfer, from: &str, to: &str) -> Result<(), String> {
    if let Some(owner) = browser_owner(transfer) { crate::browser::transfer_browser_window(app, from, to, owner).await?; }
    Ok(())
}

/// Dynamic capabilities bind to one exact, random, never-reused webview label.
/// No window inheritance, remote origins, sidecar spawning, updater or app exit.
fn add_capability(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let mut capability = tauri::ipc::CapabilityBuilder::new(format!("{label}-interface")).webview(label);
    for permission in ["core:event:default", "core:window:default", "core:window:allow-close", "core:window:allow-minimize",
        "core:window:allow-maximize", "core:window:allow-toggle-maximize", "core:window:allow-unmaximize", "core:window:allow-start-dragging",
        "core:window:allow-show", "core:window:allow-unminimize", "core:window:allow-set-title", "dialog:allow-open", "dialog:allow-message", "dialog:allow-confirm",
        "clipboard-manager:allow-read-text", "clipboard-manager:allow-write-text"] { capability = capability.permission(permission); }
    capability = capability.permission_scoped("shell:allow-open", vec![serde_json::json!({"url":"https://**"}), serde_json::json!({"url":"http://**"})], Vec::<Value>::new());
    app.add_capability(capability).map_err(|_| "The mission window permissions could not be initialized.".into())
}

fn arm_timeout(app: tauri::AppHandle, label: String, revision: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(TRANSFER_TIMEOUT).await;
        expire_transfer(&app, &label, revision).await;
    });
}

pub(crate) async fn expire_transfer(app: &tauri::AppHandle, label: &str, revision: u64) {
    let _guard = TRANSFERS.lock().await;
    if let Ok(entry) = get_entry(label) {
        if entry.transfer.revision == revision && entry.transfer.state != Placement::Detached {
            let _ = rollback(app, entry, "The destination did not confirm restoration. Your source view remains available; retry the transfer.").await;
        }
    }
}

async fn rollback(app: &tauri::AppHandle, entry: Entry, reason: &str) -> Result<(), String> {
    let transfer = &entry.transfer;
    let (from, to) = if transfer.state == Placement::Opening { (transfer.window_label.as_str(), MAIN) } else { (MAIN, transfer.window_label.as_str()) };
    // If reparenting never occurred this is idempotent. A rollback failure keeps
    // both views and the snapshot registered; never destroy a page/draft on error.
    if let Err(error) = move_browser(app, transfer, from, to).await {
        publish(app, "failed", transfer.clone(), Some(format!("The browser could not return to its source window: {error}")));
        return Err(error);
    }
    let mut restored = transfer.clone();
    if restored.state == Placement::Opening {
        registry().lock().map_err(|_| "Mission window state is unavailable.")?.remove(&restored.window_label);
        crate::browser::close_owned_for_window(app, &restored.window_label);
        if let Some(window) = app.get_webview_window(&restored.window_label) { let _ = window.destroy(); }
        let _ = focus(app, MAIN);
    } else {
        restored.state = Placement::Detached;
        restored.revision = next_revision();
        registry().lock().map_err(|_| "Mission window state is unavailable.")?.insert(restored.window_label.clone(), Entry { transfer: restored.clone(), preparing: false });
        let _ = focus(app, &restored.window_label);
    }
    publish(app, "failed", restored, Some(reason.into()));
    Ok(())
}

#[tauri::command]
pub fn mission_windows_supported() -> bool { cfg!(any(target_os = "macos", windows)) }

#[tauri::command]
pub fn mission_windows_list(webview: Webview) -> Result<Vec<MissionTransfer>, String> {
    ensure_caller(&webview)?;
    Ok(registry().lock().map_err(|_| "Mission window state is unavailable.")?.values().map(|entry| { let mut transfer = entry.transfer.clone(); transfer.snapshot = None; transfer }).collect())
}

#[tauri::command]
pub async fn mission_window_current(webview: Webview, window_label: Option<String>) -> Result<Option<MissionTransfer>, String> {
    ensure_caller(&webview)?;
    let label = window_label.as_deref().unwrap_or(webview.label());
    if label == MAIN { return Ok(None); }
    if webview.label() != MAIN && label != webview.label() { return Err("Another window's mission state is private.".into()); }
    for _ in 0..600 {
        let entry = get_entry(label)?;
        if !entry.preparing { return Ok(Some(entry.transfer)); }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("The mission window is still preparing. Retry the transfer.".into())
}

#[tauri::command]
pub async fn mission_window_detach(app: tauri::AppHandle, webview: Webview, project_id: Option<String>, conversation_id: String, snapshot: Value) -> Result<MissionTransfer, String> {
    ensure_main(&webview)?;
    detach(&app, project_id, conversation_id, snapshot).await
}

pub(crate) async fn detach(app: &tauri::AppHandle, project_id: Option<String>, conversation_id: String, snapshot: Value) -> Result<MissionTransfer, String> {
    if project_id.as_deref().is_some_and(|id| !safe_id(id)) || !safe_id(&conversation_id) { return Err("Invalid project or conversation identity.".into()); }
    validate_snapshot(&snapshot, project_id.as_deref(), &conversation_id)?;
    let _guard = TRANSFERS.lock().await;
    let existing = registry().lock().map_err(|_| "Mission window state is unavailable.")?.values().find(|entry| entry.transfer.conversation_id == conversation_id).cloned();
    if let Some(entry) = existing {
        if entry.transfer.project_id != project_id { return Err("The conversation belongs to a different project.".into()); }
        // Opening windows stay hidden until restored, even after a repeated click.
        if entry.transfer.state == Placement::Detached { focus(app, &entry.transfer.window_label)?; }
        return Ok(entry.transfer);
    }
    if registry().lock().map_err(|_| "Mission window state is unavailable.")?.len() >= MAX_WINDOWS { return Err("Close or reintegrate a mission before opening another window (maximum 16).".into()); }
    let label = format!("mission-{:032x}", rand::random::<u128>());
    let transfer = MissionTransfer { window_label: label.clone(), project_id, conversation_id, revision: next_revision(), state: Placement::Opening, snapshot: Some(snapshot) };
    registry().lock().map_err(|_| "Mission window state is unavailable.")?.insert(label.clone(), Entry { transfer: transfer.clone(), preparing: true });
    let build = (|| {
        add_capability(app, &label)?;
        // Only this application's origin is allowed; remote content is confined
        // to separately labelled browser webviews and cannot replace this view.
        let origin = app.get_webview_window(MAIN).ok_or("The main interface is unavailable.")?.url().map_err(|_| "The application origin is unavailable.")?;
        let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html?missionWindow=1".into()))
            .title("Specrails — Mission").inner_size(1000.0, 760.0).min_inner_size(560.0, 420.0).center().visible(false).focused(false)
            .on_navigation(move |url| allowed_app_navigation(&origin, url))
            .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
        #[cfg(target_os = "macos")]
        { builder = builder.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true); }
        #[cfg(not(target_os = "macos"))]
        { builder = builder.decorations(false); }
        builder.build().map_err(|_| "The native mission window could not be created.")?;
        Ok::<(), String>(())
    })();
    if let Err(error) = build {
        // No browser was moved; remove only this newly reserved identity.
        registry().lock().map_err(|_| "Mission window state is unavailable.")?.remove(&label);
        if let Some(window) = app.get_webview_window(&label) { let _ = window.destroy(); }
        publish(app, "failed", transfer, Some(error.clone()));
        return Err(error);
    }
    if let Err(error) = move_browser(app, &transfer, MAIN, &label).await {
        let entry = get_entry(&label)?;
        let _ = rollback(app, entry, "The browser could not move to the mission window. Your integrated view remains available.").await;
        return Err(error);
    }
    registry().lock().map_err(|_| "Mission window state is unavailable.")?.get_mut(&label).ok_or("The mission window closed while preparing.")?.preparing = false;
    publish(app, "opening", transfer.clone(), None);
    arm_timeout(app.clone(), label, transfer.revision);
    Ok(transfer)
}

#[tauri::command]
pub async fn mission_window_ready(app: tauri::AppHandle, webview: Webview, revision: u64) -> Result<MissionTransfer, String> {
    ensure_caller(&webview)?;
    ready(&app, webview.label(), revision).await
}
pub(crate) async fn ready(app: &tauri::AppHandle, label: &str, revision: u64) -> Result<MissionTransfer, String> {
    let _guard = TRANSFERS.lock().await;
    let entry = get_entry(label)?;
    if entry.transfer.state == Placement::Detached && entry.transfer.revision == revision { return Ok(entry.transfer); }
    check_revision(&entry, revision, Placement::Opening)?;
    focus(app, label)?;
    let mut transfer = entry.transfer;
    transfer.state = Placement::Detached;
    registry().lock().map_err(|_| "Mission window state is unavailable.")?.insert(label.into(), Entry { transfer: transfer.clone(), preparing: false });
    publish(app, "detached", transfer.clone(), None);
    Ok(transfer)
}

#[tauri::command]
pub async fn mission_window_attach(app: tauri::AppHandle, webview: Webview, snapshot: Value) -> Result<MissionTransfer, String> {
    ensure_caller(&webview)?;
    attach(&app, webview.label(), snapshot).await
}
pub(crate) async fn attach(app: &tauri::AppHandle, label: &str, snapshot: Value) -> Result<MissionTransfer, String> {
    let _guard = TRANSFERS.lock().await;
    let entry = get_entry(label)?;
    if entry.transfer.state == Placement::Attaching { return Ok(entry.transfer); }
    if entry.transfer.state != Placement::Detached { return Err("Wait until this mission finishes opening before reintegrating it.".into()); }
    validate_snapshot(&snapshot, entry.transfer.project_id.as_deref(), &entry.transfer.conversation_id)?;
    let mut transfer = entry.transfer;
    transfer.revision = next_revision(); transfer.state = Placement::Attaching; transfer.snapshot = Some(snapshot);
    registry().lock().map_err(|_| "Mission window state is unavailable.")?.insert(label.into(), Entry { transfer: transfer.clone(), preparing: true });
    if let Err(error) = move_browser(app, &transfer, label, MAIN).await {
        let _ = rollback(app, get_entry(label)?, "The browser could not move to the main window. Close its other browser and retry.").await;
        return Err(error);
    }
    registry().lock().map_err(|_| "Mission window state is unavailable.")?.get_mut(label).ok_or("The mission window closed while preparing.")?.preparing = false;
    if let Err(error) = focus(app, MAIN) {
        let _ = rollback(app, get_entry(label)?, "The main window could not be restored. Your mission remains in its separate window.").await;
        return Err(error);
    }
    publish(app, "attaching", transfer.clone(), None);
    arm_timeout(app.clone(), label.into(), transfer.revision);
    Ok(transfer)
}

#[tauri::command]
pub async fn mission_window_ack(app: tauri::AppHandle, webview: Webview, window_label: String, revision: u64) -> Result<MissionTransfer, String> {
    ensure_main(&webview)?;
    acknowledge(&app, &window_label, revision).await
}
pub(crate) async fn acknowledge(app: &tauri::AppHandle, label: &str, revision: u64) -> Result<MissionTransfer, String> {
    let _guard = TRANSFERS.lock().await;
    let entry = get_entry(label)?;
    check_revision(&entry, revision, Placement::Attaching)?;
    // Destroy bypasses the native close→reattach interceptor after the explicit
    // restore ACK. Remove registration only after destruction was dispatched.
    if let Some(window) = app.get_webview_window(label) { window.destroy().map_err(|_| "The restored mission window could not be closed.")?; }
    registry().lock().map_err(|_| "Mission window state is unavailable.")?.remove(label);
    crate::browser::close_owned_for_window(app, label);
    publish(app, "attached", entry.transfer.clone(), None);
    Ok(entry.transfer)
}

#[tauri::command]
pub async fn mission_window_cancel(app: tauri::AppHandle, webview: Webview, window_label: String, revision: u64) -> Result<(), String> {
    ensure_caller(&webview)?;
    if webview.label() != MAIN && webview.label() != window_label { return Err("Another mission's transfer cannot be cancelled.".into()); }
    let _guard = TRANSFERS.lock().await;
    let entry = get_entry(&window_label)?;
    if entry.transfer.revision != revision || entry.transfer.state == Placement::Detached { return Err("This mission transfer is no longer current.".into()); }
    rollback(&app, entry, "The mission transfer was cancelled. Your source view remains available.").await
}

#[tauri::command]
pub fn mission_window_focus(app: tauri::AppHandle, webview: Webview, conversation_id: String) -> Result<bool, String> {
    ensure_caller(&webview)?;
    let entry = registry().lock().map_err(|_| "Mission window state is unavailable.")?.values().find(|entry| entry.transfer.conversation_id == conversation_id).cloned();
    if let Some(entry) = entry { if entry.transfer.state == Placement::Detached { focus(&app, &entry.transfer.window_label)?; } return Ok(true); }
    Ok(false)
}

/// Called only after the shared backend confirmed deletion. It must not revive
/// a deleted conversation by running the usual close/restore handshake.
#[tauri::command]
pub async fn mission_window_discard(app: tauri::AppHandle, webview: Webview, conversation_id: String) -> Result<(), String> {
    ensure_caller(&webview)?;
    let _guard = TRANSFERS.lock().await;
    let entry = registry().lock().map_err(|_| "Mission window state is unavailable.")?.values().find(|entry| entry.transfer.conversation_id == conversation_id).cloned();
    let Some(mut entry) = entry else { return Ok(()); };
    if webview.label() != MAIN && webview.label() != entry.transfer.window_label { return Err("Another mission cannot be discarded from this window.".into()); }
    if let Some(window) = app.get_webview_window(&entry.transfer.window_label) { window.destroy().map_err(|_| "The deleted mission window could not be closed.")?; }
    registry().lock().map_err(|_| "Mission window state is unavailable.")?.remove(&entry.transfer.window_label);
    crate::browser::close_owned_for_window(&app, &entry.transfer.window_label);
    entry.transfer.revision = next_revision(); entry.transfer.snapshot = None;
    publish(&app, "discarded", entry.transfer, None);
    Ok(())
}

/// Returns true only when the host must prevent native closure. Popup windows
/// deliberately bypass this function's mission policy and close normally.
pub fn request_close(app: &tauri::AppHandle, label: &str) -> bool {
    let Ok(entry) = get_entry(label) else { return false; };
    if entry.transfer.state == Placement::Detached {
        let _ = app.emit_to(label, EVENT, MissionEvent { kind: "attach-requested".into(), transfer: entry.transfer, registered: true, error: None });
    }
    true
}

/// Shared by the real application and the native regression fixture. Closing a
/// view never requests process exit or shuts down the application's sidecar.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == MAIN {
            api.prevent_close();
            let _ = window.hide();
        } else if request_close(window.app_handle(), window.label()) {
            api.prevent_close();
        }
    } else if matches!(event, tauri::WindowEvent::Destroyed) {
        window_destroyed(window.app_handle(), window.label());
    }
}

pub fn window_destroyed(app: &tauri::AppHandle, label: &str) {
    // Unexpected OS destruction must release trust and retain a recovery
    // snapshot in the failure event. Normal ACK removes the entry first/under
    // the same transfer lock, so this queued task becomes a no-op.
    let app = app.clone(); let label = label.to_string();
    tauri::async_runtime::spawn(async move {
        let _guard = TRANSFERS.lock().await;
        let entry = registry().lock().ok().and_then(|mut entries| entries.remove(&label));
        if let Some(entry) = entry {
            crate::browser::close_owned_for_window(&app, &label);
            publish(&app, "failed", entry.transfer, Some("The mission window closed unexpectedly. Its last transferred draft remains recoverable.".into()));
        }
    });
}

fn allowed_app_navigation(origin: &tauri::Url, target: &tauri::Url) -> bool {
    // Custom tauri:// origins are opaque to url::Origin. Compare the actual
    // scheme/authority, never two newly generated opaque origin identifiers.
    target.scheme() == origin.scheme() && target.host_str() == origin.host_str()
        && target.port_or_known_default() == origin.port_or_known_default()
        && matches!(target.path(), "/" | "/index.html")
        && target.query_pairs().any(|(key, value)| key == "missionWindow" && value == "1")
}

#[cfg(feature = "native-browser-smoke")]
#[allow(dead_code)]
pub fn register_smoke_interface(label: &str) {
    assert!(safe_id(label) && label != MAIN);
    registry().lock().unwrap().insert(label.into(), Entry { transfer: MissionTransfer {
        window_label: label.into(), project_id: Some("smoke-project".into()), conversation_id: label.into(), revision: next_revision(),
        state: Placement::Detached, snapshot: None,
    }, preparing: false });
}

#[cfg(feature = "native-browser-smoke")]
#[allow(dead_code)]
pub fn unregister_smoke_interface(label: &str) { registry().lock().unwrap().remove(label); }

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> Value { serde_json::json!({"version":1,"projectId":"project-1","conversationId":"conversation-1","composer":{"text":"unsent"}}) }
    fn entry(state: Placement) -> Entry { Entry { transfer: MissionTransfer { window_label:"mission-test".into(),project_id:Some("project-1".into()),conversation_id:"conversation-1".into(),revision:4,state,snapshot:Some(snapshot()) }, preparing:false } }
    #[test]
    fn snapshots_are_versioned_bounded_and_bound_to_conversation() {
        assert!(validate_snapshot(&snapshot(),Some("project-1"),"conversation-1").is_ok());
        assert!(validate_snapshot(&snapshot(),Some("other"),"conversation-1").is_err());
        assert!(validate_snapshot(&snapshot(),Some("project-1"),"other").is_err());
        let mut value=snapshot(); value["version"]=2.into(); assert!(validate_snapshot(&value,Some("project-1"),"conversation-1").is_err());
        value=snapshot(); value["composer"]["text"]="x".repeat(MAX_SNAPSHOT_BYTES).into(); assert!(validate_snapshot(&value,Some("project-1"),"conversation-1").is_err());
        assert!(validate_snapshot(&Value::Null,Some("project-1"),"conversation-1").is_err());
    }
    #[test]
    fn identity_and_revision_checks_fail_closed() {
        for value in ["", "../mission", "a?b", "project with spaces"] { assert!(!safe_id(value)); }
        assert!(safe_id("a_123-Z"));
        assert!(check_revision(&entry(Placement::Opening),4,Placement::Opening).is_ok());
        assert!(check_revision(&entry(Placement::Opening),3,Placement::Opening).is_err());
        assert!(check_revision(&entry(Placement::Attaching),4,Placement::Opening).is_err());
        let mut preparing=entry(Placement::Opening); preparing.preparing=true; assert!(check_revision(&preparing,4,Placement::Opening).is_err());
    }
    #[test]
    fn home_snapshots_and_local_app_navigation_are_supported() {
        let mut value=snapshot(); value["projectId"]=Value::Null;
        assert!(validate_snapshot(&value,None,"conversation-1").is_ok());
        assert!(validate_snapshot(&value,Some("project-1"),"conversation-1").is_err());
        value.as_object_mut().unwrap().remove("projectId");
        assert!(validate_snapshot(&value,None,"conversation-1").is_err());
        for base in ["tauri://localhost/", "http://tauri.localhost/", "http://localhost:4201/"] {
            let origin=tauri::Url::parse(base).unwrap();
            assert!(allowed_app_navigation(&origin,&origin.join("index.html?missionWindow=1").unwrap()));
            assert!(!allowed_app_navigation(&origin,&origin.join("index.html").unwrap()));
            assert!(!allowed_app_navigation(&origin,&tauri::Url::parse("https://example.org/?missionWindow=1").unwrap()));
            assert!(!allowed_app_navigation(&origin,&origin.join("evil.html?missionWindow=1").unwrap()));
        }
    }
    #[test]
    fn closed_browser_identity_does_not_trigger_native_transfer() {
        let mut transfer=entry(Placement::Opening).transfer;
        transfer.snapshot.as_mut().unwrap()["workspace"]=serde_json::json!({"browserOwnerId":"existing-owner","browserOpen":false});
        assert_eq!(browser_owner(&transfer),None);
        transfer.snapshot.as_mut().unwrap()["workspace"]["browserOpen"]=true.into();
        assert_eq!(browser_owner(&transfer),Some("existing-owner"));
    }
    #[test]
    fn exact_registered_interfaces_only_and_no_global_commands() {
        let mut item=entry(Placement::Detached); item.transfer.window_label="mission-unit-permissions".into();
        registry().lock().unwrap().insert(item.transfer.window_label.clone(),item);
        assert!(is_trusted_interface("main")); assert!(is_trusted_interface("mission-unit-permissions"));
        assert!(!is_trusted_interface("mission-unregistered")); assert!(!is_trusted_interface("native-browser-mission-unit-permissions"));
        for cmd in ["restart_app","set_tray_labels","desktop_notify","mission_window_detach","mission_window_ack"] { assert!(!permits_command("mission-unit-permissions",cmd)); }
        assert!(permits_command("mission-unit-permissions","browser_capture"));
        registry().lock().unwrap().remove("mission-unit-permissions"); assert!(!is_trusted_interface("mission-unit-permissions"));
    }
}
