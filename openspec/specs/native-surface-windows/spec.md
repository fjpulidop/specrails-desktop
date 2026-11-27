# native-surface-windows Specification

## Purpose
Defines framing and minimize behaviour of native modal surface windows and shared dialog panels.

## Requirements

### Requirement: Surface panels clip without gaps
Dialog panels and native surface panels SHALL clip their overflow so content fills the frame with no empty bottom strip and the title keeps its heading format after first render.

#### Scenario: Native frame stable
- **WHEN** a native surface window is open and focused or resized
- **THEN** the panel stays framed to the window and the title keeps its title style

### Requirement: Minimizing a native modal leaves the main window up
On macOS a native surface window SHALL have no parent window, so minimizing it does not minimize the main app; on Windows and Linux it SHALL remain owned by its opener.

#### Scenario: macOS minimize
- **WHEN** the user minimizes a native modal on macOS
- **THEN** only that modal minimizes

### Requirement: Native windows open at once with their content
A native surface window SHALL show its real content without waiting for a fallback timer: the page SHALL reveal its hidden window once the framed content is in the DOM, without relying on animation frames (a hidden window runs none). When a pre-loaded spare window is ready, opening a surface SHALL reuse it, so the window appears with its content in about a tenth of a second; a spare SHALL be used for a single surface and never carry state into another open.

#### Scenario: Hidden window reveals itself
- **WHEN** a surface window's framed content is in the DOM while the window is hidden
- **THEN** the page shows the window without waiting for an animation frame or the host's fallback

#### Scenario: Spare takes the surface
- **WHEN** the person opens a surface and a spare window is ready
- **THEN** the spare renders that surface at the opener's center with the surface's size, title and permissions, and a new spare is prepared afterwards

### Requirement: The window content is never the in-page modal
The first dialog committed inside a native surface window SHALL be presented as the window (no scrim, no card, title-bar header), even when React discarded earlier renders of it.

#### Scenario: Discarded first render
- **WHEN** the surface's dialog mounts after the window frame and its first render is thrown away
- **THEN** the dialog that commits fills the window as its content

### Requirement: A native modal stays above its opener
On macOS a surface window SHALL be ordered right above its opener whenever the opener comes forward, without becoming key, moving with the opener or minimizing with it.

#### Scenario: Clicking the opener
- **WHEN** the person clicks the main window while a surface window it opened is visible
- **THEN** the surface window stays visible above the main window
