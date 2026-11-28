# pr-ci-loop-editable Specification

## Purpose
Makes the loop that keeps a pull request's CI green (Fix PR CI) a visible, editable built-in, running exactly as before until someone edits it.

## Requirements

### Requirement: Fix PR CI shows in Loops
When Core runs host tasks, Fix PR CI SHALL be listed with the built-in loops, editable in place and restorable, and SHALL NOT be copied or run loose from Loops (it starts from a pull request).

#### Scenario: Fix PR CI shows in Loops
- **WHEN** the person opens Loops with a Core that runs host tasks
- **THEN** Fix PR CI is listed as a built-in they can edit, without Duplicate, and starting it from Loops is refused

### Requirement: Every door runs the published loop
A CI run started from a delivery or from a mission's offer SHALL run the same graph: the edited, published Fix PR CI, else its original version; a Draft edit SHALL never reach a run.

#### Scenario: Every door runs the published loop
- **WHEN** Fix PR CI was edited and published
- **THEN** the next CI run from a delivery or a mission offer runs the published graph

### Requirement: Edits keep the safety contract
Publishing an edited Fix PR CI SHALL be refused unless it still waits on the pull request checks, pushes only verified fixes, uses only the host tasks Desktop performs and never changes the spec.

#### Scenario: Edits keep the safety contract
- **WHEN** an edit would push an unverified candidate
- **THEN** publishing is refused naming the node, and runs keep the last published graph
