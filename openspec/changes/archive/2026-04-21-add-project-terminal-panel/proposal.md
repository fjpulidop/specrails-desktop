## Why

Users currently have to context-switch to an external terminal (iTerm, Terminal.app, etc.) to run commands against the project specrails-hub is managing. This breaks flow and loses the per-project mental model. A built-in, VSCode/Cursor-style bottom terminal panel — with real shell integration and per-project state — makes specrails-hub a complete workspace instead of just a job-queue dashboard.

## What Changes

- Add a collapsible bottom panel per project hosting one or more native shell terminals.
- Spawn real PTYs on the server via `node-pty`, using `$SHELL` as login + interactive (`-l -i`) so `.zshrc` / `.bashrc` / `.zprofile` load normally.
- Every new terminal starts in `project.path` (the project directory).
- Support up to 10 terminals per project, each renameable, switchable via a right-side sidebar, killable individually.
- Panel has three visibility states: **hidden** (icon in StatusBar), **restored** (user-draggable height), **maximized** (fills full project viewport).
- Keyboard shortcut `Cmd+J` (`Ctrl+J` on non-mac) toggles the panel and focuses the active terminal.
- Hard distinction between **minimize** (collapse panel, PTYs keep running) and **close** (kills PTY, direct, no confirmation).
- Terminal state (PTY + scrollback ring buffer) persists across project switches; xterm.js DOM nodes are never unmounted, avoiding reinit/glitches.
- Pixel-perfect icon alignment: the collapse chevron in the panel top-bar and the expand chevron in the StatusBar occupy the same screen coordinates.
- Cross-platform PTY support (macOS, Linux, Windows via ConPTY) — free with `node-pty`.
- **BREAKING** for desktop sidecar packaging: `build-sidecar.mjs` must bundle `pty.node` alongside `better_sqlite3.node` and register a resolver hook, or the packaged desktop binary will fail to spawn terminals.

## Capabilities

### New Capabilities
- `project-terminal-panel`: Per-project bottom terminal panel lifecycle — open/close/maximize/resize, terminal creation/deletion/rename, active-terminal switching, keyboard shortcut binding, icon alignment invariant, and state persistence across project switches and panel collapse.
- `terminal-pty-bridge`: Server-side PTY session management and client WebSocket transport — spawning shells with correct shell/cwd/env, scrollback ring buffer, attach/detach/replay protocol, resize propagation, per-project isolation, and kill semantics (individual, project-removal, server-shutdown).

### Modified Capabilities
_None — this is purely additive._

## Impact

- **Server**: new `server/modules/terminals/runtime/terminal-manager.ts`, new WS endpoint `/ws/terminal/:id`, new REST routes under `/api/projects/:projectId/terminals/*`, new dependency `node-pty`, hook into `project-registry.ts` for cleanup on project removal and `index.ts` for graceful shutdown.
- **Client**: new `xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` dependencies, new `TerminalsProvider` context, new `BottomPanel` / `TerminalViewport` / `TerminalSidebar` / `TerminalTopBar` components, new `useTerminals` hook, integration in `ProjectLayout.tsx` and `StatusBar.tsx`, new keybinding in `useKeyboardShortcuts.ts`.
- **Desktop sidecar**: `scripts/build-sidecar.mjs` must include the platform-specific `pty.node` prebuilt addon; packaging must place it alongside `better_sqlite3.node`; the `Module._resolveFilename` patch in `server/index.ts` must be extended to redirect `node-pty` binding.
- **Tests**: vitest suites for `TerminalManager` (spawn/attach/scrollback/kill/limit), WebSocket bridge integration, and client store (per-project isolation, persistence across switches).
- **No DB schema changes** — terminals are ephemeral (die with server).
