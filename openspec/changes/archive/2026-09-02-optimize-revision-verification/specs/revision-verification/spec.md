## ADDED Requirements

### Requirement: Revision mutation and verification have separate owners

The factory Revision loop SHALL execute the requested mutation once in a mutation step and SHALL execute final review in a separate, read-only verification step. The verification step SHALL start a fresh provider session and SHALL receive the complete durable revision briefing, including the user request and frozen launch-time spec. The mutation step SHALL NOT invoke `sr-reviewer`, a full repository gate, or a general codebase health audit. The verification step MAY write reviewer evidence artifacts but SHALL NOT modify source, tests, or OpenSpec contract artifacts.

#### Scenario: Clean revision uses one independent final gate

- **WHEN** a revision mutation completes and its candidate has no defects
- **THEN** a separate verification step SHALL review that candidate
- **AND** that step SHALL NOT resume the mutating agent's provider session
- **AND** it SHALL receive the complete durable revision briefing explicitly
- **AND** the loop SHALL NOT execute the generic verification command or a repository-wide health check after that review

#### Scenario: Verification finds a defect

- **WHEN** the read-only verification step finds a defect
- **THEN** it SHALL emit `VERIFICATION: FAIL` without modifying the candidate
- **AND** the Decider SHALL route to the existing fix step
- **AND** the fix step SHALL start outside the read-only reviewer's provider session while receiving its finding through durable loop history
- **AND** the fixed candidate SHALL return to the independent verification step
- **AND** the original revision mutation step SHALL NOT run again

### Requirement: Every revision candidate receives one full-scope gate

The dedicated revision verification step SHALL establish one passing full-scope project gate for the candidate evaluated by the Decider. Focused checks run during mutation SHALL NOT substitute for that final gate. When `sr-reviewer` already executed the full suite/build gate, the step SHALL treat it as the pass of record and SHALL NOT repeat it. When the reviewer executed only scoped checks, the step SHALL run the missing full-scope commands exactly once.

#### Scenario: Reviewer already ran the full gate

- **WHEN** the installed reviewer executes the project's full required test, typecheck, lint, and build commands for the candidate
- **THEN** the dedicated verification step SHALL reuse those results
- **AND** it SHALL NOT execute the same full gate a second time

#### Scenario: Reviewer ran scoped checks only

- **WHEN** the installed reviewer reports only focused or scoped checks
- **THEN** the dedicated verification step SHALL run the missing full-scope project gate before emitting PASS
- **AND** the candidate SHALL receive exactly one full-scope gate

#### Scenario: Reviewer is unavailable

- **WHEN** no applicable reviewer can run or no valid reviewer result can be produced
- **THEN** the dedicated verification step SHALL run the full-scope project gate itself
- **AND** it SHALL expose reviewer confidence as unavailable
- **AND** it SHALL NOT emit PASS from absent reviewer evidence alone

### Requirement: Revision completion evidence describes the final candidate

The dedicated revision verification step SHALL retain node id `verify`, SHALL end with exactly one final `VERIFICATION: PASS|FAIL` sentinel, and SHALL produce fresh reviewer evidence for the candidate when the reviewer is available. Any mutation after a score is produced SHALL invalidate that score for completion and settlement.

#### Scenario: Reviewer role has its own terminal format

- **WHEN** the installed reviewer procedure ends its internal phase with `Score:` and `Verdict:` lines
- **THEN** the dedicated outer verification step SHALL treat those lines as an intermediate reviewer result
- **AND** it SHALL continue through any missing project gates
- **AND** it SHALL still end with the outer `VERIFICATION: PASS|FAIL` sentinel

#### Scenario: Fix invalidates the previous score

- **WHEN** a verification failure routes through the fix step and changes the candidate
- **THEN** the subsequent verification pass SHALL produce a new review result
- **AND** the previous confidence score SHALL NOT be harvested as evidence for the fixed candidate

#### Scenario: Fresh current reviewer schema is harvested

- **WHEN** the latest revision verification pass writes a ticket-matched confidence artifact under `.specrails/agent-memory/explanations/`
- **THEN** settle-time harvesting SHALL accept `overall_score` as the overall value
- **AND** it SHALL require the exact dated reviewer filename for that ticket
- **AND** it SHALL accept that artifact only when its modification time is not earlier than the latest verify-step's millisecond engine boundary
- **AND** `.specrails/agent-memory` SHALL remain excluded from delivery commits and PRs

#### Scenario: Freshness cannot be proved

- **WHEN** the harvester finds only a confidence artifact created before the latest verify-step start, a legacy step event without a high-resolution boundary, or unreadable freshness metadata
- **THEN** the settled reviewer confidence SHALL be unavailable
- **AND** the stale artifact SHALL NOT be presented as evidence for the revision

### Requirement: Revision optimization preserves delivery semantics

The optimized verification flow SHALL remain Architect-less and SHALL preserve the existing branch/worktree, full-ticket-set, superseding generation, rollback, sentinel harvesting, and post-PR continuation behavior. Implement, Batch, Freestyle, and SDD Quick factory loops SHALL retain their existing generic verification behavior.

#### Scenario: Revision fails after superseding a delivery

- **WHEN** an optimized revision generation fails
- **THEN** the existing generation recovery machinery SHALL restore the prior delivery exactly as before

#### Scenario: Other factory loops are built

- **WHEN** a non-Revision factory loop graph is created
- **THEN** its verification node SHALL continue to use the generic verification command
