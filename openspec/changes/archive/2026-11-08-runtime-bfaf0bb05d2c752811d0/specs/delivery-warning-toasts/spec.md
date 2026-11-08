# Spec Delta

## Purpose

Persistent delivery warning toasts (cleanup incomplete, safety archive) carry long paths and git errors. This capability keeps them inside the window, readable and always dismissible.

## ADDED Requirements

### Requirement: Warning toast stays within the window
A delivery warning toast SHALL never exceed the viewport in width or height. Its preferred width is 356px, reduced when the viewport is narrower.

#### Scenario: Long multi-line warnings in a short window
- **WHEN** a cleanup-incomplete toast with 3 or more multi-line warnings containing 150-character paths renders in a 700px-high window
- **THEN** the whole toast, including its title, action and close control, is inside the viewport

#### Scenario: Narrow viewport
- **WHEN** the viewport is narrower than 356px plus the toaster margins
- **THEN** the toast is narrowed to fit instead of overflowing horizontally

### Requirement: Long text wraps
The toast description SHALL preserve line breaks (one warning per line) and break unbroken tokens such as long paths instead of widening the toast or collapsing it to one word per line.

#### Scenario: Path without spaces
- **WHEN** a warning contains a 150-character path with no spaces
- **THEN** the path wraps inside the toast at the bounded width

#### Scenario: Long text in any shipped locale
- **WHEN** the toast title, hint or action label renders in any of the 8 shipped locales
- **THEN** the toast remains within the window and dismissible

### Requirement: Description scrolls internally
When the description is taller than the available height, only the description region SHALL scroll. Title, action button and close control SHALL remain outside the scrolling region and visible, and no detail text is truncated.

#### Scenario: Description taller than available height
- **WHEN** the warnings exceed the available height
- **THEN** the description scrolls vertically and the full text remains reachable by scrolling

### Requirement: Close control is always reachable
The toast SHALL expose a visible, unclipped close control that dismisses it in a single click, in both toaster positions (top-right while a modal is open, bottom-right otherwise).

#### Scenario: Single-click dismissal
- **WHEN** the user clicks the close control of a long warning toast
- **THEN** the toast is dismissed

#### Scenario: Both toaster positions
- **WHEN** a long warning toast renders in the top-right or the bottom-right position
- **THEN** its close control is on-screen

### Requirement: Details remain complete and copyable
The toast SHALL keep the full warning details inside it and keep its Copy details action, which writes the full unmodified text to the clipboard. The toast stays persistent until dismissed.

#### Scenario: Copy details
- **WHEN** the user activates Copy details on a cleanup-incomplete or safety-archive toast
- **THEN** the full newline-joined warning text is written to the clipboard

#### Scenario: Safety archive toast
- **WHEN** a safety-archive toast with long paths renders
- **THEN** it satisfies the same containment, wrapping, scrolling and close-control behaviour

#### Scenario: Persistence unchanged
- **WHEN** a warning toast is shown and the user takes no action
- **THEN** it remains visible until dismissed
