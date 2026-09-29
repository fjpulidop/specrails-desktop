## MODIFIED Requirements

### Requirement: Loop Rail Mode

A rail SHALL support a launch mode named `loop`, selectable alongside the existing `implement` and `freestyle` modes. When a rail's mode is set to `loop`, the rail header SHALL render the loop-mode controls (loop picker, AI engine selector, model selector, reasoning-effort selector) and SHALL NOT render the controls exclusive to the other modes. Selecting `loop` mode MUST NOT alter the rail's currently assigned spec. The removed `batch-implement` mode SHALL NOT be offered; a rail persisted with it SHALL load as `implement`.

#### Scenario: Loop appears as a selectable rail mode
- **WHEN** the user opens a rail's mode selector
- **THEN** the available modes SHALL include `implement`, `freestyle`, and `loop`
- **AND** `batch-implement` SHALL NOT be offered
- **AND** selecting `loop` SHALL set the rail's mode to `loop`

#### Scenario: Loop mode reveals loop-specific controls
- **WHEN** the user sets a rail's mode to `loop`
- **THEN** the rail header SHALL display a published-loop picker, an AI engine selector, a model selector, and a reasoning-effort selector
- **AND** the controls exclusive to `implement` and `freestyle` SHALL NOT be displayed for that rail
