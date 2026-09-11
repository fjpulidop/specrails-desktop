## ADDED Requirements

### Requirement: Shared execution context and ownership
Every provider workflow SHALL resolve explicit frozen spec scope, repository paths, backlog and artifact roots and SHALL obey host ownership of worktrees and delivery.

#### Scenario: Hosted multi-repo implementation
- **WHEN** Desktop launches a spec affecting two isolated repositories
- **THEN** each provider uses the supplied repositories and shared backlog, without creating unmanaged worktrees or shipping changes itself

### Requirement: Durable phase recovery and final gates
Single, batch and retry SHALL share phase states and enforce required confidence, tasks and review gates before archive or success. Retry SHALL resume blocked or failed work without repeating still-valid completed phases.

#### Scenario: Reviewer failure after completed development
- **WHEN** review fails and the run resumes with unchanged scope and candidate
- **THEN** the completed design and development evidence remains available and review resumes without relaunching the whole coordinator

#### Scenario: Missing or low confidence report
- **WHEN** a required confidence report is missing or below its threshold
- **THEN** archive and successful delivery remain blocked

### Requirement: Candidate-bound verification
Successful checks SHALL be recorded against the actual candidate, scope, commands and environment. Reuse SHALL require a match; preview/apply SHALL verify the candidate that will be applied.

#### Scenario: Reuse and invalidation
- **WHEN** Desktop verifies an unchanged candidate with matching complete Core verification evidence
- **THEN** it can reuse those checks while reviewing acceptance criteria, and a changed file or scope invalidates reuse

### Requirement: Provider capability preflight
Provider execution SHALL validate required skills and use explicit continuation data when native subagent continuity is unavailable.

#### Scenario: Relocated Gemini workspace
- **WHEN** an implementation starts from a workspace outside the code repository
- **THEN** its required OpenSpec skills are available there or preflight returns an actionable failure before model execution
