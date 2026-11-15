# Spec Delta

## Purpose

Lets a mission offer, start, track and report the CI repair of an existing pull request in a project repository, without requiring a prior Specrails delivery, ticket or run.

## ADDED Requirements

### Requirement: Mission prepares a CI repair offer from a project PR URL
The platform SHALL let a mission agent prepare the "Fix PR CI" offer from a PR URL without a ticket, run or delivery. The URL SHALL be resolved only against repositories registered in the mission's pinned project, and the admission SHALL carry that repository's identity, the PR number and URL, and the head and base refs validated by the host. Preparing SHALL NOT start an agent, create a worktree or publish anything.

#### Scenario: PR without prior delivery
- **WHEN** the mission requests a CI repair offer for an open same-repository PR of a project repository that has no delivery
- **THEN** an admission is persisted and the mission shows the "Fix PR CI" card in state `offered` with the repository and PR number
- **AND** no job, worktree or push exists

#### Scenario: Secondary repository
- **WHEN** the URL belongs to a secondary repository of the project and another project repository has a PR with the same number
- **THEN** the admission carries the secondary repository's identity and only that repository's PR is queried or modified

#### Scenario: Repository outside the project
- **WHEN** the URL names a repository not registered in the mission's project
- **THEN** preparation is refused with the explicit reason `pr_repository_not_in_project` and no card is shown

### Requirement: PR validation reports a specific reason before any agent starts
Preparation and start SHALL validate that the PR is open, resolvable, same-repository and has usable head and base refs, and SHALL report a distinct reason per failure. Authentication and connection failures SHALL NOT be reported as a missing PR. A validation failure SHALL NOT fall back to another branch or PR and SHALL NOT create a PR.

#### Scenario: Closed or merged PR
- **WHEN** the PR is closed or merged
- **THEN** the request fails naming that state and no agent starts

#### Scenario: GitHub unreachable
- **WHEN** GitHub access fails with an authentication or network error
- **THEN** the reason names an authentication or connection failure, not "PR not found"

#### Scenario: Incompatible refs
- **WHEN** the PR head or base refs are unusable
- **THEN** the request fails with an incompatibility reason before any agent starts

### Requirement: Fork PRs are rejected with the concrete limitation
Specrails writes to the PR branch with the project repository's own push rights, so a PR whose head lives on a fork, or whose same-repository origin cannot be proven, SHALL be rejected before any work starts. The rejection SHALL state that fork branches are not writable by this mechanism. Permissions SHALL NOT be widened.

#### Scenario: Fork PR at preparation
- **WHEN** a mission asks to repair the CI of a fork PR
- **THEN** no offer is shown and the reply states the fork limitation

#### Scenario: Origin unprovable at start
- **WHEN** same-repository origin cannot be proven when Start is pressed
- **THEN** the start is refused with the fork limitation and nothing is pushed

### Requirement: Start requires explicit user action
Starting SHALL happen only by explicit user action on the card, under the existing feature flag, engine capability, permission and cost-confirmation rules. The start SHALL re-validate the PR before any agent runs, and the target SHALL come from the persisted admission, not from card or workflow text.

#### Scenario: Explicit start
- **WHEN** the user presses Start on an offered card
- **THEN** one run starts and the card shows `started`, not a completed repair

#### Scenario: PR changed after the offer
- **WHEN** the PR was closed, or its head or base branch changed, before Start
- **THEN** the start is refused with the reason, nothing is pushed, and no other branch or PR is used

### Requirement: Repair runs on the same PR with unchanged guarantees
A started repair SHALL run the canonical PR CI repair in an isolated worktree on the PR head branch with its base preserved, and SHALL publish verified fixes only to that PR. Repair behaviour, budgets and the guards against weakening checks SHALL be unchanged, and no saved library loop SHALL be required.

#### Scenario: Verified fix
- **WHEN** a verified fix is produced
- **THEN** it is pushed to the admitted PR branch and no new PR is created

#### Scenario: Loop library empty
- **WHEN** the user's loop library has no "Fix PR CI" entry
- **THEN** the repair still starts from the card

### Requirement: Offers and active runs are unique per project, repository and PR
The platform SHALL deduplicate offers by project, repository and PR number, and SHALL allow at most one active CI run for that identity across delivery-backed and mission-origin paths. Repeated requests, transport retries and double clicks SHALL reuse the existing offer or run.

#### Scenario: Repeated prepare
- **WHEN** the same PR is prepared twice
- **THEN** one admission and one card exist

#### Scenario: Concurrent start
- **WHEN** Start is submitted twice concurrently for one offer
- **THEN** exactly one run exists and the second call reports it

#### Scenario: Active delivery-backed run
- **WHEN** a delivery-backed CI run is active for the same repository and PR
- **THEN** a mission-origin start is refused and refers to the active run

### Requirement: Mission shows progress, logs and result after reload
The mission card SHALL show state, run log access and the terminal result for mission-origin offers without depending on a delivery card. The terminal result SHALL distinguish green checks, no checks, and a stop with a concrete reason, and SHALL persist across a conversation reload.

#### Scenario: Reload after settlement
- **WHEN** the conversation is reloaded after the run settled
- **THEN** the card shows the same terminal state, reason and log link

#### Scenario: PR without checks
- **WHEN** the repaired PR has no checks
- **THEN** the card shows "no checks" and not green

#### Scenario: Run stops
- **WHEN** the repair stops before green
- **THEN** the card shows needs-attention with the stop reason

### Requirement: Delivery-backed CI repair is preserved
Offers and starts for Specrails deliveries SHALL behave as before and keep their delivery and rail identities. Mission-origin admission SHALL NOT synthesize delivery or rail identities and SHALL NOT replace or alter an existing delivery.

#### Scenario: Delivery regression
- **WHEN** a ready-for-review delivery is offered CI repair and the user starts it
- **THEN** the existing card, start and states behave unchanged without adding any loop to the library

### Requirement: CI repair never merges or accepts work
Preparing or completing a CI repair SHALL NOT merge the PR and SHALL NOT mark a spec accepted or done because checks are green.

#### Scenario: Green result
- **WHEN** a repair ends green
- **THEN** the PR stays open and no spec or ticket status changes
