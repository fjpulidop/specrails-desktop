## ADDED Requirements

### Requirement: Frozen coordinated execution
Every multi-repository launch SHALL persist a manifest identifying selected members, frozen paths, base commits and allocated worktrees before invoking a provider. A spec or batch SHALL execute with one coordinated implementation context covering its selected worktrees.

#### Scenario: Preparation fails midway
- **WHEN** preparation of a later worktree fails
- **THEN** no implementation provider SHALL start and only resources allocated by that attempt SHALL be released

#### Scenario: Project membership changes during a run
- **WHEN** another repository is added while implementation is running
- **THEN** the existing run's write roots and manifest SHALL remain unchanged

#### Scenario: Only a secondary repository changes
- **WHEN** an iteration modifies files only in a selected secondary worktree
- **THEN** progress detection SHALL recognize that change and verification SHALL include that repository

### Requirement: Grouped repository delivery
A multi-repository implementation SHALL expose one public delivery with per-repository results and recorded evidence. Repository child actions SHALL use their frozen source paths and SHALL NOT independently complete shared tickets, Jira issues or milestone chains.

#### Scenario: One repository is integrated
- **WHEN** only one of several required repository results is accepted
- **THEN** the parent SHALL expose partial progress and SHALL NOT mark the spec complete

#### Scenario: Integration fails after an earlier success
- **WHEN** integration of a later repository fails
- **THEN** earlier integration results SHALL remain durable and retry SHALL operate only on outstanding results

#### Scenario: Process restarts after partial delivery
- **WHEN** the server restarts between repository decisions
- **THEN** it SHALL reconstruct the parent and child states without repeating completed side effects or claiming global success

#### Scenario: Final acceptance
- **WHEN** all required repository deliveries satisfy their acceptance contract
- **THEN** the parent SHALL perform the shared completion effect once and expose the complete grouped evidence

### Requirement: Backward-compatible execution and isolation
Built-in and custom loop launches SHALL share the repository manifest contract. Single-repository projects SHALL retain their current execution and safe delivery behavior. Concurrent operations on the same physical Git repository SHALL share canonical locking even through different memberships or worktree paths.

#### Scenario: Existing single-repository loop
- **WHEN** an existing spec and loop have no repository selection
- **THEN** the loop SHALL retain its primary working directory, profile, deadline, verification and delivery behavior

#### Scenario: Two projects share a repository
- **WHEN** they concurrently prepare or integrate work against the same Git common directory
- **THEN** Specrails SHALL serialize the local Git mutations and preserve the existing recorded-SHA and external-writer guards
