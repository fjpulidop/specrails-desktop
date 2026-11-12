# Milestone launch chain delta

## ADDED Requirements

### Requirement: Chain creation timestamp compatibility
Chain snapshots in milestone.chain_changed and milestone progress payloads SHALL include createdAt from the existing chain creation timestamp as an ISO 8601 string. This addition SHALL require no migration. Clients SHALL accept historical payloads with missing or invalid createdAt, normalize that field to null, and retain all otherwise valid chain data.

#### Scenario: Snapshot preserves original start
- **WHEN** a chain created at 10:00 is updated at 10:38 and serialized
- **THEN** createdAt represents 10:00 and updatedAt represents 10:38 in both chain and progress snapshots

#### Scenario: Older payload remains readable
- **WHEN** an otherwise valid chain payload omits createdAt or supplies null, a non-string or an invalid date
- **THEN** the client retains the chain and treats its start timestamp as unavailable

### Requirement: Unified milestone notification content
The five existing milestone toasts SHALL share a localized title containing the available project name, milestone label and event text, plus a secondary status and available total elapsed time. Rail launches and checkpoints SHALL retain rail k of n; pauses SHALL retain their reason; delivery SHALL retain review-count context. Project names SHALL resolve client-side by message projectId from the existing project list.

#### Scenario: Rail launch identifies its project
- **WHEN** rail 4 of 8 launches for project specrails and milestone M1, 38 minutes after the chain began
- **THEN** the title reads the localized equivalent of “specrails · M1 — rail 4 of 8 launched” and the description reads “Running · 38m total”

#### Scenario: Checkpoint shares the layout
- **WHEN** rail 1 of 3 delivers and the chain waits for approval
- **THEN** the title contains project, M1 and the rail 1 of 3 checkpoint prompt, and the description contains awaiting-approval status and available total chain time

#### Scenario: Pause shares the layout
- **WHEN** a chain pauses for a known reason
- **THEN** the title contains its project, milestone and localized pause reason, and the secondary line contains Paused and available total chain time

#### Scenario: Delivery is distinct from completion
- **WHEN** a milestone becomes delivered with eight specs on review
- **THEN** its title identifies project, milestone and eight specs waiting for review, and its secondary status says delivered/awaiting review rather than completed

#### Scenario: Completion shares the layout
- **WHEN** every milestone spec is merged and the existing completion event arrives
- **THEN** the title identifies project, milestone and completion, and its secondary line uses the localized “Completed in” wording when elapsed is available

### Requirement: Static total milestone elapsed time
Elapsed SHALL be static at toast creation and measured from chain creation, including waiting and paused periods. Active, checkpoint and paused events SHALL use receipt time; delivered/completed SHALL use the associated snapshot updatedAt as end, never receipt time. Durations SHALL clamp below zero and truncate to seconds below 60 seconds, minutes below 60 minutes, and hours with zero-padded minutes thereafter. No live ticker SHALL be introduced.

#### Scenario: Compact duration boundaries
- **WHEN** elapsed is respectively 45 seconds, 38 minutes, 60 minutes and 125 minutes
- **THEN** the durations are respectively 45s, 38m, 1h 00m and 2h 05m

#### Scenario: Terminal elapsed ignores late receipt
- **WHEN** a chain starts at 10:00, its associated end snapshot says 12:05 and the delivered or completion toast is built at 13:00
- **THEN** its elapsed is 2h 05m and remains unchanged while the toast is visible

#### Scenario: Future start clamps
- **WHEN** the start is later than the applicable receipt or end timestamp
- **THEN** elapsed renders as 0s rather than a negative value

#### Scenario: Completion uses preceding progress
- **WHEN** a project-scoped progress message includes a chain and is followed by a completion event without a chain
- **THEN** the completion toast uses timing associated with that project's milestone, including when no chain-change message was observed

### Requirement: Notification context degrades safely
Missing or blank project names SHALL omit the project segment. Missing or invalid start timestamps SHALL omit elapsed. Delivered/completed events without a valid end SHALL omit elapsed instead of substituting now. Remaining content SHALL preserve meaningful existing event wording and status, without undefined, NaN, empty separators, or timing borrowed from another project or milestone.

#### Scenario: Historical chain without timing
- **WHEN** an event has neither a resolvable project name nor a valid chain start
- **THEN** the toast retains milestone/event wording and status, with no empty project or elapsed segment

#### Scenario: Completion without known chain
- **WHEN** a completion event arrives without any associated chain snapshot
- **THEN** completion still appears with available project and milestone content but no invented elapsed time

#### Scenario: Project identity survives switches
- **WHEN** the user views project B while receiving a milestone event for project A
- **THEN** the toast identifies project A and uses only project A's matching milestone timing

#### Scenario: Refreshed project name is used
- **WHEN** the existing project list renames project A before a later milestone event
- **THEN** that event uses the refreshed name without resetting notification transition bookkeeping

### Requirement: Notification lifecycle and actions remain stable
The change SHALL preserve all existing event-emission guards, toast id formats, durations, severity and action behavior. It SHALL NOT synthesize historical toasts from initial progress snapshots or add replay on reload/reconnect. Chain-launch, chain-checkpoint, chain-paused, milestone-delivered and milestone-completed id prefixes and existing suffixes SHALL remain unchanged.

#### Scenario: Existing actions remain operational
- **WHEN** checkpoint Launch next or Auto-continue, pause Resume, or delivered Review is activated
- **THEN** the existing project-specific request or review navigation occurs with unchanged success/error handling and toast id reuse

#### Scenario: Default and explicit lifetimes stay stable
- **WHEN** the five existing notifications are formatted
- **THEN** launch keeps its default lifetime, checkpoint keeps 60000ms, pause and delivery keep 30000ms, and completion keeps 15000ms

#### Scenario: Initial progress is inert
- **WHEN** the app reloads and receives initial progress showing an already delivered milestone
- **THEN** the hook records its state and timing without showing a historical delivered notification

#### Scenario: Repeated frames retain existing guards
- **WHEN** the same launch, checkpoint, pause or delivered frame is received again
- **THEN** existing transition guards and stable ids continue preventing duplicate notifications, without new content-driven triggers

### Requirement: Milestone notification localization parity
All new milestone notification layout, event, status and elapsed text SHALL use milestoneProgress.toast translation keys. English and Spanish SHALL contain matching keys and localized copy. The other six shipped locales SHALL retain matching key trees and localized templates; existing shared action/reason keys SHALL remain available.

#### Scenario: English and Spanish rendering
- **WHEN** each of the five events is formatted in English and Spanish with known context
- **THEN** titles, status, elapsed wording and existing actions use the selected language without raw keys or untranslated new labels

#### Scenario: Shipped locale key parity
- **WHEN** builder translation key trees are compared across en, es, fr, de, pt, it, zh and ja
- **THEN** every new notification key exists with matching interpolation parameters in all eight locales
