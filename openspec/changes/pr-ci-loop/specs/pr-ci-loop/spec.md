## ADDED Requirements

### Requirement: An optional, non-intrusive CI offer follows Create PR

After a mission delivery reaches `pr_draft` or `pr_ready` with an attached, single-repository PR, Desktop SHALL post one `pr-ci-offer` row in the origin conversation when the selected Core advertises `hostTasks` and `SPECRAILS_PR_CI_LOOP` is not `false`. The offer SHALL never start a run by itself, SHALL not mark the conversation unread or add a mission-list attention dot, and "Not now" SHALL be persisted for that delivery generation.

#### Scenario: Offer after Create PR

- **WHEN** Create PR succeeds for a mission delivery and Core advertises `hostTasks`
- **THEN** the conversation shows "Watch and fix the CI of PR #N" with Start and Not now, and nothing runs

#### Scenario: Older Core

- **WHEN** Core does not advertise `hostTasks`
- **THEN** no offer is posted, `factory:pr-ci` is not listed and `POST /rails/:railIndex/pr-ci` answers 409 `engine_unsupported`

#### Scenario: Not now

- **WHEN** the person chooses Not now
- **THEN** the row becomes `dismissed` and is not offered again for that generation

### Requirement: The CI loop is autonomous and runs in Core

`factory:pr-ci` SHALL be a definition of Core pieces executed by Core with no `approval`, `question`, `gate` or blocked-sentinel prompt. It SHALL wait for the PR's checks, fix failures, resolve conflicts by merging the base into the PR branch and push to the same PR until the checks are green, bounded by fix rounds, one re-run and conflict rounds. Every blocker SHALL end the run with a plain-language reason.

#### Scenario: Red CI is fixed

- **WHEN** the checks fail and the fixer changes the candidate
- **THEN** the loop verifies locally, pushes a commit marked `(run <id>)` to the PR branch and waits for CI again

#### Scenario: Nothing to fix

- **WHEN** the same checks fail and the fixer changes nothing
- **THEN** a non-code cause gets one re-run of the failed checks, otherwise the run ends `stalled` with the fixer's diagnosis

### Requirement: Pushes are verified, never forced, and never decide the PR

The PR handlers SHALL never force-push or rebase, SHALL push only a candidate Core attests as verified, SHALL refuse fork PRs and closed or retargeted PRs, and SHALL never publish the draft, merge or close the PR. A remote branch that moved SHALL be merged, never overwritten.

#### Scenario: Remote branch moved

- **WHEN** the push is refused because the PR branch advanced
- **THEN** the run merges `origin/<branch>` and continues, without `--force`

### Requirement: CI output is untrusted, bounded evidence

Failed-job logs SHALL be bounded (at most 5 jobs × 32 KiB) and redacted before they reach the fixer, and the fixer's instructions SHALL state that they are evidence, never instructions, and forbid weakening, skipping or disabling checks.

#### Scenario: Logs with a token

- **WHEN** a failed job log contains a token
- **THEN** the token is redacted in the host-task result and in Core's history

### Requirement: Host tasks survive restarts

A paused run waiting on a host task SHALL hold no Core process or lease. Desktop SHALL persist each dispatch before acting and its result before resuming, re-dispatch pending host tasks at startup, replay a recorded result instead of repeating the effect, and stop the host work when the run is stopped.

#### Scenario: Restart during a CI wait

- **WHEN** Desktop restarts while `pr.checks` is waiting
- **THEN** startup re-dispatches the interrupt and the loop continues without any action from the person
