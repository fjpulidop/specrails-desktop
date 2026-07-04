# Embedded browser: performance + popup support

The embedded browser backs two surfaces: **Add Spec → From a website** (`BrowserCaptureModal`) and the read-only **WebView** for opening links / the Agent-Mode Browser tool (`WebViewModal`, `AgentBrowserCapture`). Both ride the same session machinery. This doc maps the pipeline, the fluidity levers applied (benchmark: Cursor's embedded browser), the tuning knobs, and the OAuth popup design.

## Pipeline map

```
Chromium (headless, persistent shared context — browser-context-pool.ts)
  │  CDP Page.startScreencast (JPEG frames)          Playwright input API
  ▼                                                   ▲
PlaywrightPageHandle (server/browser-playwright.ts)   │
  │  ScreencastFrame (raw JPEG Buffer)                │ dispatchInput
  ▼                                                   │
BrowserCaptureManager (server/browser-capture-manager.ts)
  │  binary WS frames (dedicated /ws/browser/:id)     │ JSON control {type:'input'|'probe'}
  ▼                                                   │
useBrowserCaptureSession (client)  ───────────────────┘
  │  createImageBitmap → canvas 2d drawImage
  ▼
<canvas> in BrowserCaptureModal / WebViewModal
```

- REST (`project-router-terminals.ts`, `/browser/sessions*`): create / navigate / capture / clipboard / element / popup-view / kill.
- Session create opens one page in the app-wide shared persistent context (global cookies/logins).

## Bottlenecks found (as-was)

1. **`create()` awaited the initial `page.goto(…, waitUntil: 'domcontentloaded')`** — the POST (and the modal spinner) blocked up to 30s on a slow site before the first frame could ever be shown.
2. **Unthrottled wheel forwarding.** Every trackpad wheel event (60–120 Hz on macOS) crossed WS → manager → Playwright as `mouse.move` **then** `mouse.wheel` — two sequentially-awaited CDP commands per tick, flooding the page's input queue. This was the single biggest scroll-lag source. (`WebViewModal` also forwarded every raw `pointermove`, unthrottled.)
3. **Client frame path dropped the *newest* frame.** While one decode was in flight, incoming frames were discarded — so under load the canvas kept showing the *older* frame and lagged reality.
4. **Screencast ack after fan-out.** `Page.screencastFrameAck` was sent after the frame handler ran; Chromium throttles on unacked frames, so ack latency directly limited fps.
5. **No backpressure handling.** A slow client's WS send-buffer queued unlimited stale frames — latency grew unboundedly instead of frames being dropped.
6. **Pop-ups were silently ignored.** `window.open` / `target=_blank` / OAuth login windows opened invisible pages — an Okta-style login was impossible.

## Changes applied

### Server

| Lever | Where | Expected win |
|---|---|---|
| **Non-blocking initial navigation** — `create()` returns as soon as the page exists; `goto` completes in the background and lands via the `nav` WS broadcast. The client attaches + screencasts immediately, so the page paints progressively. | `browser-capture-manager.ts` `runInitialNavigation` | Removes 1–30 s of perceived cold-open latency; the biggest UX win. |
| **Ack-first screencast** — `screencastFrameAck` fires (fire-and-forget) *before* the handler/fan-out, overlapping Chromium's next capture with delivery. | `browser-playwright.ts` `startScreencast` | Higher fps ceiling, lower frame age. |
| **Wheel fast-path** — skip the redundant `mouse.move` when the cursor hasn't moved (tracked via `lastMouse`), and dispatch move+wheel back-to-back (`Promise.all`) so a concurrent wheel can't interleave between them. | `browser-playwright.ts` `dispatchInput` | ~2× fewer CDP commands per wheel; ordering hazard removed. |
| **Frame conflation for slow consumers** — skip a frame for any WS client whose `bufferedAmount` exceeds 1 MB (frames are independent JPEGs; `lastFrame` still updates). | `browser-capture-manager.ts` fan-out | Latency stays bounded under backpressure — staleness, not fps, is what reads as "sluggish". |
| **Centralised screencast params** — `screencastParams()`: JPEG, `everyNthFrame: 1`, guard caps 3840×2400 (viewport already ≤ display size, so this is a guard, not a downscaler). | `browser-playwright.ts` | Tunable quality knob (below); pathological-viewport guard. |
| **Live URL bar** — `onNavigated` (main-frame `framenavigated`) broadcasts `nav` on in-page link clicks/redirects. | manager + playwright handle | URL bar no longer goes stale after clicking links. |

### Client

| Lever | Where | Expected win |
|---|---|---|
| **Pointer/wheel coalescing** — `createPointerInputCoalescer`: ≤1 `move` (newest-wins) + ≤1 `wheel` (deltas summed, latest position) per animation frame; `flush()` runs synchronously before every mouse down/up, preceded by an exact `move` to the click point. | `lib/browser-capture.ts`, used by both modals | 2–5× fewer input messages during scroll; click precision *improved* (down/up now always preceded by an exact-position move — the server dispatches clicks at the current cursor position). |
| **Latest-frame-wins decode+draw pipeline** — `createFramePipeline`: only the newest undecoded frame is kept (intermediates dropped), decode via `createImageBitmap(Blob)` (off-main-thread), paints coalesced on rAF drawing only the newest bitmap. | `lib/browser-frame-pipeline.ts`, wired in `useBrowserCaptureSession` | Under load the canvas shows the *freshest* frame instead of falling behind; drops are counted, not felt. |
| **Dev perf probe** — `localStorage['specrails-desktop:browser-capture-debug'] = '1'` → `console.table` every 2 s: `fpsReceived`, `fpsDrawn`, `droppedStale`, `droppedUndrawn`, `avgDecodeMs`, `avgDrawMs`. | `browser-frame-pipeline.ts` reporter | Cheap before/after measurement on real pages. |

Select-mode hover-probe throttling (rAF + 40 ms) is untouched — element-picker precision is unchanged.

## Popup support (OAuth login windows)

Pop-ups now work end-to-end — the design:

- **Adoption.** `PlaywrightPageHandle.onPopup` (Playwright `page.on('popup')`) hands every popup to the manager, which registers it on the session's `popups[]` stack. The popup lives in the **same browser context** natively, so cookies and the `window.opener`/`postMessage` relationship survive — exactly what completes an OAuth popup flow. Popups can themselves open popups (chained IdP windows): latest wins.
- **Routing split.** *Interactive* traffic (mouse/wheel/keys, clipboard — pasting credentials) targets the **viewed** page (top popup while `popupView`, else root). *Capture-ish* traffic (region capture, breakpoints, hover probe, URL-bar navigation, lastUrl persistence) **always targets the root page** — a popup is never the spec's subject. `resize` fans to root + all popups so coordinate mapping never diverges.
- **Screencast switch.** `applyScreencast` reconciles which page the CDP screencast runs on (`screencastPage`) against the active page on the same serialized per-session op chain; opening/closing/toggling a popup stops the cast on the old page and starts it on the new one (CDP emits a frame immediately on start, so the switch paints at once).
- **Lifecycle.** Popup `close` (the typical OAuth self-close) auto-returns to the opener — or to the next popup down. Session `kill`/`shutdown` closes all popups. Viewport is inherited at adoption.
- **Client.** WS `{type:'popup', count, active, url}` broadcasts (re-sent to late attachers, refreshed as the popup walks its redirect chain) drive a slim bar: *"Login window — <origin>"* + back-to-page while active; a *"Show login window"* chip while parked on the root; `+N` hint when stacked. Select mode is disabled (and force-exited) while a popup is viewed. The toggle is `POST /browser/sessions/:id/popup-view {target:'root'|'popup'}`.

## Tuning knobs

| Knob | Default | Effect |
|---|---|---|
| `SPECRAILS_BROWSER_SCREENCAST_QUALITY` (server env) | `70` | JPEG quality 1–100. Lower → smaller frames/higher fps; higher → crisper. |
| `localStorage['specrails-desktop:browser-capture-debug'] = '1'` (client) | off | Per-2s frame-pipeline stats in the console. |
| `MAX_CLIENT_BUFFERED_BYTES` (`browser-capture-manager.ts`) | 1 MB | WS backpressure threshold before frames are conflated per client. |

## Deferred / non-goals

- **DPR-aware streaming** (frames at `devicePixelRatio ×` for retina crispness) — costs 4× pixels; quality knob covers most of it. Revisit if crispness complaints appear.
- **Context prewarm on Add-Spec-modal open** — would shave the first-ever Chromium launch (~0.5–1 s); needs a hook outside the browser-capture surface. The shared context already persists across sessions, so only the first open pays it.
- **Input round-trip probe** — needs a server echo; the frame probe covers the visible symptom.

## Verification

Unit coverage: `server/browser-capture-manager.test.ts` (deferred nav, conflation, full popup lifecycle), `server/browser-playwright.test.ts` (`screencastParams`), `server/project-router.browser.test.ts` (popup-view route), `client/src/lib/browser-frame-pipeline.test.ts` (latest-wins/drop/dispose/stats), `client/src/lib/browser-capture.test.ts` (coalescer, popup helpers).

Manual QA feel-check list:

1. **Scroll fluidity** — open a long page (e.g. a docs site), trackpad-scroll fast: motion should track your fingers with no rubber-banding or seconds-later catch-up.
2. **Typing latency** — click a search box, type quickly: characters should appear with terminal-like latency.
3. **Cold open** — "From a website" on a slow site: the modal should show the page *painting* immediately, not a 10 s spinner.
4. **Picker precision** — select mode: hover highlight follows exactly, clicked element == captured element, breadcrumb ↑/↓ unchanged.
5. **Okta-style OAuth popup** — click a "Sign in with …" button: the login window takes over the canvas with the "Login window — <origin>" bar; complete the login (typing + ⌘V paste land in the popup); on the popup's self-close you're back on the opener **logged in**. "Back to page" / "Show login window" toggles views mid-flow.
6. **Perf numbers** — set the debug flag, repeat (1): `fpsDrawn` should sit near `fpsReceived` with `droppedUndrawn` low; during heavy load drops rise while the image stays *current*.
