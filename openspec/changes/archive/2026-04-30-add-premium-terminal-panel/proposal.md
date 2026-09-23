## Why

The bottom terminal panel today is a thin xterm.js wrapper with default settings. Real-world use surfaces concrete pain points: drag-and-dropping a file from Finder/Explorer onto the terminal does nothing (path not inserted), tmux/alt-screen apps swallow mouse selection so Cmd+C copies nothing, the rendered text "descuajaringa" while the side panels animate (ResizeObserver fires mid-transition and PTY redraws on every frame), there is no font-zoom, no scrollback search, no right-click menu, no GPU rendering, no shell integration (no jump-to-prompt, no per-command timing, no notifications), and no inline image support. Side-by-side with Ghostty, Warp or modern VSCode terminal, the panel feels first-generation.

This change rewrites the terminal panel into a "premium" experience in one cohesive pass: fix the three real bugs (drag-drop, tmux copy/paste, resize jitter), add the table-stakes polish (WebGL/ligatures/Unicode 11/search/zoom/right-click), and ship the differentiating shell-integration layer (OSC 133 marks via auto-injected `--init-file`, jump prev/next prompt, finished-command notifications, inline images via Sixel + iTerm2 protocol). All wired through a global hub-level settings page with per-project overrides.

## What Changes

### Tier 1 — Bug fixes the user hits daily

- **Drag-drop external files (Tauri only)** — listen to the Tauri webview drag-drop event, hit-test the active terminal viewport, shell-quote the dropped path(s) for the host platform (POSIX vs Windows), and inject via `term.paste()`. Browser context: silent no-op.
- **Cmd+C / Cmd+V / Cmd+K / Cmd+F keybindings** registered through xterm's `attachCustomKeyEventHandler`. Cmd+C copies the current xterm selection (works around tmux mouse-mode swallowing), Cmd+V pastes from `navigator.clipboard.readText()` using bracketed-paste mode, Cmd+K clears, Cmd+F opens the search overlay. `Shift+drag` already bypasses mouse-mode in xterm; surface a one-time hint when the user drags inside an alt-screen app.
- **Resize debounce** — replace the rAF-only throttle in `TerminalsContext` with a trailing 120ms debounce, plus listen to `transitionend` on ancestor sidebars to issue a final refit after CSS transitions settle. PTY `resize` is sent only after the geometry stabilises.

### Tier 2 — Premium polish (table stakes for a "modern" terminal)

- **GPU rendering** via `@xterm/addon-webgl`. Auto-attach when WebGL2 is available; on `webglcontextlost` or init failure, fall back to canvas renderer and surface a one-time toast.
- **Scrollback search** via `@xterm/addon-search`. Cmd+F opens a search overlay (next/prev/case/regex/whole-word). Search ring kept per-session in memory.
- **Unicode 11 widths** via `@xterm/addon-unicode11` so emoji/CJK align correctly.
- **Programming ligatures** via `@xterm/addon-ligatures` (joins `=>`, `->`, `!=`, etc.). Disabled if the configured font lacks ligature features.
- **Right-click context menu** with Copy, Paste, Select all, Clear, Search, Save scrollback…, and (Tier 3) "Open this directory" / "Reveal in Finder" when shell-integration emits a CWD mark.
- **Font zoom** — Cmd+= / Cmd+- / Cmd+0 — adjusts the active session's font size in 1px steps, persisted to user settings (clamped 8–32).
- **Settings UI** — new `Terminal` section in `GlobalSettingsPage` (hub-wide defaults) and a corresponding override block in `SettingsPage` (per-project): font family, font size, copy-on-select, render mode (auto/canvas/webgl), shell-integration enabled, notify-on-completion enabled, image rendering enabled.

### Tier 3 — Shell integration & inline media (the differentiator)

- **OSC 133 / OSC 1337 shell integration via auto-inject** — when shell integration is enabled (default ON), `terminal-manager.ts` resolves the user's shell and spawns it with an `--init-file` (zsh/bash) or a `$PROFILE` shim (PowerShell) that emits OSC 133 prompt marks (`A` prompt-start, `B` prompt-end, `C` pre-exec, `D` post-exec with exit code) and OSC 1337 `CurrentDir=…`. The shim chains to the user's normal rc files (`~/.zshrc`, `~/.bashrc`) so behaviour is preserved. An opt-out toggle lives in Settings.
- **Prompt navigation** — Cmd+↑ / Cmd+↓ jump to previous/next prompt mark in the scrollback. The xterm decoration API draws a left-margin gutter showing exit-code colour (green/red) per command.
- **Per-command timing** — render elapsed wall-clock time inline with the prompt marker once OSC 133 D arrives. Slow commands (>30s by default, configurable) keep counting until they finish.
- **Notify on long-running command** — when a foreground command exceeds the threshold (default 60s) AND the window is unfocused, fire a desktop notification ("`npm test` finished — exit 0 in 1m 42s") via the Tauri notification plugin (browser fallback: HTML5 `Notification`).
- **Inline images** via `@xterm/addon-image` — Sixel and the iTerm2 inline-image protocol (OSC 1337 `File=…`). Image rendering can be disabled in settings (default ON).

### Cross-cutting

- Terminal settings live in `~/.specrails/hub.sqlite` (`hub_settings` table) for hub defaults, and in each project's `jobs.sqlite` for overrides. Resolution order at session create: per-project override → hub default → built-in default. Hot-reload: changes to font size / render mode apply to live sessions without recreate; shell-integration toggle takes effect on the *next* spawn (existing PTYs keep their boot-time wiring).
- A new `terminal_command_marks` table per-project records `{ sessionId, startedAt, finishedAt, exitCode, command, cwd }` for completed commands, capped at 1000 rows per session (FIFO eviction). Used by prompt navigation, notifications, and a future "command history" feature.
- `xterm.js` upgraded to the latest stable that supports the WebGL/Unicode/Ligatures/Image addons against the version we already have. Addons are loaded conditionally so a missing optional dep does not break the panel.

## Capabilities

### New Capabilities
- `terminal-shell-integration`: server-side auto-injected shell shim that emits OSC 133 / OSC 1337 marks, plus client-side parsing, command-mark storage, and the prompt-navigation / notification / context-menu features built on top.
- `terminal-rendering-and-input`: GPU-vs-canvas render policy, Unicode 11 widths, ligatures, scrollback search, font zoom, copy/paste/clear keybindings, right-click context menu, drag-drop file-path injection, resize debounce.
- `terminal-inline-media`: Sixel and iTerm2 inline-image rendering inside the panel, with the per-tier opt-out path.
- `terminal-settings`: hub-wide defaults and per-project overrides for the terminal panel, persistence schema, hot-reload semantics.

### Modified Capabilities
- `project-terminal-panel`: the panel UX gains font-zoom, search overlay, right-click menu, prompt-navigation gutter, image rendering, drag-drop hint surfaces, and resize-debounce behaviour. Existing requirements around visibility states, per-project isolation, and keyboard focus stay intact; only new requirements are added.
- `terminal-pty-bridge`: PTY spawn semantics change — `terminal-manager.ts` learns to inject the shell-integration `--init-file` (or `$PROFILE` shim on Windows), resize debounce affects the WS `resize` cadence, and the bridge gains a control frame for OSC-133-derived command marks streamed back to the client alongside the existing binary output.

## Impact

**New code (server):**
- `server/terminal-shell-integration.ts` — resolves the shim path per shell (zsh/bash/fish/PowerShell), composes the `--init-file` arguments, manages a per-session writable temp shim that chains to user rc files, and parses the inbound OSC 133/1337 stream into structured `CommandMark` events on top of the existing PTY data flow.
- `server/modules/terminals/runtime/terminal-settings.ts` — CRUD over the hub `terminal_settings` table and per-project `terminal_settings_override` table; surface a single `resolveTerminalSettings(projectId)` helper.
- `server/modules/terminals/runtime/terminal-marks-store.ts` — append-only ring storage for `terminal_command_marks` per-project, with the 1000-row FIFO cap.
- New shim scripts under `server/shell-integration/`: `zsh-shim.zsh`, `bash-shim.bash`, `fish-shim.fish`, `powershell-shim.ps1`. Bundled with the desktop app via `scripts/build-sidecar.mjs`.

**Modified code (server):**
- `server/modules/terminals/runtime/terminal-manager.ts` — call `resolveTerminalSettings`, optionally compose shell-integration args, write per-session shim, attach the OSC parser to the PTY data path, broadcast `mark` control frames over the existing terminal WS.
- `server/db.ts` — three new migrations: `hub_settings.terminal_*` columns, per-project `terminal_settings_override` table, per-project `terminal_command_marks` table.
- `server/project-router.ts` and `server/hub-router.ts` — new REST endpoints under `/api/hub/terminal-settings` and `/api/projects/:projectId/terminal-settings` (GET/PATCH), plus `/api/projects/:projectId/terminals/:id/marks` (GET, paginated).

**New code (client):**
- `client/src/features/terminals/components/terminal/TerminalSearchOverlay.tsx`, `TerminalContextMenu.tsx`, `PromptGutter.tsx`, `CommandTimingBadge.tsx`.
- `client/src/lib/shell-quote.ts` — POSIX vs Windows path quoting for drag-drop.
- `client/src/lib/tauri-drag-drop.ts` — Tauri webview drag-drop listener with browser no-op fallback.
- `client/src/features/settings/components/TerminalSettingsSection.tsx` (used by both `GlobalSettingsPage` and `SettingsPage`).

**Modified code (client):**
- `client/src/features/terminals/context/TerminalsContext.tsx` — addon loading (WebGL, search, unicode11, ligatures, image), trailing-debounced resize, settings-driven font/render-mode hot-reload, command-mark store fed by control frames, custom-key handler for the new keybindings.
- `client/src/features/terminals/components/terminal/TerminalViewport.tsx` — mounts the search overlay, context menu, and prompt-gutter overlay; handles drag-over visual.
- `client/src/features/terminals/components/terminal/TerminalTopBar.tsx` — new "Search" affordance + settings shortcut.
- `client/src/features/settings/pages/GlobalSettingsPage.tsx`, `client/src/features/settings/pages/SettingsPage.tsx` — render `TerminalSettingsSection`.

**Dependencies (npm, client):**
- Add `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-unicode11`, `@xterm/addon-ligatures`, `@xterm/addon-image`. All maintained alongside the `@xterm/xterm` core, ESM, no native binaries.

**APIs:**
- New: `GET/PATCH /api/hub/terminal-settings`, `GET/PATCH /api/projects/:projectId/terminal-settings`, `GET /api/projects/:projectId/terminals/:id/marks`.
- Existing terminal WS gains a JSON control frame `{ type: "mark", kind: "prompt-start"|"prompt-end"|"pre-exec"|"post-exec"|"cwd", payload }`.
- No breaking changes to existing terminal endpoints.

**Performance:**
- WebGL renderer expected to cut frame time on heavy output by ~40-60% (per upstream benchmarks). Canvas fallback path keeps current performance floor.
- Resize debounce reduces PTY `resize` syscalls during sidebar transitions from ~12 (per 200ms transition) to 1.
- OSC parser adds a single regex scan over each PTY chunk; negligible at observed throughput.

**Security:**
- Shell shims are written to a per-session temp file under `~/.specrails/projects/<slug>/terminals/<id>/shim.zsh` with `chmod 600`. The path is passed as a CLI argument, never composed by the shell. The shim itself only `source`s the user's regular rc files; it does not eval anything from the network.
- Drag-drop quoting uses a strict allowlist for POSIX (`'\''`-escaping inside single quotes) and `^`-escaping plus double quotes for `cmd.exe`. Path strings are never interpolated unquoted.
- Inline images are decoded by xterm's image addon in the renderer; images cannot escape the canvas. A hard cap on image bytes per frame protects against memory pressure.
- Notifications respect the Tauri permission model; browser fallback requires explicit user permission via `Notification.requestPermission()`.

**Out of scope (explicit, deferred):**
- Split panes inside a single terminal session.
- SSH / serial profiles.
- A full theming UI (color picker, syntax sets). The existing Dracula-ish theme stays default; users pick from a fixed shortlist.
- A persistent command-history searcher across sessions (the per-session ring buffer is the v1 building block).
