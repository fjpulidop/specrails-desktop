# project-builder-entry (delta)

## MODIFIED Requirements

### Requirement: Existing | New chooser on Add Project
The "+ Add Project" action SHALL present a pre-screen with two cards — **Existing project** and **New project** — before any dialog-specific UI. Choosing *Existing* SHALL continue into the current AddProjectDialog/setup-wizard flow byte-identically. Choosing *New* SHALL close the dialog and open the FLOATING agent panel in builder mode (see `builder-mode-agent-panel`), in both board and Agent Mode. The chooser SHALL be gated by `VITE_FEATURE_PROJECT_BUILDER` (client) and `SPECRAILS_PROJECT_BUILDER` (server), both default ON with `"false"` as the opt-out; when disabled, "+ Add Project" SHALL open the Existing flow directly with no pre-screen.

#### Scenario: Existing path unchanged
- **WHEN** the user clicks "+ Add Project" and selects *Existing project*
- **THEN** the current AddProjectDialog renders with identical behavior (path input, prerequisites panel, provider multi-select)

#### Scenario: New path opens the agent in builder mode
- **WHEN** the user selects *New project*
- **THEN** the dialog closes and the floating agent panel opens in builder mode with an empty blueprint conversation

#### Scenario: Feature flag off
- **WHEN** `VITE_FEATURE_PROJECT_BUILDER` is the string `"false"`
- **THEN** "+ Add Project" opens the Existing flow directly and no builder mode is reachable

## REMOVED Requirements

### Requirement: Builder shell layout
**Reason**: The standalone full-screen `ProjectBuilderShell` overlay is replaced by builder mode hosted inside the agent surfaces — one agent identity, no separate window.
**Migration**: The live blueprint panel, dimension rows, spec-card waves, surprise-me affordance, and invalid-block resilience are re-specified in `builder-mode-agent-panel` (per-mode blueprint surface + in-panel phases); the underlying components (`BlueprintPanel`, `BlueprintCommitForm`) are reused unchanged.
