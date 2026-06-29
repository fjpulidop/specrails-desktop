## ADDED Requirements

### Requirement: SMASH-capable hint hidden for Codex provider

The `ContextScopeSlider` component SHALL NOT render the `scope-smash-hint` element when the `provider` prop equals `'codex'`, regardless of the value of `scope.contractRefine`. The element MUST be absent from the DOM entirely (not hidden via CSS) when `provider === 'codex'`.

#### Scenario: Codex project, contractRefine enabled
- **WHEN** `ContextScopeSlider` receives `provider="codex"` and `value.contractRefine === true`
- **THEN** the `scope-smash-hint` element is not present in the rendered output

#### Scenario: Claude project, contractRefine enabled
- **WHEN** `ContextScopeSlider` receives `provider="claude"` (or no `provider` prop) and `value.contractRefine === true`
- **THEN** the `scope-smash-hint` element is rendered with the SMASH-capable text, identical to pre-change behaviour

#### Scenario: Claude project, contractRefine disabled
- **WHEN** `ContextScopeSlider` receives `provider="claude"` and `value.contractRefine === false`
- **THEN** the `scope-smash-hint` element is not present in the rendered output (existing gate unchanged)

#### Scenario: No provider prop (default)
- **WHEN** `ContextScopeSlider` is rendered without a `provider` prop
- **THEN** behaviour defaults to Claude (hint is shown when contractRefine is true), ensuring backward compatibility with any call site that does not yet pass provider

### Requirement: SMASH mention removed from Contract Layer hint for Codex

The `ContextScopeChecks` component SHALL render the Contract Layer checkbox `hint` as `"post-commit refinement"` only (without `" · enables SMASH"`) when the `provider` prop equals `'codex'`. For all other providers (or when `provider` is absent), the hint SHALL remain `"post-commit refinement · enables SMASH"`.

#### Scenario: Codex project shows trimmed hint
- **WHEN** `ContextScopeChecks` receives `provider="codex"`
- **THEN** the Contract Layer checkbox hint does not contain the text "SMASH"

#### Scenario: Claude project shows full hint
- **WHEN** `ContextScopeChecks` receives `provider="claude"` or no provider prop
- **THEN** the Contract Layer checkbox hint contains "enables SMASH"

### Requirement: ProposeSpecModal threads provider to scope components reactively

`ProposeSpecModal` SHALL read `provider` from the `useDefaultSpecModel` hook result and pass it as a prop to both `ContextScopeSlider` and `ContextScopeChecks`. Because `useDefaultSpecModel` re-fetches when `activeProjectId` changes, switching the active project from Claude to Codex (or vice versa) while the modal is open MUST update the SMASH-capable visibility without requiring the modal to be closed and reopened.

#### Scenario: Active project switched from Claude to Codex while modal open
- **WHEN** the Add Spec modal is open on a Claude project with contractRefine enabled, and the user switches the active project to a Codex project (without closing the modal)
- **THEN** the SMASH-capable hint disappears and the Contract Layer checkbox hint text no longer mentions SMASH

#### Scenario: Active project switched from Codex to Claude while modal open
- **WHEN** the Add Spec modal is open on a Codex project, and the user switches the active project to a Claude project
- **THEN** the SMASH-capable hint appears (if contractRefine is enabled) and the full hint text is restored

### Requirement: Server strips contractRefine for Codex explore launches

The `POST /:projectId/chat/conversations` endpoint SHALL set `contextScope.contractRefine` to `false` when `project.provider === 'codex'`, regardless of the value sent by the client. This is a defence-in-depth measure: it ensures that a client bug or a manually crafted request cannot persist `contractRefine: true` for a Codex project.

#### Scenario: Codex project explore launch with contractRefine true
- **WHEN** `POST /api/projects/:projectId/chat/conversations` is called with body `{ kind: "explore", contextScope: { ..., contractRefine: true } }` and the project has `provider === 'codex'`
- **THEN** the conversation is created with `contextScope.contractRefine === false`

#### Scenario: Claude project explore launch preserves contractRefine
- **WHEN** `POST /api/projects/:projectId/chat/conversations` is called with `contractRefine: true` and the project has `provider === 'claude'`
- **THEN** the conversation is created with `contextScope.contractRefine === true` (unchanged)

#### Scenario: Codex project explore launch with contractRefine false
- **WHEN** `POST /api/projects/:projectId/chat/conversations` is called with `contractRefine: false` and the project has `provider === 'codex'`
- **THEN** the conversation is created normally with no error
