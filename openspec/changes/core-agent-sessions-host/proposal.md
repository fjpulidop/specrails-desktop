## Why

Agent execution is moving into Core (paired Core change `agent-session-runtime`). Core becomes the single engine for provider sessions, sub-agents, usage and durable session state; Desktop becomes the host that applies product rules and renders state, as it already does for implementation runs.

The trigger is a confirmed defect: mission turns kill Claude background sub-agents two seconds after the first `result`, and the next `--resume` makes the agent relaunch them silently. Desktop also has no model for sub-agents at all. Codex expresses sub-agents as threads, which Desktop cannot represent either. Fixing this inside Desktop would add a third provider layer on top of `server/providers/*` and Core's executors.

## What Changes

- New server capability module `server/modules/agent-sessions/`. It owns:
  - one Core session host process per project scope, plus one for the global scope: supervision, restart with backoff and graceful shutdown;
  - protocol negotiation (`runtime api` → `sessions`, `initialize` → `protocolVersion`);
  - a typed JSON-RPC client;
  - cursor-based event replay.
- A **conversation transport port**, so features choose between the Core session transport and the existing legacy transports at composition time.
  - The legacy path stays available when the installed Core lacks `sessions`, or when `SPECRAILS_CORE_SESSIONS=off`.
- **Missions run on Core sessions.**
  - Desktop keeps its product rules: queue and steer UX, receipts, Specrails MCP capability minting (now bound to the Core session lifetime), tiers, PR and rail cards, titles.
  - Core events are projected into the desktop database: messages, invocations with origin, sub-agent projection, last applied sequence.
  - The projection is rebuildable from Core's journal.
- **Mission sub-agent experience**:
  - a live "N agents working" card per launching turn;
  - an expandable sub-agent stream;
  - continuation turns with origin labels;
  - a background-agents composer pill with Stop;
  - a deferred-settings notice;
  - interrupted rows with a Relaunch draft.
  - It is premium, reduced-motion aware and available in all 8 locales.
- **Accounting from Core usage events**: billed vs estimated, per-turn deltas, origin `user|subagent|system`, sub-agent breakdown never added to totals.
- **Sub-agent policy toggle, delivered last**:
  - a project setting "Allow sub-agents", default **off**, applied to every conversational surface of the project (missions, explore, refinements) but not to Implement pipelines;
  - a global setting, also default off, for missions without a project.
  - Until then Desktop sends `subagents: enabled`, preserving today's behaviour.
- Packaging and compatibility:
  - the bundled Core must include the host operation;
  - Windows spawn traps are handled (bundled Node path, spawn environment);
  - `check-core-compat` and the paired smoke test cover the sessions contract.
- Out of scope, as follow-up changes: migrating explore, blueprint, agent refine, interactive jobs and one-shot features to Core sessions, and deleting `server/providers/*` afterwards.

## Capabilities

### New Capabilities
- `core-session-host`: discovery and negotiation of Core sessions, per-scope host supervision, restart and recovery, replay cursors, legacy fallback, conversation transport port.
- `mission-subagents`: projection of Core sub-agent events, durable desktop projection, snapshot/WS/API/MCP exposure, mission UI for live and historical sub-agents, interruption and relaunch drafting, cost presentation.
- `subagent-policy-toggle`: project and global "Allow sub-agents" settings (default off), mapping to Core session policy, safe application to running sessions, UI and API.

### Modified Capabilities
- `desktop-agent-chat`: the terminal-state guarantee covers agent-initiated continuation turns and the background phase; connection recovery reconciles the resident phase and sub-agent state.
- `agent-live-steering`: native input reaches a Core session between turns and while only sub-agents run, with Core receipts mapped to the existing receipt vocabulary.

## Impact

- **Server**:
  - new `server/modules/agent-sessions/`;
  - `server/modules/missions/runtime/agent-chat-manager.ts` gains a transport seam and keeps its product rules;
  - `server/agent-mcp-config.ts` (capability bound to the session);
  - accounting (`ai-invocations` origin, Core usage projection);
  - `desktop-db.ts` (appended migrations for the projection);
  - startup and shutdown wiring in `server/index.ts`;
  - core runtime loader (`sessions` capability);
  - `server/core-compat.ts` and `scripts/check-core-compat.ts`;
  - project-settings module (toggle, last).
- **Client**: `client/src/features/missions/` (state, WS handlers, sub-agent components, composer pill), settings UI (toggle, last), i18n in 8 locales.
- **Docs**:
  - `docs/internals/agent-sessions.md`, a new architecture and operations guide;
  - updates to the internals index, API reference, configuration, operations runbook and user mission docs;
  - module READMEs and boundaries manifest.
- **Packaging**: bundled Core version pin with the host operation; native smoke covers launching the host on all platforms.
- **Dependency**: requires the Core release containing `agent-session-runtime`. Without it, Desktop keeps legacy behaviour.
