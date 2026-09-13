## ADDED Requirements

### Requirement: Mission and board share evidence presentation
Desktop SHALL expose the same implementation summary, role route details and expandable repository-attributed check evidence through the shared mission/board log components. Evidence SHALL distinguish executed, reused and not-run checks and requested versus observed model/effort.

#### Scenario: Two backend repositories have checks
- **WHEN** the job's evidence is opened in either log mode
- **THEN** each check has a distinct repository identity and the same result/provenance in both modes

#### Scenario: Evidence exceeds the viewport
- **WHEN** a user expands long evidence in a short mission or board modal
- **THEN** wheel, trackpad and keyboard scrolling can reach all evidence and log controls without trapped content

### Requirement: Evidence reads are bounded and scoped
Desktop SHALL retrieve source/output on demand through project/run-scoped opaque IDs and cursors, display saved content as text, and expose unavailable/truncated/loading/error states. It MUST NOT accept client paths, invoke providers or regenerate evidence during reads.

#### Scenario: Client requests another run's evidence
- **WHEN** an evidence/source ID or cursor belongs outside the requested project/run
- **THEN** the request fails without arbitrary file access

#### Scenario: Stored output is truncated
- **WHEN** Core reports truncation or another page
- **THEN** Desktop displays that limitation and supported pagination without claiming a full log is visible

### Requirement: Historical summaries survive cleanup and resume
Desktop SHALL persist validated terminal summaries through the existing job event mechanism, deduplicate replay and supersede current state with a newer continuation's terminal result while preserving cumulative usage and history.

#### Scenario: Failed job completes after continuation
- **WHEN** the later terminal summary is settled and replayed
- **THEN** the shared current state reflects the newer result and cost is counted exactly once
- **AND** the earlier failure remains historical rather than the current step verdict

#### Scenario: A later continuation fails without efficiency data
- **WHEN** a later durable invocation ID/ordinal has failed or cancelled with no valid efficiencySummary
- **THEN** its current result cannot inherit the preceding validated summary
- **AND** after cleanup the earlier summary remains explicitly historical and current unavailable fields stay unavailable

#### Scenario: Original worktree is removed
- **WHEN** saved terminal summary is available
- **THEN** the UI shows the recorded result for its original candidate and retains measured usage
- **AND** live validity and continuation are unavailable unless their actual prerequisites still exist

#### Scenario: Core evidence storage is also removed
- **WHEN** a user expands evidence after cleanup
- **THEN** the summary remains readable and detailed evidence is labeled unavailable
- **AND** the UI does not invent a passed check or attempt regeneration

### Requirement: Cost and acceptance claims use measured evidence
Desktop SHALL preserve unknown values, count actual invocations separately from observable model requests, show routing/reuse reasons, and distinguish technical acceptance, independent acceptance, archive and host delivery. It MUST NOT infer money saved or acceptance from successful exit alone.

#### Scenario: Reused evidence has no new execution
- **WHEN** a check is reused
- **THEN** the UI links its prior evidence and does not display a fictional zero-duration passed execution or estimated dollars saved

#### Scenario: Optional efficiency data is absent or malformed
- **WHEN** an old or malformed event is projected
- **THEN** ordinary log/usage behavior remains intact and new fields display unavailable instead of zero or success

### Requirement: New copy remains localized and accessible
Desktop SHALL update all eight existing locale catalogs and preserve accessible labels, focus behavior and keyboard operation in the shared controls and evidence panel.

#### Scenario: User opens either mode in a supported non-English locale
- **WHEN** efficiency controls and evidence are shown
- **THEN** all new copy resolves through the locale catalog and interactive elements remain keyboard accessible
