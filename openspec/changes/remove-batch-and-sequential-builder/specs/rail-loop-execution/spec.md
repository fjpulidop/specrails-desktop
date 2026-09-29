## MODIFIED Requirements

### Requirement: Execution routing by loop kind

The launch path SHALL route a factory loop (`implement`/`freestyle`) to the existing execution engine (QueueManager — slash command or raw autonomous prompt) and a custom loop to the `LoopRunManager` engine. The unified Loop picker SHALL hide this split from the user. The legacy QueueManager path SHALL always invoke `implement` for an implementation launch; it SHALL never invoke `batch-implement`.

#### Scenario: Factory loop uses the existing engine

- **WHEN** a rail launches the `implement` factory loop
- **THEN** execution SHALL go through the existing QueueManager `/specrails:implement` path (unchanged behaviour)

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
