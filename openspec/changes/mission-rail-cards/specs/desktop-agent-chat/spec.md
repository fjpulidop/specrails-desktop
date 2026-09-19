## ADDED Requirements

### Requirement: Operator proposes launches through cards
The operator prompt SHALL instruct the agent to propose rail assignment and launch by emitting a `rail-launch` block, and to call the launch tool directly only when the user explicitly asked to launch now.

#### Scenario: Assignment request
- **WHEN** the user asks to assign or prepare specs for a rail without saying "launch now"
- **THEN** the agent answers with a `rail-launch` block and ends its turn without calling the launch tool

#### Scenario: Explicit launch
- **WHEN** the user explicitly asks to launch immediately
- **THEN** the agent may call the launch tool directly and the launch is tagged with the conversation origin

### Requirement: Message intents are persisted
The agent message store SHALL persist an optional intent on a message row, settable by the client after a user decision, so decision cards render frozen after reload.

#### Scenario: Intent patch
- **WHEN** the client patches a message intent after a successful launch
- **THEN** the store persists it and subsequent conversation reads carry it

### Requirement: Failure briefing turns are bounded and accounted
An automatic failure turn SHALL use the conversation's provider and model, be recorded in agent accounting like any turn, run at most once per run id, and never chain into further automatic turns.

#### Scenario: One turn per run
- **WHEN** the same run emits two failure signals
- **THEN** only one automatic turn starts and the second signal only updates the card
