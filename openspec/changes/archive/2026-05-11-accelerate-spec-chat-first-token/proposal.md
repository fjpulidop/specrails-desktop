## Why

The Explore Spec chat feels sluggish on every turn — first-token latency is dominated by claude CLI auto-loading the project's massive `CLAUDE.md`, plus the hub's own system prompt injecting live job stats that invalidate Anthropic's prompt cache on every turn. Multi-turn brainstorming, the core UX promise of Explore, currently feels like waiting for a car to start before each sentence rather than a fluid back-and-forth.

## What Changes

- **Stabilize the Explore system prompt**: stop injecting live `getStats()` / `listJobs()` data into the system prompt for Explore turns so the prompt becomes deterministic and Anthropic's prompt cache hits across turns within the 5-minute TTL window.
- **Run Explore turns from a hub-managed cwd** (`~/.specrails/projects/<slug>/explore-cwd/`) with a small, focused embedded `CLAUDE.md` instead of `<project.path>` — the project's own `CLAUDE.md` is no longer auto-loaded, dramatically reducing input tokens.
- **Symlink** `<explore-cwd>/project → <project.path>` so tools (`Read`, `Grep`, `Glob`) still reach the user's repo when needed for high-quality spec brainstorming. The project's `CLAUDE.md` is never modified, moved, or deleted.
- **Add a per-project toggle "Use MCPs in Explore"** in the project SettingsPage — default OFF. When ON, Explore turns spawn from `<project.path>` (legacy behavior) so `.mcp.json` loads; when OFF (default), spawn from the explore-cwd.
- **Keep tools enabled in Explore** (`--tools default`) so quality is preserved.
- **Optimized respawn with `--resume`** for Explore: each turn still spawns a fresh `claude` process (true persistent stdin multi-turn is not pursued), but with the new stable system prompt + reduced project context, the Anthropic prompt cache stays warm across respawns and the model rehydrates session state instantly.
- **Lifecycle**: minimized-to-toast Explore conversations kill the process after 2 minutes idle; restore respawns with `--resume`. Crash recovery auto-respawns once silently; second crash surfaces as `chat_error`. Cap of 5 concurrent Explore processes per project.
- **Premium streaming UX**: client renders status pills mapped to `stream-json` event stages (`Conectando` → `Pensando` → `Consultando código` → live streaming), skeleton from T+0ms, and char-by-char rendering for the perceived "electrizante" feel.
- **Out of scope** (deferred to follow-up changes): Quick-mode (`POST /tickets/generate-spec`) latency, sidebar chat (`kind='sidebar'`), per-project user-customizable Explore prompt overrides, true persistent process via stdin multi-turn.

## Capabilities

### New Capabilities

_None — all new behaviour layers onto the existing `explore-spec` capability._

### Modified Capabilities

- `explore-spec`: adds requirements around how Explore turns are spawned (hub-managed cwd with embedded `CLAUDE.md`, symlink to project), the deterministic system prompt that no longer pulls live job stats, the per-project MCP toggle (default OFF), the optimized-respawn-with-`--resume` lifecycle, idle-kill / crash-recovery / concurrency-cap rules, and the premium streaming UX (status pills + skeleton + char-by-char).

## Impact

- **Server**:
  - `server/modules/conversations/runtime/chat-manager.ts` — split system-prompt builders so Explore turns no longer pull live job stats; route Explore spawns through a new `ExploreCwdManager`; add per-conversation respawn-with-`--resume` policy, idle timer, crash auto-respawn-once, and concurrency cap.
  - New `server/modules/conversations/runtime/explore-cwd-manager.ts` — owns explore-cwd lifecycle: ensure-dir, write/refresh embedded `CLAUDE.md`, manage `./project` symlink (junction on Windows), expose `getCwd(projectId)`.
  - `server/hub-router.ts` or per-project settings router — new `GET/PATCH /api/projects/:projectId/explore-mcp-enabled` endpoint backed by `hub_settings` or per-project settings table; default `false`.
  - `server/db.ts` — migration for the new `explore_mcp_enabled` per-project setting (or piggyback on existing settings infra).
- **Client**:
  - `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` — render new `<SpecGenStatus>` stages from WS `chat_stream`/`tool_use` events; char-by-char rendering pass; instant skeleton.
  - New `client/src/features/specs/components/explore-spec/ExploreStatusPills.tsx` (or similar) — stage pills.
  - `client/src/features/settings/pages/SettingsPage.tsx` — Explore section with the MCP toggle.
- **Telemetry / WS**: no protocol changes needed; the existing `chat_stream`, `chat_error`, `chat_complete` events suffice. Status pills derive from already-streamed `assistant`/`tool_use` events.
- **Filesystem (hub-managed)**: new directory `~/.specrails/projects/<slug>/explore-cwd/` containing `CLAUDE.md` and the `project` symlink. Cleaned up on `ProjectRegistry.removeProject`.
- **Tests**: chat-manager tests extended for the new spawn-cwd logic + idle/crash policies; new explore-cwd-manager tests; client shell tests for status-pill rendering. Coverage thresholds (server 80%, client 80% lines) must hold.
- **No changes** to: Quick-mode (`/tickets/generate-spec`), sidebar chat, `QueueManager`, `SetupManager`, `specrails-core`. The user's `<project>/CLAUDE.md` is read-only from the hub's perspective and never touched.
