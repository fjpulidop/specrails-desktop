## MODIFIED Requirements

### Requirement: Canonical rich detailed-spec contract
Every detailed Builder spec SHALL contain an English action-oriented unique title, a one-sentence `shortSummary` no longer than 240 characters, a valid kind and priority, non-empty domain labels, 6–10 separate non-empty independently testable `acceptanceCriteria` written as observable outcomes (covering the happy path, at least one failure or edge case and at least one automated verification), and an optional `dependsOnIndex` that points strictly to an earlier spec. Its `description` SHALL contain exactly these non-empty `##` sections, once and in order: `Problem Statement` (3–5 sentences, at least 200 characters), `Proposed Solution` (a numbered user journey plus `###` sub-blocks for user experience, data model, interfaces & contracts, planned modules and key decisions; at least 500 characters), `Out of Scope` (at least 3 bullets stating what, why and where it lands), `Technical Considerations` (at least 5 labelled bullets), `Estimated Complexity` (level, reasoning, main uncertainty). The description SHALL NOT contain `## Acceptance Criteria`; ticket persistence SHALL fold the structured criteria into one such section through the normal helper.

#### Scenario: Rich spec matches normal Specrails shape
- **WHEN** a complete detailed spec is emitted
- **THEN** its five canonical description sections with their sub-blocks, separate criteria, summary, priority, kind, labels, and dependency are preserved in the full snapshot

#### Scenario: Acceptance criteria remain separate
- **WHEN** a generated description already contains an `## Acceptance Criteria` heading
- **THEN** the quality gate rejects it instead of allowing duplicated criteria in the eventual Board ticket

### Requirement: Single-response complete M1 generation
Interview and Surprise Me snapshots SHALL populate the five blueprint dimensions while keeping `m1Specs` empty and `specsComplete=false`. Only explicit user approval or a direct request to generate the backlog SHALL start detailed generation. Generation SHALL then be app-driven and batched on a resumable session: the agent emits ONE outline snapshot listing the entire 5–10-spec M1 walking skeleton (kind, title, summary, priority, labels, dependency; empty bodies), the app asks for the full detail of two specs per continuation turn, each answered with the FULL snapshot, and one audit turn ends with `specsComplete=true` only after the agent self-validates every spec against the canonical contract. The agent SHALL NOT present a partial set as a finished backlog and SHALL NOT set `specsComplete=true` before every spec is complete. On a provider without native resume the agent SHALL instead emit the entire complete set in ONE response. `m1Specs[0]` SHALL be explicitly `kind='scaffold'` and SHALL omit `dependsOnIndex`; every later dependency SHALL point strictly backward. Day-0 Technical Considerations SHALL reference the planned stack, components, contracts, risks, and inter-spec dependencies — labelling them as planned — without claiming existing repository paths; the scaffold spec SHALL note the repo already contains a README and define run, test, and CI outcomes.

#### Scenario: Approval precedes spec generation
- **WHEN** the Builder proposes a complete blueprint through interview or Surprise Me but the user has not approved generation
- **THEN** the snapshot contains no `m1Specs`, keeps `specsComplete=false`, and invites approval

#### Scenario: Complete set arrives through app-driven turns
- **WHEN** generation begins on a blueprint targeting 7 M1 specs on a resumable session
- **THEN** the first response is an outline of all 7, the app drives detail turns until every spec is complete, and the final snapshot sets `specsComplete=true`

#### Scenario: Scaffold first
- **WHEN** the complete generation arrives
- **THEN** `m1Specs[0]` is `kind='scaffold'`, describes the chosen stack truthfully, and has no dependency

#### Scenario: Completion flag waits for the full quality bar
- **WHEN** generation cannot produce the entire intended set or any spec fails self-validation
- **THEN** it does not publish a completed generation snapshot and no partial subset becomes committable
