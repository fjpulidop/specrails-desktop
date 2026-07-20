# explicit-pr-target Specification

## Purpose
TBD - created by archiving change deliver-rail-into-existing-pr. Update Purpose after archive.
## Requirements
### Requirement: Launch accepts an explicit target PR

`POST /rails/:i/launch` SHALL accept an optional `targetPrNumber` (positive integer). When present and the launch takes the isolated PR-delivery path, the platform SHALL resolve that exact open PR as the continuation target for the entire launch, independent of ticket status and of any PR references in the spec text. The MCP `specrails_rails(launch)` tool SHALL accept the same optional field.

#### Scenario: Explicit target from a todo ticket

- **WHEN** a rail with a `todo` ticket is launched with `targetPrNumber: 151` and PR #151 is verifiably OPEN on the same repository
- **THEN** the rail's worktree SHALL materialize PR #151's head branch as its working branch
- **AND** the recorded `base_branch` SHALL be PR #151's `baseRefName`, even when it differs from the configured integration branch
- **AND** no new PR SHALL be created at delivery time

#### Scenario: Malformed target rejected

- **WHEN** a launch body carries a `targetPrNumber` that is not a positive integer within bounds
- **THEN** the launch SHALL fail 400 `invalid_target_pr` before any validation or allocation runs

#### Scenario: Target without PR mode

- **WHEN** `targetPrNumber` is sent but the launch would not take the isolated PR-delivery path
- **THEN** the launch SHALL fail 400 `target_pr_requires_pr_mode` instead of silently ignoring the designation

### Requirement: Explicit target validation is authoritative and fail-closed

The designated PR SHALL be validated through the authoritative PR lifecycle observation before any delivery row is inserted or worktree allocated. Each failure SHALL reject the launch with a distinct machine-readable code and a human-readable reason; the platform SHALL NEVER silently fall back to a fresh integration-branch run.

#### Scenario: PR not open

- **WHEN** the designated PR is CLOSED or MERGED
- **THEN** the launch SHALL fail with `target_pr_not_open` naming the actual state

#### Scenario: Fork-based PR rejected

- **WHEN** the designated PR's head lives on a fork (`isCrossRepository` true, or same-repo cannot be proven)
- **THEN** the launch SHALL fail with `target_pr_fork`
- **AND** no fetch, branch, or worktree SHALL be created

#### Scenario: PR not found

- **WHEN** the designated PR number does not resolve on the repository's remote
- **THEN** the launch SHALL fail with `target_pr_not_found`

#### Scenario: Head branch cannot be materialized

- **WHEN** the PR is open and same-repo but its head branch cannot be fetched and pinned to the observed `headRefOid`
- **THEN** the launch SHALL fail with `target_pr_unfetchable`

### Requirement: Candidate PRs are suggested, never auto-selected

The platform SHALL expose the rail's candidate open PRs (matched to the rail's tickets by PR-number mention or Jira key, without the automatic-continuation status gate) as display-only suggestions in the launch flow. Selection SHALL require an explicit user action; a launch without a designation SHALL behave byte-identically to today.

#### Scenario: Candidate list rendered

- **WHEN** the user opens the deliver-into-existing-PR affordance on a rail whose ticket mentions `#151`
- **THEN** PR #151 SHALL appear as a candidate with its number, title, and head branch
- **AND** fork-based candidates SHALL render disabled with the fork reason

#### Scenario: No designation means legacy behavior

- **WHEN** a rail is launched without `targetPrNumber`
- **THEN** target resolution SHALL NOT run and the launch SHALL be byte-identical to the pre-change flow, including the existing gated automatic continuation
