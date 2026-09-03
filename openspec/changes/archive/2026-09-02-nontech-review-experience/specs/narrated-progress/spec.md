# narrated-progress Specification

## ADDED Requirements

### Requirement: Milestone narration is deterministic and template-based

The platform SHALL render a plain-language milestone narration of a run derived exclusively from persisted structured data: loop step events (kind, title, iteration, rendered command), step-end events (duration, status, decider verdict, the interrupted state when the end event is missing), and tool events (names and inputs from the persisted stream). Narration SHALL be produced by i18n templates with zero model calls, SHALL work for every provider (degrading predictably where a provider's stream carries less tool granularity), and SHALL NOT assert any outcome (e.g. tests passing) that lacks a structured source.

#### Scenario: Loop run narrated

- **WHEN** a user opens a loop job's narrated view
- **THEN** each step SHALL render as a plain-language milestone line including its title, iteration when >1, and duration once ended

#### Scenario: Interrupted step

- **WHEN** a step has no end event and the job has settled
- **THEN** the narration SHALL mark that step as interrupted

#### Scenario: No invented outcomes

- **WHEN** a step's raw output contains prose claiming success
- **THEN** the narration SHALL NOT convert it into an asserted outcome; only structured verdicts (decider decision, shell exit codes) may be stated as outcomes

#### Scenario: Localized narration

- **WHEN** the app language is any supported locale
- **THEN** every narration line SHALL render from the locale's templates, passing the key-parity test

### Requirement: Narration is a third altitude behind a toggle

The narrated view SHALL be offered inside the existing job detail surfaces (page and modal variants) as a mode toggle alongside the raw log view, following the shipped Story|Log toggle pattern with per-project persistence. The raw log view SHALL remain byte-identical to its pre-change rendering. Existing glance-level surfaces (phase chips, overview strip) SHALL be unaffected.

#### Scenario: Toggle persists

- **WHEN** a user switches a job view to narrated mode
- **THEN** subsequent job views in that project SHALL default to narrated mode until switched back

#### Scenario: Raw logs untouched

- **WHEN** the narrated feature flag is disabled
- **THEN** the job detail surfaces SHALL render byte-identical to their pre-change behavior

### Requirement: Narration handles every stream shape

The narrated view SHALL handle: plain (non-loop) jobs using parsed assistant/tool lines only; loop jobs using step boundaries and graph data; legacy loop runs lacking graph or node ids (linear fallback); and late attachment (rendering the full past history from the persisted event stream).

#### Scenario: Plain job

- **WHEN** a non-loop job is opened in narrated mode
- **THEN** milestones SHALL derive from tool activity and turn boundaries without step structure

#### Scenario: Late attach

- **WHEN** a user opens the narrated view 30 minutes into a run
- **THEN** the full history SHALL render from persisted events with live updates continuing seamlessly

### Requirement: Waiting is honest

Wherever a duration expectation is displayed alongside narration, it SHALL come exclusively from the duration-range query (p25–p75, minimum sample floor) and SHALL be absent otherwise. Elapsed time is always shown from real clock data.

#### Scenario: Range shown with history

- **WHEN** the run's loop has sufficient duration history
- **THEN** the narrated view MAY show "runs like this have taken X–Y min" with the sample count

#### Scenario: Silence without history

- **WHEN** no qualifying history exists
- **THEN** no expected-duration text SHALL appear

### Requirement: Stuck runs notify the user

The client SHALL surface the stuck event as a native notification through the existing notification path, respecting its user preference filters, with plain-language copy naming the project and what stalled.

#### Scenario: Stuck notification delivered

- **WHEN** a stuck event is broadcast for a project and the user has notifications enabled
- **THEN** a native notification SHALL fire once for that stall episode with a plain-language message
