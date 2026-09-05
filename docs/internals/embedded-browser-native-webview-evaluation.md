# Embedded browser: native-webview evaluation (Cursor-class experience)

> Update 2026-09-05: mission browsing now also uses the native pane on macOS, with same-page Retina snapshots, DOM selection and annotations. The original evaluation below is historical; current behavior and validation are documented in [the browser audit](browser-native-retina-audit.md).

> Status: **implemented (phases 0–1 + devtools/zoom from phase 2)** — researched
> 2026-07-26, shipped via OpenSpec change `native-embedded-browser`. As-built:
> `src-tauri/src/browser.rs`, `client/src/lib/native-browser.ts`,
> `client/src/components/browser-capture/NativeBrowserPane.tsx`, router in
> `WebViewModal.tsx`. Open follow-ups: Windows z-order QA on a real build
> (tauri #9798), localhost-preview affordance (port detection), agent
> observability (phase 3).

## 1. The problem

The current "embedded browser" is a **remote-rendered screencast**, not a browser:

```
headless Chromium (Playwright, server)  ──CDP Page.startScreencast──▶  JPEG q70 frames
        ▲                                                                   │ WebSocket
        │ every key/click/scroll/clipboard round-trips                      ▼
     input WS  ◀────────────────────────────────  <canvas> + createImageBitmap (client)
```

- `server/browser-playwright.ts` — CDP screencast (JPEG, quality 70, `everyNthFrame: 1`).
- `server/browser-context-pool.ts` — one persistent headless Chromium resident for the app.
- `client/src/components/browser-capture/useBrowserCaptureSession.ts` — WS → bitmap → canvas pipeline, newest-frame-wins.
- The app **bundles a full Chromium** in the installer (`server/chromium-resolver.ts`, XOR blob `chromium.pak`) just to power this.

Consequences: a second full Chromium process tree resident; continuous JPEG
encode + WS transfer + decode + canvas paint; input latency on every keystroke;
scroll feels remote; text is lossy JPEG. And the SSRF guard (`isNavigableUrl`)
**blocks localhost/private IPs**, so the #1 IDE-browser use case — previewing your
own dev server — is impossible by design.

Surfaces using it today:
- `WebViewModal` (browse-only): links from `TicketDetailModal`, `AgentMessage`, `AgentPrDecisionCard`.
- `BrowserCaptureModal` ("Add Spec from a website"): element select, DOM capture,
  annotations, responsive breakpoints, network sketch — this one has real
  product value in the Playwright path.

## 2. What the best IDEs actually do

| IDE | Mechanism | Verdict |
|---|---|---|
| **Cursor** (Browser / Browser control) | Real native Chromium view composited in-window (Electron `WebContentsView`-class, per the z-order-over-dialogs bug signature) + **CDP side-channel for the agent** (console, network, screenshots), element picker → chat, DevTools panes, localhost hot-reload | The bar to match |
| **JetBrains** | JCEF — real embedded Chromium in the runtime | Same tier |
| **VS Code** | Simple Browser / Live Preview = **iframe in webview** — breaks on `X-Frame-Options`/`frame-ancestors`; the old full-fidelity extension (Browser Preview) was a **CDP screencast and was deprecated** for exactly our symptoms | Cheap tier |
| **Windsurf** | Separate Chromium-fork window paired with the IDE + agent observability | Adjacent pattern |

Pattern: **nobody premium streams screenshots**. They composite a real native
browser surface into the window and keep the "chrome" (address bar, tabs) in the
editor's own UI. The 2025–26 differentiator is **agent observability** (console,
network, screenshot-to-chat), not tabs.

## 3. Options for specrails-desktop (Tauri v2)

| Option | Fidelity | Effort | Risk | Notes |
|---|---|---|---|---|
| **A. Tauri child webview** (`unstable` feature, `Window::add_child` + `WebviewBuilder`) | Native (WKWebView / WebView2) | Medium | Medium — unstable flag, bug tail | The Electron-`WebContentsView` equivalent. Recommended. |
| B. Separate `WebviewWindow` | Native | Low | Low | Own OS window; docking is fake. Good fallback if A blocks. |
| C. CEF via `cef-rs` | Chromium-exact | Very high | High | Raw bindings, no plugin, +150 MB, signing/notarization project. Not now. |
| D. iframe in main webview | n/a | Low | — | Dead on arrival for arbitrary sites (frame-ancestors). |
| E. Keep screencast | Lossy | 0 | — | The thing we're replacing. Stays as fallback + capture engine. |

Key facts on **A** (verified against tauri 2.11.x / wry 0.55 docs + issue tracker):
- API available per-webview: `navigate`, `url`, `reload`, `eval`, `show/hide`,
  `set_bounds`/`set_auto_resize`, `set_zoom`, `open_devtools`, cookies APIs,
  `clear_all_browsing_data`, `incognito`, `data_directory`, `proxy_url`,
  `user_agent`, `on_navigation` (cancelable), `on_page_load`, `on_new_window`
  (popup policy), `on_download`.
- **No back/forward API** — portable route is `eval("history.back()")`; macOS can
  reach the raw `WKWebView` (`WebViewExtMacOS`) for real `goBack/canGoBack` +
  `with_back_forward_navigation_gestures` (swipe).
- **Hard constraint:** the child webview is a separate native surface — main-webview
  HTML can never render above it. Same constraint Cursor lives with (their browser
  overdraws their own dialogs — public bug). Mitigation: `hide()`/shrink the pane
  whenever a modal/dropdown would intersect it.
- **Platform notes:** macOS + Windows supported (our only shipped targets — Linux
  Wayland limitation is moot). Known unstable-flag bug tail to QA against:
  z-order inconsistency (#9798), resize stalls (#10131), white-on-load (#10011),
  only-last-child renders (#11376), example positioning (#10420).

## 4. Recommended architecture

**Hybrid: native child webview for browsing; Playwright stays for capture; screencast stays as fallback.**

```
┌────────────────────────────── Tauri window ──────────────────────────────┐
│ main webview (React app)                                                 │
│  ┌─ BrowserPane chrome (React): address bar, back/fwd, reload, devtools ─┐│
│  │  ┌──────────────── reserved <div> hole ────────────────┐              ││
│  │  │        child webview  (WKWebView / WebView2)        │◀─ set_bounds ││
│  │  │        real page, native compositing, zero streaming │   from       ││
│  │  └──────────────────────────────────────────────────────┘  ResizeObs. ││
│  └────────────────────────────────────────────────────────────────────────┘│
└───────────────────────────────────────────────────────────────────────────┘
```

- **Rust side (`src-tauri`):** enable `features = ["unstable"]`; commands
  `browser_open(url, bounds)`, `browser_set_bounds`, `browser_navigate`,
  `browser_back/forward` (eval + macOS ext), `browser_hide/show`, `browser_close`,
  `browser_devtools`. Events to JS: `browser://nav` (url/title from
  `on_navigation`/`on_page_load` + title polling via eval), `browser://new-window`
  (popup policy: open in-pane by default). One pane v1 (no tabs), `label`-addressed
  so tabs are a v2, not a rewrite.
- **Client:** `BrowserPane.tsx` replaces `WebViewModal`'s canvas: renders only the
  chrome + an empty measured `<div>`; `ResizeObserver` + scroll/layout effects
  stream the rect over IPC. A tiny `useNativeBrowserOverlayGuard` hides the child
  webview while any `z`-layered surface (Radix dialog, dropdown, toast area,
  MinimizedChatsDock interactions) intersects the pane — the same discipline the
  terminal panel already applies to its host div, inverted.
- **Session/profile:** `data_directory` under `~/.specrails/native-browser-profile/`
  → persistent logins like a real browser (parallel to the Playwright profile, not
  shared — WKWebView/WebView2 cannot read a Chromium profile). Optional incognito
  flag per open.
- **localhost allowed.** The SSRF guard exists because the *server* renders pages;
  a native client-side webview is just a browser the user drives — no server-side
  fetch, no SSRF. This unlocks the killer feature: **dev-server preview** (open
  `http://localhost:5173` next to the terminal panel, Cursor-style).
- **Fallback ladder (runtime-detected):**
  1. Tauri desktop → native child webview.
  2. `npm run dev` in a plain browser (no Tauri) → current screencast path, unchanged.
  3. Kill switch `SPECRAILS_NATIVE_BROWSER=false` / `VITE_FEATURE_NATIVE_BROWSER=false`
     → screencast everywhere (byte-identical legacy).
- **Capture stays Playwright.** "Add Spec from a website" (element probe, DOM
  capture, annotate, breakpoints, network ring) keeps the headless path — that is
  an *instrumented agent browser*, the analogue of Cursor's CDP channel, and CDP
  does not exist on WKWebView. Long-term option: move light capture (screenshot of
  the native pane via injected JS/`print`) natively and drop the bundled Chromium
  from the installer for users who never capture — out of scope v1.

### Why not B/C first
B (separate window) loses the in-layout experience that defines Cursor's browser;
keep it as the contingency if the spike hits a blocker on Windows z-order. C (CEF)
is the only path to Chromium-exact + CDP-native embedding, but it is a
multi-month integration and ~150 MB — revisit only if agent-side observability on
the *interactive* pane becomes a hard requirement.

## 5. Rollout plan

- **Phase 0 — spike (1 day):** branch; `unstable` feature on; hardcoded
  `add_child` pane over the Dashboard; verify on macOS: bounds sync under sidebar
  animation, hide-on-modal, focus in/out, `on_new_window`, localhost nav. Then the
  same build on Windows (the z-order + white-on-load bugs are Windows-flavored).
  Exit criteria: 60 fps scroll, no keystroke latency, no compositing artifacts.
- **Phase 1 — replace browse surfaces:** `BrowserPane` + Rust commands; route
  `WebViewModal` callers (spec links, agent links, PR cards) through it; fallback
  ladder + kill switches; i18n ×8; docs.
- **Phase 2 — premium chrome:** omnibox with history, zoom controls, per-pane
  DevTools button, "Preview localhost" affordance (detect ports from the terminal
  panel / rails dev servers), swipe gestures on macOS.
- **Phase 3 (deferred) — agent observability:** injected-script console/error
  collector + screenshot-to-spec from the native pane (Cursor's differentiator),
  evaluated against the existing Playwright capture channel.

## 6. Sources

- Cursor browser docs/blog: cursor.com/docs/agent/tools/browser · cursor.com/blog/browser-visual-editor
- VS Code Simple Browser iframe limits: microsoft/vscode#127141 · deprecated screencast ext: auchenberg/vscode-browser-preview
- JetBrains JCEF: plugins.jetbrains.com/docs/intellij/embedded-browser-jcef.html
- Tauri: docs.rs/tauri `WebviewBuilder`/`Webview` · PR #8280, #9059 · issues #9798, #10420, #10131, #10011, #11376, #14588 · `examples/multiwebview`
- wry: docs.rs/wry `WebViewBuilder`, `WebViewExtMacOS`
- cef-rs: github.com/tauri-apps/cef-rs
