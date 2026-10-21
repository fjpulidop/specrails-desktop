# agents-section Specification

## Purpose
TBD - created by archiving change add-agents-profiles. Update Purpose after archive.

## Requirements

### Requirement: Sidebar entry
The project sidebar SHALL contain a new entry labeled "Agents" placed between the existing pipeline-related entries and Settings. The entry SHALL be visible in Super mode only.

#### Scenario: Entry visible in Super mode
- **WHEN** `activeProjectId` is non-null
- **THEN** the sidebar shows an "Agents" link between the pipeline entries and Settings

#### Scenario: Entry hidden in legacy mode
- **WHEN** the app runs in legacy single-project mode
- **THEN** the "Agents" sidebar entry is not rendered

### Requirement: Three-tab shell
The Agents section SHALL render a tab strip with three tabs: `Profiles`, `Agents`, `Models`. `Profiles` SHALL be the default landing tab.

#### Scenario: Default landing
- **WHEN** the user navigates to `/projects/:id/agents` for the first time
- **THEN** the Profiles tab is active

#### Scenario: Tab persistence
- **WHEN** the user selects the Agents tab and navigates away and back
- **THEN** the app restores the Agents tab as active for that project (per-project memory)

### Requirement: Profiles tab
The Profiles tab SHALL display a list/grid of the project's profiles, a "New profile" action, and an editing surface for the currently-selected profile that shows orchestrator model, agent chain (ordered, per-agent model dropdown), and routing rules (ordered, drag-to-reorder, first-match-wins semantics visible).

#### Scenario: Profile list displayed
- **WHEN** the Profiles tab renders and the project has profiles `default`, `data-heavy`
- **THEN** both profiles are shown as selectable tabs or cards, with `default` marked as the project default

#### Scenario: Required agents not removable
- **WHEN** the user attempts to remove `sr-architect`, `sr-developer`, or `sr-reviewer` from a profile's chain
- **THEN** the remove action is disabled with a tooltip explaining these are required

#### Scenario: Routing rule ordering visible
- **WHEN** the Profiles tab shows a profile with multiple routing rules
- **THEN** rules are rendered in evaluation order with visible ordinals and drag handles; the terminal `default: true` rule is pinned last and cannot be moved

### Requirement: Agents tab
The Agents tab SHALL display a catalog segmented into Upstream and Custom. Upstream entries are the provider's baseline roles (`sr-architect`, `sr-developer`, `sr-reviewer`), defined by the specrails-core runtime and listed read-only with the runtime definition as their body; they do not correspond to files in `.claude/agents/`. Custom entries are the `custom-*` agents in the provider's native catalog and are editable. An "Open in Studio" action SHALL open a Custom agent in the Agent Studio.

#### Scenario: Upstream read-only
- **WHEN** the user selects `sr-developer`
- **THEN** a read-only viewer shows the role's description ("runtime-defined by specrails-core") and the current runtime definition body; no edit actions are offered

#### Scenario: Upstream shown without installed files
- **WHEN** the project has no `.claude/agents` directory
- **THEN** the Upstream segment still lists the three baseline roles and the Custom segment is empty

#### Scenario: Custom editable
- **WHEN** the user selects `custom-pentester`
- **THEN** an "Open in Studio" button and a "Version history" control are offered

### Requirement: Models tab
The Models tab SHALL display default model selectors (per role) and a "Test connectivity" action for the current Claude CLI login. Values on this tab SHALL represent the project's baseline defaults, distinct from any specific profile.

#### Scenario: Default models shown
- **WHEN** the Models tab renders
- **THEN** selectors for orchestrator default, developer default, reviewer default, and fallback agent default are visible with the current values

### Requirement: Feature flag gating
The Agents section SHALL be gated behind `VITE_FEATURE_AGENTS_SECTION` on the client and `SPECRAILS_AGENTS_SECTION !== 'false'` on the server during rollout.

#### Scenario: Section hidden when flag off
- **WHEN** `VITE_FEATURE_AGENTS_SECTION` is not `true`
- **THEN** the sidebar entry is not rendered and the `/projects/:id/agents` route returns the default not-found experience

#### Scenario: Server endpoints gated
- **WHEN** `SPECRAILS_AGENTS_SECTION` is `false` AND a request hits `/api/projects/:id/profiles`
- **THEN** the server returns HTTP 404

### Requirement: Upgrade banner for older core
The Agents section SHALL display a banner when the linked project's specrails-core version is older than 4.1.0. The banner SHALL instruct the user to run `npx specrails-core@latest update`.

#### Scenario: Banner shown on older core
- **WHEN** the project's installed specrails-core version is 4.0.8
- **THEN** the Agents section shows a non-dismissable banner naming the required version

#### Scenario: Banner hidden on 4.1.0+
- **WHEN** the project's specrails-core version is 4.1.0 or newer
- **THEN** no banner is displayed

### Requirement: Per-project memory of active tab and selection
The app SHALL persist per-project the last-visited Agents sub-tab and the last-selected profile name for that project. These SHALL be restored when returning to the project.

#### Scenario: Tab restored on project switch
- **WHEN** the user is on the Agents tab with Profiles sub-tab open for project A, switches to project B, and returns to A
- **THEN** the Agents tab is active with the Profiles sub-tab selected
