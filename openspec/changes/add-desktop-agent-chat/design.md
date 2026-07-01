# Design — Desktop Agent Chat

## Context

The embedded MCP server (#469) already exposes the whole app to MCP clients via a scoped token over loopback, with `specrails_select_project` (sticky active project), `specrails_watch` (bridges the pervasive `202 + WS` async pattern), and a four-tier permission model. This change consumes that surface from *inside* the app. Nothing about the MCP server's wire contract changes.

The hard parts are: (1) a chat that is **app-global**, not per-project, without forking `ChatManager` wholesale; (2) a permission model the user can **steer live** and trust; (3) a non-modal shell whose whole point is that you **watch the app change behind it**; (4) motion that feels "de lujo" on a WebKit (Tauri) webview.

## Decisions

### D1 — `AgentChatManager` as a sibling, not a generalized `ChatManager`
`ChatManager` is deeply project-bound: per-project cwd resolution, project-name system prompts, a per-project `_buildDashboardContextBlock`, and a per-project `jobs.sqlite`. Forcing it to also be app-global would thread `projectId | null` through dozens of call sites. Instead we add `AgentChatManager`, which **reuses the shared spawn→stream→settle core** (`spawn-lifecycle.ts` `runAiCliInvocation`, the provider adapters, `parseStreamLine`, `finaliseInvocationResult`) but supplies its own cwd (`~/.specrails/agent-cwd/`), its own "operator" system prompt, and its own app-level conversation store. Streaming reuses the same WS event vocabulary (`chat_stream`/`chat_done`/`chat_error`) under an `agent.*` channel so the client renderer is near-identical.

**Alternative rejected:** one `ChatManager` with a nullable project. Rejected for the call-site blast radius and the per-project DB coupling.

### D2 — App-global persistence in `desktop.sqlite`
The agent's conversations are not owned by any project, so they live in the app registry DB (`desktop.sqlite`) in a new `agent_conversations` table (`id, title, provider, model, pinned_project_id NULL, tier_level, created_at, updated_at`) plus `agent_messages`. `pinned_project_id` records the selector state so a reopened conversation restores its target project. Persistence is app-global per the user's explicit choice (decision ④).

### D3 — Non-modal shell is the feature, not a constraint
The panel renders above the route outlet with **no backdrop dim** and `pointer-events` only on the panel itself, so the dashboard stays fully interactive and live. The agent's mutations arrive on the same project-scoped WS events the dashboard already listens to, so the board updates underneath in real time. Movability/resize come from `useMovableResizableModal` (already in the repo). Minimize reuses `MinimizedChatsDock` with a new `'agent'` chip kind; unlike per-project chips the agent chip carries no `projectId` (or a synthetic app-level marker).

```
 ┌───────────────────────── window ─────────────────────────┐
 │  dashboard (LIVE, interactive)        ┌──────────────────┐│
 │  ░ rails board updates in real time ░ │ 🤖 agent panel   ││  ← non-modal,
 │  ░ as the agent operates ░            │  glass, movable  ││    movable+resize
 │                                       │  resizable       ││
 │                              [_min]──►│                  ││
 │                                       └──────────────────┘│
 └───────────────────────────────────────────────────────────┘
```

### D4 — Cumulative tier ladder for the in-app agent; Settings checkboxes stay for external clients
The MCP server's four tiers are *independent checkboxes* governing external clients. For the in-app agent we expose a **cumulative ladder** — strictly more intuitive for a live control — mapped onto those tiers:

```
 level 0  Observe     = read
 level 1  Edit        = read + write
 level 2  Operate     = read + write + ai-spawn        (money)
 level 3  Autonomous  = read + write + ai-spawn + destructive   (irreversible)
```

`Shift+Tab` cycles 0→1→2→3→0. The effective in-app level is **independent** of the Settings▸MCP external checkboxes: the agent is more trusted (it's the user, in their app, watching) and deserves a live dial; external clients (operating unseen) keep the explicit Settings gate. Server-side, the agent router enforces the conversation's `tier_level` before dispatching any tool, returning a machine-readable "needs level N" the client renders as the 🔒 message.

Ordering rationale: read (safe) < write (reversible) < ai-spawn (costs money) < destructive (irreversible) is a monotonic "blast radius" escalation, so cumulative inclusion is sound.

### D5 — Option-C approvals
Even within the chosen level, **ai-spawn and destructive** actions surface an inline `[Approve] [Cancel]` chip with a cost/impact estimate the first time they occur in a session; an "don't ask again this session" promotes that action class to silent for the rest of the conversation. Reversible writes never prompt. This is a UI-layer gate on top of the server tier-enforcement (defence in depth): the server still refuses if the *level* is too low; the approval chip handles the *within-level* "are you sure about spending/deleting" beat.

```
 🤖  I'll launch 3 rails on acme-api.
     ┌───────────────────────────────────────────────┐
     │ ⚡ Launch 3 rails · ~$2.40 · ai-spawn          │
     │   [Approve]  [Cancel]   ☐ don't ask again      │
     └───────────────────────────────────────────────┘
```

### D6 — Cursor-style project selector; `Home` = app-global
A header dropdown clones Cursor's `Home▾` menu: a search field, a Recents list, the full project list, and footer actions (`Search across all projects`, `Add project…`). Two modes:

- **Pinned project** → the client sends the project id with each turn; the agent calls `specrails_select_project` so all domain tools scope there. Phrases like "launch the high ones" resolve against that project.
- **`Home`** → no `specrails_select_project`. The agent operates app-globally (`specrails_projects` list/create, cross-project reads). When a request is project-specific and ambiguous, the agent **asks**: create a new project, or search across all.

The selector **defaults to the currently-open dashboard project** (decision ⑥) but is freely overridable to `Home`; changing it does **not** move the user's dashboard view (decoupled — decision from the `select_project` risk).

### D7 — Cross-project search v1 = agent iterates
Native cross-project search would need a new MCP capability. For v1 the agent achieves "search across all projects" by listing projects (`specrails_projects`) and querying each (`specrails_search` is project-scoped today). A dedicated cross-project search capability is a documented follow-up (decision ⑦). The UI exposes the affordance ("Search across all projects"); the agent does the fan-out.

### D8 — Part A: MCP availability via the workspace `.mcp.json` only
To let a project's *own* spawns (rails/explore/chat) call the Specrails MCP, we merge a `mcpServers.specrails` entry — **surgically**, into the **workspace** `.mcp.json** under `~/.specrails/projects/<slug>/workspace/` (app-managed; the relocation contract keeps the repo pristine), never the repo's `.mcp.json`. The entry runs `node <bundled>/specrails-mcp.js` (stdio); the bridge reads `~/.specrails/mcp.token` locally so no token is written into the file. Merge follows the existing plugin `.mcp.json` mutex/atomic pattern. Recursion (a rail that spawns rails) is bounded by the tier model — `ai-spawn` is opt-in.

### D9 — Motion stack = add `motion` (lib), GPU-only
The repo has no animation library (pure CSS + 13 keyframes). CSS reaches ~90% but the signature interactions — **interruptible** spring summon, and a true **panel↔dock layout morph** — look stiff in CSS when interrupted. We add `motion` (lightweight, React-19 compatible). Animation discipline: only `transform`/`opacity` are animated (GPU compositing), `will-change` is set during and cleared after, drag/resize are rAF-throttled (the premium-terminal panel already establishes this), blur ≤ 20px single-layer (WebKit cost), and everything collapses to a near-instant fade under `prefers-reduced-motion`.

Signature animations:
1. **Summon** — origin-anchored from the Bot trigger: `scale .85→1`, `opacity 0→1`, `translateY 8→0`, spring overshoot ≈220ms.
2. **Minimize** — panel morphs toward the dock corner; the chip receives with a micro-bounce; fully reversible.
3. **Tool-cards** — stream in staggered (≈60ms), each slide-up 12px + fade; the `◉live` dot pulses (opacity 1↔.4, ~1.4s) until the watched op settles.
4. **Tier chip** — the level bar fills (`width` via transform-scaleX), color crosses to the tier accent, micro-bounce `scale 1→1.08→1`.
5. **Project dropdown** — spring-down with per-item stagger (≈30ms).
6. **Streaming text** — reuse the existing `useSmoothStream` char buffer.

### D10 — Generous sizing
Default ≈520px × 78vh (spacious), min 400px × 420px, max ≈880px × 94vh. Double-click header cycles compact/comfortable/max presets; edge-snap available. Resize persists per-app to `localStorage`.

### D11 — Degraded when MCP disabled
If `mcp_enabled` is `false`, the agent has no tools. The panel still opens but shows a one-click "Enable Specrails MCP" banner (calls the existing `/api/mcp-admin`), and the agent runs read-only-chat until enabled. Feature-flagged off entirely via `SPECRAILS_AGENT_CHAT=false` / `VITE_FEATURE_AGENT_CHAT=false`.

## Risks / Open Questions

- **Recursion & cost.** Agent→AI→AI. Mitigated by tiers (ai-spawn opt-in) + Option-C approval + an optional per-conversation spend cap. Worth a hard ceiling.
- **`select_project` vs UI sync.** Resolved decoupled (D6): the board never auto-jumps. If users later *want* "follow the agent", that's an opt-in follow toggle (follow-up).
- **WebKit blur performance** on large panels with a live board behind. Keep blur single-layer ≤20px; measure on the Tauri build.
- **Cross-project fan-out latency** (D7) — listing+querying every project can be slow on large registries; cap + stream partial results; native capability is the real fix.
- **Token exposure.** The bridge reads `~/.specrails/mcp.token`; ensure the workspace `.mcp.json` (D8) never inlines it and stays under `$HOME`, not the repo.
