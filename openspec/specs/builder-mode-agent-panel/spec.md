# builder-mode-agent-panel Specification

## Purpose
TBD - created by archiving change reskin-project-builder-into-agent-panel. Update Purpose after archive.
## Requirements
### Requirement: Builder mode lifecycle on the agent surfaces
The app SHALL provide a builder mode owned by `AgentChatContext`: `enterBuilderMode()` opens the floating agent panel (if closed) and switches its conversation area to a day-0 blueprint session over the existing `/api/blueprint/*` transport; `exitBuilderMode()` restores the normal agent chrome exactly. The builder session SHALL use `blueprint_conversations` and the `blueprint.*` WS events — it SHALL NOT appear in the mission selector nor mix into `agent_conversations`. Session logic SHALL live in a reusable `useBuilderSession()` hook (bootstrap, streaming, phases, snapshot, send/commit/launch), extracted from the shipped shell.

#### Scenario: Enter from the chooser
- **WHEN** the user picks *New project* on the Add Project chooser
- **THEN** the dialog closes and the floating agent panel opens in builder mode, in both board and Agent Mode

#### Scenario: Agent state preserved across the mode
- **WHEN** builder mode is entered while an agent conversation has queued messages
- **THEN** exiting builder mode restores the same conversation, queue, and pinned cards without loss

#### Scenario: Builder conversations stay out of mission history
- **WHEN** a builder session runs to completion
- **THEN** the mission selector lists no new conversation

### Requirement: Halo transformation animation
On fresh entry into builder mode, an animated halo of light SHALL orbit the empty composer and the agent identity on the `AgentBubble` and panel header, using theme accent tokens (no brand-named colors). The halo SHALL be visible only while the builder is in its initial `chat` state with zero messages; the first work message SHALL remove it from every placement while builder mode continues. Rotation SHALL be CSS-driven (no per-frame JS), enter/exit SHALL animate (scale/fade), and no commit wind-down SHALL exist. Under `prefers-reduced-motion` the entry halo SHALL render as a static glow with no rotation.

#### Scenario: Halo appears on enter
- **WHEN** builder mode activates
- **THEN** the empty composer, bubble, and panel header show the orbiting halo

#### Scenario: Halo ends when work begins
- **WHEN** the user sends the first work message
- **THEN** the halo disappears from the composer and agent identity while builder mode remains active

#### Scenario: Reduced motion respected
- **WHEN** the OS reports `prefers-reduced-motion: reduce`
- **THEN** the halo renders as a static ring without rotation

### Requirement: Per-mode blueprint surface transformation
While builder mode is active: in Agent Mode the `AgentWorkspaceSidebar` SHALL transform (animated swap) into the live blueprint panel plus the phase CTA, restoring the tool rail on exit; in board mode the floating panel SHALL gain an attached blueprint side pane hosting the same component. Both placements SHALL render the same `BlueprintPanel` fed by the builder session's last valid snapshot, and an invalid streamed block SHALL never blank it.

#### Scenario: Mission sidebar transforms
- **WHEN** builder mode activates while in Agent Mode
- **THEN** the workspace sidebar swaps to the blueprint panel and swaps back on exit

#### Scenario: Board-mode pane
- **WHEN** builder mode activates while in board mode
- **THEN** the floating panel shows the blueprint pane attached to its conversation area

#### Scenario: Blueprint dimensions preserve completion indicators
- **WHEN** either builder-mode placement renders the last valid blueprint snapshot
- **THEN** the panel shows product, core flow, platform, stack, and M1 constraints
- **AND** every dimension displays its filled (`✓`) or pending (`✗`) indicator

### Requirement: In-panel phases
The builder phases SHALL render inside the agent panel flow: `chat` (conversation + composer bound to the blueprint transport, surprise-me affordance on first turn), `commit` (the shipped commit mini-form replacing the conversation area), `progress` (the streamed step list), `done` (Launch Milestone 1 / Open project CTAs). The chat composer SHALL offer provider, model, and provider-supported reasoning-effort selection; a native vertically resizable textarea; and the same horizontal-send icon as the mission composer. In Agent Mode the initial hero composer SHALL morph smoothly into its docked position on the first send via a shared layout identity. The full-screen `ProjectBuilderShell` overlay SHALL be removed.

#### Scenario: Commit inside the panel
- **WHEN** the user activates *Create specs* with a valid blueprint
- **THEN** the commit mini-form renders inside the panel and a successful submit streams the progress steps in place

#### Scenario: Overlay gone
- **WHEN** builder mode is used end to end
- **THEN** no full-screen overlay mounts; all interaction happens within the agent surfaces

#### Scenario: Composer parity
- **WHEN** the selected provider advertises reasoning-effort levels
- **THEN** the Builder shows provider/model/effort controls, sends a validated effort per turn, and retains the resizable mission-style input and send action

#### Scenario: First-send morph in Agent Mode
- **WHEN** the user sends the first message from the centered empty composer
- **THEN** that composer transitions smoothly into the docked conversation position

### Requirement: Exit protection
An explicit exit (panel close or Esc from the chat phase) SHALL ask for confirmation when the blueprint has at least one filled dimension, and SHALL abort any in-flight builder turn on confirm. Esc from the commit form SHALL return to the chat phase, not exit.

#### Scenario: Dirty exit confirms
- **WHEN** the user closes the panel after the blueprint gained content
- **THEN** a confirmation is shown before builder mode ends

#### Scenario: Clean exit is silent
- **WHEN** the user closes the panel before any dimension filled
- **THEN** builder mode ends without confirmation
