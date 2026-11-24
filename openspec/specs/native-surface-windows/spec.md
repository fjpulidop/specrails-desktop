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
