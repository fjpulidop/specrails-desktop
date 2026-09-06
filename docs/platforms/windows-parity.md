# Windows feature parity audit

This audit covers the `codex/multi-repo-projects` branch, including mission steering, multiple repositories, persistent process logs and the code explorer. It is a compatibility and regression audit, not a certificate that every Windows configuration or third-party login has been tested.

## Feature coverage

| Feature | Windows implementation and checks |
| --- | --- |
| Installation, native runtimes | Native x64/ARM64 NSIS and MSI builds; embedded WebView2 offline provisioning; bundled Node/Git/core/OpenSpec; staged SQLite and full ConPTY/WinPTY dependency validation. |
| Desktop updates | Installer-specific Tauri targets keep NSIS and MSI separate. Missing, empty or ambiguous artifact/signature pairs fail manifest generation. Generic NSIS entries remain for older clients. Publication is serialized, and previous download installers are retained until the remote manifest matches the new release. |
| Startup and project catalog | Recover the actual Windows profile rather than inventing `C:\Users\Default`; SQLite catalog/repository IDs reopen under the same Unicode/spaced profile. |
| Projects and multi-repo | Repository membership and canonical identity use real paths; junction and case aliases cannot add the same repository twice. Shared backlog and per-repository jobs retain their existing regression coverage. |
| Core setup and updates | Offline assembly from the shipped core; preserve and restore the previous active framework if Windows junction replacement fails. Installed-package smoke waits for the real workspace marker. |
| Missions and live messages | Claude streaming keeps stdin open and puts system context in prompt files on Windows; Codex and Gemini large prompts avoid command-line limits. Edit/delete/steer UI behavior remains shared. |
| Rails and built-in/custom loops | Windows-safe process wrappers, environment and cwd handling; stop flows terminate owned process trees. User-authored shell commands still need syntax supported by their configured shell. |
| Background applications and logs | A Windows Job Object owns the application before command admission and retains descendants after launchers exit. Stop waits for the contained processes to terminate. Graceful host shutdown drains processes and logs before force-stop fallback. |
| Terminal | Bundled ConPTY helper forks the bundled Node instead of recursively launching the pkg sidecar. Native package smoke checks input, output and descendant cleanup. File drops quote for the session's actual shell. |
| Git and worktrees | Existing repository-scoped integration/checkout protections remain; Windows process and path helpers are exercised by native regression fixtures. Conflict decisions remain deliberate user-visible outcomes. |
| Files and observability | Same read-only tree/search/activity/diff/summary interfaces; Windows watcher root deletion degrades and retries instead of reporting a dead native watcher as healthy. |
| MCP and plugins | Core and project/repository scope remain explicit. Serena's app-managed Codex MCP configuration is injected into the actual provider spawns without replacing the user's authentication home. |
| Native browser | WebView2 browsing, capture and selector support share the host API; remote pages do not receive privileged desktop IPC. Browser/popup ownership and events are scoped to the calling app window. Reparenting retains the live session; occupied destinations park their previous browser and restore it on rollback. |
| Detached mission windows | Independent native windows share the original backend and active agent invocation. Versioned draft/workspace handoffs require destination acknowledgement; stale acknowledgements cannot close the source. Native mission close reintegrates, main close hides to tray, and popup close destroys only its own window. |
| File reveal, save, notifications | Supported native host commands replace dynamic imports that could be rejected by the production CSP or refer to missing plugins. |
| Keyboard, layouts, language | Ctrl+Enter works for feature exploration/refinement, shortcut hints display Windows modifiers, and terminal errors have translations in all eight locales. Shared client suites cover remaining UI behavior. |
| Mobile companion, analytics, settings, tickets/integrations | Shared Node/React implementations and existing regression suites; Windows startup, profile and subprocess fixes also apply to these callers. External services require their own credentials/network access. |

## Automated gates

`.github/workflows/ci.yml` runs a `windows-parity` matrix on `windows-latest` (x64) and `windows-11-arm`. It installs dependencies, checks TypeScript, runs release/PTY helper regression tests, native filesystem/process tests, client tests, the application build, native host build/tests, and four real native fixtures: WebView2 capture/selection, authentication popups, mission window handoff, and browser multiwindow transfer/parking. The separate bundled-core matrix exercises Windows junction/copy relocation for providers.

`.github/workflows/desktop-release.yml` builds the real installers and runs `scripts/smoke-windows-installers.ps1` before publishing artifacts. For each NSIS and MSI package, the script installs into a temporary path containing spaces and drives `scripts/smoke-installed-windows.mjs` with the installed Node runtime. The driver uses an isolated user profile and tests:

1. The installed pkg sidecar boots with bundled resources and authenticates API access.
2. A temporary Git repository is registered and core assembly completes offline.
3. A source file can be read through the project API.
4. A real PTY executes a Node helper in the correct cwd and streams its output.
5. Closing the terminal terminates that helper, including the packaged ConPTY cleanup path.
6. A background wrapper exits and leaves a descendant alive; its card remains running and Stop terminates the descendant before confirming completion.
7. Authenticated host shutdown exits cleanly; restarting retains the same project ID.
8. The temporary package is uninstalled and its fixture is removed.

Release-manifest and staged-helper tests can also run locally:

```sh
node --test scripts/build-updater-manifest.test.mjs scripts/stage-windows-pty.test.mjs
```

The current local audit results and any unexecuted checks are recorded in `openspec/changes/windows-feature-parity/verification.md`. A workflow definition is not evidence of a successful Windows run. The `native-macos` job compiles the same host and runs the four fixtures against WebKit, without a sidecar or packaged runtime resources.

The detachable-window implementation has passed native macOS fixtures locally, including independent mission windows, draft/revision rollback, browser session transfer, destination display scale, popup ownership and parked-session restoration. Windows x64/ARM64 execution of the new gates remains pending until CI results are recorded; a macOS pass does not establish WebView2 parity. See [Detachable mission windows](../features/detachable-mission-windows.md) for the behavior and test matrix.

## Real-device release acceptance

Before claiming complete Windows parity, record successful x64 and ARM64 CI/release runs and exercise the actual installed UI on supported Windows versions:

- Clean NSIS and MSI installs, in-place upgrades from the previous release, relaunch, tray quit and uninstall. Verify one installation entry and preserved projects/logs.
- Native browsing and capture at 100%, 150% and 200% display scaling; resize, maximize, multi-monitor movement, keyboard/clipboard, popup/self-close, and the relevant Okta/SSO tenant. Detach two active missions, minimize main independently, move them between monitors, and reattach into a window with its own open browser; verify both sessions and pending inputs remain intact.
- Provider authentication and one real mission/rail per enabled provider; steering during a tool call; cancellation; multi-repo integration/checkout with clean and conflicting working trees.
- Long-running frontend/backend processes, immediate startup failure, stopping nested processes, app quit/update during execution, and persisted logs after restart.
- File selection/reveal/save and desktop notifications under normal user permissions. Test corporate security or network-drive policies where these are part of the supported customer environment.

Installers remain unsigned with Authenticode, so SmartScreen behavior described in the [Windows guide](./windows.md) still applies. The app cannot bypass OS or identity-provider policies.

## Platform references

- [Tauri Windows installers and WebView2 provisioning](https://v2.tauri.app/distribute/windows-installer/)
- [Tauri updater](https://v2.tauri.app/plugin/updater/); the pinned updater 2.10.1 selects `OS-ARCH-installer` before `OS-ARCH` in `get_urls`.
- [Node filesystem watcher caveats](https://nodejs.org/api/fs.html#caveats)
- [Microsoft WebView2 runtime distribution](https://learn.microsoft.com/microsoft-edge/webview2/concepts/distribution)
- [Microsoft Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
