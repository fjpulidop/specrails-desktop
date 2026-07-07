## ADDED Requirements
### Requirement: Agent Mode SHALL highlight unread mission conversations

Agent Mode MUST visually distinguish mission conversations that receive assistant or system output while they are not visible to the user.

#### Scenario: Inactive mission receives assistant output
- **GIVEN** Agent Mode is open with mission conversation A selected
- **AND** mission conversation B is visible in the left sidebar
- **WHEN** an `agent_*` assistant or system output event arrives for mission conversation B
- **THEN** conversation B's `MessageSquare` icon SHALL use the theme alert accent
- **AND** conversation B's icon SHALL show a fast breathing glow when motion is allowed
- **AND** any existing streaming title shimmer for conversation B SHALL remain available

#### Scenario: Active mission receives output while app is hidden
- **GIVEN** mission conversation A is selected
- **AND** `document.visibilityState` is `hidden`
- **WHEN** assistant or system output arrives for mission conversation A
- **THEN** conversation A SHALL be marked unread in the left sidebar
- **AND** the unread alert SHALL remain until the conversation is visible again

#### Scenario: Selecting unread mission clears alert after load
- **GIVEN** mission conversation B is marked unread
- **WHEN** the user selects mission conversation B from the sidebar
- **AND** the conversation load succeeds
- **THEN** conversation B SHALL no longer be marked unread

#### Scenario: Returning visible clears active mission alert
- **GIVEN** mission conversation A is active and marked unread because output arrived while the document was hidden
- **WHEN** `document.visibilityState` changes to `visible`
- **THEN** conversation A SHALL no longer be marked unread
- **AND** unread alerts for other conversations SHALL remain unchanged

#### Scenario: Reduced motion disables unread animation
- **GIVEN** a mission conversation is unread
- **AND** the user prefers reduced motion
- **WHEN** the sidebar renders that conversation
- **THEN** the icon SHALL keep the static theme alert accent
- **AND** the icon SHALL NOT run the breathing glow animation
