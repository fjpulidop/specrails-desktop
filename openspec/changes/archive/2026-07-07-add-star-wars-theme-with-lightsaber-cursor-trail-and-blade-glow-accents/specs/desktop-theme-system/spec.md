## ADDED Requirements

### Requirement: Star Wars background effects are visible only in primary work views

The `star-wars` theme SHALL show its global `LightsaberTrail` cursor effect behind app content in Mission Control and the Specs Board, not only on one board surface. The theme SHALL also show a view-local Starfield background behind Mission Control and the Specs Board. Both effects MUST be scoped to `star-wars`; other themes MUST retain their existing backgrounds and effects.

#### Scenario: Mission Control reveals the Star Wars effects
- **WHEN** the active theme is `star-wars` and Mission Control is rendered
- **THEN** the outer Mission Control page background is transparent enough for the global `LightsaberTrail` and local Starfield to be visible behind its content
- **AND** readable cards, panes, and controls remain painted above the effects

#### Scenario: Specs Board renders a local Starfield under Star Wars
- **WHEN** the active theme is `star-wars` and the Specs Board dashboard route is rendered
- **THEN** a local Starfield canvas is mounted behind the board content
- **AND** the global `LightsaberTrail` remains available at the root layer

#### Scenario: Starfield does not render outside the requested views
- **WHEN** the active theme is `star-wars` and any route other than Mission Control or the Specs Board is rendered
- **THEN** no view-local Starfield canvas is mounted for that route

#### Scenario: Other themes do not receive Star Wars background effects
- **WHEN** the active theme is any theme other than `star-wars`
- **THEN** neither Mission Control nor the Specs Board mounts the Starfield effect
- **AND** Star Wars transparency rules do not apply

### Requirement: Starfield is motion-aware and non-interactive

The Starfield effect SHALL render a low-opacity canvas of small stars that drift slowly and continuously. It MUST render nothing or remain non-animated when `prefers-reduced-motion: reduce` is active; in this implementation it should follow the existing effect convention and render no animation output. It MUST pause its animation loop while the document is hidden, resume when visible, and never intercept pointer input.

#### Scenario: Reduced motion suppresses Starfield animation
- **WHEN** the user agent reports `prefers-reduced-motion: reduce`
- **THEN** Starfield does not start a requestAnimationFrame loop
- **AND** no animated star drift is produced

#### Scenario: Starfield pauses while the tab is hidden
- **WHEN** Starfield is mounted and `document.hidden` becomes `true`
- **THEN** its animation frame loop is cancelled
- **AND** the loop resumes only after the document becomes visible again

#### Scenario: Starfield never intercepts input
- **WHEN** Starfield is mounted
- **THEN** its canvas layer has `pointer-events: none`
- **AND** clicking or dragging anywhere in Mission Control or the Specs Board reaches the underlying UI
