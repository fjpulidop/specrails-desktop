# Browser authentication popup audit

Date: 2026-09-05. Branch: `feat/codex-gpt-6-astra`.

## Scope and causes

The browser already supported first-level authentication windows. The audit found defects in nested windows, closure and asynchronous lifecycle handling, rather than a universal prohibition on `window.open`.

On macOS, a real WKWebView fixture reproduced two failures: the first popup's `on_new_window` handler explicitly denied another popup, and the installed Wry UI delegate did not implement `webViewDidClose:`. A page could deliver its authentication result with `postMessage` but leave its window open. The initial blank window, cross-origin redirects, shared cookies and opener relationship already worked.

The Chromium development path also completed the ordinary OAuth sequence. Regression tests reproduced missed children opened before subscription, closed pages adopted after an asynchronous opener lookup, missed closure notifications and an obsolete popup screencast failure disconnecting the whole session.

The review found two additional recovery problems in the streamed UI: browser navigation always targeted the root page even when a popup was visible, and switching back to the root changed the client optimistically while HTTP failures were ignored. Reloading a login could therefore reload its opener, or a failed view switch could enable root-page capture while the stream still showed the login.

## Implementation boundaries

- Native windows retain the engine-supplied `NewWindowFeatures`, including the opener configuration. They are actual related browser windows; an OAuth URL is not reopened in an unrelated browser profile.
- Nested native windows share the same pane owner and have a bounded live-window count. Closing a pane releases only its own windows. Creation failures produce an owner-scoped, localized error without exposing an OAuth URL or raw native error.
- The macOS close delegate handles only `webViewDidClose:` and forwards Wry's existing delegate behavior. It uses the public WebKit callback, without rewriting a site's JavaScript or exposing an application command to the page.
- Playwright subscription replay checks the direct opener, skips closed pages, deduplicates delivery and invalidates pending lookups when the parent closes. Late close subscriptions notify once. A superseded popup's failed CDP startup does not disconnect the opener.
- Streamed navigation targets the page selected when the action starts. Popup navigation returns `target: 'popup'` and does not replace or persist root-page metadata; the client takes popup metadata from the existing WebSocket events. View switching remains tied to server state, and failures remain visible without pretending a switch succeeded. Late responses are checked against the session, popup revision and latest switch request.

HTTP/HTTPS/about:blank navigation restrictions, Chromium request guards and the native app-command boundary remain enforced. This change does not disable browser origin isolation, alter an identity provider's COOP policy, or transfer cookies to the system browser.

## Reproducible acceptance checks

`node scripts/smoke-browser-popups.mjs` exercises the production Playwright page handle and session manager with temporary state and two synthetic local origins. It covers blank-window creation, cross-origin HTTP redirects, login input, cookies, `postMessage`, self-close, iframe-initiated login, nested second-factor windows, repeated immediate callbacks, late listener attachment and isolation between browser sessions.

The native popup fixture is under `src-tauri/examples/native-browser-popup-smoke.rs`. From `src-tauri`, run `cargo run --offline --example native-browser-popup-smoke --features native-browser-smoke` on macOS. It uses a temporary authentication fixture and an ephemeral browser store. It checks actual WebKit behavior, rather than substituting mocked window events: asynchronous opening, opener communication and cookies, nested windows, `_blank`, an iframe, immediate self-close, the window limit and retry, owner cleanup and denied remote app commands. The existing `native-browser-smoke` example also passes the Retina snapshot and selector regression checks after installing the popup delegate.

Unit and component regressions cover lifecycle races, navigation ownership, failed view switches and localized native popup errors. See the browser rendering and capture checks in [the Retina audit](browser-native-retina-audit.md) for the independent viewport and screenshot guarantees.

Completed checks for this patch:

- Server coverage: 282 files and 7,418 tests passed; 85.98% statements, 78.40% branches, 90.02% functions and 88.32% lines, with the existing thresholds.
- Client coverage: 354 files and 4,431 tests passed; 89.24% statements/lines, 83.00% branches and 74.58% functions, with the existing thresholds.
- Targeted popup checks: 120 server tests across the page handle, manager and HTTP routes; 61 client tests for the streamed browser and API; 63 client tests for the native pane, native API and locale parity.
- Rust: 26 library tests passed, plus `cargo check --offline --all-targets --features native-browser-smoke` and both actual WebKit smoke examples.
- Global TypeScript, the production server/client/CLI build and the Core 4.11.1 / Desktop 2.40.0 compatibility check passed.

No real Okta tenant, credentials, production database or user browser profile is used. Passing the synthetic OAuth flows does not certify every organization's identity-provider policy. Windows native behavior still needs a real Windows smoke run; macOS WebKit and Chromium are the locally exercised engines. Native changes require rebuilding the desktop application and do not replace an installed signed release.

## Reference

The [official Okta Auth JS documentation](https://github.com/okta/okta-auth-js/) describes popup flows that exchange results with `window.postMessage`, and a distinct redirect-based flow for external identity providers whose COOP headers separate browsing contexts. Preserving browser-native opener semantics is necessary; overriding those security policies in Specrails would not be a valid interoperability fix.
