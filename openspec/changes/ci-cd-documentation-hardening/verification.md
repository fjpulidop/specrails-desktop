# Verification — 6 September 2026

Verified the working trees of `specrails-desktop` (`codex/multi-repo-projects`) and `specrails-core` (`codex/implement-update-reliability`). Existing feature changes were preserved. These results describe local source validation, not a published release or a successful hosted matrix.

## Automated checks

| Check | Result |
| --- | --- |
| Desktop full TypeScript check (server, CLI, MCP bridge and client) | PASS |
| Desktop production build (server/assets, client, CLI and MCP bridge) | PASS |
| Desktop script regressions | 29 passed |
| Desktop server coverage | 8,062 passed, 7 platform skips; two provider authorization suites verified separately with 23 additional passing tests |
| Desktop client coverage | 4,834 passed across 385 files |
| Desktop npm consumer smoke | PASS: actual tarball production install, CLI help/version, installed MCP resolver and required shell/schema/template resources, integrity receipt |
| Core full TypeScript check | PASS |
| Core release helper regressions | 19 passed |
| Core full coverage | 569 passed across 39 files |
| Core npm consumer smoke | PASS: actual tarball installed into a temporary consumer, two CLI entry points, four provider assemblies and four frozen pipeline journals |
| actionlint 1.7.12, all workflows in both repositories | PASS, with ShellCheck integration disabled |
| README relative paths, anchors and documented npm aliases | PASS against the actual source trees |
| `git diff --check`, both repositories | PASS |

Desktop server coverage was statements **86.37%**, branches **79.27%**, functions **90.51%**, lines **89.05%**. Client coverage was statements/lines **89.96%**, branches **84.09%**, functions **75.70%**. Existing configured thresholds were retained.

Core coverage was statements **86.04%**, branches **77.91%**, functions **95.59%**, lines **89.83%**. In total, the non-duplicated suites above passed **13,536 tests**, with seven platform skips.

## Isolation and limitations

Server tests ran with a temporary `os.homedir()` override to protect the user's existing provider state. The two suites that explicitly exercise home-directory authorization semantics ran separately without that override. Core uses a temporary override that respects each test's own HOME/USERPROFILE changes; a first run with a fixed override caused one false failure by sharing an acknowledgment file between tests. The corrected isolated scaffold suite passed all 42 tests. No product change or coverage exemption was introduced for that harness issue.

Package smoke checks install dependencies with lifecycle scripts disabled and use temporary consumers. They do not launch an agent, access a real project registry, or certify native SQLite/PTY rebuild behavior. Core's package fixture confirms that an unimplemented journal cannot be reported as successfully verified.

Local tests ran on macOS with Node 25.9.0. The configured Linux/macOS/Windows and Node-version matrices still require hosted execution. Native installer installation, real signing/notarization, npm authorization, OIDC account configuration, cross-repository token access and Hostinger FTPS/TLS/rename behavior cannot be certified by these local checks. No secrets, repository settings, tags, releases or remote branches were modified.

The initial audit recorded a separate Chromium distribution-signing finding. Its implementation has subsequently been addressed by [signed-chromium-distribution](../signed-chromium-distribution/verification.md); that report distinguishes local verification from the remaining hosted Apple acceptance.

## Reproduction

- Desktop: `npm run typecheck`, `npm run test:scripts`, server/client coverage scripts, `npm run build`, `npm run check:package -- --output <temporary-directory>`.
- Core: `npm run typecheck`, `npm run test:scripts`, `npm run test:coverage`, `npm run check:package` (or pass an explicit temporary output directory to `scripts/verify-package.mjs` after building).
- Workflows: `actionlint -shellcheck= .github/workflows/*.yml` from each repository.
- OpenSpec: `openspec validate ci-cd-documentation-hardening --strict`.

Release and recovery procedures are documented in [Desktop CI/CD](../../../docs/ci-cd.md) and Core's `docs/ci-cd.md`. The npm `E404` observed in Desktop's prior hosted publication remains an account/authorization check; this audit does not infer a specific credential cause from that response.

## Native popup smoke follow-up

Hosted macOS timed out while evaluating synchronous popup creation immediately after a self-closing popup, including a single-slot opening in one run. The fixture now schedules each opening after evaluation returns, fills eight concurrent slots one at a time, waits for both native-window and JavaScript acknowledgements, and then attempts the ninth. It retains the original per-operation deadline and explicitly requires a new denial event, checks slot release/retry and verifies owner isolation. The real macOS native smoke passed all OAuth-style opener/cookie/postMessage, IPC denial, close, limit and teardown scenarios after this change; no product popup limit or global timeout was relaxed.


## Windows process and Unicode follow-up

The orphan-process fixture previously spawned its server through Node without `detached`. On Windows, libuv puts that immediate child in an additional `KILL_ON_JOB_CLOSE` job, so exiting the wrapper killed the server before Specrails could exercise its own job ownership. The integration and installed-app fixtures now share a .NET launcher with no extra job or breakaway. Both still require the wrapper and shell to exit, the server to remain alive, and Stop/supervisor shutdown to close the owned descendant. Failed startup now includes bounded captured state/output.

The Windows filesystem worker also exited during a directory copy under a Unicode profile. Node's native `cpSync` directory fast path has a [documented Windows path regression](https://github.com/nodejs/node/issues/61878). Recovery, updates, migration, overlay preparation and packaging copies use the JavaScript traversal path and fresh staging destinations while preserving existing options and actual Unicode fixtures. Existing build resources are replaced as owned output trees; the bundled dependency overlay uses asynchronous copying, whose file removal/copy operations use libuv. A nonzero copy mode alone is insufficient because the affected synchronous overwrite removes the destination before inspecting that mode. This does not substitute mocked filesystem behavior for the native Windows checks.

Independent Windows/macOS checks now continue after another check fails, provided their install/build prerequisites succeeded. There is no `continue-on-error`: any failing check still fails its job. This exposes multiple regressions in one run instead of hiding later checks behind the first failure.

The native mission-window smoke waits for confirmed popup destruction and main-window hiding, replacing fixed 100 ms sleeps with bounded state checks. Local native macOS validation passed with the original assertions intact.

The hosted Windows build also exposed an outdated `BOOL` path in the multiwindow fixture. It now uses `windows::core::BOOL`, matching the locked `windows` 0.61 and WebView2 `IsVisible` signature. Local native-example compilation passed; the Windows matrix validates the platform-gated code and its real visibility assertions.
