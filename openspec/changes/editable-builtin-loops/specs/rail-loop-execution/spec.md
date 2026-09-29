## ADDED Requirements

### Requirement: Factory-id launches resolve the built-in row

A launch with a factory loop id SHALL keep the factory id's mode derivation and SHALL run the graph of its built-in row. The launch SHALL use the row's graph when the edited built-in is Published, the row's last published snapshot when an edit is still `Draft`, and the code default when the row is missing or unedited. Aliases SHALL resolve to their canonical built-in. An edited built-in graph SHALL pass graph validation and engine-availability checks before any run or worktree is allocated.

#### Scenario: Edited built-in on a rail

- **WHEN** a rail launches `factory:implement` after the user published an edited Implement built-in
- **THEN** the run SHALL receive the edited graph and the rail mode SHALL remain `implement`

#### Scenario: Built-in edit in progress

- **WHEN** a rail launches a built-in whose latest edit is still `Draft`
- **THEN** the run SHALL receive the last published graph

#### Scenario: Engine unavailable for an edited built-in

- **WHEN** an edited built-in requires an engine the active Core cannot launch
- **THEN** the launch SHALL fail with `409` and the engine error code before allocating runs
