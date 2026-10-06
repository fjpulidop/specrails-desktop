## MODIFIED Requirements

### Requirement: Completion screen renders truthful tile grid

The setup wizard's completion step SHALL render a tile grid that matches the namespaces and counts reported by `SetupSummary`, with labels the user will actually type. The `Agents` tile reports the project's custom roles (`summary.agents`); the baseline roles are runtime-defined and are not counted.

#### Scenario: Quick tier renders three tiles
- **WHEN** the completion step renders with `summary.tier === 'quick'`
- **THEN** the grid contains exactly three tiles, labelled `Agents`, `/specrails:*`, and `/opsx:*`
- **AND** no tile labelled `Personas` is rendered
- **AND** no tile labelled `Spec` is rendered

#### Scenario: Full tier renders four tiles
- **WHEN** the completion step renders with `summary.tier === 'full'` and `summary.personas > 0`
- **THEN** the grid contains exactly four tiles, labelled `Agents`, `/specrails:*`, `/opsx:*`, and `Personas`
- **AND** no tile labelled `Spec` is rendered

#### Scenario: Full tier with zero personas
- **WHEN** the completion step renders with `summary.tier === 'full'` and `summary.personas === 0`
- **THEN** the `Personas` tile is not rendered

#### Scenario: Install without custom roles
- **WHEN** the completion step renders after an install that produced commands and no custom roles
- **THEN** the `Agents` tile shows `0` and the completion step still reports success
