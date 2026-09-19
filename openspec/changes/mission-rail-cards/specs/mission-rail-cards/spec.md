## ADDED Requirements

### Requirement: The agent proposes a launch as an editable rail card
When the operator agent decides that specs should be assigned to a rail and launched, it SHALL emit a fenced `rail-launch` JSON block instead of prose, and the mission SHALL render that block as a rail launch card pre-filled with the agent's recommendation (target rail or new rail, specs, mode/loop, engine, model, reasoning effort, profile, target PR, base branch, rail name). Every option a rail header exposes in Board mode SHALL be editable on the card before launch.

#### Scenario: Proposal renders as a card
- **WHEN** an assistant message contains a valid `rail-launch` block
- **THEN** the message renders a rail launch card with the proposed values and a Play action, and the raw block is not shown as text

#### Scenario: User edits the proposal
- **WHEN** the user changes the rail, specs, engine, model, effort, profile, loop, target PR or base branch on the card
- **THEN** the card keeps the edited configuration locally and Play launches with the edited values, never the agent's originals

#### Scenario: New rail from the card
- **WHEN** the proposal names no existing free rail or the user picks "New rail"
- **THEN** Play first creates the rail through the rails API, then assigns and launches; a `rail_limit_reached` error is shown inline with a rail switch

#### Scenario: Proposal is reconciled against live state
- **WHEN** the card mounts and the proposed rail is busy, the model is stale, or a spec no longer exists
- **THEN** the card degrades honestly (warning pill, adapter default, missing chip removed) and stays launchable if at least one valid spec and rail remain

#### Scenario: Unreadable proposal is never silent
- **WHEN** the block is malformed or truncated
- **THEN** the message shows a muted "proposal unreadable" note with the agent's text intact, and no Play action

### Requirement: Play launches from the client under the user's authority
Play SHALL launch through the app's own rails REST from the client, tagged with the mission's origin conversation, and SHALL be treated as a user action outside the agent tier ladder. Server rejections SHALL be rendered inline on the card.

#### Scenario: Successful play
- **WHEN** the user presses Play
- **THEN** the client calls the rails launch route with `originConversationId` and `originSurface:'agent-chat'` plus the edited configuration, the button disables in flight, and the card transitions to the launched phase on the 202

#### Scenario: Launch rejected
- **WHEN** the server answers 409 `tickets_in_flight`, `pr_decision_pending` or 400 validation
- **THEN** the card shows the server's error and action text inline and remains editable

### Requirement: A taken proposal is frozen
A launched or dismissed proposal SHALL be persisted on its message row so that it renders as a frozen decision after reload and can never be launched twice.

#### Scenario: Reload after launch
- **WHEN** the conversation is reloaded after Play succeeded
- **THEN** the proposal renders as a "Launched → Rail N" stub linking to the run card, with no editable controls

#### Scenario: Dismissed proposal
- **WHEN** the user dismisses a proposal
- **THEN** it renders as a dismissed stub and the agent's next turn can see it was declined

### Requirement: One card follows the run from launch to settle
Every launch originating from a mission SHALL be represented by exactly one run card that progresses through launched → running → settled, and, when a delivery row exists, into the existing PR-decision phase. The card SHALL exist for shared-cwd launches (no git repository or no commits) keyed on the run ids.

#### Scenario: Running phase
- **WHEN** the run is live
- **THEN** the card shows the status pill, live elapsed time, the current phase/activity line, log chips that open the job detail modal, and a Stop action

#### Scenario: Shared-cwd launch without git
- **WHEN** the project has no git repository or no commits and the launch takes the shared-cwd path
- **THEN** a run card is still posted to the origin mission, progresses to settled with the real outcome, and shows an honest note that no PR phase exists

#### Scenario: Delivery phase
- **WHEN** the run settles with a delivery row
- **THEN** the same card renders the existing PR-decision controls without a second card

### Requirement: Failure is shown with its reason and recovery actions
When a run fails, stalls, hits a provider limit or is detected stuck, the card SHALL show the failure code and detail as text and SHALL offer the recovery actions the runtime exposes (resume, recover & retry, approve, relaunch, discard), disabled while in flight and reconciled to the broadcast.

#### Scenario: Implementation failure
- **WHEN** a run settles `implementation_failed` or the launch auto-closes as `discarded`
- **THEN** the card shows `statusDetail` and per-unit failure codes inline, not only on hover

#### Scenario: Recoverable step
- **WHEN** the runtime reports `canResume` or `recoverableSteps` for the run
- **THEN** the card offers the matching action and the action reaches the runtime-controls route

### Requirement: A failure triggers the card and the agent
A terminal failure, stall, provider limit or stuck detection SHALL update the origin mission's card in place, insert a compact failure system row into the conversation, and start at most one automatic, bounded agent turn briefed with the failure and the available recovery options.

#### Scenario: Automatic failure turn
- **WHEN** a mission-originated run fails and the conversation is idle
- **THEN** exactly one agent turn starts with the fixed failure briefing, explains the failure briefly and proposes the next action through the card, without relaunching by itself

#### Scenario: Conversation busy
- **WHEN** the failure arrives while the conversation is streaming
- **THEN** the briefing is queued once (deduplicated by run id) and dispatched after the live turn

#### Scenario: Auto-turn disabled
- **WHEN** `SPECRAILS_MISSION_FAILURE_TURN` is `false`
- **THEN** the card and the system row still update and no automatic turn starts

#### Scenario: Untagged launch
- **WHEN** the run has no origin conversation
- **THEN** nothing is posted to any mission

### Requirement: Cards match the mission's visual language and locales
Rail cards SHALL reuse the established mission card chrome (glass surface, header with rail and spec chips, status pill, motion transitions honoring reduced motion, pinned dock behaviour) and every string SHALL exist in all supported locales.

#### Scenario: Locale parity
- **WHEN** the locale parity test runs
- **THEN** every `agent:railCard.*` key exists in the 8 locales with identical placeholders

#### Scenario: Pinned while attention is needed
- **WHEN** a card is in proposal, running or failed phase
- **THEN** it is pinned in the dock above the composer, and it unpins when terminal
