# Detachable mission windows

A mission can move from the main Specrails interface to its own native window on macOS or Windows. Several missions can remain visible at once, each bound to its original conversation and project. Home missions also work. Browser-only development retains the integrated interface and does not offer native window controls.

## Using the windows

Use the mission header action to open a separate window. Selecting that action again focuses the existing window; it does not create another copy. The main interface shows where the mission is open instead of exposing a second editable conversation. Each window has independent minimize, maximize/restore and resize controls. Minimizing main leaves the other mission windows available.

The reintegrate action and the mission window's native close button return it to main. Closing main preserves its existing hide-to-tray behavior. Quitting Specrails remains an application shutdown, including its backend; it is different from moving or closing one mission window.

## State and execution

The feature moves a view of the existing conversation. It does not create another server, database, agent invocation or provider session, and it does not restart a running agent. Transcript, queued messages, active tools and running jobs remain in the existing backend. The destination reconnects to that state.

A versioned snapshot carries unsent composer text, inline reference positions, uploaded attachment descriptors, scroll position, workspace panels, selected repository/file, browser identity/URL and the selected terminal layout/session ID. Input is frozen during the handoff. The destination restores its view and acknowledges the current transfer revision before ownership changes or the old mission window is destroyed. Failed hydration and timeouts retain a recoverable source snapshot; a delayed acknowledgement cannot commit an obsolete transfer. Pending uploads or other unfinished composer operations must finish before moving the view.

Window placement and unsent view snapshots are session state, not a new durable draft backup. Existing persisted messages and jobs retain their normal storage behavior. Restarting the application is not covered by the in-memory handoff guarantee.

## Browsers and authentication windows

Each native browser belongs to an exact registered app window and a mount owner. Commands derive the calling window from native IPC; web pages and authentication popups cannot impersonate that interface. Browser events follow the current owner window.

A handoff reparents the existing WebKit/WebView2 child instead of opening its URL again. DOM state, history, cookies and popup opener relationships stay with the session. Authentication popups are independent native top-level windows; destroying the former mission window does not destroy a popup belonging to the transferred browser. The destination adopts the same owner, updates its bounds and displays it at the destination screen's scale. Cleanup from the former window cannot close the transferred browser.

If the destination already contains another browser, its pane and popups are parked hidden, without destroying the session. Explicitly returning to that owner restores it. Rolling back the transfer retains the previous destination browser and requests restoration from its mounted interface. A parked browser and its popups remain hidden until that interface explicitly adopts the owner; moving another mission cannot expose an unframed browser over the main interface. A late cleanup for an inactive parked owner does not destroy it. Window teardown removes its remaining owned sessions. The limit is eight parked browsers per app window; exceeding it produces an actionable error rather than silently discarding a session.

## Verification matrix

| Check | Native macOS | Windows x64 / ARM64 |
| --- | --- | --- |
| Rust ownership, snapshot scope, revisions and close policy | Passed locally; `native-macos` CI gate | `windows-parity` CI gates; native execution pending |
| `native-mission-window-smoke`: independent windows, Home scope, renderer IPC, duplicate focus, close/ack and timeout recovery | Passed locally | Gate added; execution pending |
| `native-browser-multiwindow-smoke`: separate owners/popups, transfer/adoption, parked target, rollback, source destruction with a live popup, event routing, destination scale and stale cleanup | Passed locally | Gate added; execution pending |
| `native-browser-smoke`: native capture, DOM/Shadow DOM selection, zoom and remote IPC denial | Passed locally | Existing gate retained |
| `native-browser-popup-smoke`: nested/cross-origin opener callbacks, self-close, capacity recovery and owner cleanup | Passed locally | Existing gate retained |
| React handoff, draft/reference restoration and shared workspace behavior | Shared client regression suites | Shared client suite also runs on Windows |

The native fixtures use local or in-memory pages and isolated browser profiles. They do not start a sidecar, access user databases, authenticate with external tenants or call models. Run them from `src-tauri` after building the client assets:

```sh
cargo test --locked --lib --features native-browser-smoke
cargo run --locked --example native-mission-window-smoke --features native-browser-smoke
cargo run --locked --example native-browser-multiwindow-smoke --features native-browser-smoke
cargo run --locked --example native-browser-smoke --features native-browser-smoke
cargo run --locked --example native-browser-popup-smoke --features native-browser-smoke
```

For a source-only checkout without assembled desktop resources, set `TAURI_CONFIG` to `{"bundle":{"active":false,"externalBin":[],"resources":[]}}`, as CI does. These are interactive native tests; they require an OS desktop session.

On Windows the examples embed `src-tauri/examples/windows-app.manifest` (Common Controls v6) through `build.rs`. tauri-build only gives that manifest to the package binaries, and without it the loader refuses the example executable with `STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139): tao/wry import `SetWindowSubclass` by name, which comctl32 5.82 does not export. CI runs each fixture through `scripts/run-native-smoke.ps1`, which reports the process's own exit code, echoes its output and prints the PE subsystem, WebView2 runtime and DLL dependents when a run needs diagnosis.

## Limits and remaining platform acceptance

- At most 16 detached missions and a 2 MiB transfer snapshot. Oversized state is rejected without truncating unsent work.
- Live browser transfer requires the same running native host. It does not migrate sessions between computers or survive application termination.
- Local macOS capture verifies the destination display's actual scale. Mixed-DPI monitor movement, Windows 100%/150%/200% scaling, and installed UI behavior still need real-device acceptance.
- Local authentication fixtures exercise browser mechanics. Corporate Okta/SSO tenants, OS policies and external provider authentication require separate acceptance with the intended environment.

See [Windows feature parity](../platforms/windows-parity.md) for installer and real-device release gates.
