## Context

In-app link browsing (`WebViewModal`, opened from `TicketDetailModal`, `AgentMessage`, `AgentPrDecisionCard`) rides the browser-capture screencast: headless Chromium (Playwright) on the server, CDP `Page.startScreencast` JPEG frames over WS, canvas painting, full input round-trips. Slow, lossy, heavy, and localhost-blocked. The app is a Tauri v2 shell (macOS arm64 + Windows x64/arm64 shipped targets) whose main webview loads the React client; `@tauri-apps/api` v2 is already a client dep and `isTauri()` detection exists (`client/src/lib/tauri-shell.ts`). Full research: `docs/internals/embedded-browser-native-webview-evaluation.md`.

## Goals / Non-Goals

**Goals:**
- Cursor-class interactive browsing: native compositing, no streaming, no input latency, real cookie/session persistence, localhost allowed.
- Zero regression outside Tauri: plain-browser mode and the kill switch keep the screencast path byte-identical.
- Keep the Playwright capture channel ("Add Spec from a website") untouched.

**Non-Goals:**
- Tabs (single pane v1; the Rust side is label-addressed so tabs are additive).
- Page-title display in the status line (no portable title API on a child webview without injecting IPC; address + load state suffice v1).
- Agent observability on the native pane (console/network collection — deferred; the Playwright channel already covers agent capture).
- Moving `BrowserCaptureModal` off Playwright.
- Dropping the bundled Chromium from the installer (still needed by capture).

## Decisions

1. **Tauri child webview (`unstable` cargo feature) over separate window / CEF / iframe.** `Window::add_child(WebviewBuilder, position, size)` is the Tauri equivalent of Electron's `WebContentsView` (what Cursor uses). Separate `WebviewWindow` loses the in-layout experience; CEF (`cef-rs`) is a multi-month +150 MB integration; iframes die on `X-Frame-Options`. The `unstable` flag's known bug tail is mitigated by the fallback ladder (below).
2. **Singleton pane, label `native-browser`.** One child webview at a time; `browser_open` closes any previous pane first. Commands resolve it via `app.get_webview("native-browser")` — no long-lived handles in state beyond the label.
3. **IPC surface (Rust `src-tauri/src/browser.rs`).** Commands: `browser_supported` (per-platform bool — the client probe), `browser_open { url, bounds }`, `browser_navigate { url }`, `browser_back` / `browser_forward` (via `eval("history.back()")` — Tauri exposes no goBack API), `browser_reload`, `browser_set_bounds { bounds }`, `browser_show` / `browser_hide`, `browser_close`, `browser_devtools`, `browser_zoom { factor }`. Events emitted app→main webview as `native-browser:event` with `{ kind: 'nav' | 'load-started' | 'load-finished' | 'closed', url? }` from `on_navigation` + `on_page_load`.
4. **No Tauri IPC power inside the pane.** The child webview's label is NOT listed in any capability (`capabilities/default.json` targets `main` only) and no remote-domain IPC access is granted, so arbitrary web content cannot invoke commands. This is the security boundary that lets us allow any http(s) URL, including localhost (client-side browsing is just a browser — the server-side SSRF guard rationale does not apply).
5. **URL policy client-side.** `normalizeAddress` (bare host → `https://`), allow `http:`/`https:`/`about:blank` only (no `file:`, no `data:`). Rust re-validates the scheme defensively.
6. **Bounds sync.** The React chrome renders a measured hole `<div>`; `ResizeObserver` + window-resize listener stream `getBoundingClientRect()` (logical CSS px, rAF-coalesced) to `browser_set_bounds` using `LogicalPosition`/`LogicalSize` — correct across DPI since the main webview fills the window at logical 1:1 (`decorations: false`).
7. **Session persistence.** Windows: `data_directory` = `~/.specrails/native-browser-profile/`. macOS: WKWebView uses the app's default persistent `WKWebsiteDataStore` (no per-webview data dir on macOS) — logins persist across app runs either way. Separate from the Playwright profile by nature (engines can't share profiles).
8. **Popups.** `on_new_window` → deny + navigate the pane to the requested URL (OAuth flows degrade to full-page navigation). No popup stack v1.
9. **Fallback ladder (client `WebViewModal` router).** (1) `FEATURE_NATIVE_BROWSER !== 'false'` && `isTauri()` && `browser_supported` → `NativeBrowserPane`; (2) any probe/open failure → screencast variant for that session (automatic, logged); (3) plain browser / kill switch → screencast, byte-identical. Callers (`useWebViewModal`) are unchanged.
10. **Overlay discipline.** The pane is a separate native surface — app HTML can never render above its rect (same constraint Cursor ships with). v1 confines the pane to the `WebViewModal` full-screen overlay (already the topmost surface, z-[80]); the chrome/toolbar lives outside the hole rect. Accepted caveat: toasts intersecting the hole are covered while the browser is open. A dedicated `browser_hide`/`browser_show` pair exists for future embedders that need modal-aware hiding.
11. **Devtools.** Cargo feature `devtools` on `tauri` + a chrome button calling `browser_devtools` (Safari Web Inspector on macOS, WebView2 devtools on Windows). Only ever invoked on the pane.
12. **Coverage.** Pure logic in `client/src/lib/native-browser.ts` (normalization, scheme policy, bounds mapping, probe memoization) is unit-tested. `NativeBrowserPane.tsx` is coverage-excluded with an inline reason (Tauri IPC + ResizeObserver + native view — structurally unreachable in jsdom), matching the existing browser-capture exclusions. Rust: pure helpers (scheme check, bounds struct) unit-tested in `browser.rs` `mod tests`; the rest verified by `cargo check`/`cargo test`.

## Risks / Trade-offs

- [Tauri `unstable` feature bug tail: white-on-load #10011, resize stalls #10131, Windows z-order #9798] → fallback ladder keeps every surface functional; kill switch restores legacy wholesale; pane confined to one full-screen surface minimizes layout/compositing churn; Windows behavior must be validated on a real Windows build before release (CI builds it, manual QA required).
- [HTML can't overlay the pane rect] → v1 confinement to the topmost modal; documented caveat for toasts.
- [No back/forward *state* API (canGoBack)] → nav buttons always enabled; `history.back()` on an empty stack is a no-op. Cosmetic only.
- [`unstable` feature flips ALL tauri windows to child-webview internals (#9059)] → main window keeps working (single webview per window is the degenerate case); verified by running the app after the Cargo change.
- [OAuth popups coerced to same-pane navigation] → acceptable for v1 link-browsing; the capture path (which has a real popup stack) is unaffected.
- [Profile split between engines (native pane vs Playwright capture)] → inherent; users may need to log in twice across the two features. Documented.

## Migration Plan

Additive, no data migration. Rollback = `VITE_FEATURE_NATIVE_BROWSER=false` (or non-Tauri context) → screencast path, byte-identical; the Cargo `unstable` feature itself is exercised only when a pane is opened.

## Open Questions

- Windows z-order in practice on tauri 2.11.x (issue #9798 dates from the beta cycle) — resolve during Windows QA; contingency is per-platform gating in `browser_supported`.
