# jira-status-sync Specification

## Purpose
Keep configured Jira status identity consistent in both synchronization directions,
preserve workflow restrictions, and make recovery safe and actionable without
replaying obsolete status intentions.
## Requirements
### Requirement: Explicit status identity is authoritative
Desktop SHALL honor configured Jira status names and IDs across all five logical states during outbound idempotency and inbound materialization, independently of default status categories. Unconfigured mapping SHALL retain category fallback. Duplicate mappings SHALL retain review precedence and otherwise use category fallback rather than an arbitrary logical state.

#### Scenario: Configured To Do already reached in another category
- **WHEN** an issue is already at the configured To Do destination in the indeterminate category
- **THEN** the outbox operation completes without requesting a self-transition and inbound polling preserves todo

#### Scenario: Status ID identifies the current destination
- **WHEN** a configured ID equals the issue's current status ID
- **THEN** Desktop recognizes completion without a transition write

#### Scenario: Transition ID collides with unavailable status ID
- **WHEN** no destination matches the configured status ID but an unrelated transition has that ID
- **THEN** Desktop does not apply the unrelated transition or report the target reached

### Requirement: Explicit transition completion is truthful
Desktop SHALL report success only after reaching an explicit target when one is configured, and SHALL report the actual destination category. It SHALL preserve valid reverse transitions and genuine workflow restrictions without speculative lateral exploration.

#### Scenario: An intermediate category is insufficient
- **WHEN** a walk reaches a different state in the logical target category but not the configured status
- **THEN** it does not report the operation as applied to the requested target

#### Scenario: Jira offers no valid return path
- **WHEN** a requested return to To Do has no supported available transition
- **THEN** the operation remains actionable with current status, target and available destination context

### Requirement: Superseded failed transitions cannot undo newer intentions
Desktop SHALL retain obsolete failed transitions as superseded history distinct from applied work, exclude them from attention counts and prevent replay. Reconciliation SHALL be idempotent and issue/project scoped. Independent comment and update operations and normal pending FIFO SHALL remain intact.

#### Scenario: A newer status intention replaces a failed transition
- **WHEN** an old failed transition has a newer transition intention for the same issue
- **THEN** it becomes superseded and retrying it sends no Jira mutation

#### Scenario: Legacy retry follows newer completion
- **WHEN** a historical transition has already been requeued but a newer transition is complete
- **THEN** draining the historical operation does not roll back the issue

### Requirement: Connector recovery identifies the affected issue
Desktop SHALL display issue identity, status target when available and readable errors for actionable operations. Counts and rows SHALL refresh after recovery and synchronization with protection against stale responses from another project. Failed status discovery SHALL show an error and retry action while preserving saved mappings.

#### Scenario: Pending failures refresh
- **WHEN** sync or retry changes the actionable outbox
- **THEN** the panel shows current counts and rows for the active project

#### Scenario: Status discovery fails
- **WHEN** Jira's status list cannot be retrieved
- **THEN** the connector explains the failure and offers retry rather than silently showing only Automatic
