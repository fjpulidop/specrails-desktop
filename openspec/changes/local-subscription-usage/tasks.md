## 1. Deferred implementation checkpoint

- [x] 1.1 Wait for explicit implementation authorization after the pending Specrails integrations; re-inspect status and rebaseline provider visibility, Core/runtime ownership, app settings and sidebar entry points without overwriting user work.
- [x] 1.2 Verify current Claude OAuth endpoint/credential locations and Codex generated read-only RPC contract; record supported CLI/platform/auth matrix with sanitized fixtures, and revise design evidence gates before coding adapters.
- [x] 1.3 Review the static visual reference and finalize placement against the post-integration UI; preserve consumed-quota, freshness and missing-value semantics.

## 2. Domain and collection

- [x] 2.1 Add the subscription-usage module contracts, normalization functions and focused tests for zero/null/invalid percent, UTC conversions, reordered windows and model-specific quotas.
- [x] 2.2 Add bounded same-context Claude OAuth credential reads and HTTP collection with denied Keychain, API auth, timeout, invalid payload and no-secret-output fixtures.
- [x] 2.3 Add isolated Codex account/rate-limit RPC collection using command/environment helpers; cover supported/unsupported methods, startup failure, partial frames, identity, timeouts and owned-process shutdown without thread/turn calls.
- [x] 2.4 If shared RPC utilities are extracted, run existing Codex live-session cancellation/settlement regressions and preserve the execution transport contract.

## 3. Service and API

- [x] 3.1 Implement machine/auth-context cache, opaque generations, revision ordering and before/after auth checks; test account switch during refresh, late replies, sign-out and unchanged-account transient errors.
- [x] 3.2 Implement single-flight refresh, two-provider concurrency, 30-second minimum interval, visible-demand cadence, freshness/reset expiry and Retry-After/exponential backoff with an injected clock.
- [x] 3.3 Add authenticated desktop GET/POST routes and composition/disposal hooks; cover malformed body, provider effects absent from GET, independent outcomes, existing route precedence and no project state dependencies.

## 4. Shared UI state and surfaces

- [x] 4.1 Add validated global-origin API client and shared host-scoped store/hook; test hidden/unmounted timer cleanup, shared consumers, delayed responses, revisions and refresh timeout recovery.
- [x] 4.2 Build always-detailed panel, window rows and localized date/freshness formatting; cover zero, null, stale, signed-out, unsupported, throttled and partial-success snapshots.
- [x] 4.3 Mount footer Usage summaries for Claude and Codex in mission and board, with a viewport-bounded hover/focus menu containing all quotas.
- [x] 4.4 Add global settings Subscription usage section inside the existing app modal; preserve runtime-provider draft edits and project route without extra detail/provider-management actions.
- [x] 4.5 Add all supported locale keys, theme-token styling, accessible progress/status semantics without persisting usage/identity or presentation preferences.

## 5. Verification and release documentation

- [x] 5.1 Update public APIs, reviewed server/client boundary manifests, fixed architecture rules, module/feature READMEs and narrow user guide; run source-map generation and separate generated changes.
- [x] 5.2 Run `npm run typecheck`, subscription-usage server suites, affected desktop route/provider lifecycle suites, client feature/sidebar/settings tests and `npm run audit:architecture`; do not lower coverage thresholds.
- [x] 5.3 Run build/package checks for the new module and subprocess resource path; run `npm run check-core-compat` if Core/provider transport integration changes.
- [ ] 5.4 Perform visual QA for light/dark/effect themes, collapsed rail, narrow viewport, long translations, 200% zoom, keyboard/screen reader semantics and reduced motion against the static reference.
- [x] 5.5 Perform explicitly authorized local read-only provider smoke checks on the supported matrix without logging credentials; document unsupported combinations, rollback/disposal and freshness limits before enabling UI.
