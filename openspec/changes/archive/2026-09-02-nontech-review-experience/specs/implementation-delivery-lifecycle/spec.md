# implementation-delivery-lifecycle Delta

## ADDED Requirements

### Requirement: Delivery generations carry launch snapshots and settle evidence

Each delivery generation row SHALL durably carry (a) the launch-time snapshot of every covered ticket's title, description, and labels, captured at row INSERT, and (b) the settle-time verification evidence (sentinel verdict, verify output tail, reviewer confidence score when present) harvested before any worktree release. Downstream composition (review packet, PR body) SHALL source "what was asked" from the snapshot and verification claims from the harvested evidence — never from live mutable stores or unparsed logs.

#### Scenario: Evidence survives worktree teardown

- **WHEN** a delivery's worktrees have been released after settle
- **THEN** the packet SHALL still render the full verification evidence from the row

#### Scenario: Revision generations snapshot independently

- **WHEN** a revision creates a new generation after the spec was edited
- **THEN** the new generation's snapshot SHALL reflect the tickets as they were at the revision launch

### Requirement: On-review revision launches are a narrow guard exemption

The pending-decision launch guard SHALL gain exactly one new exemption: a launch explicitly flagged as a revision of the rail's active delivery, at decision `on_review`, covering exactly that delivery's full ticket set. The exemption SHALL be enforced identically at every launch door (REST route and MCP tool). All existing guard behavior SHALL remain unchanged for non-revision launches, and the existing post-PR continuation exemption is unaffected.

#### Scenario: Revision exemption at the REST door

- **WHEN** a flagged revision launch matching the active `on_review` delivery's full ticket set arrives at the launch route
- **THEN** it SHALL proceed and create a superseding generation

#### Scenario: Same rule at the MCP door

- **WHEN** the same launch arrives via the MCP rails tool
- **THEN** the identical exemption logic SHALL apply

#### Scenario: Everything else still blocks

- **WHEN** any launch that is not a flagged full-set revision targets a rail with an active `on_review` delivery
- **THEN** the existing pending-decision conflict SHALL be returned unchanged

### Requirement: Revisions introduce no new wire vocabulary

Revision support SHALL NOT add decision enum values, WS message types, or mobile-wire changes. In-flight revisions present through existing decision values and the existing broadcast shape, so clients that predate this change SHALL continue to render delivery cards correctly throughout a revision.

#### Scenario: Old client during a revision

- **WHEN** a client built before this change observes a rail mid-revision
- **THEN** it SHALL render the delivery using known decision values with no vanished card
