# project-builder-entry

## ADDED Requirements

### Requirement: Existing | New chooser on Add Project
The "+ Add Project" action SHALL present a pre-screen with two cards — **Existing project** and **New project** — before any dialog-specific UI. Choosing *Existing* SHALL continue into the current AddProjectDialog/setup-wizard flow byte-identically. Choosing *New* SHALL open the Project Builder shell. The chooser SHALL be gated by `VITE_FEATURE_PROJECT_BUILDER` (client) and `SPECRAILS_PROJECT_BUILDER` (server), both default ON with `"false"` as the opt-out; when disabled, "+ Add Project" SHALL open the Existing flow directly with no pre-screen.

#### Scenario: Existing path unchanged
- **WHEN** the user clicks "+ Add Project" and selects *Existing project*
- **THEN** the current AddProjectDialog renders with identical behavior (path input, prerequisites panel, provider multi-select)

#### Scenario: New path opens the Builder
- **WHEN** the user selects *New project*
- **THEN** the Project Builder shell opens with an empty blueprint conversation

#### Scenario: Feature flag off
- **WHEN** `VITE_FEATURE_PROJECT_BUILDER` is the string `"false"`
- **THEN** "+ Add Project" opens the Existing flow directly and no Builder UI is reachable

### Requirement: Builder shell layout
The Project Builder SHALL render a conversation surface with a live blueprint panel. The panel SHALL show the five blueprint dimensions (product, core flow, platform, stack, M1 constraints) each with a filled (✓) or pending (✗) indicator, and SHALL reveal the complete M1 detailed-spec card set together when the single post-approval snapshot closes. It SHALL NOT present partial generation waves as a reviewable or commit-ready backlog. Each detailed-spec card SHALL expose short summary, priority, and acceptance-criteria count; its read-only detail modal SHALL expose the summary, priority, exact canonical five-section description, and every separate criterion that will be folded into the final ticket. The same review contract and atomic reveal SHALL apply in later-milestone generation. The panel SHALL update from the normalized view of each latest valid `blueprint-draft` block, while commit readiness SHALL be derived from that block's retained raw JSON.

#### Scenario: Dimensions fill during interview
- **WHEN** an assistant message contains a valid `blueprint-draft` block with `product` and `stack` populated
- **THEN** the product and stack rows show ✓ and display their summary values

#### Scenario: Complete spec set appears together
- **WHEN** the post-approval response closes a valid snapshot containing all 7 intended M1 specs
- **THEN** all 7 cards render together and the panel never exposes a 2–3-spec intermediate set

#### Scenario: Invalid block never blanks the panel
- **WHEN** a streamed message contains a malformed `blueprint-draft` block
- **THEN** the panel keeps rendering the last valid snapshot

#### Scenario: Rich spec is reviewable before commit
- **WHEN** the user opens a generated M1 or M2+ spec card
- **THEN** the preview shows its short summary, priority, all five canonical sections, and all 4–10 acceptance criteria without requiring a Board ticket to exist

#### Scenario: Normalized preview does not unlock invalid raw draft
- **WHEN** compatibility defaults make an invalid generated block renderable
- **THEN** the panel may remain readable but the Create action stays disabled because readiness validates the retained raw payload

### Requirement: Interview discipline
The Builder's system prompt SHALL enforce: at most 3 question turns before proposing a complete blueprint; propose-don't-ask (the agent proposes stack/scope with a one-line rationale and asks for corrections rather than open-ended questions); and a "surprise me" fast path that fills all five dimensions with declared defaults in a single turn. Interview and Surprise Me snapshots SHALL keep `m1Specs: []` and `specsComplete=false`; only explicit user approval or a direct request to generate the backlog SHALL start detailed specs. The next assistant response SHALL contain one complete self-validated 5–10-spec M1 snapshot with `specsComplete=true`, never a partial wave. The client SHALL surface a "surprise me" affordance on the first turn.

#### Scenario: Surprise me fills everything
- **WHEN** the user activates "surprise me" after describing only the product idea
- **THEN** the next assistant message emits a `blueprint-draft` with all five dimensions populated and each assumption listed in `assumptions[]`, but no detailed specs, and invites approval

#### Scenario: Bounded interview
- **WHEN** the user answers the agent's questions across turns
- **THEN** by the fourth agent turn at the latest the agent proposes a complete blueprint rather than asking further questions

#### Scenario: Approval unlocks rich generation
- **WHEN** the user approves the proposed blueprint or directly requests the backlog
- **THEN** the Builder returns the entire 5–10-spec canonical M1 set in one response/snapshot and marks it complete only after the whole set passes its self-audit

### Requirement: Day-0 conversation infrastructure
Builder conversations SHALL run app-level with no `projectId`: a dedicated `BlueprintChatManager` reusing `runAiCliInvocation`, spawning from `~/.specrails/builder-cwd/` (always-rewritten instruction file, no `./project` symlink, no MCP configuration). Conversations and messages SHALL persist in `desktop.sqlite` via an additive migration. Streaming SHALL use app-global WS types `blueprint.stream`, `blueprint.done`, `blueprint.error` carrying no `projectId`, and these types SHALL NOT be added to the mobile-ws translation layer. Provider, model, and provider-supported reasoning-effort selection SHALL mirror agent chat (default = first enabled provider; model and effort catalogs via the models endpoint). Provider/model SHALL persist on the conversation; a catalog-valid effort SHALL ride each send, and providers without the capability SHALL omit it.

#### Scenario: No project required
- **WHEN** a Builder conversation starts with zero registered projects
- **THEN** the turn spawns successfully and streams over `blueprint.stream`

#### Scenario: Turn accounting
- **WHEN** a Builder turn settles (success or kill)
- **THEN** one row records into the app-level `agent_invocations` ledger with `project_id` NULL

#### Scenario: Restart durability
- **WHEN** the server restarts after several Builder turns
- **THEN** the conversation history reloads from `desktop.sqlite` and the user can continue the interview
