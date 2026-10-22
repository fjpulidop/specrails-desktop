# setup-wizard-summary Specification

## Purpose
TBD - created by archiving change truthful-setup-summary. Update Purpose after archive.

## Requirements

### Requirement: Setup summary reports per-namespace command counts

The setup summary produced at the end of an install run SHALL report command counts separately for the `/specrails:*` and `/opsx:*` namespaces, and SHALL NOT include counts for the deprecated `/sr:*` namespace.

#### Scenario: Install populates both namespaces
- **WHEN** `computeSummary(projectPath)` runs after a successful install that produced files in `.claude/commands/specrails/` and `.claude/commands/opsx/`
- **THEN** the returned summary has `specrailsCommands` set to the number of `.md` files directly under `.claude/commands/specrails/`
- **AND** `opsxCommands` is set to the number of `.md` files directly under `.claude/commands/opsx/`
- **AND** no field named `commands` is present on the summary

#### Scenario: One namespace directory is missing
- **WHEN** `computeSummary(projectPath)` runs and `.claude/commands/specrails/` exists but `.claude/commands/opsx/` does not
- **THEN** `specrailsCommands` is set to the count under `.claude/commands/specrails/`
- **AND** `opsxCommands` is `0`

### Requirement: Setup summary carries install tier

The setup summary SHALL include the install tier (`quick` or `full`) selected by the user for the current install run, so consumers can render tier-conditional UI without looking up state elsewhere.

#### Scenario: Quick install
- **WHEN** the user completes an install with `tier: quick`
- **THEN** the emitted summary has `tier` set to `'quick'`

#### Scenario: Full install
- **WHEN** the user completes an install with `tier: full`
- **THEN** the emitted summary has `tier` set to `'full'`

### Requirement: Setup process removes deprecated /sr: commands

The setup process SHALL delete the `.claude/commands/sr/` directory on every install run that reaches the summary step, after the specrails-core installer (`npx specrails-core init`, Node-native from v4.2.0; `install.sh` before) has completed, and SHALL report the number of `.md` files that were deleted as part of the sweep.

#### Scenario: Legacy /sr: directory exists before install completes
- **WHEN** an install run reaches the summary step with `.claude/commands/sr/` containing one or more `.md` files
- **THEN** the setup manager deletes the `.claude/commands/sr/` directory and its contents before computing the summary
- **AND** the emitted summary has `legacySrRemoved` set to the number of `.md` files that were in the directory immediately before deletion

#### Scenario: No legacy /sr: directory
- **WHEN** an install run reaches the summary step and `.claude/commands/sr/` does not exist
- **THEN** no deletion is attempted
- **AND** the emitted summary has `legacySrRemoved` set to `0`

#### Scenario: /sr: sweep failure does not abort install
- **WHEN** the deletion of `.claude/commands/sr/` fails (e.g., permission error)
- **THEN** the install run still completes
- **AND** the emitted summary has `legacySrRemoved` set to `0`
- **AND** the failure is logged for diagnostics

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

### Requirement: Completion screen announces legacy /sr: cleanup

The setup wizard's completion step SHALL display a one-line notice immediately below the tile grid when the summary reports that legacy `/sr:*` commands were removed during the install run.

#### Scenario: Legacy commands were removed
- **WHEN** the completion step renders with `summary.legacySrRemoved > 0`
- **THEN** a notice reading "Removed N legacy `/sr:*` command(s)" is rendered below the tile grid, where N is `summary.legacySrRemoved`

#### Scenario: Nothing to remove
- **WHEN** the completion step renders with `summary.legacySrRemoved === 0`
- **THEN** no legacy-cleanup notice is rendered

### Requirement: Intro paragraph matches rendered tiles

The paragraph above the tile grid SHALL only mention capability categories that are actually represented in the grid for the current tier.

#### Scenario: Quick tier intro
- **WHEN** the completion step renders with `summary.tier === 'quick'`
- **THEN** the paragraph above the grid mentions agents and commands, and does not mention personas

#### Scenario: Full tier intro
- **WHEN** the completion step renders with `summary.tier === 'full'` and `summary.personas > 0`
- **THEN** the paragraph above the grid mentions agents, personas, and commands
