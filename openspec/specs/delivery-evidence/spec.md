# delivery-evidence Specification

## Purpose
TBD - created by archiving change nontech-review-experience. Update Purpose after archive.
## Requirements
### Requirement: Verification evidence is harvested deterministically at settle

The platform SHALL harvest verification evidence inside the settle path of every isolated delivery run, BEFORE any worktree release, using only deterministic reads (no model calls): the reviewer's `confidence-score.json` (from each unit's `openspec/changes/<name>/` directory in the mounted worktree, falling back to the committed branch content when the worktree is unavailable), the `VERIFICATION: PASS/FAIL` sentinel parsed from the verify step's persisted output, and a bounded tail (≤4 KB) of the verify step's output. Harvested evidence SHALL be persisted durably on the delivery generation row. Harvest failure SHALL be non-fatal: it degrades the evidence to "not available" and never blocks or alters settle.

#### Scenario: Evidence captured before worktree release

- **WHEN** an isolated rail run settles with a reviewable outcome
- **THEN** the delivery row SHALL carry the parsed sentinel verdict, the verify output tail, and the confidence score JSON (when present) before any `releaseRailWorktrees` call for that unit runs

#### Scenario: Confidence score absent

- **WHEN** the run produced no `confidence-score.json` (factory run without an openspec change, or an older core)
- **THEN** the evidence record SHALL mark the reviewer score as unavailable
- **AND** settle SHALL complete unchanged

#### Scenario: Harvest failure is non-fatal

- **WHEN** reading or parsing any evidence source throws
- **THEN** the failure SHALL be logged and the remaining evidence sources SHALL still be attempted
- **AND** the delivery SHALL settle exactly as it would without the harvest

### Requirement: The spec snapshot is captured at launch

The platform SHALL capture each covered ticket's title, description, and labels onto the delivery generation row at launch INSERT time. Packet and PR composition SHALL read this snapshot — never the live ticket store — for "what was asked" content.

#### Scenario: Spec edited mid-run

- **WHEN** a user edits a ticket's description while a delivery run for that ticket is in flight
- **THEN** the delivery's review packet SHALL render the description as it was at launch

#### Scenario: Snapshot present for every generation

- **WHEN** a revision launch creates a new superseding generation
- **THEN** the new row SHALL carry its own launch-time snapshot

### Requirement: Duration ranges are honest percentiles

The platform SHALL expose a duration-range query returning a p25–p75 band per loop id (over `loop_runs.total_duration_ms`) and per job command shape (over `jobs.duration_ms`). Consumers SHALL receive no range when the sample count is below 5 — the platform SHALL NOT fabricate, extrapolate, or default a duration estimate.

#### Scenario: Sufficient history

- **WHEN** a loop id has 5 or more settled runs
- **THEN** the query SHALL return the p25–p75 band and the sample count

#### Scenario: Insufficient history

- **WHEN** a loop id has fewer than 5 settled runs
- **THEN** the query SHALL return no range for it

### Requirement: Stuck runs emit a detectable signal

The platform SHALL detect a stalled run from per-step activity checkpoint staleness (no step activity for a configurable threshold) and broadcast a project-scoped stuck event exactly once per stall episode. Detection SHALL be derived from persisted activity data only.

#### Scenario: Run stalls mid-step

- **WHEN** a running loop step's last activity checkpoint is older than the staleness threshold
- **THEN** the platform SHALL broadcast one project-scoped stuck event carrying the job id and the stalled step
- **AND** SHALL NOT broadcast again for the same stall episode

#### Scenario: Activity resumes

- **WHEN** the step produces new activity after a stuck event fired
- **THEN** a subsequent stall SHALL be eligible to emit a new event
