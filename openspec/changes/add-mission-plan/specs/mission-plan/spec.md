## ADDED Requirements

### Requirement: Mission plan
A mission SHALL keep its agent's plan of work: an ordered list of steps, each pending, in progress or done, with an optional title. An update to the same unfinished work SHALL replace the current plan in place; a new list of work, or one after the previous plan was finished, SHALL start a new plan, and earlier plans SHALL stay in the mission's history.

#### Scenario: Progress
- **WHEN** the agent marks the first step done and starts the second
- **THEN** the mission's plan shows the first step done and the second in progress

#### Scenario: New work
- **WHEN** the agent finished its plan and later sets out a different one
- **THEN** the new plan is the current one and the previous plan stays in the history

### Requirement: Sources
The plan SHALL come from the agent's own todo list when its provider keeps one (Claude's `TodoWrite`), with no extra instruction, and from Specrails' `specrails_missions` action `plan` for any provider, which an in-app agent may call only for its own mission at any permission level. The Intent persona SHALL ask the agent to keep its plan with one of the two.

#### Scenario: Claude's todo list
- **WHEN** the agent writes its list with TodoWrite
- **THEN** the mission's plan shows those steps and their states

#### Scenario: Another provider
- **WHEN** a Codex agent calls specrails_missions plan with its steps
- **THEN** the mission's plan shows them

### Requirement: Plan pill
Once a mission has a plan, the composer SHALL show a Plan pill beside Processes and Resources with the progress (done of total); hovering or focusing it SHALL show the steps with their state, the step in progress, and that all steps are done when they are. Without a plan no pill SHALL show, and the plan SHALL not appear inline in the transcript.

#### Scenario: Hover the pill
- **WHEN** the person hovers the Plan pill while the agent works
- **THEN** a panel lists the steps, done ones checked, the current one marked in progress, the rest pending

### Requirement: Read over MCP
Any MCP client SHALL read a mission's current plan (`specrails_missions get` with field `plan`): title, done and total, and each step with its status.

#### Scenario: External client
- **WHEN** an MCP client gets a mission with field plan while its agent works
- **THEN** it receives the steps and how many are done
