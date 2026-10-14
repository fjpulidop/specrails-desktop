## Why

When the user asks a mission agent to "start the app", Desktop runs the dev server as a background process and Specrails Companion already shows that process and its logs. The user still cannot *see* the running web app from the phone. That is the missing step in driving a project away from the desk. The app usually listens only on the Desktop machine's loopback (`http://localhost:5173`), so the phone cannot reach it. Opening it on the LAN would bypass the paired-device authorization and break for the HTTPS web companion (mixed content). Desktop already has a server-side Playwright browser with a CDP screencast and remote input. Companion already holds an authenticated WebRTC DataChannel to Desktop. Connecting the two gives a private, LAN-only remote view of the app that works for both the native and the web companion.

## What Changes

- **Desktop – preview targets**: detect the local URLs a project's background processes announce in their logs (`Local: http://localhost:5173/`, `ready on http://127.0.0.1:3000`, …). Expose them as *preview targets* on the mobile gateway, scoped to the processes the device is authorized to see.
- **Desktop – preview sessions**: let a paired device open, navigate, resize and close a server-side browser session pointed at a preview target. Reuse `BrowserCaptureManager` sessions, limits, idle sweep, popups and input dispatch.
- **Desktop – narrow loopback exception**: the screencast path's SSRF guard currently rejects every loopback/private URL. Preview sessions MAY navigate to loopback origins *only* when the origin is currently announced by a running background process of that project. Every other navigation keeps the existing guard. **Modifies** the `native-browser-pane` rule that the server-side guard stays unchanged.
- **Desktop – frame channel**: stream screencast JPEG frames and session control over a dedicated per-session WebRTC DataChannel on the existing peer connection, so frames never block the RPC channel. Large frames are fragmented into binary chunks, and frames are dropped (newest wins) when the phone falls behind.
- **Desktop – gateway surface**: add preview routes to the `/v1` allow-list, add a `appPreview` capability flag, and show a Desktop-side indicator while a paired device is viewing a session.
- **Companion (native + web)**: add a "Preview" action on processes that announce a URL. It opens a full-screen viewer that renders the frames, maps taps, drags, pinch/scroll and text input to browser input events, and offers back/forward/reload, an address bar limited to allowed origins, a popup view, and reconnect. Older Desktops degrade cleanly.

## Capabilities

### New Capabilities
- `companion-app-preview`: remote, read/interact view of a project's locally served web app from a paired Companion. Covers preview-target discovery, session lifecycle, authorization, the frame/control channel, input mapping, degradation and the Desktop viewing indicator.

### Modified Capabilities
- `native-browser-pane`: the requirement "Localhost and private addresses are navigable in the native pane" currently says the server-side screencast path keeps its SSRF guard unchanged. It now allows a narrow, process-announced loopback exception for companion preview sessions only.

## Impact

- **Desktop server**: `server/mobile/*` (router allow-list, capabilities, DataChannel peer, WebRTC peer), `server/modules/browser/runtime/*` (session ownership/origin policy, navigation guard), `server/modules/terminals/runtime/*` and `server/transient-children.ts` (URL detection from background process logs), `server/index.ts` (no change to the existing `/ws/browser/:id` path).
- **Desktop client**: browser session list/indicator for companion-owned sessions; i18n in all locales.
- **Companion** (`/Users/javi/repos/specrails-companion`): `lib/data/webrtc_transport.dart` (accept extra binary channels), a new preview repository/model, a new `features/preview/` viewer, entry points in missions/jobs process views, translations. The web build shipped through `specrails-web` picks it up unchanged.
- **Contracts**: additive. New `/v1` routes, a new capability flag and a new DataChannel label family (`preview:<sessionId>`). The existing `mobile` channel protocol and `/ws/browser/:id` are unchanged.
- **Dependencies**: none new (`werift`, `flutter_webrtc`, Playwright/Chromium already bundled). Requires browser capture to be enabled on Desktop.
- **Performance**: JPEG frames (~30–150 KB) over the LAN. Expected 5–15 fps on Wi-Fi. This is a usability preview, not video streaming.
