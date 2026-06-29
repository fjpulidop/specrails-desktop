## ADDED Requirements

### Requirement: ContextScopeSlider is provider-aware

The `ContextScopeSlider` component SHALL accept an optional `provider` prop of type `'claude' | 'codex'`. When absent, the component MUST default to `'claude'` behaviour. All existing layout, keyboard interaction, drag behaviour, cost/token lines, and preset logic are unchanged. Only the conditional rendering of provider-specific affordances (currently: the SMASH-capable hint) is affected by this prop.

#### Scenario: Slider renders without provider prop
- **WHEN** `ContextScopeSlider` is rendered without a `provider` prop
- **THEN** it behaves identically to prior behaviour (SMASH hint shown when contractRefine is true)

#### Scenario: Slider renders with provider="codex"
- **WHEN** `ContextScopeSlider` receives `provider="codex"`
- **THEN** no SMASH-related elements are rendered; all other slider functionality is unaffected

### Requirement: ContextScopeChecks is provider-aware

The `ContextScopeChecks` component SHALL accept an optional `provider` prop of type `'claude' | 'codex'`. The prop affects only the hint text of the `contractRefine` checkbox row. When absent, the component MUST default to `'claude'` behaviour (full hint text). No checkbox is hidden or disabled by this prop.

#### Scenario: Checks render without provider prop
- **WHEN** `ContextScopeChecks` is rendered without a `provider` prop
- **THEN** the Contract Layer checkbox displays `hint="post-commit refinement · enables SMASH"`, identical to prior behaviour

#### Scenario: Checks render with provider="codex"
- **WHEN** `ContextScopeChecks` receives `provider="codex"`
- **THEN** the Contract Layer checkbox displays `hint="post-commit refinement"` (SMASH mention absent); no other checkbox is affected

#### Scenario: contractRefine checkbox still usable for Codex
- **WHEN** `ContextScopeChecks` receives `provider="codex"` and the user toggles the contractRefine checkbox
- **THEN** the `onChange` callback fires with the updated scope, allowing the Contract Layer refinement (non-SMASH aspect) to still be optionally enabled
