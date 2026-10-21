## ADDED Requirements

### Requirement: Delivery lifecycle instants are recorded once
The system SHALL persist nullable ISO instants `on_review_at`, `decided_at`,
`published_at` and `merged_at` on each delivery, written first-write-wins inside
the decision transition's own UPDATE, so that retries, double decisions, replays
and restart reconciliation never change a recorded instant. Historical rows
SHALL remain NULL.

#### Scenario: Reviewable delivery
- **WHEN** a delivery transitions into `on_review` for the first time
- **THEN** `on_review_at` is set, and re-entering `on_review` later leaves it unchanged

#### Scenario: Double decision
- **WHEN** two surfaces submit Create PR against the same `on_review` snapshot
- **THEN** only the winner stamps `decided_at` with its lease claim instant and the loser changes nothing

#### Scenario: Replay
- **WHEN** a transition is replayed carrying a later decision, publish or merge instant
- **THEN** the originally recorded instant is kept

#### Scenario: Migration
- **WHEN** migration 72 runs on an existing database
- **THEN** the four columns exist as nullable TEXT and existing rows keep NULL values

### Requirement: Decision adapters stamp their milestone
Each decision adapter SHALL stamp its milestone: Create PR (including a failed
attempt), Discard, acknowledge-no-changes and local merge SHALL stamp `decided_at` with the operation-lease claim instant;
local merge and observed GitHub merges SHALL stamp `merged_at`; publishing a
draft (in-app or observed) SHALL stamp `published_at`. A human decision SHALL
NOT be inferred from automatic transitions.

#### Scenario: Local merge
- **WHEN** the user merges a reviewable delivery locally
- **THEN** both `decided_at` and `merged_at` are recorded

#### Scenario: Startup recovery
- **WHEN** recovery moves a delivery out of `on_review` without a user action
- **THEN** `decided_at` stays NULL

### Requirement: Time to decision and merge are reported null-safely
The analytics API SHALL return, per project and per loop for the selected
period, the median and p90 of `decided_at − on_review_at` and
`merged_at − on_review_at`, with counts of measured, pending and unknown
deliveries. Missing or negative intervals SHALL count as unknown or pending and
SHALL NOT contribute zero durations; statistics SHALL be null when nothing is
measurable. Repository children SHALL be counted only through their group.

#### Scenario: Legacy merged delivery
- **WHEN** a merged delivery has no recorded instants
- **THEN** it counts as unknown for both metrics and does not affect median or p90

#### Scenario: No data
- **WHEN** no delivery reached review in the period
- **THEN** the response reports zero deliveries with null statistics

### Requirement: Decision times are visible in Analytics and MCP
The project Analytics page SHALL show time to decision and time to merge
(median, p90, measured/pending/unknown) and a per-loop table in all supported
locales, showing "unknown" rather than zero, and `specrails_analytics` SHALL
offer a read-only `decision_times` action that honours the period window.

#### Scenario: Empty project
- **WHEN** the Analytics page loads for a project without reviewed deliveries
- **THEN** the card shows an empty-state message instead of zero durations

#### Scenario: MCP read
- **WHEN** an MCP client calls `specrails_analytics` with action `decision_times` and a period
- **THEN** the server reads `/analytics/decision-times` with only the window filters
