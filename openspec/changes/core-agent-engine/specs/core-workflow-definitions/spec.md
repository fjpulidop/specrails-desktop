## ADDED Requirements

### Requirement: Definition authoring and publication
Desktop SHALL edit, save, fork, import and export Core JSON graph definitions. Publishing SHALL validate structure locally and pieces through Core, reporting node-scoped errors.

#### Scenario: Invalid piece
- **WHEN** Core rejects a published piece parameter
- **THEN** the graph stays unpublished and the canvas identifies the offending node

#### Scenario: Legacy graph
- **WHEN** a saved legacy loop is opened before D8
- **THEN** its existing editor and execution path remain available

### Requirement: Deterministic frozen launch
Desktop SHALL resolve spec/constants/command tokens, obtain the definition hash from Core and freeze per-run context, config and definition using exclusive creation. New definition graphs SHALL execute only in Core with host-owned git.

#### Scenario: Repeat compilation
- **WHEN** the same graph and launch inputs are compiled twice
- **THEN** the definitions and Core-calculated hashes agree

#### Scenario: Frozen file conflict
- **WHEN** an active run already has different frozen input
- **THEN** the launch fails without overwriting it

#### Scenario: Core execution
- **WHEN** a definition run starts
- **THEN** Desktop launches one Core run and never executes a node or chooses a successor

### Requirement: Progressive factories and roles
Factory graphs and role authoring SHALL become definitions only when the required Core pieces are available, preserving factory IDs, aliases and legacy fallback.

#### Scenario: Old Core
- **WHEN** a factory is launched without engineV2
- **THEN** the existing factory path is used

#### Scenario: Role permissions
- **WHEN** a read-only custom role is selected
- **THEN** the frozen role descriptor preserves access and artifact permissions
