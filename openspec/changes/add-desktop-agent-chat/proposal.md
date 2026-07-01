## Why

Specrails Desktop already embeds an MCP server (`/api/mcp` + the `specrails-mcp` stdio bridge, shipped in #469 / v2.17.0) that exposes ~18 domain-facade tools — enough for an *external* client (Cursor, Claude Desktop) to drive the whole app. The original MCP design explicitly deferred one thing as the natural next step:

> Future (not now): auto-connect an in-app Specrails Chat to its own MCP.

This change is that step. Today every chat in the app is **per-project** (`ChatManager` is one-per-project; `ChatPanel` mounts only inside `ProjectLayout`; minimized chats all carry a `projectId`). There is no assistant that lives **above** projects and can operate the tool itself. A user who wants to "launch the 3 highest-priority tickets of acme-api", "create a project", or "what did I spend this week across everything" must navigate there by hand.

We add a **global agent chat**: a floating, gorgeous, non-modal panel — summonable from anywhere, minimizable to the existing dock — whose conversation is supercharged with Specrails' own MCP so it can *drive the entire application from inside the application*. Because every Specrails mutation is WebSocket-broadcast, the panel is deliberately non-modal: the user **watches the board move in real time** while the agent works. That live "operate-and-see" loop — not the chat box — is the feature.

## What Changes

- **Global agent chat shell.** A new app-root provider mounts a floating glass panel (movable + resizable via the existing `useMovableResizableModal`) summoned by a persistent top-bar Bot trigger + `Cmd/Ctrl+K`, and minimized to the existing `MinimizedChatsDock` (new chip `kind: 'agent'`). Non-modal: the dashboard behind stays live and interactive. Default size is generous (≈520px × 78vh), resizable up to near-fullscreen, with sane minimums.
- **App-level agent backend.** A new `AgentChatManager` (sibling of `ChatManager`, sharing the spawn/stream/WS core) runs an AI CLI from an app-level cwd (`~/.specrails/agent-cwd/`) with `--mcp-config` pointed at the bundled `specrails-mcp` bridge, an "operator" system prompt, and the conversation persisted **app-globally** (new `agent_conversations` table in `desktop.sqlite`, not any per-project DB).
- **Multi-provider.** The agent runs on claude / codex / gemini, picked per-conversation from a header selector (claude default for best tool-calling).
- **Cursor-style project selector.** A header dropdown (clone of Cursor's Home▾ menu: search + Recents + project list + actions) sets which project the agent talks to. `Home` = no project → app-global mode (list/create projects, cross-project queries; the agent asks the user to pick/create when a request is project-specific). Selecting a project pins it via `specrails_select_project`. The agent's target project is **decoupled** from the user's dashboard view — the board never jumps on its own. The selector *defaults* to the currently-open project, overridable to `Home`.
- **Shift+Tab tier ladder.** A live chip in the panel cycles a **cumulative** permission ladder with `Shift+Tab` (mirroring Claude Code's mode cycling): `Observe` (read) → `Edit` (+write) → `Operate` (+AI-spawn, costs money) → `Autonomous` (+destructive). Each level includes all below. The agent refuses actions above the current level and names the level to unlock. This drives the **in-app agent only**; the existing Settings▸MCP four-tier checkboxes continue to govern *external* MCP clients independently.
- **Option-C approvals.** Within the chosen level, reversible writes run silently; cost-incurring (AI-spawn) and irreversible (destructive) actions show an inline `[Approve] [Cancel]` chip with an estimate the first time, with a per-session "don't ask again" — zero surprise spend or deletion, zero nagging.
- **Auto-MCP availability to projects (Part A).** On project setup the app surgically merges a `mcpServers.specrails` entry into the project's **workspace** `.mcp.json` (`~/.specrails/projects/<slug>/workspace/.mcp.json`, app-managed — never the pristine repo) so that project's own rails/explore/chat spawns can also call the Specrails MCP. Token stays local (bridge reads `~/.specrails/mcp.token`).
- **Premium motion.** A motion spec built on the lightweight `motion` library (added dep): origin-anchored spring summon, panel↔dock morph on minimize, staggered live tool-cards, the tier-chip fill animation, and a spring project dropdown — all GPU-only (transform/opacity), `prefers-reduced-motion` aware.
- **Full i18n.** All new user-facing strings (tier names, dropdown, approvals, empty states) ship in the 8 locales under a new `agent` namespace; the key-parity test enforces it.

Not breaking: the existing per-project `ChatManager`/`ChatPanel` are untouched; the embedded MCP server is reused as-is; a user who never opens the agent chat is unaffected. The agent chat is gated by a feature flag (`SPECRAILS_AGENT_CHAT` server / `VITE_FEATURE_AGENT_CHAT` client, default-on opt-out) and is inert when the MCP server is disabled (degraded state surfaced).

## Capabilities

### New Capabilities
- `desktop-agent-chat`: the global, app-level agent chat — the floating non-modal shell, summon/minimize lifecycle, multi-provider `AgentChatManager` backend pointed at the Specrails MCP bridge, app-global persistence, generous sizing, and the premium motion/visual contract.
- `agent-chat-tiers`: the `Shift+Tab` cumulative tier ladder (Observe/Edit/Operate/Autonomous), its server-side enforcement for the in-app agent, and the Option-C inline approval flow for cost/destructive actions.
- `agent-chat-project-selector`: the Cursor-style project dropdown, the `Home` (app-global) vs pinned-project modes, `specrails_select_project` integration, view-decoupling, and the open-project default.
- `agent-chat-mcp-availability`: Part A — the surgical injection of the Specrails MCP server into each project's workspace `.mcp.json`, plus the agent spawn's `--mcp-config` wiring to the bundled bridge.

### Modified Capabilities
<!-- The desktop-mcp-server / desktop-mcp-tools capabilities from #469 are not yet synced into openspec/specs/, so the reuse here (scoped token, /api/mcp, specrails_select_project, specrails_watch, the four-tier model) is referenced rather than expressed as MODIFIED deltas against an unpublished base. -->

## Impact

- **Server (new)**: `server/agent-chat-manager.ts` (app-level spawner; reuses the `spawn-lifecycle`/adapter core), `server/agent-chat-router.ts` (app-level `/api/agent/*` routes — conversations CRUD, send, tier, project-pin, approvals), `server/agent-cwd-manager.ts` (materialize `~/.specrails/agent-cwd/` + bridge mcp-config), `server/agent-mcp-config.ts` (write the `--mcp-config` file pointed at `specrails-mcp`).
- **Server (modified)**: `desktop-db.ts` (+`agent_conversations` table migration), `index.ts` (mount agent router + construct `AgentChatManager` next to the registry), `setup-manager.ts` / `workspace-manager.ts` (Part A: merge `mcpServers.specrails` into workspace `.mcp.json`), `provider-selection.ts` (reuse for the agent's per-conversation provider).
- **Client (new)**: `client/src/context/AgentChatContext.tsx` (app-root provider + summon/minimize state), `client/src/components/agent-chat/` (`AgentChatPanel`, `AgentChatHeader`, `AgentProjectSelector`, `AgentTierChip`, `AgentToolCard`, `AgentApprovalChip`, `AgentTrigger`), `client/src/hooks/useAgentChat.ts`, motion helpers.
- **Client (modified)**: `App.tsx` (mount `AgentChatProvider` at root, inside `DesktopProvider`), `MinimizedChatsContext.tsx` (+`'agent'` kind / dock chip), top-bar (Bot trigger), global `Cmd/Ctrl+K` handler.
- **i18n**: new `agent` namespace × 8 locales (tier names, dropdown, approvals, errors); key-parity test must pass.
- **Deps**: add `motion` (client). No server deps (MCP SDK already present from #469).
- **Database**: additive `agent_conversations` table in `desktop.sqlite`; no per-project schema change.
- **specrails-core**: ZERO coupling — the agent talks to the app's own MCP/REST; core only sees a `mcpServers.specrails` entry in the app-managed workspace `.mcp.json` (Part A), never the pristine repo.
- **Coverage**: tier-ladder resolution, approval gating, project-scope resolution, mcp-config writing, and the cross-project "Home asks" logic are pure/unit-tested to keep server ≥80% and client ≥80%.
