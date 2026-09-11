# Verification — Windows feature parity

## Environment and scope

The implementation and local regression checks were performed on macOS arm64. The existing branch's multi-repo, steering, process-log and file-explorer work is preserved. No release, real provider request or user project mutation was performed for this audit.

## Executed checks

- Release manifest and packaged ConPTY helper: 10 Node tests passed (`/tmp/specrails-windows-packaging.log`).
- Actual node-pty package contents for Windows x64 and ARM64: required DLLs, EXEs and native modules present; staged helper patch applies to both layouts. These binaries were inspected, not executed on macOS.
- Host control, Windows profile helpers, prompt transport, filesystem/SQLite recovery and Codex plugin configuration: initial focused run 5 suites / 48 tests passed (`/tmp/specrails-windows-focused.log`).
- Feature proposal Ctrl+Enter, shortcut panel and AI edit UI: 3 suites / 89 tests passed (`/tmp/specrails-windows-shortcuts.log`).
- Updated workflow YAML parses successfully. Tauri config validates against the installed CLI JSON schema.

Final checks after the Job Object implementation was frozen:

| Check | Executed result |
| --- | --- |
| Full server suite with an isolated temporary home | 324 files / 8,062 tests passed; 2 Windows-only files / 7 tests skipped. `/tmp/specrails-windows-server-full.log` |
| Two server suites that manage their own HOME fixtures, run separately | 2 files / 23 tests passed. `/tmp/specrails-windows-home-fixtures.log` |
| Combined server result | **326 files / 8,085 tests passed**, 7 Windows-only tests unexecuted |
| Full client suite | **378 files / 4,762 tests passed**. `/tmp/specrails-windows-client-full.log` |
| TypeScript server/client | Passed. `/tmp/specrails-windows-typecheck-final.log` |
| Application production build | Passed. `/tmp/specrails-windows-build.log` |
| Rust host tests | **33 passed**. `/tmp/specrails-windows-native-tests-final.log` |
| Rust all-targets native smoke feature check | Passed on macOS. `/tmp/specrails-windows-native-check-final.log` |
| Native browser capture/selector and popup fixtures | Passed on macOS, including physical pixel dimensions, zoom and 8 popup blocks. `/tmp/specrails-windows-native-browser-smoke-final.log`, `/tmp/specrails-windows-popup-smoke.log` |
| Chromium CDP DPR regression | Both session configurations produced PNG 400×200 for CSS 200×100 at DPR2. `/tmp/specrails-windows-capture-smoke.log`, `/tmp/specrails-windows-capture-metrics-smoke.log` |
| Windows Job control protocol and POSIX process regressions | 43 tests passed; native Windows cases separately gated. `/tmp/specrails-windows-job-freeze.log` |
| OpenSpec, workflow syntax and diff whitespace | Strict change validation, YAML parse and `git diff --check` passed |

The combined totals do not add focused runs a second time. These are local scratch log paths, not committed CI artifacts. The two HOME-specific suites deliberately run without the temporary-home preload because they implement their own environment fixtures.

Final independent review also corrected two release defects: the publish job now checks out the manifest generator before using it, and it preserves old installers until the remotely served JSON exactly matches the new manifest. Publication of the shared latest channel is serialized. Installer smoke steps have an explicit 20-minute ceiling.

## Windows execution gates

The new Windows x64/ARM64 source CI and NSIS/MSI installed-package release smoke must run on Windows before release acceptance. They have not been executed on this macOS host. The five cases in `server/windows-execution.integration.test.ts` and two cases in `server/windows-background-containment.integration.test.ts` intentionally require native Windows rather than mocking the platform. The latter verify an orphaned descendant after its launchers exit, and abrupt supervisor loss: both require the descendant to be dead and its port released before the final event.

The release driver exercises the installed Node/sidecar/SQLite/PTY/core resources in temporary spaced and Unicode paths, checks terminal descendant termination, background descendants whose launchers have exited, graceful shutdown and project persistence across restart. The PowerShell/.NET Job Object supervisor is embedded as source and uses OS-provided APIs; its Windows compilation and real process behavior remain subject to those gates. Source CI also builds and runs the native WebView2 fixtures on both architectures. This does not substitute for manually testing real provider accounts, WebView2 display scaling across monitors or an enterprise SSO tenant.

See `docs/platforms/windows-parity.md` for the feature matrix and concrete real-device acceptance checklist.
