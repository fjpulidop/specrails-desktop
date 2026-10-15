## ADDED Requirements

### Requirement: Preview target discovery
Desktop SHALL derive preview targets from the log output of running mission background processes. Other sources, such as Desktop terminals, are out of scope. A preview target is an http(s) URL whose host is loopback (`localhost`, `127.0.0.0/8`, `::1`) or the wildcard bind address (`0.0.0.0`, `::`), normalized to `http://localhost:<port>`. Detection MUST strip ANSI escape sequences, deduplicate by origin, and keep the most recently announced URL first. A target MUST disappear when its process exits. The gateway SHALL expose targets only for processes the device is already authorized to see.

#### Scenario: Vite dev server announces its URL
- **WHEN** a mission's background process logs `  ➜  Local:   http://localhost:5173/`
- **THEN** the process's preview targets include `http://localhost:5173/`

#### Scenario: Wildcard bind is normalized
- **WHEN** a process logs `listening on http://0.0.0.0:3000`
- **THEN** the preview target is `http://localhost:3000/`

#### Scenario: Process exits
- **WHEN** the background process that announced a target exits
- **THEN** the target is no longer listed and new preview sessions to that origin are rejected

#### Scenario: Unauthorized process
- **WHEN** a device lacking the grant needed to see a process requests its preview targets
- **THEN** the gateway rejects the request without revealing the URL

### Requirement: Preview session lifecycle
A paired device SHALL be able to open a preview session for an announced target, then navigate it (goto/back/forward/reload), resize its viewport and close it. Preview sessions MUST reuse the project's server-side browser session engine, including idle sweep, popup handling and teardown. Preview sessions MUST NOT count against the Desktop per-project session limit. Instead, each device MUST hold at most one preview session, and opening another one MUST replace it. A project MUST hold at most two device-owned sessions. A session opened by a device MUST be marked as owned by that device. Only that device MAY attach to or close it from the gateway. Closing the frame channel MUST detach the device without killing the session immediately, and the idle sweep MUST reclaim it.

#### Scenario: Open a preview
- **WHEN** an authorized device opens a preview for `http://localhost:5173/`
- **THEN** Desktop creates a browser session at that URL with the device's viewport and returns its id

#### Scenario: Desktop sessions do not block the phone
- **WHEN** the Desktop user already has 4 browser sessions open in the project
- **THEN** a device can still open a preview session

#### Scenario: Same device opens a second preview
- **WHEN** a device with an open preview session opens a preview of another target
- **THEN** the previous session is killed, its channel receives `closed`, and the new session is returned

#### Scenario: Device budget reached
- **WHEN** two other devices already hold preview sessions in the project
- **THEN** the gateway returns a limit error that Companion shows as a recoverable message

#### Scenario: Another device tries to attach
- **WHEN** a different paired device requests the frame channel for a session it does not own
- **THEN** the request is rejected

#### Scenario: Browser capture disabled
- **WHEN** browser capture is disabled on Desktop
- **THEN** the `appPreview` capability is reported as unavailable and preview routes return a disabled error

### Requirement: Origin-pinned navigation
Preview sessions MUST allow navigation to a loopback/private origin only while that exact origin is an announced preview target of the same project. All other navigations MUST pass the existing server-side SSRF guard. The policy MUST apply to every navigation entry point: initial URL, gateway navigate, and in-page link or redirect handled by the browser.

#### Scenario: Navigate within the app
- **WHEN** the user taps a link from `http://localhost:5173/` to `http://localhost:5173/settings`
- **THEN** the page navigates

#### Scenario: Navigate to an unannounced loopback port
- **WHEN** a preview session is asked to go to `http://localhost:4200/` and no running process announced that origin
- **THEN** the navigation is rejected and the session stays on its current page

#### Scenario: Page-initiated public URL
- **WHEN** the previewed page redirects or links to a public `https://` URL (e.g. an OAuth provider)
- **THEN** the navigation follows the existing guard and succeeds

#### Scenario: Manual public URL from the phone
- **WHEN** a device sends a gateway navigate to a public URL that is not an announced origin
- **THEN** the gateway rejects it, because manual navigation only accepts paths on announced origins

### Requirement: Dedicated frame and control channel
Desktop SHALL stream each preview session over its own DataChannel labelled `preview:<sessionId>` on the device's existing peer connection, without SDP renegotiation and without changing the `mobile` channel protocol. JPEG frames MUST be sent as binary messages, fragmented when they exceed the safe message size and reassembled by Companion. Control (`nav`, `popup`, `closed`) MUST be sent as JSON text. When the channel's send buffer exceeds the conflation threshold, Desktop MUST skip frames (newest wins), and the next delivered frame MUST be complete.

#### Scenario: Large frame
- **WHEN** a screencast frame is larger than the maximum message size
- **THEN** Companion receives it in chunks and renders only the fully reassembled frame

#### Scenario: Slow phone
- **WHEN** the phone falls behind and the channel buffer is above the threshold
- **THEN** intermediate frames are dropped and the latest frame is shown, with no growing latency

#### Scenario: RPC stays responsive
- **WHEN** a preview is streaming
- **THEN** RPC requests on the `mobile` channel keep completing without waiting behind frames

### Requirement: Touch and keyboard input mapping
Companion SHALL translate gestures into browser input events in page coordinates, accounting for letterboxing and device scale. A tap becomes mouse down/up, a long press becomes a right click, a vertical or horizontal drag becomes wheel scroll, and soft-keyboard text becomes key events. Desktop MUST rate-limit inbound input as on the existing browser WebSocket.

#### Scenario: Tap a button
- **WHEN** the user taps a button rendered in the preview
- **THEN** the page receives a click at the matching coordinates

#### Scenario: Type into a field
- **WHEN** the user focuses a text input and types with the soft keyboard
- **THEN** the characters appear in the field

#### Scenario: Rotate the phone
- **WHEN** the viewer size changes
- **THEN** Companion sends a resize and the session viewport follows within normalized bounds

### Requirement: Viewer states and degradation
Companion SHALL show honest viewer states: connecting, live, reconnecting, session closed, and target gone. It SHALL offer the preview action only when Desktop reports the `appPreview` capability and the process has at least one target. On reconnection it MUST re-attach to the same session if it still exists, otherwise it MUST offer to reopen the target. The native and web companion MUST behave the same.

#### Scenario: Older Desktop
- **WHEN** Desktop does not report `appPreview`
- **THEN** no preview action is shown and existing process views are unchanged

#### Scenario: Wi-Fi drop
- **WHEN** the peer connection drops and recovers while the session is still alive
- **THEN** the viewer re-attaches and resumes from a fresh frame

### Requirement: Desktop viewing indicator
Desktop SHALL show, in all supported locales, which browser sessions are owned by a paired device, and SHALL let the user end such a session from Desktop.

#### Scenario: User ends a phone preview from Desktop
- **WHEN** the user closes a device-owned session on Desktop
- **THEN** the session is killed and Companion shows "session closed"
