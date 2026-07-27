## 1. Rust: native pane commands

- [x] 1.1 Add `unstable` + `devtools` features to the `tauri` dependency in `src-tauri/Cargo.toml`
- [x] 1.2 Create `src-tauri/src/browser.rs`: `browser_supported`, `browser_open`, `browser_navigate`, `browser_back`/`browser_forward`, `browser_reload`, `browser_set_bounds`, `browser_show`/`browser_hide`, `browser_close`, `browser_devtools`, `browser_zoom`; scheme validation; `on_navigation`/`on_page_load`/`on_new_window` wiring emitting `native-browser:event` to the main webview; Windows `data_directory` profile; `mod tests` for the pure helpers
- [x] 1.3 Register the commands in `lib.rs` `generate_handler` and verify `cargo check` (and `cargo test`) pass with the new features

## 2. Client: native pane surface

- [x] 2.1 Add `FEATURE_NATIVE_BROWSER` to `client/src/lib/feature-flags.ts`
- [x] 2.2 Create `client/src/lib/native-browser.ts`: `normalizeAddress` + scheme policy, `rectToBounds`, memoized `isNativeBrowserAvailable()` probe (isTauri + `browser_supported`), thin invoke/event wrappers with runtime-safe dynamic imports
- [x] 2.3 Create `client/src/components/browser-capture/NativeBrowserPane.tsx`: chrome (back/forward/reload/address/Go/devtools/zoom/close) + measured hole div, ResizeObserver + rAF bounds sync, `native-browser:event` subscription, open-failure reporting to the parent
- [x] 2.4 Route `WebViewModal.tsx` through the ladder: native pane when available, automatic per-session fallback to the legacy screencast variant on probe/open failure, untouched legacy path otherwise

## 3. i18n + coverage + docs

- [x] 3.1 Add the new `browser` namespace keys (devtools, zoom controls, native status) to all 8 locales; keep key-parity test green
- [x] 3.2 Unit-test `client/src/lib/native-browser.ts` (normalization, scheme rejection, bounds mapping, probe memoization + fallback); coverage-exclude `NativeBrowserPane.tsx` with an inline reason
- [x] 3.3 Update CLAUDE.md (native browser section) and mark the evaluation doc as implemented (phases 0–1)

## 4. Gates

- [x] 4.1 `npm run typecheck` + `cd client && npx tsc --noEmit` pass
- [x] 4.2 `npm test` + client tests pass; server and client coverage thresholds hold
- [x] 4.3 `cargo check` passes in `src-tauri` (macOS); note Windows QA follow-up in the design doc
