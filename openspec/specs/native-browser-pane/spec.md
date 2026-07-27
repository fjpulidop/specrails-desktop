# native-browser-pane Specification

## Purpose

Gives the desktop app a Cursor-class in-app browsing experience: a real native child webview (Tauri v2 `Window::add_child` — WKWebView on macOS, WebView2 on Windows) composited inside the main window, replacing the server-side screencast for the browse-only `WebViewModal` surfaces (spec/agent/PR links). Native compositing means zero streaming, zero input latency, real cookies/logins, per-webview devtools, and localhost navigation for dev-server preview. The screencast path remains the automatic fallback (plain-browser mode, probe/open failure, kill switch) and the Playwright capture channel ("Add Spec from a website") is untouched. Rust side: `src-tauri/src/browser.rs`; client: `client/src/lib/native-browser.ts` + `client/src/components/browser-capture/NativeBrowserPane.tsx` + the router in `WebViewModal.tsx`. Research + as-built record: `docs/internals/embedded-browser-native-webview-evaluation.md`.

## Requirements

### Requirement: Native pane availability detection and fallback ladder
The in-app browse surface (`WebViewModal` router) SHALL select its rendering engine by a three-step ladder: (1) when the client feature flag `FEATURE_NATIVE_BROWSER` is enabled AND the app runs inside the Tauri shell AND the `browser_supported` IPC probe returns true, it SHALL render the native child-webview pane; (2) when the probe or the pane open fails at runtime, it SHALL automatically fall back to the legacy screencast variant for that session; (3) outside Tauri or with `VITE_FEATURE_NATIVE_BROWSER=false`, it SHALL render the legacy screencast variant with behavior byte-identical to before this change.

#### Scenario: Native pane selected in the desktop app
- **WHEN** a spec/agent/PR link is opened in-app inside the Tauri desktop build with the flag enabled and `browser_supported` returning true
- **THEN** the native child-webview pane renders the page and no screencast session is created on the server

#### Scenario: Automatic fallback on native open failure
- **WHEN** the native probe succeeds but `browser_open` rejects (e.g. platform bug)
- **THEN** the surface falls back to the screencast variant for that session without user action and the link still opens

#### Scenario: Plain-browser mode unchanged
- **WHEN** the client runs outside Tauri (`npm run dev` in a browser) or the kill switch is set
- **THEN** the screencast variant is used, byte-identical to legacy behavior

### Requirement: Native pane lifecycle and bounds synchronization
The client SHALL render only browser chrome plus a measured hole element, and SHALL keep the native child webview's bounds synchronized to that element (logical CSS pixels, coalesced to at most one update per animation frame) across window resizes and layout changes. Exactly one native pane SHALL exist at a time: opening a pane SHALL close any previous one, and closing the surface SHALL destroy the child webview.

#### Scenario: Bounds follow the hole element
- **WHEN** the window is resized while the pane is open
- **THEN** the child webview is repositioned/resized to match the hole element's rectangle

#### Scenario: Close destroys the native webview
- **WHEN** the user closes the browse surface (close button, Esc, or backdrop)
- **THEN** the child webview is closed and a subsequent open creates a fresh pane

### Requirement: Navigation chrome
The native pane chrome SHALL provide an address input with Go, back, forward, and reload controls, a devtools button, and zoom controls. Address input SHALL be normalized (bare host upgraded to `https://`) and restricted to `http:`, `https:`, and `about:blank` — other schemes SHALL be rejected client-side and defensively re-rejected in Rust. Navigation and load events from the native webview SHALL update the displayed URL and a loading indicator.

#### Scenario: Address normalization
- **WHEN** the user types `example.com` and submits
- **THEN** the pane navigates to `https://example.com/`

#### Scenario: Disallowed scheme rejected
- **WHEN** the user submits `file:///etc/passwd`
- **THEN** no navigation occurs

#### Scenario: URL reflects real navigation
- **WHEN** the page redirects or the user clicks an in-page link
- **THEN** the address bar updates to the new URL from the native navigation events

### Requirement: Localhost and private addresses are navigable in the native pane
The native pane SHALL allow navigation to loopback/private-network http(s) URLs (e.g. `http://localhost:5173`), since browsing happens client-side in the user's own webview. The server-side screencast path SHALL keep its existing SSRF guard unchanged.

#### Scenario: Dev-server preview
- **WHEN** the user navigates the native pane to `http://localhost:4201`
- **THEN** the page renders

### Requirement: Pane isolation from app IPC
The native child webview SHALL NOT be granted any Tauri capability or remote-domain IPC access; web content loaded in the pane MUST NOT be able to invoke app commands.

#### Scenario: No capability grants for the pane label
- **WHEN** the Tauri capabilities are inspected
- **THEN** no capability lists the native pane's webview label or grants remote-URL IPC access

### Requirement: Session persistence and login popups
The native pane SHALL persist cookies/logins across app restarts (Windows via a dedicated profile directory under `~/.specrails/`; macOS via the app's default persistent WebKit data store). `window.open`/popup requests for http(s) URLs SHALL open as REAL satellite popup windows created from the opener's webview configuration/environment (so `window.opener`, postMessage, and session cookies keep working — the OAuth/IdP login-popup contract, e.g. Okta). Popup windows SHALL receive no Tauri capability, SHALL honour a site-requested size/position, and SHALL be closed together with the pane. Non-web schemes SHALL be denied.

#### Scenario: Login survives restart
- **WHEN** the user logs into a site in the native pane, quits, and relaunches the app
- **THEN** the session cookie is still present when revisiting the site

#### Scenario: IdP login popup appears and completes
- **WHEN** page content calls `window.open(idpUrl)` for an OAuth/IdP login
- **THEN** a real popup window opens on `idpUrl` and, after login, the opener page in the pane receives the postMessage/callback and the popup can close

#### Scenario: Popups close with the pane
- **WHEN** the pane is closed or reopened while a login popup window is still open
- **THEN** the popup window is closed as well
