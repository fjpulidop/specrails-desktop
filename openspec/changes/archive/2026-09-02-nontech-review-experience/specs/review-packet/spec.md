# review-packet Specification

## ADDED Requirements

### Requirement: The packet is composed server-side from durable data only

The platform SHALL compose the review packet in a pure server-side module from durable sources only: the delivery generation row (units, outcomes, run ids), the launch-time spec snapshot, harvested verification evidence, `file_story_contributions` stats, and invocation cost sums. Composition SHALL make no model calls and read no live mutable stores.

#### Scenario: Packet reproducible after restart

- **WHEN** the app restarts while a delivery sits at `on_review`
- **THEN** the packet SHALL render identically from the persisted rows alone

#### Scenario: No model spend

- **WHEN** a packet is composed or re-rendered any number of times
- **THEN** zero `ai_invocations` rows SHALL be produced by composition

### Requirement: The packet is a family of variants

The platform SHALL render a distinct packet variant per settle shape: Success, Nothing-to-change (the `no_changes` outcome, mapped to its existing verbs), Partial ("N of M ready", derived from per-unit outcomes), and Failed (what was attempted, why it stopped in plain language, one primary next action). A run that changed nothing SHALL never render a template that implies changes.

#### Scenario: Partial batch

- **WHEN** a 3-ticket delivery settles with 2 succeeded units and 1 failed unit
- **THEN** the packet SHALL state that 2 of 3 are ready, render per-ticket outcome cards, and offer the decision verbs scoped to what is deliverable

#### Scenario: Nothing to change

- **WHEN** a delivery settles as `no_changes`
- **THEN** the packet SHALL state plainly that nothing needed changing and why, and offer the existing Mark-done / Refine verbs

#### Scenario: Failure is first-class

- **WHEN** a delivery settles with `implementation_failed`
- **THEN** the packet SHALL describe in plain language what was attempted and why it stopped, and present exactly one primary recovery action

### Requirement: Proof is tiered by epistemic source and never invents numbers

The packet's verification section SHALL render three visually distinct, labeled tiers: APP-VERIFIED (diff stats, files touched including "no test files changed", decider routed decision, shell exit codes when present), AI-REPORTED (the sentinel verdict and verify output tail, labeled as the AI's own report that Specrails did not independently execute), and REVIEWER SCORE (confidence overall, aspect scores, and flags, labeled as the AI reviewer's own confidence, surfacing the documented human-review band). The packet SHALL NOT display any numeric verification claim (e.g. a test count) that lacks a structured source.

#### Scenario: Sentinel rendered as AI-reported

- **WHEN** the harvested evidence contains `VERIFICATION: PASS`
- **THEN** the packet SHALL display it in the AI-REPORTED tier with copy stating the AI reports its verification passed and Specrails did not independently run it

#### Scenario: Low confidence surfaces human-review guidance

- **WHEN** the harvested confidence score's overall value is within the reviewer's documented human-review band
- **THEN** the packet SHALL surface a "human review recommended" indicator

#### Scenario: No structured test counts

- **WHEN** no structured test-count source exists for the run
- **THEN** the packet SHALL NOT render any test count, regardless of counts appearing in prose logs

### Requirement: Decisions use human verbs with pre-resolved consequences

The packet SHALL present the decision as human verbs (Accept / Request changes / Discard) mapped as a presentation layer over the existing decision machinery for the clean `on_review` path. Accept SHALL pre-resolve its git action from shipped capability probes (remote presence, offline gh auth): with a remote and authenticated gh it resolves to PR creation; without a remote it resolves to local integration and SHALL ALWAYS interpose a plain-language consequence confirmation before executing. The packet surface SHALL NOT expose raw git vocabulary; the existing fine-grained controls SHALL remain available behind an explicit disclosure. Local-integration failure guards SHALL be translated into plain-language, actionable recovery copy.

#### Scenario: Accept with GitHub available

- **WHEN** the project has a remote and an authenticated gh, and the user activates Accept
- **THEN** the platform SHALL execute the create-pr decision via the existing decision endpoint

#### Scenario: Accept without a remote

- **WHEN** the project has no git remote and the user activates Accept
- **THEN** the packet SHALL first display a plain-language confirmation stating the changes will be written directly into the project with no separate review copy and cannot be undone
- **AND** only execute merge-local after explicit confirmation

#### Scenario: Blocked local integration explained in plain language

- **WHEN** merge-local returns the dirty-tree guard
- **THEN** the packet SHALL explain in plain language that the project has unsaved changes and what to do, without exposing git terms

### Requirement: Cost is transparent per cycle

The packet SHALL display the delivery cycle's real cost (summed from the generation's run ids, with the estimated marker where applicable and an em-dash until authoritative) and the cumulative cost across the generation chain. The revision input SHALL display an expected-cost line only when derived from real percentile history; never a projected or invented figure.

#### Scenario: Cost line on the packet

- **WHEN** a delivery settles and its invocation rows carry costs
- **THEN** the packet SHALL show the cycle cost with the `~` marker if any component was estimated

#### Scenario: No cost history

- **WHEN** no revision-loop cost history exists
- **THEN** the revision input SHALL show no expected-cost figure

### Requirement: Packet content is localized

All packet copy SHALL be produced through the i18n pipeline in all supported locales, composed from deterministic templates over structured data, satisfying the key-parity test.

#### Scenario: Non-English user

- **WHEN** the app language is any supported non-English locale
- **THEN** every packet section, verb, label, and confirmation SHALL render in that locale

### Requirement: The packet renders on existing surfaces through existing sync machinery

The packet SHALL be reachable as a routed full-screen page and as an expanded section of the existing agent-chat delivery card. Both renderings SHALL derive state from the shared presentation derivation, execute decisions through the existing single decision caller, and reconcile to the existing broadcast and authoritative response snapshot. The packet SHALL NOT introduce optimistic decision state, a new sync channel, or a new chat surface; a "discuss this delivery" affordance SHALL route into the existing agent chat with the delivery context attached.

#### Scenario: Decision from the packet reflected everywhere

- **WHEN** the user executes Accept from the packet page
- **THEN** the rail strip and the agent-chat card SHALL converge to the post-decision state via the existing broadcast without bespoke wiring

#### Scenario: Concurrent decision race

- **WHEN** a decision is executed from another surface while the packet is open
- **THEN** the packet SHALL reconcile to the authoritative state and present the neutral already-resolved outcome
