# agent-spec-framing Specification

## Purpose
TBD - created by archiving change critical-spec-framing. Update Purpose after archive.
## Requirements
### Requirement: The operator agent states its framing before proposing a spec

When the user describes product or code work, the operator agent SHALL establish and show its framing of the request before it emits any `spec-draft` block. The framing SHALL be produced BEFORE the first solution proposal, not after it, and SHALL be shown as an artifact in the conversation rather than asserted in prose. The agent SHALL NOT decide on its own that a request is clear enough to skip this step; only the user may waive it. Support and troubleshooting requests, which are routed through `specrails_support` and do not become specs, SHALL be unaffected.

#### Scenario: A work request produces a frame before any draft

- **WHEN** the user describes work to be done in a project and the agent intends to author a spec
- **THEN** the agent SHALL emit a `problem-frame` block before emitting any `spec-draft` block
- **AND** the reply carrying the frame SHALL end after the frame and its question
- **AND** no spec-persisting tool SHALL be called in that turn

#### Scenario: The agent judges the request obvious

- **WHEN** the agent assesses the request as unambiguous and well-scoped
- **THEN** it SHALL still emit a `problem-frame` block
- **AND** it SHALL NOT treat its own confidence as grounds to skip the step

#### Scenario: Support questions are not framed as specs

- **WHEN** the user reports a broken setup, a failed job, or asks how to use the app
- **THEN** the agent SHALL route the request through `specrails_support`
- **AND** it SHALL NOT emit a `problem-frame` block or propose a spec unless the user explicitly pivots to product work

### Requirement: The problem frame carries two anchored readings and the question that separates them

The framing artifact SHALL be a single fenced code block tagged `problem-frame` containing exactly one complete JSON object with the keys `restated`, `alternative`, `discriminator`, `assumptions`, and `unknowns`. Every key SHALL be present on every emission; the block SHALL be a full snapshot that replaces the previous frame and SHALL NOT be a diff.

`restated` and `alternative` SHALL each carry a non-empty `reading` and a `touches` list naming the files or surfaces that reading would change, drawn from the code the agent actually read. `alternative` SHALL express a genuinely different reading of the same request; two readings SHALL NOT share both their touched surfaces and their intended outcome. `discriminator` SHALL be a non-empty question stating what the user could say to pick between the two readings. `assumptions` and `unknowns` SHALL be arrays of strings and MAY be empty. The agent SHALL NOT additionally restate the frame's content in prose, and SHALL reserve prose for what changed and the question it is asking.

#### Scenario: A well-formed frame renders as a card

- **WHEN** an assistant message contains a valid `problem-frame` block
- **THEN** the client SHALL parse it and render it as a framing card in the conversation
- **AND** both readings SHALL be rendered with their touched surfaces
- **AND** the discriminating question SHALL be rendered as the card's question
- **AND** the raw block SHALL NOT be shown as literal code to the user

#### Scenario: A malformed or partial block does not render

- **WHEN** the block is not valid JSON, or is missing any required key, or either `reading` or `discriminator` is empty
- **THEN** the client SHALL NOT render a framing card for it
- **AND** the message SHALL still render its remaining content without error

#### Scenario: Two readings differing only in surface

- **WHEN** the ambiguity is about which part of the product the request concerns
- **THEN** the two readings SHALL name different touched surfaces
- **AND** the discriminator SHALL ask what distinguishes those surfaces for the user

#### Scenario: Two readings differing only in outcome

- **WHEN** the ambiguity is about what finishing the work means rather than where it happens
- **THEN** the two readings MAY name the same touched surfaces
- **AND** they SHALL differ in the outcome they describe
- **AND** the discriminator SHALL ask which outcome the user wants

#### Scenario: A later frame supersedes an earlier one

- **WHEN** the agent emits a second `problem-frame` block after the user corrects its framing
- **THEN** the later block SHALL be treated as the current frame
- **AND** the earlier card SHALL NOT be treated as the frame in force

### Requirement: The frame's readings are one-click answers to the discriminating question

Each rendered reading SHALL be an interactive control that, when activated, sends that reading's own text as the user's next turn through the same send path a composer submission uses, with no composer pre-fill step and no additional confirmation. The two readings SHALL keep identical visual weight; the interaction SHALL add only an affordance (pointer cursor, hover and focus states, keyboard focus ring). Both readings SHALL be focusable and activatable from the keyboard. Only the card on the newest message SHALL be actionable, and while a turn is in flight the readings SHALL be disabled. The `assumptions`, `unknowns`, and `discriminator` fields SHALL remain non-interactive.

#### Scenario: A reading is picked as the reply

- **WHEN** the user activates either reading on the current frame's card
- **THEN** that reading's exact text SHALL be sent as the next user turn
- **AND** the conversation SHALL continue as if the user had typed it and pressed send

#### Scenario: An already-answered frame is not re-sendable

- **WHEN** the user activates a reading on a frame card that is no longer the newest message
- **THEN** no turn SHALL be sent
- **AND** the older card SHALL render as static content rather than a dead control

#### Scenario: A reading cannot fire during an in-flight turn

- **WHEN** a turn is streaming and the user activates a reading on the newest frame card
- **THEN** the control SHALL be disabled and no turn SHALL be sent

### Requirement: Persisting an agent-authored spec requires an answered frame

`specrails_specs(commit_draft)` SHALL refuse a first-party call when the calling conversation contains no `problem-frame` block that the user has subsequently answered. A frame is answered when at least one user message follows the assistant message carrying it. The refusal SHALL be returned in the same shape as an existing tier refusal, SHALL name the missing artifact, and SHALL state the action that satisfies it. A refusal SHALL NOT persist a spec, SHALL NOT partially write, and SHALL NOT trigger Contract Layer enrichment.

#### Scenario: Commit without any frame is refused

- **WHEN** the first-party agent calls `commit_draft` in a conversation that contains no `problem-frame` block
- **THEN** the call SHALL be refused with a message naming the missing frame
- **AND** no ticket SHALL be created

#### Scenario: Commit with an unanswered frame is refused

- **WHEN** the agent emits a `problem-frame` block and calls `commit_draft` before any user message follows it
- **THEN** the call SHALL be refused
- **AND** no ticket SHALL be created

#### Scenario: Commit after an answered frame succeeds

- **WHEN** a `problem-frame` block was emitted, at least one user message followed it, and the agent then calls `commit_draft`
- **THEN** the call SHALL proceed exactly as it does today
- **AND** Contract Layer enrichment SHALL run according to its existing default and opt-out

#### Scenario: A user reply that disagrees still satisfies the gate

- **WHEN** the user's message following a frame rejects or corrects the agent's framing
- **THEN** the gate SHALL treat the frame as answered
- **AND** the agent SHALL emit a corrected frame rather than persist the spec

### Requirement: One frame authorises one spec

While framing is on, a frame SHALL authorise the next `commit_draft` in its conversation and no more. A `commit_draft` SHALL require a frame emitted after the most recent successful `commit_draft` in the same conversation.

#### Scenario: A second spec in one conversation needs its own frame

- **WHEN** a spec has been persisted in a conversation and the agent attempts a second `commit_draft` without a new frame
- **THEN** the second call SHALL be refused
- **AND** the refusal SHALL name the missing frame for the new spec

### Requirement: The user may switch framing off for the conversation

The user SHALL be able to switch the framing step off, and the waiver SHALL persist for the remainder of that conversation rather than for a single spec. A single user word SHALL restore it. When a waiver takes effect the agent SHALL state that framing is off and name what restores it, so a disabled ritual is always visible rather than silent. The agent SHALL NOT waive on its own behalf, SHALL NOT infer a waiver from brevity or apparent simplicity, and SHALL NOT solicit one preemptively.

#### Scenario: A waiver persists across several specs

- **WHEN** the user tells the agent to skip framing and create specs directly
- **THEN** subsequent `commit_draft` calls in that conversation SHALL be permitted without a frame
- **AND** the agent SHALL state in that turn that framing is off and how to restore it

#### Scenario: Framing is restored on request

- **WHEN** the user asks for framing back after having waived it
- **THEN** the next `commit_draft` SHALL again require an answered frame

#### Scenario: The agent cannot waive for itself

- **WHEN** no user waiver was given
- **THEN** the agent SHALL NOT bypass the gate on the grounds that the request was simple
- **AND** it SHALL NOT ask the user to waive framing before having framed anything

### Requirement: The gate applies only to first-party in-app calls

The framing precondition SHALL apply only when the call carries a first-party agent capability. Calls from external MCP clients SHALL reach `commit_draft` with behaviour byte-identical to today, since they cannot render the framing card and hold no conversation in the agent message store.

#### Scenario: An external MCP client is unaffected

- **WHEN** an external MCP client calls `commit_draft`
- **THEN** the framing precondition SHALL NOT be evaluated
- **AND** the call SHALL behave exactly as it does before this change

### Requirement: The agent's spec-authoring stance favours understanding over dispatch

The operator manual SHALL present spec authoring as framing-first rather than as a numbered dispatch pipeline, and SHALL NOT instruct the agent to be action-oriented when authoring specs. It SHALL state a minimum as well as a maximum for clarifying questions on a fuzzy request, and SHALL require the agent to surface a competing reading or a material assumption when one exists. Existing cost, destruction, confirmation, and permission-ladder rules SHALL remain unchanged, and both prompt constants SHALL remain free of interpolation or live data so prompt caching continues to hit.

#### Scenario: Framing precedes code grounding for an ambiguous request

- **WHEN** the user's request admits more than one reasonable reading
- **THEN** the agent SHALL surface the competing reading before proposing a solution
- **AND** it SHALL NOT resolve the ambiguity silently by choosing the more probable reading

#### Scenario: Prompt constants stay cacheable

- **WHEN** the manual and system prompt are rewritten for this change
- **THEN** both SHALL remain static string constants with no timestamps, interpolation, or live state

### Requirement: The framing step carries a stated bar for keeping it

The change SHALL record, before implementation, the evidence that decides whether the framing step is retained. That evidence SHALL be derivable from persisted conversation history with no new storage, no new WebSocket message, and no analytics surface built for it. The recorded bar SHALL name a sample size, a threshold, and the action taken when the threshold is not met, and SHALL be identified as a judgement to be revised by the first evaluation rather than as a measured value.

#### Scenario: The retention signal is derivable without instrumentation

- **WHEN** the criterion is evaluated
- **THEN** the count of answered frames and the count of those superseded before their spec was persisted SHALL be obtainable from existing agent message rows
- **AND** no counter column, event, or dashboard SHALL have been added to produce them

#### Scenario: The threshold is not met

- **WHEN** the recorded sample has accumulated and superseded frames fall below the recorded threshold
- **THEN** the framing step SHALL be removed or redesigned rather than retained by default

