# Spec Delta

## MODIFIED Requirements

### Requirement: Area accents and surface layering
Each app area SHALL take an accent from the active theme (areas that would share a hue in a theme SHALL be remapped to distinct theme accents), and surfaces SHALL be layered title bar darkest, centre intermediate and sidebars lightest in every theme.

#### Scenario: Layered surfaces
- **WHEN** any theme is active
- **THEN** the title bar is darker than the centre, and the centre is darker than the sidebars

### Requirement: Sidebars can be fully hidden
Auto-hiding sidebars SHALL reserve no space and show no icon rail when hidden, SHALL remain reachable by keyboard focus, and SHALL not render their own header (the title bar owns the collapse control).

#### Scenario: Hidden sidebar
- **WHEN** a sidebar is unpinned and not hovered or focused
- **THEN** it takes no width and is inert
