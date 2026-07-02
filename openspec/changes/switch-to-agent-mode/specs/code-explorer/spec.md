## ADDED Requirements

### Requirement: Embeddable Code explorer

`CodePage` SHALL support a controlled/`embedded` mode so it can render inline outside the `/code` route (for the Agent Mode Files split pane). In embedded mode it SHALL NOT call `navigate` to `/code` on file/filter interactions — those SHALL be surfaced as callbacks — and its URL→state synchronization effects SHALL be no-ops. Selection and provenance filters SHALL be driven by props (controlled state), preserving the provenance toolbar. Non-embedded mode SHALL behave exactly as today (route-driven navigation and URL sync).

#### Scenario: Embedded mode suppresses navigation
- **WHEN** `CodePage` renders with `embedded` and the user opens a file
- **THEN** it fires the selection callback and does NOT call `navigate({ pathname: '/code' })`

#### Scenario: Embedded mode ignores URL state
- **WHEN** `CodePage` is embedded
- **THEN** its `searchParams`→state synchronization effect performs no state reset

#### Scenario: Controlled selection reflects props
- **WHEN** the parent passes a selected path and change handler
- **THEN** `CodePage` reflects that path and reports changes via the handler instead of writing the URL

#### Scenario: Route mode unchanged
- **WHEN** `CodePage` renders on the `/code` route (not embedded)
- **THEN** it navigates and syncs the URL exactly as before this change
