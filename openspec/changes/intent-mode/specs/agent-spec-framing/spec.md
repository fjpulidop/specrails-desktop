## MODIFIED Requirements

### Requirement: The operator agent states its framing before proposing a spec

When the user describes product or code work, the operator agent SHALL interview the user like an analyst and show its framing as an intent before it emits any `spec-draft` block. The interview asks about users, limits, and how the user will know it worked. The intent SHALL be produced BEFORE the first solution proposal, not after it, and SHALL be shown as an artifact in the conversation rather than asserted in prose. The agent SHALL NOT decide on its own that a request is clear enough to skip this step; only the user may waive it. When the user dictates a solution, the agent SHALL keep the outcome it serves as the intent and record the dictated solution as a constraint or an open question. Support and troubleshooting requests, which are routed through `specrails_support` and do not become specs, SHALL be unaffected.

#### Scenario: A work request produces an intent before any draft

- **WHEN** the user describes work to be done in a project and the agent intends to author a spec
- **THEN** the agent SHALL emit an `intent-draft` block before emitting any `spec-draft` block
- **AND** the reply carrying the intent SHALL end after the intent and its question
- **AND** no spec-persisting tool SHALL be called in that turn

#### Scenario: The agent judges the request obvious

- **WHEN** the agent assesses the request as unambiguous and well-scoped
- **THEN** it SHALL still emit an `intent-draft` block
- **AND** it SHALL NOT treat its own confidence as grounds to skip the step

#### Scenario: The user dictates a solution

- **WHEN** the user's request names a specific implementation
- **THEN** the intent's problem and outcome SHALL describe what that implementation is for
- **AND** the dictated implementation SHALL appear as a constraint or an open question, never as the outcome

#### Scenario: Support questions are not framed as specs

- **WHEN** the user reports a broken setup, a failed job, or asks how to use the app
- **THEN** the agent SHALL route the request through `specrails_support`
- **AND** it SHALL NOT emit an `intent-draft` block or propose a spec unless the user explicitly pivots to product work

### Requirement: The problem frame carries two anchored readings and the question that separates them

The framing artifact SHALL be a single fenced code block tagged `intent-draft`. The block SHALL contain exactly one complete JSON object with the keys `problem`, `outcome`, `successSignals`, `affects`, `constraints`, `openQuestions` and `readings`, plus an optional `hypothesis`. Every required key SHALL be present on every emission, and the block SHALL be a full snapshot that replaces the previous intent, never a diff. `problem` and `outcome` SHALL be non-empty strings. The list keys SHALL be arrays of strings and MAY be empty, except `openQuestions`, which SHALL be an array of strings or of `{ question, answer? }` objects.

`readings` SHALL carry `restated`, `alternative` and `discriminator`, each a non-empty string:

- `restated` and `alternative` SHALL be genuinely different readings of the same problem or outcome, and SHALL NOT describe implementations.
- `discriminator` SHALL be the question the user could answer to pick between them.

The agent SHALL NOT additionally restate the intent's content in prose, and SHALL reserve prose for what changed and the question it is asking. A legacy `problem-frame` block stored in an existing conversation SHALL keep rendering as a framing card.

#### Scenario: A well-formed intent renders as a card

- **WHEN** an assistant message contains a valid `intent-draft` block
- **THEN** the client SHALL parse it and render it as an intent card in the conversation
- **AND** the card SHALL show problem, outcome, success signals, affects, constraints and open questions, and both readings
- **AND** the discriminating question SHALL be rendered as the card's question
- **AND** the raw block SHALL NOT be shown as literal code to the user

#### Scenario: A malformed or partial block does not render

- **WHEN** the block is not valid JSON, is missing any required key, or `problem`, `outcome` or a reading is empty
- **THEN** the client SHALL NOT render an intent card for it
- **AND** the message SHALL still render its remaining content without error

#### Scenario: Two readings differing only in outcome

- **WHEN** the ambiguity is about what finishing the work means
- **THEN** the two readings SHALL differ in the outcome they describe
- **AND** the discriminator SHALL ask which outcome the user wants

#### Scenario: A later intent supersedes an earlier one

- **WHEN** the agent emits a second `intent-draft` block after the user corrects it
- **THEN** the later block SHALL be treated as the current intent
- **AND** the earlier card SHALL NOT be treated as the intent in force

#### Scenario: A stored legacy frame

- **WHEN** a conversation created before this change contains a `problem-frame` block
- **THEN** it SHALL render as the legacy framing card

### Requirement: The frame's readings are one-click answers to the discriminating question

Each rendered reading on the intent card SHALL be an interactive control that, when activated, sends that reading's own text as the user's next turn. It SHALL use the same send path as a composer submission, with no composer pre-fill step and no additional confirmation. The two readings SHALL keep identical visual weight; the interaction SHALL add only an affordance (pointer cursor, hover and focus states, keyboard focus ring). Both readings SHALL be focusable and activatable from the keyboard. Only the card on the newest message SHALL be actionable, and while a turn is in flight the readings SHALL be disabled. The other sections SHALL remain non-interactive.

When the newest intent has been answered, the card SHALL also offer the two paths with equal weight:

- **Explore**: start an Intent session.
- **Delegate**: ask the agent to write the spec from the intent.

#### Scenario: A reading is picked as the reply

- **WHEN** the user activates either reading on the current intent card
- **THEN** that reading's exact text SHALL be sent as the next user turn
- **AND** the conversation SHALL continue as if the user had typed it and pressed send

#### Scenario: An already-answered intent is not re-sendable

- **WHEN** the user activates a reading on an intent card that is no longer the newest message
- **THEN** no turn SHALL be sent
- **AND** the older card SHALL render as static content rather than a dead control

#### Scenario: A reading cannot fire during an in-flight turn

- **WHEN** a turn is streaming and the user activates a reading on the newest intent card
- **THEN** the control SHALL be disabled and no turn SHALL be sent

#### Scenario: Delegate from the card

- **WHEN** the user activates Delegate on an answered intent card
- **THEN** a user turn asking the agent to write the spec from this intent SHALL be sent

### Requirement: Persisting an agent-authored spec requires an answered frame

`specrails_specs(commit_draft)` SHALL refuse a first-party call when the calling conversation contains no `intent-draft` block (or legacy `problem-frame` block) that the user has subsequently answered. A frame is answered when at least one user message follows the assistant message carrying it. The refusal SHALL be returned in the same shape as an existing tier refusal, SHALL name the missing intent, and SHALL state the action that satisfies it. A refusal SHALL NOT persist a spec, SHALL NOT partially write, and SHALL NOT trigger Contract Layer enrichment. A successful first-party `commit_draft` SHALL attach the newest answered `intent-draft` as the spec's intent unless the call carries its own `intent`.

#### Scenario: Commit without any intent is refused

- **WHEN** the first-party agent calls `commit_draft` in a conversation that contains no `intent-draft` or `problem-frame` block
- **THEN** the call SHALL be refused with a message naming the missing intent
- **AND** no ticket SHALL be created

#### Scenario: Commit with an unanswered intent is refused

- **WHEN** the agent emits an `intent-draft` block and calls `commit_draft` before any user message follows it
- **THEN** the call SHALL be refused
- **AND** no ticket SHALL be created

#### Scenario: Commit after an answered intent succeeds and carries it

- **WHEN** an `intent-draft` block was emitted, at least one user message followed it, and the agent then calls `commit_draft`
- **THEN** the call SHALL proceed and the spec SHALL be persisted with that intent
- **AND** Contract Layer enrichment SHALL run according to its existing default and opt-out

#### Scenario: A legacy answered frame still satisfies the gate

- **WHEN** a conversation has an answered `problem-frame` and no `intent-draft`
- **THEN** `commit_draft` SHALL proceed and the spec SHALL be persisted without an intent

#### Scenario: A user reply that disagrees still satisfies the gate

- **WHEN** the user's message following an intent rejects or corrects it
- **THEN** the gate SHALL treat the intent as answered
- **AND** the agent SHALL emit a corrected intent rather than persist the spec

### Requirement: One frame authorises one spec

While framing is on, an intent (or legacy frame) SHALL authorise the next `commit_draft` in its conversation and no more. A `commit_draft` SHALL require an intent emitted after the most recent successful `commit_draft` in the same conversation.

#### Scenario: A second spec in one conversation needs its own intent

- **WHEN** a spec has been persisted in a conversation and the agent attempts a second `commit_draft` without a new intent
- **THEN** the second call SHALL be refused
- **AND** the refusal SHALL name the missing intent for the new spec
