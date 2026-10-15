## Context

- **Companion transport.** Companion (Flutter, native + web build served by `specrails-web`) talks to Desktop over one WebRTC DataChannel labelled `mobile`. Desktop is the offerer (`werift`, `server/mobile/mobile-webrtc-peer.ts`), the SDPs travel by QR, and the link is LAN-only with host ICE candidates. On top runs `DataChannelPeer` (`server/mobile/mobile-datachannel.ts`): JSON RPC to the `/v1` allow-list (`MOBILE_ALLOWLIST`), push events, and `__chunk` text fragmentation at 16 KB.
- **Desktop browser.** `BrowserCaptureManager` (per project, `server/modules/browser/runtime/`) runs Playwright Chromium sessions. Each one has a CDP screencast (raw JPEG `Buffer` per frame), input dispatch (`BrowserInputEvent`: mouse, wheel, key, resize), popups, a limit of 4 sessions per project and a 10-minute idle sweep. Clients attach through the structural `BrowserWsClient` (`readyState`, `bufferedAmount`, `send(string|Buffer)`, `close`). Frame fan-out already conflates on `bufferedAmount` (newest wins).
- **Loopback is blocked server-side.** `isNavigableUrl` rejects loopback/private hosts for every server-side navigation entry point (BUG-BROWSER-01), and the `native-browser-pane` spec says this path keeps that guard. In-page navigations (link clicks, redirects) are not intercepted today.
- **Processes.** Mission background processes (`BackgroundProcess`: `projectId`, `chatId`, `cwd`, `command`, status) and their log lines are persisted by `BackgroundProcessStore`. Companion already lists them and tails their logs through `/v1/projects/:pid/missions/:cid/processes[...]`.

## Goals / Non-Goals

**Goals:**
- Show the user's locally served web app on the phone, live and interactive, from both the native and the web Companion.
- Keep the security posture: deny by default, paired-device grants enforced, no LAN exposure of dev servers, loopback reachable only for origins the project itself announced.
- Reuse the existing browser session engine and peer connection. Do not add a new server or dependency.

**Non-Goals:**
- Real video streaming (H.264/VP8 media tracks), audio, or high-fps animation fidelity.
- Previewing native or mobile apps, or apps not started as a Desktop background process. Desktop-native pane sessions and terminals started outside missions are possible later sources, see Open Questions.
- Remote access outside the LAN (no TURN/relay). This follows the existing companion constraint.
- DevTools, element capture or spec creation from the phone. These remain Desktop features.

## Decisions

### D1. Reuse the server-side Playwright session, not a tunnel
Desktop renders the page in its own Chromium and ships pixels; the phone sends input.
- *Alternative A, HTTP/WS tunnel over the DataChannel* (WebView or service worker proxy): rejected. HMR WebSockets, absolute URLs, cookies, CORS and service workers make it fragile, and Flutter web cannot intercept iframe traffic.
- *Alternative B, bind the dev server to the LAN*: rejected. It requires changing the user's app config, bypasses device grants, and the HTTPS web companion cannot embed `http://` (mixed content).

### D2. A per-session DataChannel `preview:<sessionId>` on the existing peer
Desktop calls `pc.createDataChannel('preview:<id>', { ordered: true })` after the preview open RPC. A new channel on an established SCTP association needs no SDP renegotiation, and Companion already adopts channels through `onDataChannel`.
- *Why a separate channel:* the `mobile` channel carries RPC. Frames there would cause head-of-line blocking for every request and would break its JSON-only framing.
- *Why ordered + reliable rather than `maxRetransmits: 0`:* loss is rare on a LAN, and a reliable channel keeps chunk reassembly trivial. Freshness comes from `bufferedAmount` conflation, the same mechanism the WS path already uses.
- The channel is wrapped in a `DataChannelBrowserClient` adapter implementing `BrowserWsClient`, so `BrowserCaptureManager.attach/detach` and the fan-out stay unchanged. `readyState` maps to channel state, `bufferedAmount` maps to the SCTP buffer, a string `send` becomes a text message and a `Buffer` `send` becomes binary fragments.

### D3. Binary fragmentation format
Frames above 16 KB (the safe cross-stack message size already used for text) are split into binary messages, each with an 8-byte header: `u32 frameSeq | u16 index | u16 count` (big-endian), followed by the payload. Companion keeps a single in-progress frame. A chunk with a newer `frameSeq` discards the incomplete older one, and a frame renders only when all chunks are present. Conflation runs per frame, never per chunk: the adapter checks the threshold before sending the first chunk and then sends the whole frame. A partial frame is therefore never sent.

### D4. Origin-pinned loopback policy
A `PreviewOriginPolicy` (a pure domain function plus a provider of announced origins per project) decides whether a preview session may navigate to `url`:
`isNavigableUrl(url) || (session.owner.kind === 'device' && announcedOrigins(projectId).has(origin(url)))`.
- It is applied at session create, gateway navigate, and through a Playwright `context.route` / main-frame request guard for in-page document navigations of device-owned sessions. A rejected navigation aborts and keeps the current page. Subresource requests to the same announced origin are allowed. Other loopback subresources are aborted.
- Regular screencast sessions are not affected (the `native-browser-pane` delta).
- *Alternative, an explicit per-session allowlist set by the user*: rejected. It adds UI and is easier to abuse. The process announcement is the evidence that the project owns that port.

### D5. URL detection from process logs
A pure `extractPreviewUrls(line)` (ANSI-stripped, loopback/wildcard hosts normalised to `localhost`, explicit port required) runs over the log snapshot of each running mission process. `createPreviewTargetSource` derives targets on demand and memoises them per process, keyed on the log tail. An exited process stops contributing, and a process recovered after a restart (`interrupted`, OS state unknown) never contributes. Targets are derived state and are never persisted. The manager caches the announced-origin set for 1 s, because the request guard consults it on every request. The process hooks emit `background_process.preview_targets` (identity only, once per newly seen origin), and the mobile bridge forwards it as a `mission.updated` invalidation.

### D6. Gateway surface and authorization
New allow-list entries:
- `GET  /v1/projects/:pid/missions/:cid/preview-targets` (`{ targets: [{ processId, urls }] }`)
- `POST /v1/projects/:pid/preview-sessions`: body `{ missionId, processId, url, viewport }`, returns `{ sessionId, channel, url }`
- `POST /v1/projects/:pid/preview-sessions/:sid/attach` (re-attach on a new channel after a reconnect)
- `POST /v1/projects/:pid/preview-sessions/:sid/navigate`
- `DELETE /v1/projects/:pid/preview-sessions/:sid`

Process-derived routes reuse the mission authorization: all-project grant, per the `mobile-mission-control` spec. Resize and input go over the preview channel as JSON (`{type:'input', event}`), rate-limited like `/ws/browser/:id`. `/v1/capabilities` gains `appPreview: boolean`, which is true when browser capture is enabled and the runtime supports it. The session `owner` (`{kind:'device', deviceId}`) is stored on `BrowserSession`. Revoking a device kills its sessions.

### D7. Companion viewer
- **Data.** A `PreviewRepository` exposes targets, open/navigate/close and a `PreviewStream` that yields decoded frames plus control events. `WebRtcTransport` gains `channels`, a stream of extra adopted channels keyed by label. The existing `mobile` handling is untouched.
- **Rendering.** `Image.memory(gaplessPlayback: true)` with `BoxFit.contain`, sized to the session viewport. Coordinates map from the letterboxed view to page space.
- **Gestures.** Tap becomes mouse down/up, long press becomes right click, pan becomes wheel deltas, and a hidden `TextField` becomes key events (`Enter`, `Backspace` mapped). Pinch zooms the view locally and is not sent to the page.
- **Viewport.** On open, rotation and resize, the viewer requests the phone's logical size × DPR clamped by `normalizeBrowserViewport`, so responsive layouts render as on a phone.
- **Chrome and states.** Back/forward/reload, an origin chip with an address field limited to announced origins, a popup banner, and the honest states from the spec. The same widget runs in the native and web builds.

## Risks / Trade-offs

- [Bandwidth and latency on weak Wi-Fi] → newest-wins conflation, a phone-sized viewport (fewer pixels than desktop), and JPEG quality from the existing env tuning. A per-session quality hint is a possible follow-up.
- [SCTP max message size differs across stacks (werift / libwebrtc / browsers)] → fixed 16 KB fragments, proven for the text path.
- [An in-page navigation guard misses an edge case (service worker, `window.open`)] → popups already route through `adoptPopup`, and the guard is applied at the context level, so popups inherit it. Tests cover redirect, link, `window.open` and `fetch` to an unannounced port.
- [A port announced by one project is reused by another app after exit] → targets are cleared on process exit, and the policy is evaluated per navigation, not cached per session.
- [Sessions created from the phone compete with the Desktop user's sessions] → device sessions have their own budget (R2: one per device, two per project), are visible and closable on Desktop, and are reclaimed by the idle sweep.
- [Browser capture disabled or Chromium missing] → `appPreview: false` and the action is hidden.

## Migration Plan

Additive and capability-gated. Ship Desktop first: older Companions ignore the new capability and channels. Then ship Companion: on older Desktops it hides the action. Rollback is disabling `appPreview` (browser capture flag) or reverting either side independently. No DB migration.

## Resolved Questions

### R1. Sources of preview targets: mission background processes only (v1)
The flow this change serves is "ask the agent to start the app". That always produces a mission `BackgroundProcess` with structured, persisted log lines and a `projectId`. Desktop PTY terminals carry raw, redrawn TTY output (spinners, clears, cursor moves), so URL detection there is noisier. Terminals also have no grant model in the gateway today. The discovery port (`announcedOrigins(projectId)`) is source-agnostic, so terminals or project run scripts can feed it later in a separate change without touching the policy or the channel.

### R2. Device sessions get their own budget: one per device, at most two per project
Device-owned sessions do not count against `MAX_SESSIONS_PER_PROJECT` (4), so a phone can never take away the Desktop user's browser sessions. Each device holds at most **one** preview session. Opening a preview from a device that already has one replaces the old session, which is killed and its channel gets `closed`, because a phone shows one viewer at a time. A project holds at most **two** device-owned sessions across all devices. Beyond that the gateway returns the recoverable limit error. The existing idle TTL still applies.

### R3. Manual address field: announced origins only
The phone's address field accepts only paths on announced origins (an origin picker plus a path input). It does not accept arbitrary public URLs. Allowing them would turn Desktop into a general-purpose browser proxy for the phone, egressing from the user's machine and network, with no benefit for previewing the app. Public navigations *initiated by the page* (OAuth redirects, external links, login popups) still pass the existing SSRF guard. Login flows started inside the app therefore keep working.
