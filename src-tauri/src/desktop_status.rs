//! Main-interface-only system status. Never changes display sleep or system settings.
use serde::Serialize;
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::process::{Child, Command, Stdio};

#[derive(Default)]
pub struct DesktopStatus {
    #[cfg(target_os = "macos")]
    inhibitor: Mutex<Option<Child>>,
    #[cfg(target_os = "windows")]
    worker: Mutex<Option<WindowsAwake>>,
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    unused: Mutex<()>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    awake: bool,
}
#[cfg(target_os = "macos")]
impl Drop for DesktopStatus {
    fn drop(&mut self) {
        if let Ok(child) = self.inhibitor.get_mut() {
            if let Some(mut child) = child.take() { let _ = child.kill(); let _ = child.wait(); }
        }
    }
}
#[tauri::command]
pub async fn desktop_system_status(state: tauri::State<'_, DesktopStatus>) -> Result<Status, String> {
    #[cfg(target_os = "macos")]
    {
        let awake = {
            let mut child = state.inhibitor.lock().map_err(|_| "status unavailable")?;
            let running = match child.as_mut() { Some(child) => matches!(child.try_wait(), Ok(None)), None => false };
            if !running { *child = None; }
            running
        };
        Ok(Status { supported: true, awake })
    }
    #[cfg(target_os = "windows")]
    {
        let worker = state.worker.lock().map_err(|_| "status unavailable")?;
        Ok(Status { supported: true, awake: worker.as_ref().is_some_and(|worker| worker.thread.as_ref().is_some_and(|thread| !thread.is_finished())) })
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _guard = state.unused.lock().map_err(|_| "status unavailable")?; Ok(Status { supported: false, awake: false }) }
}
#[tauri::command]
pub fn desktop_set_awake(state: tauri::State<'_, DesktopStatus>, enabled: bool) -> Result<(), String> {
    set_awake(&state, enabled)
}
fn set_awake(state: &DesktopStatus, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = state.inhibitor.lock().map_err(|_| "status unavailable")?;
        if let Some(mut current) = child.take() {
            if enabled && matches!(current.try_wait(), Ok(None)) { *child = Some(current); return Ok(()); }
            let _ = current.kill(); let _ = current.wait();
        }
        if enabled {
            // -i prevents idle system sleep, not display sleep; -w releases the
            // assertion even after a crash when this native process exits.
            *child = Some(Command::new("/usr/bin/caffeinate")
                .args(["-i", "-w", &std::process::id().to_string()])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().map_err(|_| "keep awake unavailable")?);
        }
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        let mut worker = state.worker.lock().map_err(|_| "status unavailable")?;
        if enabled {
            if worker.as_ref().is_some_and(|worker| worker.thread.as_ref().is_some_and(|thread| !thread.is_finished())) { return Ok(()); }
            *worker = Some(WindowsAwake::start()?);
        } else { *worker = None; }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = (state, enabled); Err("keep awake is unsupported on this platform".into()) }
}

// Windows assertions are thread-owned. A dedicated thread both acquires and
// releases the assertion; dropping the state joins it before disposal finishes.
#[cfg(target_os = "windows")]
struct WindowsAwake {
    stop: std::sync::mpsc::Sender<()>,
    thread: Option<std::thread::JoinHandle<()>>,
}
#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
extern "system" { fn SetThreadExecutionState(flags: u32) -> u32; }
#[cfg(target_os = "windows")]
impl WindowsAwake {
    fn start() -> Result<Self, String> {
        let (stop, stopped) = std::sync::mpsc::channel();
        let (ready, readiness) = std::sync::mpsc::sync_channel(1);
        let thread = std::thread::Builder::new().name("specrails-awake".into()).spawn(move || {
            // ES_CONTINUOUS | ES_SYSTEM_REQUIRED, deliberately no display lock.
            let acquired = unsafe { SetThreadExecutionState(0x80000001) } != 0;
            let _ = ready.send(acquired);
            if acquired {
                let _ = stopped.recv();
                unsafe { SetThreadExecutionState(0x80000000); }
            }
        }).map_err(|_| "keep awake unavailable")?;
        let worker = Self { stop, thread: Some(thread) };
        if readiness.recv().unwrap_or(false) { Ok(worker) } else { Err("keep awake unavailable".into()) }
    }
}
#[cfg(target_os = "windows")]
impl Drop for WindowsAwake {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(thread) = self.thread.take() { let _ = thread.join(); }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn disposal_releases_the_owned_caffeinate_process() {
        let state = DesktopStatus::default();
        set_awake(&state, true).unwrap();
        let pid = state.inhibitor.lock().unwrap().as_ref().unwrap().id();
        drop(state);
        let output = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "pid="]).output().unwrap();
        assert!(!output.status.success());
    }
    #[test]
    fn awake_starts_disabled_and_toggle_is_idempotent() {
        let state = DesktopStatus::default();
        assert!(state.inhibitor.lock().unwrap().is_none());
        set_awake(&state, true).unwrap();
        let pid = state.inhibitor.lock().unwrap().as_ref().unwrap().id();
        set_awake(&state, true).unwrap();
        assert_eq!(state.inhibitor.lock().unwrap().as_ref().unwrap().id(), pid);
        set_awake(&state, false).unwrap();
        assert!(state.inhibitor.lock().unwrap().is_none());
        set_awake(&state, false).unwrap();
    }
}
