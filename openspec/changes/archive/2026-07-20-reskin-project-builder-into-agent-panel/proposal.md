# Reskin the Project Builder into the agent panel

## Why

The Project Builder shipped (change `add-project-builder`) as a standalone full-screen overlay (`ProjectBuilderShell`) — a FOURTH chat surface next to Explore, the desktop agent chat, and the milestone shell, each with its own window identity. The user already knows ONE agent (the mission/floating agent); creating a project is operating the app, so it belongs to that same agent. A separate window is a design smell: it breaks the single-agent identity, duplicates chat chrome, and adds a modal context switch exactly at the moment we want the experience to feel magical.

## What Changes

- **The agent panel becomes the Builder** (reskin, decided): the day-0 blueprint conversation renders INSIDE the existing agent surfaces — the floating `AgentChatPanel` (board mode) and the Agent Mode mission surface — instead of a standalone overlay. The blueprint protocol and orchestrated commit stay unchanged; the only server-side parity extension exposes each provider's effort catalog and validates/forwards the per-turn effort selected by the shared-style composer.
- **Entry-only halo animation**: on fresh entry the agent visually transforms — an animated halo of light orbits the empty composer plus the agent identity (bubble + panel header avatar), making the mode unmistakable. It disappears as soon as the first work message starts even though builder mode remains active. Built with the existing `motion` dependency + a rotating conic-gradient ring; respects `prefers-reduced-motion`; there is no commit wind-down.
- **Mission-composer parity**: the Builder exposes provider, model, and reasoning-effort selection, a native `resize-y` textarea, and the same `SendHorizontal` action. In Agent Mode the fresh hero composer and docked composer share a layout identity so the first send morphs the agent smoothly downward.
- **Sidebar transformation (mission mode)**: while builder mode is active in Agent Mode, the `AgentWorkspaceSidebar` transforms into the live blueprint panel (the five dimension ✓/✗ rows + spec cards in waves), animated in/out. Exiting builder mode restores the normal workspace sidebar.
- **Blueprint pane (board mode)**: in board mode the floating panel gains an attached blueprint side pane (the same `BlueprintPanel`), since there is no workspace sidebar to transform.
- **Entry point**: the Add Project chooser's *New* card forces the FLOATING agent panel open in builder mode (works identically from board and mission modes — decided). The `ProjectBuilderShell` full-screen overlay is deleted.
- **In-panel phases**: the commit mini-form, streamed progress steps, and the done screen (Launch M1 / Open project) render inside the panel flow, reusing `BlueprintCommitForm`, the step list, and the existing CTAs.
- **Mode lifecycle**: builder mode starts on chooser *New* and ends after a done-screen action or on explicit exit (confirm if a blueprint draft is in progress). The halo has its own shorter lifecycle and ends on the first work message. The builder conversation remains a `blueprint_conversations` session — never mixed into `agent_conversations` history or the mission selector.

## Capabilities

### New Capabilities

- `builder-mode-agent-panel`: builder mode inside the agent surfaces — entry/exit lifecycle, in-panel chat over the blueprint transport, in-panel commit/progress/done phases, halo animation, and the sidebar/pane transformation per UI mode.

### Modified Capabilities

- `project-builder-entry`: the Builder shell requirement changes — the *New* card opens the agent panel in builder mode instead of a full-screen overlay; the shell-layout requirement is replaced by the panel-hosted layout.

## Impact

- **Client**: `AgentChatContext` (builder-mode state), `AgentBubble`/`AgentChatPanel`/`AgentConversationHeader` (entry halo + builder chrome), `BuilderComposer` (provider/model/effort parity, resizable input, shared send icon, inline morph), `AgentWorkspaceSidebar` (blueprint transformation), `AddProjectDialog` (New → open panel in builder mode), deletion of `ProjectBuilderShell.tsx` (its pieces `BlueprintPanel`, `BlueprintCommitForm`, progress list are reused). i18n `builder` namespace gains mode-chrome keys ×8.
- **Server**: narrow composer-parity plumbing only: `/api/blueprint/models` includes provider effort levels and `/send` validates/forwards `reasoning_effort`. The blueprint protocol, commit orchestration, persistence, accounting, and WS events stay unchanged.
- **Out of scope**: the M2+ `MilestoneGenerateShell` (stays as-is; candidate for the same treatment later), any MCP/operator-prompt fusion (option 2, rejected), mobile.
