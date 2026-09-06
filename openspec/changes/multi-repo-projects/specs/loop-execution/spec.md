## MODIFIED Requirements

### Requirement: Shell Node Execution

Shell nodes SHALL execute their configured command in the run's working directory for single-repository runs, or in their explicitly selected repository's worktree for multi-repository runs, and MUST capture the command's stdout, stderr, and exit code. The captured result SHALL feed the next node in the graph and SHALL be available to the Loop Decider as part of the last node output. A multi-repository shell node's `repositoryId` MUST belong to the frozen write selection; an omitted or invalid target SHALL be rejected before implementation starts.

#### Scenario: Shell node captures full result
- **WHEN** a Shell node executes its command and the process exits
- **THEN** the engine SHALL capture stdout, stderr, and the integer exit code from the process
- **AND** the captured result SHALL be passed as input to the next node in the traversal

#### Scenario: Shell result feeds the Decider
- **WHEN** a Shell node is the last node executed before the Loop Decider runs
- **THEN** the Shell node's stdout, stderr, and exit code SHALL be included in the last node output provided to the Decider

#### Scenario: Explicit secondary shell target
- **WHEN** a multi-repository shell node selects the backend repository
- **THEN** its command SHALL execute in that repository's allocated worktree and its evidence SHALL identify that repository

#### Scenario: Ambiguous shell target
- **WHEN** a multi-repository launch includes a shell node without a target
- **THEN** launch validation SHALL reject the ambiguity without starting implementation or silently choosing the primary
