mod browser;
mod invoke_guard;
mod backend_health;

use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;
use tauri::Emitter;
use tauri::{RunEvent, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

const SERVER_PORT: u16 = 4200;
const HEALTH_URL: &str = "http://127.0.0.1:4200/api/health";
const HEALTH_TIMEOUT_SECS: u64 = 30;

/// Check whether a TCP port is currently free (bind succeeds → free).
fn check_port_available(port: u16) -> bool {
    TcpListener::bind(format!("127.0.0.1:{}", port)).is_ok()
}

fn wait_for_port_available(port: u16, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if check_port_available(port) {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A substring that must appear in the sidecar process's command line / image
/// before we are willing to signal a PID. The sidecar is the bundled
/// `specrails-server` binary, always launched with a `--parent-pid=<host pid>`
/// argument (see the spawn site below). Both anchors are checked so a recycled
/// PID belonging to unrelated user software is never killed (BUG-TAURI-02).
const SIDECAR_PROCESS_MARKER: &str = "specrails-server";

#[cfg(any(unix, test))]
fn sidecar_command_matches(command: &str, parent_pid: u32) -> bool {
    command.contains(SIDECAR_PROCESS_MARKER)
        && command.split_whitespace().any(|arg| arg == format!("--parent-pid={parent_pid}"))
}

#[cfg(any(windows, test))]
fn sidecar_tasklist_matches(row: &str, pid: u32) -> bool {
    let mut fields = row.trim().split(',');
    let image = fields.next().unwrap_or_default().trim_matches('"').to_ascii_lowercase();
    let observed_pid = fields.next().unwrap_or_default().trim_matches('"');
    let image_matches = image == "specrails-server.exe"
        || (image.starts_with("specrails-server-") && image.ends_with(".exe"));
    image_matches && observed_pid == pid.to_string()
}

/// Verify that the live process holding `pid` is actually our sidecar before we
/// signal it. The stored PID is captured once at spawn and could, after an early
/// sidecar exit, be recycled by the OS for an unrelated process. We therefore
/// confirm identity from the OS process table (image name / command line) rather
/// than trusting the bare PID. Returns `true` only when the running process is
/// recognisably the sidecar; `false` when it is dead, recycled, or unverifiable.
#[cfg(unix)]
fn pid_is_sidecar(pid: u32) -> bool {
    use std::process::Command;
    // `ps -o command= -p <pid>` prints only the full command line (no header).
    // An empty/failed result means the PID is not alive or not inspectable.
    let cmdline = Command::new("ps")
        .args(["-ww", "-o", "command=", "-p", &pid.to_string()])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if cmdline.is_empty() {
        return false;
    }
    // Require both anchors, with an exact handshake token: a reused PID for
    // another Specrails instance or a parent-pid prefix must never be signalled.
    sidecar_command_matches(&cmdline, std::process::id())
}

#[cfg(windows)]
fn pid_is_sidecar(pid: u32) -> bool {
    use std::process::Command;
    // `tasklist /FI "PID eq <pid>" /FO CSV /NH` yields a CSV row whose first
    // field is the image name. We confirm both that the PID is alive (a row is
    // returned) and that its image name matches the sidecar before tree-killing,
    // so a recycled PID for unrelated software is never force-killed.
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
        .output()
        .ok();
    let row = match out {
        Some(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return false,
    };
    // No matching task prints an INFO line. A generic `.exe` suffix is not
    // identity evidence: it used to authorize killing any recycled Windows PID.
    sidecar_tasklist_matches(&row, pid)
}

/// Kill a child process — SIGTERM on Unix with SIGKILL fallback, taskkill on Windows.
///
/// Guarded by an identity check (`pid_is_sidecar`) so a stale/recycled PID is
/// never signalled (BUG-TAURI-02): if the process holding the PID is dead or is
/// no longer recognisable as our sidecar, we bail without sending any signal.
#[cfg(unix)]
fn terminate_process(pid: u32) {
    use std::process::Command;
    // Identity gate: never signal a recycled/unrelated PID.
    if !pid_is_sidecar(pid) {
        return;
    }
    // Send SIGTERM first
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .output();

    // Wait up to 5s for graceful exit, then SIGKILL
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        std::thread::sleep(Duration::from_millis(200));
        // Check if still alive by sending signal 0
        let alive = Command::new("kill")
            .args(["-0", &pid.to_string()])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !alive {
            break;
        }
        if Instant::now() >= deadline {
            // Re-verify identity before the irrecoverable SIGKILL: between the
            // initial check and now the sidecar could have exited and the PID
            // been recycled. Only force-kill if it is still our process.
            if pid_is_sidecar(pid) {
                let _ = Command::new("kill")
                    .args(["-KILL", &pid.to_string()])
                    .output();
            }
            break;
        }
    }
}

#[cfg(windows)]
fn terminate_process(pid: u32) {
    use std::process::Command;
    // Identity gate: never force-kill a recycled/unrelated PID's whole tree.
    if !pid_is_sidecar(pid) {
        return;
    }
    // Windows Node cannot catch a graceful termination signal (taskkill /F issues
    // a non-catchable TerminateProcess), so there is no point POSTing to a
    // shutdown route. Kill the whole process tree (/T) so the node sidecar AND its
    // children (claude/codex rails, node-pty shells) are reaped — without /T the
    // node process dies but its children are orphaned and keep file/DB locks.
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();

    // Best-effort wait so the caller can rely on port 4200 having been released.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let alive = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false);
        if !alive || Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Shared handle to the spawned sidecar PID, exposed to commands via managed state.
struct SidecarState {
    pid: Arc<Mutex<Option<u32>>>,
    stopping: Arc<AtomicBool>,
}

/// Retire only the process generation that exited. Return whether the user
/// should see a disconnection, suppressing planned quit/update teardown.
fn record_sidecar_exit(pid_state: &Mutex<Option<u32>>, stopping: &AtomicBool, exited_pid: u32) -> bool {
    if let Ok(mut current) = pid_state.lock() {
        if *current == Some(exited_pid) {
            *current = None;
            return !stopping.load(Ordering::SeqCst);
        }
    }
    false
}

/// Stable id for the single system-tray / menu-bar item, used to retrieve and
/// relabel the tray at runtime via `set_tray_labels`.
const TRAY_ID: &str = "main-tray";

/// Runtime handle to the live tray icon so the `set_tray_labels` IPC command can
/// rebuild its menu in the user's active UI language without restarting the app.
struct TrayState {
    tray: Mutex<Option<tauri::tray::TrayIcon>>,
}

/// Actions a tray menu item can trigger. Extracted as a pure mapping so the
/// id → action dispatch is unit-testable without a live event loop.
#[derive(Debug, PartialEq, Eq)]
enum TrayAction {
    Open,
    Exit,
    Unknown,
}

/// Pure mapping from a tray menu item id to the action it triggers. The tray's
/// `on_menu_event` closure (which DOES need a live app handle) delegates here so
/// the routing logic itself can be tested headlessly.
fn tray_action_for_id(id: &str) -> TrayAction {
    match id {
        "open" => TrayAction::Open,
        "exit" => TrayAction::Exit,
        _ => TrayAction::Unknown,
    }
}

/// Terminate the sidecar (if still running) using the identity-gated kill
/// primitive. Shared by the tray "Exit" path and the true-quit
/// `RunEvent::ExitRequested` hook so both reap the sidecar identically.
///
/// Idempotent: `terminate_process` no-ops when the PID is `None` (the
/// `CommandEvent::Terminated` handler nulled it) or when `pid_is_sidecar`
/// rejects a recycled/unrelated PID — so calling this twice (tray Exit then the
/// `ExitRequested` fired by `app.exit(0)`) is safe.
fn shutdown_sidecar(state: &SidecarState) {
    state.stopping.store(true, Ordering::SeqCst);
    let pid = *state.pid.lock().unwrap();
    if let Some(pid) = pid {
        terminate_process(pid);
    }
}

/// Rebuild the tray menu with new "Open"/"Exit" labels. Invoked from the client
/// on startup and on every UI-language change so the menu matches the active
/// language. Builds a fresh `Menu` each call (menu item text is not mutated in
/// place) and swaps it onto the live tray via `set_menu`.
#[tauri::command]
fn set_tray_labels(
    app: tauri::AppHandle,
    tray: tauri::State<'_, TrayState>,
    open: String,
    exit: String,
) -> Result<(), String> {
    let guard = tray.tray.lock().map_err(|e| e.to_string())?;
    let Some(tray_icon) = guard.as_ref() else {
        return Err("tray not initialized".to_string());
    };
    let open_i = MenuItem::with_id(&app, "open", &open, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let exit_i = MenuItem::with_id(&app, "exit", &exit, true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let menu =
        Menu::with_items(&app, &[&open_i, &exit_i]).map_err(|e| e.to_string())?;
    tray_icon.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Show, unminimize, and focus the main window. Used by the tray "Open" menu
/// item, the tray-icon left click, and the single-instance relaunch callback.
/// `unminimize` runs before `set_focus` so a hidden-then-minimized window is
/// always brought back to the front.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Cleanly restart the desktop app after a self-update.
///
/// The naive path — calling plugin-process `relaunch()` from the frontend —
/// races: Tauri's `restart()` exits the host WITHOUT firing `CloseRequested`
/// (so the sidecar is never terminated by us) and relaunches immediately, while
/// the old Node sidecar is still listening on port 4200. The freshly-launched
/// instance then fails its startup port check and the user has to restart a
/// second time. This command closes that race: it terminates the current
/// sidecar (and its process tree), waits until port 4200 is actually free, and
/// only THEN restarts — so the new instance always finds a clean port.
#[tauri::command]
fn restart_app(app: tauri::AppHandle, sidecar: tauri::State<'_, SidecarState>) {
    if sidecar.stopping.swap(true, Ordering::SeqCst) {
        return;
    }
    let pid = *sidecar.pid.lock().unwrap();
    let stopping = Arc::clone(&sidecar.stopping);
    // Run off the command thread so the `invoke` resolves immediately and the UI
    // stays responsive while the (up to several second) teardown happens.
    std::thread::spawn(move || {
        if let Some(pid) = pid {
            terminate_process(pid);
        }
        // The Node server holds the port; it may take a moment to release after
        // SIGTERM/taskkill. Never launch a new host into an occupied port: that
        // previously turned a delayed shutdown into a broken update relaunch.
        if !wait_for_port_available(SERVER_PORT, Duration::from_secs(8)) {
            stopping.store(false, Ordering::SeqCst);
            app.dialog()
                .message("The local server has not released port 4200 yet. Specrails has not restarted. Wait a moment and try Restart again.")
                .title("Specrails — Restart delayed")
                .blocking_show();
            return;
        }
        app.restart();
    });
}

pub fn run() {
    // Shared, captured by `move` into the setup closure; exposed to commands via
    // SidecarState. The window-close handler no longer needs the PID (close now
    // hides to tray); sidecar termination runs from the tray Exit path and the
    // true-quit `RunEvent::ExitRequested` hook, which read SidecarState.
    let sidecar_pid: Arc<Mutex<Option<u32>>> = Arc::new(Mutex::new(None));
    let sidecar_stopping = Arc::new(AtomicBool::new(false));

    tauri::Builder::default()
        // Single-instance MUST be registered FIRST so a second launch focuses the
        // existing window before any sidecar can spawn — never contending port 4200.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(|invoke| invoke_guard::dispatch(invoke, tauri::generate_handler![
            restart_app,
            set_tray_labels,
            browser::browser_supported,
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_close,
            browser::browser_devtools,
            browser::browser_zoom,
            browser::browser_capture_supported,
            browser::browser_set_select_mode,
            browser::browser_selection,
            browser::browser_capture
        ]))
        .setup(move |app| {
            let app_handle = app.handle().clone();

            // Expose the sidecar PID to the `restart_app` command, the tray Exit
            // handler, and the `RunEvent::ExitRequested` quit hook.
            app.manage(SidecarState {
                pid: Arc::clone(&sidecar_pid),
                stopping: Arc::clone(&sidecar_stopping),
            });

            // --- Port conflict check (with a grace window) ---
            // Run this BEFORE showing/maximizing the window so a conflict bails
            // out cleanly. During a self-update relaunch (or a quick quit→reopen)
            // the previous sidecar may still be releasing port 4200 for a second
            // or two; retry for a grace window instead of an immediate fatal
            // failure that would force the user to restart a second time.
            if !wait_for_port_available(SERVER_PORT, Duration::from_secs(10)) {
                app_handle
                    .dialog()
                    .message("Port 4200 is already in use by another process. Close it and reopen Specrails.")
                    .title("Specrails — Port Conflict")
                    .blocking_show();
                std::process::exit(1);
            }

            // --- Force the main window to open maximized ---
            // tauri.conf.json sets `maximized: true`, but macOS's window-state
            // restoration can override that on subsequent launches. This explicit
            // call guarantees the window fills the screen every time.
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.maximize();
            }

            // --- System tray / menu-bar item ---
            // Built BEFORE the sidecar spawn so the tray is present at launch
            // independent of the server. Labels default to English; the client
            // pushes the active-language labels via `set_tray_labels` on startup
            // and on every language change. The icon comes from the configured
            // bundle icon (tauri.conf.json `bundle.icon`) — no separate tray asset.
            // We deliberately do NOT set ActivationPolicy::Accessory, so macOS
            // keeps the regular Dock presence.
            let open_i = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let exit_i = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_i, &exit_i])?;
            // macOS: a monochrome TEMPLATE icon (black + alpha) so the menu bar
            // tints it white/dark like native items. Other platforms keep the
            // colored app icon (a white glyph would vanish on light taskbars).
            #[cfg(target_os = "macos")]
            let tray_icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))
                .expect("bundled tray-icon.png must decode");
            #[cfg(not(target_os = "macos"))]
            let tray_icon = app.default_window_icon().unwrap().clone();
            let tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(tray_icon)
                .icon_as_template(cfg!(target_os = "macos"))
                .menu(&tray_menu)
                .tooltip("Specrails")
                .on_menu_event(|app, event| match tray_action_for_id(event.id.as_ref()) {
                    TrayAction::Open => show_main_window(app),
                    TrayAction::Exit => {
                        // Terminate the sidecar, then quit. `app.exit(0)` also
                        // fires `RunEvent::ExitRequested`, which calls
                        // `shutdown_sidecar` again — idempotent by design.
                        let state = app.state::<SidecarState>();
                        shutdown_sidecar(&state);
                        app.exit(0);
                    }
                    TrayAction::Unknown => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            app.manage(TrayState {
                tray: Mutex::new(Some(tray)),
            });

            // --- Spawn sidecar ---
            let parent_pid_arg = format!("--parent-pid={}", std::process::id());

            // Resolve the bundled runtimes path from Tauri's resource directory.
            // On macOS: <app>.app/Contents/Resources/runtimes
            // On Windows: <install-dir>/resources/runtimes
            let runtimes_path = app_handle
                .path()
                .resource_dir()
                .ok()
                .map(|p| p.join("runtimes").to_string_lossy().into_owned())
                .unwrap_or_default();

            // Only enter desktop bundled-runtimes mode when a bundled Node binary is
            // actually present (not just a `.gitkeep` placeholder). A build that ships
            // no runtimes (e.g. an architecture without bundled binaries, or a corrupted
            // resource copy) then runs as a normal server: the sidecar's path-resolver /
            // setup-prerequisites fall back to system PATH discovery instead of
            // dead-ending Add Project with a "bundle corrupted" error the user can't fix.
            let runtimes_root = std::path::Path::new(&runtimes_path);
            let has_runtimes = runtimes_root.join("node").join("bin").join("node").exists()
                || runtimes_root.join("node").join("node.exe").exists();

            let sidecar = app_handle
                .shell()
                .sidecar("specrails-server")
                .map_err(|error| {
                    app_handle.dialog()
                        .message(format!("The bundled local server could not be found: {error}. Reinstall Specrails; your saved projects remain on disk."))
                        .title("Specrails — Startup Error")
                        .blocking_show();
                    error
                })?
                .args([&parent_pid_arg]);
            let sidecar = if has_runtimes {
                // Bundled node/git win: server/path-resolver.ts prepends the bundled bin
                // dirs ahead of the macOS login-shell PATH set below, so a system
                // homebrew/nvm node or git can never shadow the bundled runtimes.
                sidecar
                    .env("SPECRAILS_IS_DESKTOP", "1")
                    .env("SPECRAILS_BUNDLED_RUNTIMES_PATH", &runtimes_path)
            } else {
                sidecar
            };

            // Resolve the bundled specrails-core path from Tauri's resource directory
            // (mirrors the runtimes resolution above: lib.rs:181-215). The bundled
            // core lets the setup wizard materialize + assemble the framework OFFLINE
            // (no `npx specrails-core` network round-trip).
            //   On macOS:   <app>.app/Contents/Resources/core
            //   On Windows: <install-dir>/resources/core
            let core_path = app_handle
                .path()
                .resource_dir()
                .ok()
                .map(|p| p.join("core").to_string_lossy().into_owned())
                .unwrap_or_default();

            // EXISTENCE-GATE the bundled core exactly like the runtimes: only export
            // SPECRAILS_BUNDLED_CORE_PATH when the compiled CLI actually exists on disk
            // (not just a `.gitkeep` placeholder). When absent, the env is never set so
            // server/bundled-core.ts returns null and setup-manager falls back to the
            // legacy `npx specrails-core init` path — never dead-ending.
            let core_root = std::path::Path::new(&core_path);
            let has_core = core_root
                .join("dist")
                .join("installer")
                .join("cli.js")
                .exists();
            let sidecar = if has_core {
                sidecar.env("SPECRAILS_BUNDLED_CORE_PATH", &core_path)
            } else {
                sidecar
            };

            // Resolve the bundled @fission-ai/openspec path from Tauri's resource
            // directory (mirrors the bundled-core block above). The bundled openspec
            // is the LAST network step of project-add: when present, the bundled-core
            // init runs `openspec init` from this tree instead of `npx`, making
            // project-add FULLY OFFLINE.
            //   On macOS:   <app>.app/Contents/Resources/openspec
            //   On Windows: <install-dir>/resources/openspec
            // openspec ships as an `npm install`ed tree (it has runtime deps), so the
            // CLI entry lives at openspec/node_modules/@fission-ai/openspec/bin/openspec.js.
            let openspec_path = app_handle
                .path()
                .resource_dir()
                .ok()
                .map(|p| p.join("openspec").to_string_lossy().into_owned())
                .unwrap_or_default();

            // EXISTENCE-GATE on the CLI entry exactly like the bundled core: only
            // export SPECRAILS_BUNDLED_OPENSPEC_PATH when the openspec CLI node entry
            // actually exists on disk (not just a `.gitkeep` placeholder). When absent
            // the env is never set so server/bundled-openspec.ts returns null and the
            // bundled-core init falls back to `npx @fission-ai/openspec` — never
            // dead-ending.
            let openspec_root = std::path::Path::new(&openspec_path);
            let has_openspec = openspec_root
                .join("node_modules")
                .join("@fission-ai")
                .join("openspec")
                .join("bin")
                .join("openspec.js")
                .exists();
            let sidecar = if has_openspec {
                sidecar.env("SPECRAILS_BUNDLED_OPENSPEC_PATH", &openspec_path)
            } else {
                sidecar
            };

            // Resolve the bundled user-guide docs path from Tauri's resource
            // directory (mirrors the bundled-core block above). The Documentation
            // panel serves these language-aware Markdown files; server/docs-router.ts
            // reads SPECRAILS_BUNDLED_DOCS_PATH (expecting a `guide/` subdir).
            // The docs are declared as `../docs/guide/**/*` in tauri.conf.json, so
            // Tauri places them under `<resource_dir>/_up_/docs/guide` (the `_up_`
            // segment is how Tauri preserves a parent-relative resource path). We
            // try that layout first, then a plain `<resource_dir>/docs` fallback.
            //   On macOS:   <app>.app/Contents/Resources/_up_/docs
            //   On Windows: <install-dir>/resources/_up_/docs
            let resource_dir = app_handle.path().resource_dir().ok();
            let docs_path = resource_dir.as_ref().and_then(|rd| {
                let up = rd.join("_up_").join("docs");
                if up.join("guide").is_dir() {
                    return Some(up.to_string_lossy().into_owned());
                }
                let plain = rd.join("docs");
                if plain.join("guide").is_dir() {
                    return Some(plain.to_string_lossy().into_owned());
                }
                None
            });
            let sidecar = if let Some(ref docs_path) = docs_path {
                sidecar.env("SPECRAILS_BUNDLED_DOCS_PATH", docs_path)
            } else {
                sidecar
            };

            // Resolve the bundled specrails-mcp stdio bridge from Tauri's resource
            // directory (mirrors the blocks above). Without this env the sidecar's
            // resolveBridgeScript() falls back to a repo-relative climb
            // (src-tauri/binaries/specrails-mcp.js) that only exists in dev — in the
            // packaged .app it returns null, so the in-app agent chat spawns WITHOUT
            // --mcp-config and can't see any specrails_* tools. The bridge JS is
            // declared as `binaries/specrails-mcp.js` in tauri.conf.json.
            //   On macOS:   <app>.app/Contents/Resources/binaries/specrails-mcp.js
            //   On Windows: <install-dir>/resources/binaries/specrails-mcp.js
            let mcp_bridge_path = app_handle
                .path()
                .resource_dir()
                .ok()
                .map(|p| {
                    p.join("binaries")
                        .join("specrails-mcp.js")
                        .to_string_lossy()
                        .into_owned()
                })
                .unwrap_or_default();

            // EXISTENCE-GATE exactly like the bundled core/openspec: only export the
            // env when the bridge JS actually exists on disk, so a build that somehow
            // shipped without it falls back to the relative climb rather than pointing
            // the server at a non-existent file.
            let sidecar = if std::path::Path::new(&mcp_bridge_path).exists() {
                sidecar.env("SPECRAILS_BUNDLED_MCP_BRIDGE_PATH", &mcp_bridge_path)
            } else {
                sidecar
            };

            // On macOS, GUI apps launched from Finder/Dock inherit a minimal PATH
            // from launchd that omits user tool dirs (homebrew, cargo, bun,
            // ~/.local/bin). We rebuild PATH from a zsh login shell and prepend
            // well-known locations so tools like `claude` are found.
            //
            // On Windows and Linux, GUI apps inherit the user's PATH correctly
            // from Explorer / the desktop environment, so we do NOT override —
            // any override here would be POSIX-only garbage and hide real tools.
            #[cfg(target_os = "macos")]
            let sidecar = {
                let home = dirs_next::home_dir()
                    .unwrap_or_else(|| std::path::PathBuf::from("/tmp"));
                let home_s = home.to_string_lossy();

                // zsh login PATH (covers nvm, pyenv, etc. configured in .zshrc)
                let zsh_path = std::process::Command::new("/bin/zsh")
                    .args(["-l", "-c", "echo $PATH"])
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_default();

                let prepend = format!(
                    "{home}/.local/bin:{home}/.bun/bin:{home}/.cargo/bin:\
                     /opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin",
                    home = home_s
                );

                let base = if zsh_path.is_empty() {
                    "/usr/bin:/bin:/usr/sbin:/sbin".to_string()
                } else {
                    zsh_path
                };
                let shell_path = format!("{prepend}:{base}");

                sidecar.env("PATH", &shell_path)
            };

            let (mut rx, child) = sidecar
                .spawn()
                .map_err(|error| {
                    app_handle.dialog()
                        .message(format!("The local server could not start: {error}. Your saved projects remain on disk."))
                        .title("Specrails — Startup Error")
                        .blocking_show();
                    error
                })?;

            let pid = child.pid();
            *sidecar_pid.lock().unwrap() = Some(pid);

            // Drain sidecar stdout/stderr to prevent pipe buffer blocking.
            // Write to ~/Library/Logs/Specrails/sidecar.log for diagnostics.
            let log_path = dirs_next::home_dir()
                .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
                .join("Library/Logs/Specrails/sidecar.log");
            if let Some(parent) = log_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            // Clear the stored PID when the sidecar terminates so a later
            // window-close / restart_app never signals a stale (possibly
            // OS-recycled) PID — the second half of the BUG-TAURI-02 guard.
            let terminated_pid_state = Arc::clone(&sidecar_pid);
            let terminated_stopping = Arc::clone(&sidecar_stopping);
            let terminated_app = app_handle.clone();
            let readiness_log_path = log_path.clone();
            std::thread::spawn(move || {
                use tauri_plugin_shell::process::CommandEvent;
                use std::io::Write;
                let mut log = std::fs::OpenOptions::new()
                    .create(true).append(true).open(&log_path).ok();
                while let Some(event) = rx.blocking_recv() {
                    let mut unexpected_exit = false;
                    let line = match event {
                        CommandEvent::Stdout(b) => format!("[OUT] {}\n", String::from_utf8_lossy(&b)),
                        CommandEvent::Stderr(b) => format!("[ERR] {}\n", String::from_utf8_lossy(&b)),
                        CommandEvent::Error(e)  => format!("[TAURI_ERR] {}\n", e),
                        CommandEvent::Terminated(s) => {
                            // Forget the PID: the sidecar is gone and its PID may
                            // be reassigned by the OS to unrelated software.
                            unexpected_exit = record_sidecar_exit(&terminated_pid_state, &terminated_stopping, pid);
                            format!("[EXIT] code={:?}\n", s.code)
                        }
                        _ => continue,
                    };
                    if let Some(f) = log.as_mut() { let _ = f.write_all(line.as_bytes()); }
                    if unexpected_exit {
                        let detail = format!(
                            "The local Specrails server stopped unexpectedly. Your saved projects remain on disk. Restart Specrails to reconnect. Diagnostics: {}",
                            log_path.display()
                        );
                        let _ = terminated_app.emit("specrails:backend-unavailable", &detail);
                        terminated_app.dialog()
                            .message(detail)
                            .title("Specrails — Server disconnected")
                            .show(|_| {});
                    }
                }
            });

            // --- Readiness monitor (runs off the UI thread) ---
            // Cold starts can take longer than 30s while migrations/recovery run.
            // A timeout is not proof of process failure: keep monitoring and let
            // the frontend retry authentication rather than killing a healthy
            // slow-starting server and presenting an apparently empty registry.
            let app_handle2 = app_handle.clone();
            let readiness_pid = Arc::clone(&sidecar_pid);
            let readiness_stopping = Arc::clone(&sidecar_stopping);
            std::thread::spawn(move || {
                use backend_health::{wait_for_backend, BackendReadiness};
                use std::io::Write;
                let mut reported_delay = false;
                loop {
                    let readiness = wait_for_backend(
                        HEALTH_URL,
                        Duration::from_secs(HEALTH_TIMEOUT_SECS),
                        || !readiness_stopping.load(Ordering::SeqCst)
                            && readiness_pid.lock().map(|state| *state == Some(pid)).unwrap_or(false),
                    );
                    match readiness {
                        BackendReadiness::Ready => {
                            let _ = app_handle2.emit("specrails:backend-ready", ());
                            break;
                        }
                        BackendReadiness::Stopped => break,
                        BackendReadiness::TimedOut => {
                            if !reported_delay {
                                reported_delay = true;
                                if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(&readiness_log_path) {
                                    let _ = writeln!(log, "[HOST] Backend readiness is delayed; keeping the sidecar alive and retrying health.");
                                }
                                let _ = app_handle2.emit("specrails:backend-starting", ());
                            }
                        }
                    }
                }
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window now MINIMIZES TO TRAY instead of quitting: the
            // close is prevented and the window hidden, so the `specrails-server`
            // sidecar keeps running and the tray item can reopen it. Sidecar
            // termination moved to the tray "Exit" path and the true-quit
            // `RunEvent::ExitRequested` hook below.
            //
            // Reopening the hidden window is per-platform, because a hidden
            // window is reachable differently on each OS:
            //  - macOS: the app keeps its Dock icon, so clicking it never
            //    launches a second process — it raises
            //    `applicationShouldHandleReopen`, handled as `RunEvent::Reopen`
            //    in the run loop below.
            //  - Windows: a hidden window has no taskbar button, so the user
            //    necessarily relaunches from the taskbar/Start shortcut. The
            //    `tauri_plugin_single_instance` callback registered above
            //    intercepts that launch and calls `show_main_window` on the
            //    existing instance, so no second sidecar is ever spawned.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            // A TRUE OS quit (Cmd-Q / app.exit / the tray "Exit" path) reaps the
            // sidecar here. Idempotent via `shutdown_sidecar` + the identity gate.
            if let RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<SidecarState>();
                shutdown_sidecar(&state);
            }
            // macOS Dock click on the ALREADY-RUNNING app. Closing the window
            // only hides it, so without this the app is reachable exclusively
            // from the menu-bar item — single-instance never fires because no
            // second process is launched. Only act when macOS reports no
            // visible window, so clicking the Dock icon of a visible app keeps
            // its current focus/window state untouched.
            #[cfg(target_os = "macos")]
            if let RunEvent::Reopen {
                has_visible_windows, ..
            } = event
            {
                if !has_visible_windows {
                    show_main_window(app_handle);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_identity_requires_its_image_and_exact_parent_handshake() {
        assert!(sidecar_command_matches("/Applications/Specrails.app/specrails-server --parent-pid=123", 123));
        for command in [
            "/Applications/Specrails.app/specrails-server --parent-pid=1234",
            "/Applications/Specrails.app/specrails-server --parent-pid=456",
            "/usr/bin/unrelated --parent-pid=123",
            "/Applications/Specrails.app/specrails-server",
        ] {
            assert!(!sidecar_command_matches(command, 123), "{command}");
        }
    }

    #[test]
    fn windows_identity_never_accepts_an_arbitrary_executable_or_pid_prefix() {
        assert!(sidecar_tasklist_matches(r#""specrails-server.exe","123","Console","1","10 K""#, 123));
        assert!(sidecar_tasklist_matches(r#""specrails-server-x86_64-pc-windows-msvc.exe","123","Console""#, 123));
        for row in [
            r#""notepad.exe","123","Console""#,
            r#""not-specrails-server.exe","123","Console""#,
            r#""specrails-server.exe","1234","Console""#,
            "INFO: No tasks are running which match the specified criteria.",
        ] {
            assert!(!sidecar_tasklist_matches(row, 123), "{row}");
        }
    }

    #[test]
    fn port_release_wait_refuses_an_occupied_port_and_accepts_it_after_release() {
        // An ephemeral test socket only; never bind or stop the user's server.
        let listener = TcpListener::bind("127.0.0.1:0").expect("test socket");
        let port = listener.local_addr().unwrap().port();
        assert!(!wait_for_port_available(port, Duration::ZERO));
        drop(listener);
        assert!(wait_for_port_available(port, Duration::from_millis(100)));
    }

    #[test]
    fn unexpected_sidecar_exit_is_reported_once_and_clears_its_pid() {
        let current = Mutex::new(Some(42));
        let stopping = AtomicBool::new(false);
        assert!(record_sidecar_exit(&current, &stopping, 42));
        assert_eq!(*current.lock().unwrap(), None);
        assert!(!record_sidecar_exit(&current, &stopping, 42));
    }

    #[test]
    fn update_shutdown_and_old_process_events_do_not_report_false_disconnections() {
        let current = Mutex::new(Some(42));
        let stopping = AtomicBool::new(true);
        assert!(!record_sidecar_exit(&current, &stopping, 42));
        assert_eq!(*current.lock().unwrap(), None);

        *current.lock().unwrap() = Some(43);
        stopping.store(false, Ordering::SeqCst);
        assert!(!record_sidecar_exit(&current, &stopping, 42));
        assert_eq!(*current.lock().unwrap(), Some(43));
    }

    // BUG-TAURI-02: the identity gate must REFUSE to recognise the current test
    // process as the sidecar — its command line is the test binary, not
    // `specrails-server`, and `--parent-pid=<this pid>` is never one of its args.
    // This proves a stale/recycled PID belonging to unrelated software (here, the
    // test harness itself) is never treated as the sidecar, so `terminate_process`
    // would short-circuit and never signal it.
    #[test]
    fn current_process_is_not_recognised_as_sidecar() {
        let me = std::process::id();
        assert!(
            !pid_is_sidecar(me),
            "the test process must not be mistaken for the specrails-server sidecar"
        );
    }

    // BUG-TAURI-02: a process that has already exited must read as "not the
    // sidecar" so a later kill is suppressed. We spawn a trivial child, wait for
    // it to die, then assert the gate rejects its (now-reusable) PID.
    #[cfg(unix)]
    #[test]
    fn exited_process_pid_is_not_recognised_as_sidecar() {
        use std::process::Command;
        let mut child = Command::new("true")
            .spawn()
            .expect("failed to spawn `true`");
        let pid = child.id();
        let _ = child.wait();
        // The PID is now dead (or possibly recycled by unrelated software);
        // either way it is NOT our sidecar, so the gate must return false.
        assert!(
            !pid_is_sidecar(pid),
            "an exited/recycled PID must not be recognised as the sidecar"
        );
    }

    // BUG-TAURI-02: an out-of-range / never-allocated PID must read as not the
    // sidecar (no process table entry → no signal).
    #[cfg(unix)]
    #[test]
    fn nonexistent_pid_is_not_recognised_as_sidecar() {
        // u32::MAX is well above any real PID on supported platforms.
        assert!(!pid_is_sidecar(u32::MAX));
    }

    // BUG-TAURI-02: `terminate_process` must be a no-op for a PID that is not the
    // sidecar. We can't observe "no signal sent" directly, but we CAN assert it
    // returns promptly (the identity gate short-circuits before the up-to-5s
    // SIGTERM→SIGKILL grace loop). A non-sidecar PID that fell through to the loop
    // would block far longer than this bound.
    #[cfg(unix)]
    #[test]
    fn terminate_process_short_circuits_for_non_sidecar() {
        let start = Instant::now();
        // Our own PID is alive but is not the sidecar → must short-circuit.
        terminate_process(std::process::id());
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "terminate_process must short-circuit (no kill) for a non-sidecar PID"
        );
    }

    // Tray menu dispatch: the pure id → action mapping the live `on_menu_event`
    // closure delegates to. "open"/"exit" map to their actions; anything else is
    // Unknown (a no-op in the closure) so an unexpected menu id never quits.
    #[test]
    fn tray_action_maps_known_ids() {
        assert_eq!(tray_action_for_id("open"), TrayAction::Open);
        assert_eq!(tray_action_for_id("exit"), TrayAction::Exit);
        assert_eq!(tray_action_for_id("something-else"), TrayAction::Unknown);
        assert_eq!(tray_action_for_id(""), TrayAction::Unknown);
    }

    // `shutdown_sidecar` must be a no-op when no sidecar PID is recorded (the
    // `CommandEvent::Terminated` handler nulls it on exit). This guards the
    // double-fire path: tray "Exit" calls it, then `app.exit(0)` fires
    // `RunEvent::ExitRequested` which calls it again — the second call must not
    // signal anything. We assert it returns promptly with a None pid.
    #[test]
    fn shutdown_sidecar_is_noop_when_pid_is_none() {
        let state = SidecarState {
            pid: Arc::new(Mutex::new(None)),
            stopping: Arc::new(AtomicBool::new(false)),
        };
        let start = Instant::now();
        shutdown_sidecar(&state);
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "shutdown_sidecar must return immediately when no PID is recorded"
        );
        // The PID stays None — nothing was spawned or signalled.
        assert!(state.pid.lock().unwrap().is_none());
        assert!(state.stopping.load(Ordering::SeqCst));
    }

    // `shutdown_sidecar` with a non-sidecar PID (our own, which is alive but not
    // the sidecar) must short-circuit via the identity gate, exactly like
    // `terminate_process_short_circuits_for_non_sidecar`. This proves the
    // Exit/ExitRequested paths inherit the BUG-TAURI-02 guard.
    #[cfg(unix)]
    #[test]
    fn shutdown_sidecar_short_circuits_for_non_sidecar_pid() {
        let state = SidecarState {
            pid: Arc::new(Mutex::new(Some(std::process::id()))),
            stopping: Arc::new(AtomicBool::new(false)),
        };
        let start = Instant::now();
        shutdown_sidecar(&state);
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "shutdown_sidecar must short-circuit (no kill) for a non-sidecar PID"
        );
    }
}
