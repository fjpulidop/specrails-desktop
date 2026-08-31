# delivery-revisions Specification

## ADDED Requirements

### Requirement: A revision is a new superseding generation

A revision launch SHALL create a new delivery generation row via the existing generation machinery (superseding the prior active generation, preserving lineage, inheriting restore-on-failure), carrying the user's revision sentence as durable metadata on the new row. The platform SHALL NOT introduce any new decision enum value for revisions; in-flight revisions serialize as existing decision values on the wire.

#### Scenario: Revision creates version 2

- **WHEN** the user submits a revision sentence on a delivery at `on_review`
- **THEN** a new generation row SHALL be created linked to the prior one, and the prior row SHALL transition to `superseded`
- **AND** the new row SHALL persist the revision sentence

#### Scenario: Stale clients keep rendering

- **WHEN** an un-updated client observes a delivery mid-revision
- **THEN** every decision value on the wire SHALL be one the client already knows, and the delivery card SHALL remain visible

#### Scenario: Failed revision restores version 1

- **WHEN** a revision generation fails to build
- **THEN** the superseded predecessor SHALL be restored as the active generation with durable rollback evidence

### Requirement: On-review revisions are permitted under strict conditions

The launch guard (including its MCP duplicate) SHALL permit a launch while the rail's active delivery sits at `on_review` ONLY when the launch is explicitly flagged as a revision of that delivery AND covers exactly the delivery's full ticket set. All other launches at `on_review` SHALL remain blocked with the existing conflict error. For multi-ticket deliveries the revision UX SHALL state plainly that the revision may touch all covered changes.

#### Scenario: Valid revision launch

- **WHEN** a launch flagged as a revision of the rail's active `on_review` delivery carries exactly that delivery's ticket set
- **THEN** the launch SHALL be accepted

#### Scenario: Non-revision launch still blocked

- **WHEN** an ordinary launch targets a rail whose active delivery is at `on_review`
- **THEN** the platform SHALL reject it with the existing pending-decision conflict

#### Scenario: Subset revision rejected

- **WHEN** a revision launch covers only a subset of the delivery's tickets
- **THEN** the platform SHALL reject it

### Requirement: Revision runs are fresh-seeded from durable context

The revision run SHALL seed a fresh provider session from durable context only: the launch-time spec snapshot, a digest of the delivery's composed content, a branch diff summary, the harvested verification evidence, and the revision sentence. Resuming the prior run's session MAY be attempted solely as an optimization when the recorded worktree path still exists, and SHALL fall back to the fresh seed on any resume failure. Correctness SHALL never depend on session memory. The run SHALL land on the ticket's existing branch via the shipped branch-resume mechanism.

#### Scenario: Fresh seed is the default

- **WHEN** a revision run starts and the original run's worktree no longer exists
- **THEN** the run SHALL start a fresh session seeded from the durable context without attempting resume

#### Scenario: Opportunistic resume fails gracefully

- **WHEN** a resume attempt reports a missing session
- **THEN** the run SHALL retry exactly once as a fresh seeded session in the same location

#### Scenario: Work lands on the same branch

- **WHEN** the revision run allocates its worktree
- **THEN** it SHALL check out the branch previously allocated for the same ticket rather than creating a suffixed sibling

### Requirement: The revision loop skips planning but never narrows verification

The platform SHALL provide a factory `revision` loop, Architect-less: a revision ai-step driven by the revision sentence plus injected context that applies ONLY the requested delta and runs focused checks, followed by a dedicated revision review/verification step that is the SINGLE owner of independent review — it spawns the worktree's `sr-reviewer` over the resulting diff to produce a fresh confidence score, establishes exactly one full-scope project gate for that candidate, and emits the `VERIFICATION: PASS|FAIL` sentinel. That review step SHALL start in a new provider session carrying the complete durable revision briefing, so its verdict never depends on the mutating step's conversation being resumable, and SHALL be read-only, routing defects to the loop's separate fix step which then re-runs the review. The normal revision path SHALL NOT run a repository-wide health audit, and SHALL NOT run a second generic verification pass after the review step. The same loop SHALL serve both revision doors: on-review launches (via the guard exemption) and post-PR continuations (`pr_draft`/`pr_ready`). Verification scope SHALL NOT be silently narrowed; scope reductions arrive only via explicit upstream verification changes. When a run cannot produce the reviewer score, the packet's reviewer tier SHALL degrade honestly to unavailable. The platform SHALL NOT display any predicted revision duration; a measured percentile band MAY be shown once at least 5 revision runs exist.

#### Scenario: No architect phase

- **WHEN** a revision run executes
- **THEN** its loop SHALL contain no planning/architect step

#### Scenario: Reviewer score on revision packets

- **WHEN** a revision run completes and its reviewer pass wrote a confidence score
- **THEN** packet v2 SHALL render the reviewer tier from the newly harvested score

#### Scenario: Post-PR iteration uses the light loop

- **WHEN** a revision is requested on a delivery at `pr_draft` or `pr_ready`
- **THEN** the launch SHALL ride the existing continuation machinery with the factory `revision` loop — not a full implement relaunch

#### Scenario: No invented duration

- **WHEN** fewer than 5 revision runs have settled
- **THEN** no duration estimate SHALL be shown on the revision input or packet

### Requirement: Agent-initiated revisions select the revision loop

The rails MCP launch surface SHALL accept explicit revision parameters (the target delivery id and the revision sentence), and the operator agent SHALL be taught to route any "modify this delivery/PR" request through the factory `revision` loop with those parameters — at both doors — instead of relaunching the full implement pipeline.

#### Scenario: Agent-chat revision request

- **WHEN** a user asks the agent chat for a change to an on-review or PR-attached delivery
- **THEN** the agent SHALL launch the factory `revision` loop with the delivery id and the user's sentence via the rails tool

#### Scenario: Revision params validated

- **WHEN** an MCP launch carries a revision delivery id that does not match the rail's active delivery
- **THEN** the launch SHALL be rejected with an actionable error

### Requirement: Version lineage is user-visible with Back-to-version-1

The packet SHALL present the generation chain as versions (v1, v2, …) with what-changed context per version (the revision sentence), and SHALL offer returning to the prior version as a first-class action riding the existing restore machinery. A failed revision SHALL render an explicit packet stating the change could not be applied and that the prior version is still what is on review, preserving the sentence for retry.

#### Scenario: Version history visible

- **WHEN** a delivery has been revised twice
- **THEN** the packet SHALL show three versions in order with each revision's sentence

#### Scenario: Failed revision is explicit

- **WHEN** a revision generation fails after the user submitted a sentence
- **THEN** the packet SHALL state the change could not be applied, confirm version 1 is unchanged and still on review, and offer retry with the preserved sentence

### Requirement: Reshape nudges are advisory and evidence-driven

The platform SHALL surface a reshape-the-spec nudge when cumulative revision cost exceeds half the original build cost, when a revision's file churn lands majority-outside the original delivery's file set, or when revision count reaches 3 (backstop). The nudge SHALL present its real numbers, SHALL record which trigger fired, and SHALL NEVER block a further revision.

#### Scenario: Cost-driven nudge

- **WHEN** cumulative revision cost crosses 50% of the original build cost
- **THEN** the packet SHALL show an advisory banner with the actual figures and a one-click path to turn the revision notes into an updated spec

#### Scenario: Never a hard block

- **WHEN** any nudge threshold has fired
- **THEN** the user SHALL still be able to submit another revision
