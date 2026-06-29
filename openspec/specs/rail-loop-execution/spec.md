# rail-loop-execution Specification

## Purpose
TBD - created by archiving change rails-as-loops. Update Purpose after archive.
## Requirements
### Requirement: A rail applies a Loop, not a mode

The rail header SHALL present a Loop picker (factory + custom loops) in place of the mode segmented control. Launching a rail SHALL apply the chosen Loop to the rail's ticket(s). The provider, model, and reasoning effort SHALL remain selectable on the rail and SHALL govern the run; the Loop SHALL carry only the pipeline/steps (it SHALL NOT override provider/model/effort).

#### Scenario: Launching a rail with a chosen loop

- **WHEN** the user selects a Loop, a provider, an effort, drags ticket(s), and presses Play
- **THEN** the rail SHALL launch that Loop applied to those tickets using the rail's provider/model/effort

#### Scenario: The Loop does not override rail provider/effort

- **WHEN** a loop run executes
- **THEN** it SHALL use the rail's provider, model, and effort for every step regardless of any per-node values

### Requirement: Execution routing by loop kind

The launch path SHALL route a factory loop (`implement`/`batch`/`ultracode`) to the existing execution engine (QueueManager — slash command or raw autonomous prompt) and a custom loop to the `LoopRunManager` engine. The unified Loop picker SHALL hide this split from the user.

#### Scenario: Factory loop uses the existing engine

- **WHEN** a rail launches the `implement` factory loop
- **THEN** execution SHALL go through the existing QueueManager `/specrails:implement` path (unchanged behaviour)

#### Scenario: Custom loop uses the loop engine

- **WHEN** a rail launches a user-built custom loop
- **THEN** execution SHALL go through the `LoopRunManager` engine

### Requirement: Backward-compatible rail mode

The `rails.mode` column, the rails REST `mode` field, and the frozen mobile wire contract SHALL be preserved. The `mode` SHALL be DERIVED from the chosen loop (`implement`→`implement`, `batch`→`batch-implement`, `ultracode`→`ultracode`, any custom loop→`loop`). An existing rail that has a `mode` but no selected loop SHALL resolve to the matching factory loop on read.

#### Scenario: Mode is derived from the chosen factory loop

- **WHEN** a rail launches the `batch` factory loop
- **THEN** the persisted/reported rail `mode` SHALL be `batch-implement`

#### Scenario: A legacy rail resolves to a factory loop

- **WHEN** an existing rail with `mode='implement'` and no selected loop is loaded
- **THEN** it SHALL resolve to the `implement` factory loop with no data migration

#### Scenario: The mobile wire is unchanged

- **WHEN** the mobile client launches a rail using the legacy `mode` field
- **THEN** the server SHALL accept it and map the mode to the matching factory loop
- **AND** no mobile-facing message type or field name SHALL change

### Requirement: Ultracode loop is claude-only

A loop that contains a native claude-only command (e.g. `{{cmd:ultracode}}`) SHALL only be launchable on a rail whose provider is claude, and the run SHALL force `provider: claude` with no agent profile (mirroring the existing ultracode guard).

#### Scenario: Ultracode loop blocked on a non-claude rail

- **WHEN** the user tries to launch an ultracode loop on a rail whose provider is codex or gemini
- **THEN** the launch SHALL be rejected with a clear claude-only message

