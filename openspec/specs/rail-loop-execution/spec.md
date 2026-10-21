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

When Loops are enabled and a loop is chosen, the launch path SHALL run both factory (built-in) and custom loops through the `LoopRunManager` engine, using the resolved built-in graph for a factory id. Only when Loops are disabled or no loop is chosen SHALL the launch use the legacy bare-mode QueueManager path. The unified Loop picker SHALL hide this split from the user. The legacy QueueManager path SHALL always invoke `implement` for an implementation launch; it SHALL never invoke `batch-implement`.

#### Scenario: Factory loop uses the loop engine

- **WHEN** Loops are enabled and a rail launches the `implement` factory loop
- **THEN** execution SHALL go through the `LoopRunManager` engine with the resolved built-in Implement graph

#### Scenario: Loops disabled falls back to the bare-mode path

- **WHEN** Loops are disabled and a rail launches in `implement` mode
- **THEN** execution SHALL go through the QueueManager `/specrails:implement` path

#### Scenario: Custom loop uses the loop engine

- **WHEN** a rail launches a user-built custom loop
- **THEN** execution SHALL go through the `LoopRunManager` engine

#### Scenario: A legacy batch launch runs implement

- **WHEN** a launch with `mode: 'batch-implement'` reaches the legacy QueueManager path on a rail holding tickets 1, 2 and 3
- **THEN** exactly one job SHALL be enqueued with `/specrails:implement #1 #2 #3 --yes` and the response `mode` SHALL be `implement`

### Requirement: Backward-compatible rail mode

The `rails.mode` column, the rails REST `mode` field, and the frozen mobile wire contract SHALL be preserved. The `mode` SHALL be DERIVED from the chosen loop (`implement`→`implement`, `freestyle`→`freestyle`, any custom loop→`loop`). An existing rail that has a `mode` but no selected loop SHALL resolve to the matching factory loop on read. The removed Batch mode's values `batch-implement` and `batch` SHALL be accepted as input aliases and normalized to `implement` at the HTTP boundary (launch body and `PUT /rails/:i/tickets`, including a stored legacy mode the route preserves); a project migration SHALL rewrite stored Batch rails to `implement`. `PUT /rails/:i/tickets` SHALL reject any other unknown `mode` with 400.

#### Scenario: Mode is derived from the chosen factory loop

- **WHEN** a rail launches the `freestyle` factory loop
- **THEN** the persisted/reported rail `mode` SHALL be `freestyle`

#### Scenario: A legacy rail resolves to a factory loop

- **WHEN** an existing rail with `mode='implement'` and no selected loop is loaded
- **THEN** it SHALL resolve to the `implement` factory loop with no data migration

#### Scenario: A stored Batch rail becomes Implement

- **WHEN** the project database holds a rail with `mode='batch-implement'` or `mode='batch'`
- **THEN** the migration SHALL rewrite it to `mode='implement'`
- **AND** a `PUT /rails/:i/tickets` or launch naming `batch-implement` SHALL store and run `implement`

#### Scenario: The mobile wire is unchanged

- **WHEN** the mobile client launches a rail using the legacy `mode` field (including `batch-implement`)
- **THEN** the server SHALL accept it and map the mode to the matching factory loop
- **AND** no mobile-facing message type or field name SHALL change

### Requirement: Freestyle loop is claude-only

A loop that contains a native claude-only command (e.g. `{{cmd:freestyle}}`) SHALL only be launchable on a rail whose provider is claude, and the run SHALL force `provider: claude` with no agent profile (mirroring the existing freestyle guard).

#### Scenario: Freestyle loop blocked on a non-claude rail

- **WHEN** the user tries to launch an freestyle loop on a rail whose provider is codex or gemini
- **THEN** the launch SHALL be rejected with a clear claude-only message
