## ADDED Requirements

### Requirement: Composer triggers open an immediate contextual palette
The agent chat composer SHALL open a shared contextual palette immediately when the user types `@`, `#`, or `/`, before any query text is entered, and SHALL support live filtering plus keyboard and pointer selection.

#### Scenario: Trigger opens before query
- **WHEN** the focused composer receives `@`, `#`, or `/`
- **THEN** the contextual palette opens immediately with relevant unfiltered suggestions for that trigger

#### Scenario: Palette filters as the user types
- **WHEN** the user types characters after the trigger
- **THEN** the palette filters and re-ranks results in real time without closing

#### Scenario: Keyboard selection is complete
- **WHEN** the palette is open
- **THEN** Up/Down moves the active row
- **AND** Enter selects it
- **AND** Tab completes the active result when completion is available
- **AND** Esc closes the palette without inserting a result

### Requirement: Composer `+` button discovers the same palette system
The agent chat composer SHALL provide a compact `+` add button that opens the same contextual palette system without requiring the user to know the typed triggers.

#### Scenario: Plus opens add menu
- **WHEN** the user activates the composer `+` button
- **THEN** a compact add menu opens with entries for Reference, Trace / job / run, Action, File attachment, and Browser capture when those capabilities are available

#### Scenario: Plus routes to typed modes
- **WHEN** the user chooses Reference from the `+` menu
- **THEN** the `@` reference palette opens
- **WHEN** the user chooses Trace / job / run
- **THEN** the `#` trace palette opens
- **WHEN** the user chooses Action
- **THEN** the `/` action palette opens

#### Scenario: Plus does not duplicate composer clutter
- **WHEN** attachment or browser-capture actions are available
- **THEN** they are reachable from the `+` affordance or visually grouped with it as add-context actions

### Requirement: `@` references Specrails objects as structured chips
The `@` trigger SHALL reference Specrails entities and conversation-created objects, inserting a structured inline chip that carries the resolved object identity rather than plain text.

#### Scenario: Empty `@` shows context-aware references
- **WHEN** the user types `@` in Mission Home
- **THEN** the palette prioritizes projects, global recents, active jobs, and objects created or touched in the current conversation

#### Scenario: Project scope narrows `@` suggestions
- **WHEN** the user types `@` while a project is pinned or active
- **THEN** project-local specs, jobs, and artifacts are ranked above global results

#### Scenario: Selecting a reference inserts a chip
- **WHEN** the user selects an `@` result
- **THEN** the composer inserts a chip with at least `type`, `id`, `label`, and `scope`
- **AND** the submitted agent turn includes that structured reference payload

#### Scenario: Reference rows explain themselves
- **WHEN** `@` results are shown
- **THEN** each row shows the object type, title, status or state when relevant, parent project or breadcrumb, and recency when available

#### Scenario: Current-context aliases resolve
- **WHEN** the user selects or types a supported alias such as `@current`, `@this`, `@last`, or `@selection`
- **THEN** the alias resolves to the current pinned/viewed/last-created/selected object when available
- **AND** the UI asks for clarification or shows no-result recovery when the alias cannot resolve

### Requirement: `#` references operational traces, IDs, and history
The `#` trigger SHALL prioritize operational traces such as jobs, runs, errors, deploys, checks, changes, and direct numeric IDs, scoped to the current project or mission before global history.

#### Scenario: Direct ID resolves a trace
- **WHEN** the user types a direct trace ID such as `#142`
- **THEN** matching jobs, runs, checks, or changes with that ID are shown first

#### Scenario: State filters surface relevant traces
- **WHEN** the user types a semantic trace query such as `#failed`, `#running`, or `#deploy`
- **THEN** matching operational items are shown with state, timestamp, and project breadcrumb

#### Scenario: Selecting a trace inserts a chip
- **WHEN** the user selects a `#` result
- **THEN** the composer inserts a trace chip with the resolved identity and metadata needed by the agent

### Requirement: `/` invokes chat-native actions that consume context
The `/` trigger SHALL open an action palette for commands such as create spec, update project, launch job, compare, summarize, save decision, open item, or generate plan, and SHALL pre-scope actions from existing chips and pinned context.

#### Scenario: Action uses existing chips
- **WHEN** the composer contains an `@Home Project` chip
- **AND** the user selects `/create spec`
- **THEN** the action is pre-scoped to the Home project

#### Scenario: Actions obey tiers and approvals
- **WHEN** the selected action requires write, AI-spawn, or destructive permissions
- **THEN** the action follows the agent tier ladder and Option-C approval requirements before execution

### Requirement: `/` action palette ranks by current workbench context
The `/` action palette SHALL rank domain-language actions by the user's current context, selected chips, pinned project, and visible mission state rather than showing a flat technical command catalog.

#### Scenario: Empty action palette starts with common work
- **WHEN** the user types `/` with no chips and no specific object selected
- **THEN** the first results include create spec, search, show status, diagnose project, launch all eligible rails when scoped to a project, and show spend when cost data exists

#### Scenario: Spec chip prioritizes spec actions
- **WHEN** the composer contains a spec chip
- **THEN** the first `/` results include update spec, assign to rail, launch in rail, refine contract, split epic, show files touched, show spend, and delete spec

#### Scenario: Job trace prioritizes run actions
- **WHEN** the composer contains a job or run trace
- **THEN** the first `/` results include open job, wait for result, compare, show diff, export diagnostic, and cancel job

#### Scenario: PR delivery prioritizes decision actions
- **WHEN** the current conversation contains an active PR delivery card or selected PR chip
- **THEN** the first `/` results include create PR, publish or integrate locally, discard implementation, and check merge status as applicable

#### Scenario: Action rows disclose cost and risk
- **WHEN** an action requires `Operate` or `Autonomous`
- **THEN** its row indicates the required level and whether an approval will be requested before execution

### Requirement: Inline composer chips expose what the agent will use
The agent chat SHALL show structured chips inside the composer itself for references and actions that will be carried into the next turn, and SHALL let the user remove, pin, or preview them without duplicating them in a separate strip.

#### Scenario: Context is visible before send
- **WHEN** the composer has resolved references or the mission has pinned context
- **THEN** the composer displays those chips before the user sends the turn

#### Scenario: Chip preview exposes object state
- **WHEN** the user hovers or clicks a context chip
- **THEN** the UI shows a preview with title, type, state, parent project, last activity, and quick actions such as open, compare, pin/unpin, or remove

#### Scenario: Removed chip is not sent
- **WHEN** the user removes a chip from the composer
- **THEN** that reference is omitted from the next submitted agent turn

### Requirement: Selected trigger tokens remain chips in conversation history
Selected `@`, `#`, and `/` palette results SHALL persist their structured reference payload with the user message and SHALL render as self-contained chips in the conversation after send and after refresh.

#### Scenario: Sent trigger selections render as inline chips
- **WHEN** the user selects an `@`, `#`, or `/` palette result and sends the turn
- **THEN** the user bubble renders the selected token as an inline chip with an icon, label, and type-specific accent color
- **AND** the copyable message text remains the user's original text

#### Scenario: Inline chips survive reload
- **WHEN** a conversation containing selected trigger chips is reloaded from storage
- **THEN** the app renders the chips from persisted structured references rather than guessing from raw text

#### Scenario: Palette chrome is localized
- **WHEN** the app language changes
- **THEN** the palette, `+` menu, empty states, and chip controls use the active locale

### Requirement: Ambiguity and empty results remain actionable
The contextual palette SHALL handle ambiguous and empty result states inline without forcing the agent to ask long clarifying questions when the user can disambiguate in the UI.

#### Scenario: Ambiguous label shows disambiguation rows
- **WHEN** a query such as `@Home` matches multiple objects
- **THEN** the palette shows separate rows with type, state, and breadcrumb so the user can select the intended object

#### Scenario: Empty result offers useful exits
- **WHEN** no results match the typed query
- **THEN** the palette offers relevant actions such as search all Specrails, create a new object with the typed name, ask the agent about the literal text, or include archived results

### Requirement: Structured references are refreshed before dispatch
Before sending an agent turn, the app SHALL refresh structured chip metadata where possible so stale labels or states do not mislead the user or the agent.

#### Scenario: Deleted object degrades clearly
- **WHEN** a chip references an object that no longer exists before the turn is sent
- **THEN** the UI marks the chip as unavailable and requires the user to remove or replace it before sending

#### Scenario: Updated object state is reflected
- **WHEN** a referenced job changes from running to failed before send
- **THEN** the chip preview and submitted reference metadata reflect the latest known state
