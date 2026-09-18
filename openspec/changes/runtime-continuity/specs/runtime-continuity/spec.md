## ADDED Requirements

### Requirement: Explicit execution deadlines
Desktop SHALL allow configuring total and inactivity deadlines independently, show their distinct defaults, and preserve explicit existing total limits in frozen launch configuration.

#### Scenario: Deadline settings round trip
- **WHEN** a user saves and reloads both limits
- **THEN** both values reach Core unchanged and labels distinguish total duration from inactivity

### Requirement: Isolated verification prerequisites
Desktop SHALL prepare local writable test caches while protecting shared installed packages. It SHALL inspect native test prerequisites and supply actionable, bounded preparation facts to the runtime without claiming a test passed.

#### Scenario: Warm worktree runs Vite tests
- **WHEN** Vite writes its temporary configuration and cache files
- **THEN** those writes stay inside the worktree and no shared dependency write permission is granted

#### Scenario: Native artifact is unavailable
- **WHEN** the required sidecar cannot be reused from a legitimate prepared checkout
- **THEN** runtime context identifies the missing prerequisite and declared preparation command without creating a fake executable

### Requirement: Preserve explicit recovery semantics
Desktop SHALL retain original runtime and scope for existing continuations and expose interrupted-write recovery consistently for timeout and cancellation.

#### Scenario: User recovers a timed-out write
- **WHEN** Core reports an interrupted write
- **THEN** Desktop supplies explicit recovery and preserves the frozen identity rather than creating an implicit new implementation
