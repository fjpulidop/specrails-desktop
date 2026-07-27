## Why

The in-app browsing experience (opening spec/agent/PR links via `WebViewModal`) is a server-side headless-Chromium screencast: JPEG frames over WebSocket painted on a canvas, with every keystroke/click/scroll round-tripping client → server → CDP. It is slow, lossy, resource-heavy (a second full Chromium resident + continuous encode/decode), and blocks localhost by SSRF design — so it cannot even preview a dev server. The best IDEs (Cursor, JetBrains) composite a REAL native browser view inside the window; screencast browsing is the approach VS Code deprecated. Evaluation: `docs/internals/embedded-browser-native-webview-evaluation.md`.

## What Changes

- Add a **native embedded browser pane**: a Tauri v2 child webview (`Window::add_child`, cargo feature `unstable`; WKWebView on macOS, WebView2 on Windows) composited inside the main window — native rendering, zero streaming, zero input latency, real cookies/logins, per-webview devtools, `http://localhost` allowed.
- New Rust module (`src-tauri/src/browser.rs`) exposing IPC commands (open/navigate/back/forward/reload/set-bounds/show/hide/close/devtools/zoom) and emitting navigation/title events to the React app.
- New client surface `NativeBrowserPane` + `useNativeBrowser` wiring: React renders only the browser chrome (address bar, nav buttons, devtools/zoom) plus a measured "hole" `<div>`; a ResizeObserver streams the rect to Rust (`set_bounds`). Persistent profile via `data_directory` under `~/.specrails/native-browser-profile/`.
- `WebViewModal` (the browse-only surface used by `TicketDetailModal`, `AgentMessage`, `AgentPrDecisionCard`) routes to the native pane when available; the screencast path remains the automatic fallback in plain-browser mode (`npm run dev` without Tauri) and behind the kill switch `VITE_FEATURE_NATIVE_BROWSER=false` — byte-identical legacy behavior.
- Playwright capture machinery ("Add Spec from a website": element select, DOM capture, annotate, breakpoints) is **untouched** — it stays the instrumented capture channel.
- i18n: new `browser` namespace keys for native-only chrome across all 8 locales.

## Capabilities

### New Capabilities
- `native-browser-pane`: the native child-webview browsing surface — availability detection and fallback ladder, pane lifecycle (open/close/bounds sync), navigation chrome behavior, session persistence, localhost policy, overlay/z-order discipline, and the kill switch.

### Modified Capabilities

<!-- none — no existing spec covers the screencast WebViewModal; its behavior is unchanged as the fallback path -->

## Impact

- **Rust / Tauri**: `src-tauri/Cargo.toml` gains the `unstable` feature on `tauri`; new `src-tauri/src/browser.rs`; command registration in `lib.rs`. Desktop-only (macOS + Windows, the shipped targets).
- **Client**: new `client/src/lib/native-browser.ts` (pure logic: availability, bounds math, URL normalization — unit-tested), `client/src/components/browser-capture/NativeBrowserPane.tsx`; `WebViewModal.tsx` becomes a thin router between native and screencast variants; `client/src/lib/feature-flags.ts` gains `FEATURE_NATIVE_BROWSER`.
- **Server**: no changes (native path is entirely client+Tauri; screencast endpoints untouched).
- **Coverage**: pure logic in `lib/` is unit-tested; the pane component is jsdom-unreachable (Tauri IPC + ResizeObserver + native view) and is excluded with an inline reason, like the existing browser-capture components.
- **Docs**: CLAUDE.md section, evaluation doc status update.
