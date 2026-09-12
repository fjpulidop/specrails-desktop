# Verification — 2026-09-06

Implementation remains on `codex/multi-repo-projects`, alongside the existing branch work. No commit, push, release or PR was made for this change.

## Local evidence

- Complete client suite: **385 files, 4,830 tests passed**. After that full run, the final browser presentation/rollback regressions and controller retry cases passed in focused runs: 46 tests across the controller and capture suites, plus 2 React binder tests.
- Native Rust suite: **45 tests passed**.
- Native macOS mission fixture passed: independent windows and Home scope, hidden hydration, idempotent detach, native close/reintegration acknowledgement, timeout rollback, stale acknowledgements, popup destruction, main hide-to-tray, deleted-conversation cleanup and renderer IPC restrictions.
- Native macOS browser fixtures passed: Retina capture and DOM selection; OAuth popups including cross-origin/nested/self-close behavior; independent sessions, occupied destination parking, explicit adoption, rollback without orphan pages, hidden popups, source destruction with a surviving OAuth popup, per-window events and stale cleanup.
- Full application TypeScript checks and production server/client/CLI builds passed. The client build retains the existing large-chunk advisory.
- Strict OpenSpec validation passed; `git diff --check` passed.

Logs from this run are under `/tmp/specrails-mission-*`, `/tmp/specrails-browser-multiwindow-rust.log` and `/tmp/specrails-native-*.log`. Fixtures use in-memory/local pages and isolated browser data. They do not launch agents or access user project databases.

## Regression coverage

Frontend tests cover macOS and Windows control profiles, main project/preferences isolation, Home missions, native availability fallback, source mutation guards, focus routing, actual React restoration before acknowledgement, simultaneous reintegrations, reload retry, stale responses, draft/reference/attachment and retry-identity recovery, pending capture protection, browser lease replay and translated actions in all eight locales.

## Windows acceptance

The implementation uses independent native windows and WebView2 on Windows. CI now runs the client regressions and all four native fixtures on both Windows x64 and ARM64, with an equivalent native macOS gate. **These Windows jobs have not run for this unpushed working tree.** A macOS run or a simulated `Win32` browser profile is not proof of actual Windows behavior.

Installed Windows behavior and mixed-DPI/multiple-monitor acceptance still require native Windows results. No claim of 100% real-device validation is made.

## Scope of recovery

During a failed transfer the source remains available, and the destination never acknowledges obsolete state. A normal renderer reload can recover its latest draft from that window's session storage. Abrupt destruction of a renderer can recover only its last transferred snapshot in the native registry; this feature does not introduce durable cross-process autosave or restore window placement after the entire application exits.

See `docs/features/detachable-mission-windows.md` for usage, architecture, limits and the platform test matrix.
