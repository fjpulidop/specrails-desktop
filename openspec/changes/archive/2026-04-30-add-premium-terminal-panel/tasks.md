## 1. Settings foundation (server)

- [x] 1.1 Add hub-db migration that seeds `hub_settings` with reserved keys `terminal.fontFamily`, `terminal.fontSize`, `terminal.renderMode`, `terminal.copyOnSelect`, `terminal.shellIntegrationEnabled`, `terminal.notifyOnCompletion`, `terminal.imageRendering`, `terminal.longCommandThresholdMs` and their documented defaults (idempotent via `INSERT OR IGNORE`)
- [x] 1.2 Add per-project migration: `terminal_settings_override(key TEXT PRIMARY KEY, value TEXT NOT NULL)` table — absence of a row means "inherit hub default"
- [x] 1.3 Add migration: per-project `terminal_command_marks` table `(id INTEGER PRIMARY KEY, sessionId TEXT, startedAt INTEGER, finishedAt INTEGER, exitCode INTEGER, command TEXT, cwd TEXT)` with index on `(sessionId, startedAt)`
- [x] 1.4 Create `server/modules/terminals/runtime/terminal-settings.ts` with `TerminalSettings` type, hub CRUD (`getHubTerminalSettings`, `patchHubTerminalSettings`), per-project CRUD (`getProjectOverride`, `patchProjectOverride`), and `resolveTerminalSettings(projectId)` returning the COALESCE merge
- [x] 1.5 Validate every patch input with bounds (`fontSize ∈ [8,32]`, `renderMode ∈ {auto,canvas,webgl}`, `longCommandThresholdMs ≥ 1000`); reject 400 on violation
- [x] 1.6 Unit tests: defaults seeded on first migration, override null falls back to hub, out-of-range rejected, GET project shape `{resolved, override, hubDefaults}`
- [x] 1.7 REST endpoints: `GET/PATCH /api/hub/terminal-settings` in `server/hub-router.ts`
- [x] 1.8 REST endpoints: `GET/PATCH /api/projects/:projectId/terminal-settings` in `server/project-router.ts`
- [x] 1.9 Supertest coverage for both routers (auth required, validation, layered resolution)

## 2. Command-marks store

- [x] 2.1 Create `server/modules/terminals/runtime/terminal-marks-store.ts` with `appendMark`, `listMarks(sessionId, limit, before)`, `deleteForSession(sessionId)`, `pruneSessionFifo(sessionId, cap=1000)`
- [x] 2.2 Implement FIFO eviction inside `appendMark` (insert + delete oldest beyond cap, single transaction)
- [x] 2.3 Endpoint: `GET /api/projects/:projectId/terminals/:id/marks?limit=&before=` in project router
- [x] 2.4 Unit tests: cap eviction is per-session, dangling pre-exec marked killed on session kill, ordering by `startedAt` desc

## 3. OSC parser

- [x] 3.1 Create `server/modules/terminals/runtime/terminal-osc-parser.ts` exporting `class OscParser { feed(chunk: Buffer): MarkEvent[]; reset(): void }` with bounded-lookahead state machine handling fragmented sequences across chunk boundaries
- [x] 3.2 Recognise OSC 133 `A`, `B`, `C`, `D[;exit]` and OSC 1337 `CurrentDir=…` and `File=…` (only the first three trigger mark events; `File=` is observed but produces no mark)
- [x] 3.3 Tolerate malformed sequences: drop bytes, never throw, never block
- [x] 3.4 Fuzz tests with corpora: oh-my-zsh, starship, p10k prompts, plain bash, fish; assert byte-for-byte passthrough invariant
- [x] 3.5 Benchmark: p99 < 0.2ms per 8KB chunk on CI runner; assertion-only-on-CI gate

## 4. Shell-integration shims

- [x] 4.1 Author `server/shell-integration/zsh-shim.zsh` (sources `~/.zshrc` then registers `precmd`/`preexec` emitting OSC 133 + OSC 1337 CurrentDir)
- [x] 4.2 Author `server/shell-integration/bash-shim.bash` (sources `~/.bashrc`, sets `PROMPT_COMMAND` chain, `DEBUG` trap)
- [x] 4.3 Author `server/shell-integration/fish-shim.fish` (registered as `conf.d/specrails-shim.fish`, hooks `fish_preexec` / `fish_postexec`)
- [x] 4.4 Author `server/shell-integration/powershell-shim.ps1` (dot-sources existing `$PROFILE`, wraps `prompt` function)
- [x] 4.5 Each shim writes a sentinel env var (`SPECRAILS_SHELL_INTEGRATION_LOADED=1`) so the server can detect bootstrap success
- [ ] 4.6 Manual verification matrix: zsh + p10k, bash + starship, fish default, pwsh on Windows — each shows prompt-start mark within 5s of first prompt

## 5. Shell-integration server module

- [x] 5.1 Create `server/terminal-shell-integration.ts` exporting `composeShellIntegrationSpawn(shell, sessionId, projectSlug, settings)` returning `{ args, env, shimDir, shimPath }`
- [x] 5.2 Implement zsh path: write `<shimDir>/.zshrc` chmod 600 that sources `~/.zshrc` then loads bundled shim, set `env.ZDOTDIR`
- [x] 5.3 Implement bash path: write `<shimDir>/shim.bash` chmod 600, prepend `--rcfile <shimPath>` to args
- [x] 5.4 Implement fish path: write `<shimDir>/fish/conf.d/specrails-shim.fish`, set `env.XDG_CONFIG_HOME = <shimDir>`
- [x] 5.5 Implement PowerShell path: write `<shimDir>/profile.ps1`, set `args = ['-NoLogo','-NoExit','-File',<shimPath>]`
- [x] 5.6 Locate bundled shim source: dev = `path.resolve(__dirname, 'shell-integration', name)`, packaged = `path.resolve(process.execPath, '..', 'shell-integration', name)` with fallback search
- [x] 5.7 Per-session cleanup helper `cleanupSessionShim(projectSlug, sessionId)` removing the directory tree
- [x] 5.8 Startup sweep `cleanupStaleShimDirs()` removing dirs older than 24h with no live session match
- [x] 5.9 Unit tests for each shell branch: arg/env shape, file written, chmod 600, chains user rc

## 6. Terminal-manager wiring

- [x] 6.1 In `server/modules/terminals/runtime/terminal-manager.ts`, call `resolveTerminalSettings(projectId)` before each spawn; on `shellIntegrationEnabled`, call `composeShellIntegrationSpawn` and merge `args` and `env`
- [x] 6.2 Hold a per-session `OscParser` instance; on PTY data, feed bytes through it and emit any resulting `MarkEvent` as JSON text frames on the session's WebSocket(s)
- [x] 6.3 Persist `pre-exec`+`post-exec` pairs into `terminal_command_marks` via the marks store
- [x] 6.4 On session kill or PTY exit, call `cleanupSessionShim`
- [x] 6.5 Wire `cleanupStaleShimDirs()` into server startup (after migrations, before listening)
- [x] 6.6 Tests: spawn with integration on/off, mark frames observed/absent, shim files created/cleaned, dangling pre-exec recorded as killed

## 7. Render-and-input addons (client)

- [x] 7.1 Add deps in `client/package.json`: `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-unicode11`, `@xterm/addon-ligatures`, `@xterm/addon-image`
- [x] 7.2 Refactor `ensureXtermForSession` in `TerminalsContext.tsx` to call a new `loadAddons(term, settings)` helper; load WebGL conditionally on `renderMode/auto+webgl2Available`, register `webglcontextlost` → fallbackToCanvas + one-shot toast
- [x] 7.3 Load Unicode 11 unconditionally; activate via `term.unicode.activeVersion = '11'`
- [x] 7.4 Load ligatures unconditionally; addon is silent no-op when font lacks features
- [x] 7.5 Load search addon unconditionally; expose `findNext`/`findPrevious`/`clearDecorations` via the handle
- [x] 7.6 Load image addon iff `imageRendering`; configure `pixelLimit = 8e6`, `cacheLimit = 32 << 20`
- [x] 7.7 Unit tests covering enable/disable matrix per addon

## 8. Resize debounce + transitionend hook

- [x] 8.1 Replace rAF-only ResizeObserver throttle with a trailing 120ms debounce in `ensureXtermForSession`
- [x] 8.2 In `TerminalViewport.tsx`, walk up to `document.body` once per mount finding ancestors that match `[data-sidebar], aside`; attach `transitionend` listener; on `propertyName ∈ {width,height}`, call `fit.fit()` + send PTY resize
- [x] 8.3 Tests with `@vitest/web` + jsdom: 12-tick burst → exactly one resize message, transitionend forces immediate fit

## 9. Custom keybindings + clipboard + zoom

- [x] 9.1 Implement `attachCustomKeyEventHandler` returning false (consumed) for `Cmd+C` (when selection non-empty), `Cmd+V`, `Cmd+K`, `Cmd+F`, `Cmd+=`, `Cmd+-`, `Cmd+0`; true for everything else
- [x] 9.2 `Cmd+C` → `navigator.clipboard.writeText(term.getSelection())`
- [x] 9.3 `Cmd+V` → `await navigator.clipboard.readText(); term.paste(text)`
- [x] 9.4 `Cmd+K` → `term.clear()`
- [x] 9.5 `Cmd+=` / `Cmd+-` → adjust `term.options.fontSize` (clamped 8–32) + PATCH project override
- [x] 9.6 `Cmd+0` → reset to resolved default
- [x] 9.7 `Cmd+F` → open `<TerminalSearchOverlay>` (state lives in `TerminalsContext` per-session)
- [x] 9.8 Unit tests: empty-selection Cmd+C passes through, Cmd+V calls term.paste, Cmd+K clears, font clamping, persistence write

## 10. Search overlay component

- [x] 10.1 Create `client/src/features/terminals/components/terminal/TerminalSearchOverlay.tsx`: input, prev/next, case toggle, regex toggle, whole-word toggle, match count, Esc close
- [x] 10.2 Integrate with addon-search's `findNext`/`findPrevious` and decoration colours from theme
- [x] 10.3 Mount into `TerminalViewport.tsx` keyed by activeId
- [x] 10.4 Unit tests: open on Cmd+F, Enter advances match, Esc closes & clears decorations, no PTY resize triggered

## 11. Right-click context menu

- [x] 11.1 Create `client/src/features/terminals/components/terminal/TerminalContextMenu.tsx` using a Radix-style portal (already in repo) or a minimal positioned div
- [x] 11.2 Items: Copy (disabled when no selection), Paste, Select All, Clear, Search, Save scrollback to file, "Open this directory" (conditional)
- [x] 11.3 Position-flip when click is near viewport bottom-right
- [x] 11.4 "Save scrollback" — dump `term.buffer.active` rows via `getLine(i).translateToString(true)`; Tauri → `dialog.save` + `fs.writeTextFile`; browser → blob download
- [x] 11.5 "Open this directory" — Tauri `revealItemInDir(latestCwd)`; hidden in browser
- [x] 11.6 Unit tests for visibility logic and the save path

## 12. Drag-drop file path injection

- [x] 12.1 Create `client/src/lib/shell-quote.ts` exporting `quotePosix(path)` and `quoteWindowsCmd(path)` with proper escaping
- [x] 12.2 Unit tests covering paths with spaces, single quotes, double quotes, backticks, `$`, parens, Unicode
- [x] 12.3 Create `client/src/lib/tauri-drag-drop.ts` registering `getCurrentWebview().onDragDropEvent` listener; no-op when `@tauri-apps/api` import fails or runtime is not Tauri
- [x] 12.4 Hit-test drop coords against active viewport's `getBoundingClientRect`; on hit, quote each path and `term.paste(paths.join(' '))`
- [x] 12.5 In `TerminalViewport.tsx`, render dragover highlight (border + low-opacity overlay) regardless of runtime
- [x] 12.6 Unit tests: hit-test boundary, quoting verified for both platforms, multi-file join

## 13. Prompt navigation + timing UI

- [x] 13.1 Create `client/src/lib/command-mark-store.ts` — module-level Map keyed by sessionId of `{ marks: Mark[], cwdHistory: string[] }`. Re-rendering React state via a tiny pub/sub
- [x] 13.2 In `TerminalsContext`, attach JSON `mark` frames to the store; expose `useSessionMarks(sessionId)` hook
- [x] 13.3 Create `client/src/features/terminals/components/terminal/PromptGutter.tsx` overlay using xterm decoration API for one marker per prompt-start
- [x] 13.4 Colour by exit code (success neutral, non-zero error from theme)
- [x] 13.5 `Cmd+ArrowUp` / `Cmd+ArrowDown` keybindings → scroll xterm to the previous/next prompt mark row
- [x] 13.6 Create `client/src/features/terminals/components/terminal/CommandTimingBadge.tsx` rendering elapsed time live (1Hz tick) once delta exceeds 500ms
- [x] 13.7 Tests: gutter draws one per mark, exit-code colour, navigation skips, badge ticks and stops on post-exec

## 14. Long-running command notifications

- [x] 14.1 In `TerminalsContext`, on `post-exec` mark whose elapsed exceeds threshold AND `document.hasFocus() === false` AND notifications enabled → call `notifyCommandFinished({ command, exitCode, elapsed })`
- [x] 14.2 `notifyCommandFinished` tries Tauri's notification plugin first (`@tauri-apps/plugin-notification`), falls back to `new Notification()` after `Notification.requestPermission()`
- [x] 14.3 Debounce: per `(sessionId, command)` 5-second window
- [x] 14.4 Unit tests with mocked focus state and Notification API

## 15. Inline image addon wiring

- [x] 15.1 Confirm addon-image config in `loadAddons` (task 7.6)
- [x] 15.2 Add `imageRendering=false` toggle path: addon not loaded; verify Sixel/iTerm2 sequences pass through and xterm renders escape code text
- [x] 15.3 Test: oversized image rejected with single warn log, total cache evicts FIFO at 32MB

## 16. Settings UI

- [x] 16.1 Create `client/src/features/settings/components/TerminalSettingsSection.tsx` with mode prop `'hub' | 'project'`. Renders inputs for every field; project mode shows "Inherit hub" placeholder + toggle that PATCHes null to clear
- [x] 16.2 Mount in `client/src/features/settings/pages/GlobalSettingsPage.tsx` with `mode="hub"`
- [x] 16.3 Mount in `client/src/features/settings/pages/SettingsPage.tsx` with `mode="project"`
- [x] 16.4 Hot-reload wiring: PATCH triggers WS broadcast (or local invalidation) so live xterms re-read settings; font/copyOnSelect/notify fields apply live
- [x] 16.5 Unit tests: hub form, project form, null-clears-override, validation surfaces, live-apply for font fields

## 17. Sentinel-not-seen toast & shift-drag hint

- [x] 17.1 In `TerminalsContext` after spawn-with-integration: 5s timer, if no prompt-start mark observed, dispatch a one-shot toast linking to settings
- [x] 17.2 In `TerminalViewport`, detect first drag while session has mouse mode enabled (track via xterm `onTitleChange` proxy or DECSET interception in OSC parser side-channel); show 3s tooltip "Hold ⇧ to select text"; persist `localStorage` dismiss flag
- [x] 17.3 Unit tests for both flows

## 18. Tauri packaging

- [x] 18.1 Update `scripts/build-sidecar.mjs` to copy `server/shell-integration/*` into `src-tauri/binaries/shell-integration/` for both macOS and Windows builds
- [x] 18.2 Update `server/terminal-shell-integration.ts` runtime path resolver to find shims relative to `process.execPath` in packaged builds
- [ ] 18.3 Manual verification: built `.dmg` and `.exe` both honour shell integration end-to-end

## 19. Documentation & release notes

- [x] 19.1 Update `CLAUDE.md` "Terminal panel" section: add WebGL/search/zoom/right-click/drag-drop/shell-integration, settings layering, hot-reload semantics
- [x] 19.2 Add `docs/terminal-panel.md` covering keybindings reference, shell-integration troubleshooting, manual opt-in fallback for failed bootstrap
- [x] 19.3 Conventional-commit message: `feat: premium terminal panel (shell integration, GPU render, search, drag-drop, marks)`

## 20. Coverage and CI gates

- [x] 20.1 Verify CI coverage thresholds pass (70% global, 80% server) after the new server modules; add tests as needed
- [x] 20.2 Run `npm run typecheck` (server + client) — zero errors
- [x] 20.3 Run full `npm test` suite — all green
- [ ] 20.4 Manual smoke pass on macOS dev: drag a file from Finder onto the active terminal, run a long command (`sleep 65`) unfocused → notification, Cmd+F search the buffer, Cmd+= zoom, right-click → Save scrollback
- [ ] 20.5 Manual smoke pass with tmux: open tmux session, Cmd+C copies a selection, Shift+drag selects across panes, paste with Cmd+V works
