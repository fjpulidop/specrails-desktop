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

### D12 — Conversational context palette: one system, typed shortcuts plus visual discovery
The agent input should feel like a context workspace, not a plain textarea with autocomplete. We use a single palette engine with specialized triggers:

```
 @  = reference a Specrails object
 #  = reference an operational trace / id / history item
 /  = invoke an action
 +  = visual entry point for the same palette
```

The typed triggers open immediately when typed, before the user enters a query. The `+` button opens the same palette for users who do not know or remember the typed shortcuts. Typing filters in real time; arrow keys move selection; Enter accepts; Tab completes; Esc closes. Selection inserts a structured inline chip instead of text:

```
 "Compare " [@ Checkout Spec] " with " [# deploy-preview failed]

 chip payload:
 {
   type: "spec",
   id: "spec_...",
   label: "Checkout Spec",
   scope: { projectId: "home" }
 }
```

The agent receives the original message text plus resolved references. This avoids name ambiguity and lets the model act as if the user had passed the real objects, not just their labels.

#### `@` references
`@` is the universal reference gesture. It can resolve projects, specs, jobs, missions, files/artifacts if exposed, current selection, and objects created during the current conversation. Power-user aliases are allowed but not required:

- `@current` / `@this` - the currently viewed or pinned context.
- `@last` - the most recent object created or touched in the conversation.
- `@selection` - the selected text/block/item in the UI, when available.

The default ranking is intentionally contextual:

1. Objects created or touched in this conversation.
2. Objects in the pinned project / current mission scope.
3. Recent objects.
4. Active or attention-worthy objects (failed jobs, running operations, draft specs).
5. Global Specrails search.

For Mission Home, the empty `@` palette starts with projects, global recents, active jobs, and conversation-created objects. Inside a project, project-local specs/jobs/artifacts move above global results. Inside a spec or job view, sibling and child items move up. The user should not have to choose a namespace before searching; the result row carries type, state, and breadcrumb.

The premium bar for `@`: it should feel like memory, not search. The first rows should usually be things the user is likely thinking about already: the current mission, the pinned project, objects just created by the agent, failed/running work, and visible UI selection. Only after those does it become a broad search box.

#### `#` traces
`#` is not a second generic entity picker. It is an accelerator for operational traces: job IDs, runs, errors, deploys, checks, PRs, changes, failed/running/completed states, and other numbered/history objects. It should support direct IDs (`#142`) and semantic filters (`#failed`, `#deploy`, `#run-42`), scoped first to the active/pinned project and then to global history.

#### `/` actions
`/` opens the action palette: create spec, update project, launch job, compare, summarize, save decision, open item, generate plan, and similar chat-native commands. Actions consume existing chips inside the composer. For example, with `@Home Project` already present as an inline chip, `/create spec` should be pre-scoped to Home. Actions still obey the tier ladder and Option-C approvals.

The action catalog is grouped by user intention, not by MCP tool name:

| Group | Representative actions |
| --- | --- |
| Create | create spec, create project, create rail, create loop, create custom agent |
| Refine | explore spec, update spec, improve spec with AI, refine contract, split epic |
| Execute | assign to rail, launch rail, launch all eligible rails, run loop, spawn job |
| Review | show status, diagnose, compare, summarize, inspect files touched, show cost |
| Navigate | open item, search current project, search all projects, show related objects |
| Queue | pause queue, resume queue, reorder queue, change priority |
| Integrate | connect Jira, sync Jira, install plugin, check plugin health |
| Decide | create PR, publish/local-integrate delivery, discard implementation, check merge |
| Configure | change rail engine/profile/mode, set budget, change app language/theme |
| Clean up | cancel job, stop rail, delete spec, purge jobs, unregister project |

The palette should not dump this whole catalog at once. It should rank actions by what is selected:

- With no chips: create spec, search, status, diagnose project, launch all, show spend.
- With a project chip: status, search specs, launch all, show rails, show spend, sync Jira, show plugins.
- With a spec chip: update spec, assign to rail, launch in rail, refine contract, split epic, show files touched, show spend, delete spec.
- With a job/run trace: open job, wait for result, compare, show diff, export diagnostic, cancel job.
- With a PR/delivery card: create PR, publish/local-integrate, discard, poll merge.
- With a file chip: read file, summarize file, regenerate summary, show provenance, show diff.

The user-facing action names must be domain language (`Launch rail`, `Refine contract`, `Show files touched`), while the implementation may map to `specrails_*` MCP tools internally.

#### `+` visual entry point
The composer `+` button is the discovery path for the whole system. It opens a compact add menu with the same underlying sources:

```
Add
  Reference...
  Trace / job / run...
  Action...
  File attachment...
  Browser capture...
```

`Reference...` opens the `@` palette, `Trace...` opens the `#` palette, and `Action...` opens the `/` palette. Existing attachment and browser-capture affordances should live behind or next to this button so the left side of the composer reads as one coherent "add context" area rather than separate unrelated icons.

#### First-use quality bar
The interaction should be understandable on first use without a tutorial. The system earns that through:

- Empty-trigger suggestions that are already useful.
- Clear row anatomy: icon/type, title, state, breadcrumb, recency.
- Contextual action ranking instead of a flat command list.
- Visible inline composer chips that show what the agent will use.
- Chips that can be opened, removed, pinned, or previewed.
- No dead ends: no-result states offer search-all, create-new, ask-agent, and archived-results recovery.
- No surprise: cost/destructive actions show tier/approval state before they run.

The product goal is to make the user feel that Specrails understands the workbench they are in. Power users can type `@`, `#`, and `/`; new users can press `+` and reach the same capability.

#### Inline composer and conversation chips
The composer itself shows what the agent will carry into the next turn. Selected `@`, `#`, and `/` results become removable chips inside the chat input rather than being duplicated as plain text or repeated in a separate strip:

```
 [@ Home Project] [@ Checkout Spec] [# deploy-preview failed] compare release risk
```

The user can remove chips, pin them for the mission, or open a preview. Chips are live, not decorative: hover/click shows title, type, state, parent project, last activity, and quick actions such as open, compare, pin/unpin, or remove. The same chip representation is used in the composer and in the sent conversation bubble: selected `@`, `#`, and `/` results persist their structured payload with the user message so refreshes render exact chips rather than regex-guessed text.

#### Ambiguity and empty states
If the typed query matches multiple objects, the palette handles disambiguation inline with rows that show type, state, and breadcrumb. If there are no results, the palette offers useful exits instead of a dead state:

- Search all Specrails.
- Create a new spec/project with the typed name, when appropriate.
- Ask the agent about the literal text.
- Include archived results.

This keeps the interaction conversational while still making the resolved context explicit.

## Risks / Open Questions

- **Recursion & cost.** Agent→AI→AI. Mitigated by tiers (ai-spawn opt-in) + Option-C approval + an optional per-conversation spend cap. Worth a hard ceiling.
- **`select_project` vs UI sync.** Resolved decoupled (D6): the board never auto-jumps. If users later *want* "follow the agent", that's an opt-in follow toggle (follow-up).
- **WebKit blur performance** on large panels with a live board behind. Keep blur single-layer ≤20px; measure on the Tauri build.
- **Cross-project fan-out latency** (D7) — listing+querying every project can be slow on large registries; cap + stream partial results; native capability is the real fix.
- **Token exposure.** The bridge reads `~/.specrails/mcp.token`; ensure the workspace `.mcp.json` (D8) never inlines it and stays under `$HOME`, not the repo.
- **Palette result latency.** Empty-trigger suggestions must feel instant. Cache recents/current-scope entities locally and stream slower global results below them.
- **Reference freshness.** Chips carry stable IDs but labels/states can change. Resolve/freshen chip metadata before dispatching a turn, and degrade clearly if an object was deleted.
- **Action overload.** Specrails has a large command surface. The palette must default to contextual ranking and progressive disclosure; otherwise `/` becomes a technical command dump.
- **Discoverability vs clutter.** The `+` button should make the system discoverable without adding a noisy toolbar. It should consolidate add-context affordances, not multiply them.
