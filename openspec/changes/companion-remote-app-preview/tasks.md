## 1. Desktop – preview target discovery

- [x] 1.1 Add pure `extractPreviewUrls(line)` (ANSI strip, loopback/wildcard normalization to `http://localhost:<port>/`, dedupe) with unit tests for Vite, Next, CRA, Astro, `0.0.0.0`, `[::1]`, `127.0.0.1` and noise lines
- [x] 1.2 Derive announced origins on demand from running processes' log snapshots (`runtime/preview-targets.ts`, memoised per log tail): exited processes stop contributing and recovered (`interrupted`) ones never do; tests for exit clearing and recovery
- [x] 1.3 Expose `announcedOrigins(projectId)` and per-process targets through a narrow port consumed by the browser and mobile modules (no undeclared cross-module imports; update `server/modules/boundaries.json` and architecture tests if needed)
- [x] 1.4 Publish `background_process.preview_targets` (identity only, once per new origin) from the process hooks; the mobile bridge forwards it as a `mission.updated` invalidation

## 2. Desktop – browser session ownership and origin policy

- [x] 2.1 Add `owner` (`desktop` | `{kind:'device', deviceId}`) to `BrowserSession`/`BrowserSessionMeta`; default `desktop`; include in session list responses (additive)
- [x] 2.2 Implement pure `PreviewOriginPolicy` (`isNavigableUrl` OR device-owned AND origin announced for the project) with tests for allowed, unannounced port, public URL, `file:`/`data:`
- [x] 2.3 Apply the policy at create (`initialUrl`) and `navigate` for device-owned sessions; keep `isNavigableUrl` unchanged for desktop-owned sessions (test that a desktop session still rejects `http://localhost:*`)
- [x] 2.4 Add a context-level main-frame/request guard for device-owned sessions (abort unannounced loopback documents and subresources); tests for link, redirect, `window.open` popup and `fetch` to an unannounced port
- [x] 2.5 Kill device-owned sessions on device revoke; ensure idle sweep reclaims detached device sessions
- [x] 2.6 Separate device budget: device sessions excluded from `MAX_SESSIONS_PER_PROJECT`; one per device (opening another replaces and kills the previous one, sending `closed`); max two device sessions per project; tests for 4 desktop sessions + phone open, same-device replace, third device rejected

## 3. Desktop – preview DataChannel

- [x] 3.1 Implement `DataChannelBrowserClient` adapting a werift `RTCDataChannel` to `BrowserWsClient` (readyState, bufferedAmount, text vs binary send)
- [x] 3.2 Implement binary fragmentation (`u32 frameSeq | u16 index | u16 count` + payload, 16 KB) with per-frame conflation before the first chunk; unit tests for split/size boundaries and never-partial frames
- [x] 3.3 Open `preview:<sessionId>` channels on the device's existing peer from the open-session use case; attach to `BrowserCaptureManager`; detach on channel close/error; reject attach for non-owner devices
- [x] 3.4 Handle inbound channel JSON (`input`, `navigate`) with the same rate limiting as `/ws/browser/:id`; validate events
- [x] 3.5 Integration test with a fake peer: open → frames arrive reassembled → input dispatched → close detaches; RPC on `mobile` stays responsive while streaming

## 4. Desktop – gateway surface

- [x] 4.1 Add the preview routes to `MOBILE_ALLOWLIST` and mobile router (targets, open, navigate, close) with mission all-project grant enforcement and redaction
- [x] 4.2 Add `appPreview` to `/v1/capabilities` (browser capture enabled + runtime support); disabled error when off
- [x] 4.3 Router tests: restricted device rejected, unknown process/target rejected, limit error shape, disabled capability, manual navigate to a public or unannounced URL rejected (path on announced origin accepted)
- [x] 4.4 Update `docs/internals/api-reference.md` and the mobile/companion internals doc with routes, channel label family and frame format

## 5. Desktop – client indicator

- [x] 5.1 Show device-owned sessions in Settings ▸ Mobile under each paired device ("Viewing <url> · <project>") with an end-preview action (`GET/DELETE /api/mobile/previews`, `mobile.previews_changed`)
- [x] 5.2 Add strings to all supported locales; component tests for badge and end action

## 6. Companion – transport and data (`specrails-companion`)

- [ ] 6.1 Extend `WebRtcTransport`/`PeerTransport` to surface additional adopted channels by label without touching `mobile` handling; fake-transport tests
- [ ] 6.2 Implement the binary chunk reassembler (newest `frameSeq` wins, render only complete frames) with unit tests mirroring the Desktop format
- [ ] 6.3 Add `PreviewRepository` + models (targets, open/navigate/close, `PreviewStream` of frames + control) gated by the `appPreview` capability; demo repository returns no targets
- [ ] 6.4 Refresh targets on `preview_targets_changed` push and on reconnect

## 7. Companion – viewer

- [ ] 7.1 Add `features/preview/` full-screen viewer rendering frames (`gaplessPlayback`, contain-fit) with connecting/live/reconnecting/closed/target-gone states
- [ ] 7.2 Implement coordinate mapping (letterbox + DPR) and gestures: tap, long-press right click, pan→wheel, local pinch zoom, soft keyboard→key events; widget tests for mapping
- [ ] 7.3 Send resize on open/rotation/resize clamped to Desktop bounds
- [ ] 7.4 Navigation chrome: back/forward/reload, origin picker (announced origins) + path input (no free URL entry), popup banner
- [ ] 7.5 Add the "Preview" entry point on mission process rows/log views that have targets; hidden when capability absent
- [ ] 7.6 Re-attach to the same session after reconnection or offer reopen
- [ ] 7.7 Translations for every Companion locale

## 8. Verification

- [x] 8.1 Desktop: `npm run typecheck`, `npx vitest run server/mobile server/modules/browser server/modules/terminals server/modules`, client tests for the indicator, `npm run audit:architecture`, `npm run docs:source-map` if files were added
- [ ] 8.2 Companion: `flutter analyze`, `flutter test`, `flutter build web` and native build
- [ ] 8.3 Manual smoke: mission starts `npm run dev` (Vite) → Companion native on iPhone and web companion via specrails-web preview it, tap/type/scroll work, unannounced port rejected, Desktop badge ends the session, Wi-Fi drop re-attaches
- [ ] 8.4 Measure fps/latency on LAN and record numbers in the internals doc
