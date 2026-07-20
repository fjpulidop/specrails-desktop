# Design — Reskin the Project Builder into the agent panel

## Context

`add-project-builder` shipped the Builder as `ProjectBuilderShell` — a fixed full-screen overlay owning its own chat column, blueprint panel, commit form, progress list, and done screen, wired to `/api/blueprint/*` + the `blueprint.*` WS events. The agent surfaces it should live in instead:

- **Floating panel** (`AgentBubble` → `AgentChatPanel`, both mounted by `AgentChatContext` at App root): movable/resizable glass panel, available in BOTH UI modes.
- **Agent Mode** (mission mode): `AgentModeSurface` hosts the conversation full-bleed; `AgentWorkspaceSidebar` is the right-side tool rail.

The Builder transport is deliberately NOT the agent transport: `blueprint_conversations` + `blueprint.stream|done|error` (app-global, no `projectId`) vs `agent_conversations` + `agent_*`. The reskin keeps that separation — only the CHROME is shared.

## Goals / Non-Goals

**Goals:**
- One agent identity: the mission/floating agent visibly *transforms* into the Builder (halo), instead of a second window appearing.
- Keep the chrome reskin client-owned; allow only the narrow server parity needed to expose and validate the provider's per-turn reasoning effort.
- Both UI modes: chooser *New* forces the floating panel open in builder mode; in Agent Mode the workspace sidebar additionally transforms into the blueprint panel.

**Non-Goals:**
- No MCP/operator fusion (the agent does not gain a `specrails_blueprint` tool; the Builder conversation never appears in the mission selector).
- No changes to the blueprint protocol, commit orchestration, or accounting.
- No M2+ `MilestoneGenerateShell` migration (follow-up candidate).
- No builder-session resume/persistence beyond what exists today (fresh conversation per entry).

## Decisions

### D1 — Builder mode state lives in `AgentChatContext`

Add a `builderMode` slice to `AgentChatContext`: `{ active: boolean, enterBuilderMode(): void, exitBuilderMode(): void }` plus the session state the shell previously owned, extracted into a reusable hook `useBuilderSession()` (conversation bootstrap, WS handling, phases `chat|commit|progress|done`, blueprint snapshot, send/commit/launch actions — the logic currently inside `ProjectBuilderShell`, moved verbatim into `client/src/hooks/useBuilderSession.ts`). The context exposes mode + session so THREE consumers stay in sync: the floating panel, the Agent Mode surface, and the workspace sidebar.

*Alternative — a separate `BuilderModeContext`*: rejected; entering builder mode must also OPEN the floating panel and suppress normal agent chrome, which is `AgentChatContext`'s state. One owner avoids cross-context choreography.

### D2 — Reskin, not transport merge (locked by the user)

While `builderMode.active`, the panel's conversation area renders the builder session (messages from `useBuilderSession`, streamed via `blueprint.stream`) INSTEAD of the agent conversation; the composer submits to `/api/blueprint/conversations/:id/send`. The agent's own conversation, queue, tiers, project selector, and mission selector are hidden (not unmounted) for the duration. Exiting restores them exactly.

### D3 — Entry-only halo animation

A `BuilderHalo` component: an absolutely-positioned ring using a rotating `conic-gradient` (accent-primary → accent-highlight → transparent) behind/around (a) the fresh empty composer, (b) the `AgentBubble`, and (c) the panel header's agent identity. It is an ENTRY flourish, not a persistent mode badge: the predicate is the fresh `chat` phase with zero messages, and the first work message removes it from every placement while builder mode continues. Implementation: CSS `@keyframes` rotation on a masked ring (no per-frame JS), `motion` only for enter/exit scale+fade. `prefers-reduced-motion` ⇒ static glow ring, no rotation. Theme-token colors only (no brand-named colors); there is no commit wind-down state.

### D4 — Per-mode blueprint surface

- **Agent Mode**: `AgentWorkspaceSidebar` renders `<BlueprintPanel/>` (+ the phase CTA: Create specs / progress summary) instead of its tool rail while builder mode is active, with an animated swap (`AnimatePresence` slide/fade). Width widens to the panel's natural width while transformed.
- **Board mode**: `AgentChatPanel` gains an attached right-side pane hosting the same `BlueprintPanel` + CTA; the panel's min-width grows while in builder mode. The pane is part of the panel (moves/resizes with it).

Same component both places — the transformation is placement, not duplication.

### D5 — Entry, exit, and lifecycle

- **Entry**: `AddProjectDialog`'s *New* card calls `enterBuilderMode()` (context) and closes the dialog. Works identically in board and Agent Mode (the floating panel opens if closed; in Agent Mode the mission surface + sidebar take the builder skin). `App.tsx` drops the `ProjectBuilderShell` mount.
- **Halo lifecycle**: entry → fresh empty composer/identity halo → first work message removes it. This is independent of the longer builder-mode lifecycle.
- **Exit**: (a) commit success → done screen (Launch M1 / Open project) → both actions exit builder mode; (b) explicit close (panel × or Esc) → confirm dialog if the blueprint has any filled dimension, else exit silently. Exit aborts any in-flight builder turn (`POST /abort`) — the conversation row remains in `blueprint_conversations` (existing behavior).
- **Project switch / navigation during builder mode**: allowed (the builder is app-level); the builder skin persists until exit.

### D6 — Phases inside the panel

`chat` renders as the conversation area; `commit` swaps the conversation area for `BlueprintCommitForm`; `progress` shows the step list; `done` the CTA screen. The chat composer mirrors the mission controls without importing its project-coupled machinery: provider/model selectors persist on the blueprint conversation, effort comes from `/api/blueprint/models` and rides each `/send`, the textarea uses native `resize-y`, and the send action uses `SendHorizontal`. In Agent Mode a shared `layoutId` links the fresh hero card to the docked card, producing the smooth first-send downward morph. All four phases reuse the shipped components/markup from `ProjectBuilderShell`, which is then deleted. The blueprint pane (D4) stays visible across all phases.

## Risks / Trade-offs

- **[Agent panel complexity]** `AgentChatPanel`/`AgentConversationHeader` are already large; the builder branch adds conditional chrome. → The branch is a single `builderMode.active` fork rendering dedicated `Builder*` subcomponents — no interleaving with agent conversation logic.
- **[Hidden-not-unmounted agent state]** A live agent stream while builder mode activates could broadcast into hidden UI. → Streams continue harmlessly (state updates on hidden components); the queue/pinned-dock stay intact on exit. No aborting of agent turns on enter.
- **[Test churn]** `ProjectBuilder.test.tsx` targets the shell. → The shell tests migrate to `useBuilderSession` (hook tests) + panel-hosted render tests; `BlueprintPanel`/`BlueprintCommitForm`/`milestone-launch` tests unchanged.
- **[Client coverage gate]** New context/animation code needs tests. → Halo is presentational (cheap render test); the mode lifecycle is pure context logic (unit-testable).

## Migration Plan

Additive then delete: land `useBuilderSession` + context slice + panel/sidebar branches, add the narrow effort-catalog/per-send parity to `/api/blueprint`, switch the chooser entry, and delete `ProjectBuilderShell.tsx` plus its overlay mount in the same change. Rollback = the `VITE_FEATURE_PROJECT_BUILDER` flag already hides the whole entry.

## Open Questions

- Esc semantics inside the commit form: back-to-chat vs exit-confirm (leaning back-to-chat; Esc exits only from the chat phase).
