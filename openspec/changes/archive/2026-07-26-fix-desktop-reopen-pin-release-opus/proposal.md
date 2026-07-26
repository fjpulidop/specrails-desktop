## Why

Four independent defects degrade day-to-day desktop use: the app becomes unreachable from the macOS Dock once it hides to the menu bar, a mission that has not started yet ignores the project the user just selected in the sidebar, a settled rail worktree can never be released (so its branch can never be checked out) because the warm `node_modules` symlink the app itself created reads as post-settlement dirt, and picking "Claude Opus" in the model selector delegates the actual model choice to whatever the CLI's `opus` alias currently resolves to instead of Opus 5.

## What Changes

- Clicking the Dock icon (macOS) while the window is hidden to the menu bar re-shows, unminimizes, and focuses it. Windows keeps the tray as the in-session entry point and relies on the already-wired single-instance relaunch for the taskbar/Start shortcut, so both platforms have a working reopen path.
- In Agent (mission) mode, selecting a project in the left sidebar immediately binds the not-yet-started mission to that project. A mission that already carries a conversation with messages is never re-pinned.
- Rail worktree release authenticates the app-created warm `node_modules` links the same way it authenticates overlay scaffolding: proven links are excluded from the cleanliness check and quarantined before `git worktree remove`, so release (and therefore branch checkout) is no longer permanently blocked. Authentication is derived live from the filesystem, so worktrees already stuck in `needs-review` heal on the next decision.
- The Claude adapter resolves the `opus` catalog alias to the concrete `claude-opus-5` model id at spawn time, and recognises `claude-opus-5` when collapsing model ids back to the alias.

## Capabilities

### New Capabilities
- `agent-mission-project-binding`: how the active project selection and a mission's pinned project stay coherent in Agent Mode.

### Modified Capabilities
- `desktop-shell`: reopening the app from the OS shell after it hides to the tray/menu bar.
- `implementation-delivery-lifecycle`: warm-dependency links are release-safe evidence, not post-settlement dirt.
- `multi-provider-architecture`: the Claude model catalog alias resolves to an explicit model id at spawn time.

## Impact

- `src-tauri/src/lib.rs` — `RunEvent::Reopen` handling.
- `client/src/context/AgentChatContext.tsx` — active-project → draft/empty-mission pin synchronisation.
- `server/worktree-node-modules.ts`, `server/rail-worktree-release.ts`, `server/rail-isolated-launch.ts` — warm-link authentication, evidence persistence, release verification.
- `server/providers/claude-adapter.ts` — alias → model id resolution.
- No schema migrations, no API surface changes, no wire-contract changes.
