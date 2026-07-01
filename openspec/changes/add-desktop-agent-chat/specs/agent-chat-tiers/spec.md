## ADDED Requirements

### Requirement: Cumulative tier ladder cycled with Shift+Tab
The agent chat SHALL expose a cumulative permission ladder with four levels — `Observe` (read), `Edit` (read+write), `Operate` (read+write+AI-spawn), `Autonomous` (read+write+AI-spawn+destructive) — where each level includes all capabilities of the levels below it, cycled with `Shift+Tab` and displayed as a live chip showing the current level.

#### Scenario: Shift+Tab advances the level
- **WHEN** the user presses `Shift+Tab` with the panel focused at level `Observe`
- **THEN** the level advances to `Edit`, then `Operate`, then `Autonomous`, then wraps to `Observe`
- **AND** the chip reflects the current level at all times

#### Scenario: Higher levels include lower capabilities
- **WHEN** the level is `Operate`
- **THEN** read, write, and AI-spawn actions are permitted
- **AND** destructive actions are not

### Requirement: Server enforces the in-app agent's level independently of external MCP settings
The server SHALL enforce the conversation's current ladder level before dispatching any agent tool call, refusing actions above the level with a machine-readable response naming the level required, and SHALL keep this in-app level independent of the Settings▸MCP external-client tier checkboxes.

#### Scenario: Action above level is refused
- **WHEN** the agent attempts a destructive action while the level is `Operate`
- **THEN** the server refuses the tool call
- **AND** returns the level required (`Autonomous`)
- **AND** the panel renders a lock message telling the user how to raise the level

#### Scenario: In-app level does not change external client tiers
- **WHEN** the user raises the in-app agent to `Autonomous`
- **THEN** the Settings▸MCP tier checkboxes that govern external MCP clients are unchanged

### Requirement: Option-C inline approval for cost and destructive actions
Within the permitted level, AI-spawn (cost-incurring) and destructive (irreversible) actions SHALL require an inline approval the first time per session, showing an impact/cost estimate, while reversible writes run without prompting; the user MAY suppress further prompts for that action class for the rest of the conversation.

#### Scenario: Cost action prompts before spending
- **WHEN** the agent is about to perform an AI-spawn action (e.g. launch rails) at a permitting level for the first time this session
- **THEN** an inline approval chip appears with an estimated cost
- **AND** the action proceeds only after the user approves

#### Scenario: Reversible write does not prompt
- **WHEN** the agent performs a reversible write (e.g. edit a ticket) at a permitting level
- **THEN** no approval chip is shown and the action proceeds

#### Scenario: Suppress further prompts for the session
- **WHEN** the user approves an action and checks "don't ask again"
- **THEN** subsequent actions of that class in the same conversation proceed without an approval chip

### Requirement: Tier names are localized in all supported languages
The ladder level names and related strings SHALL be provided in all 8 supported locales under the `agent` namespace, with key parity enforced by the locale-parity test.

#### Scenario: Level names render in the active language
- **WHEN** the app language is set to any of the 8 supported locales
- **THEN** the four ladder level names render translated from the `agent` namespace
