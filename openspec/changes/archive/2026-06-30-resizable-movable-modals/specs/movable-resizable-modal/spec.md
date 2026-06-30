## ADDED Requirements

### Requirement: Movable-Resizable Modal Hook

The client SHALL provide a `useMovableResizableModal()` hook that owns a single `{x, y, w, h}` geometry state plus the pointer-capture lifecycle for both moving and resizing a modal panel. The hook SHALL return a `panelRef`, a `panelStyle`, `headerHandleProps` for the move surface, an array of `resizeHandles`, an `isFloating` flag, and a `reset()` function. The hook SHALL accept `enabled`, `allowMove`, `minWidth`, and `minHeight` options.

#### Scenario: Hook returns inert geometry before interaction

- **WHEN** a modal mounts using the hook and the user has not yet moved or resized it
- **THEN** `panelStyle` SHALL be an empty object and `isFloating` SHALL be `false`

#### Scenario: Move disabled when allowMove is false

- **WHEN** the hook is configured with `allowMove: false`
- **THEN** it SHALL NOT expose a usable header move surface
- **AND** it SHALL still expose `resizeHandles`

### Requirement: Default State Identical To Today

A modal using the hook that the user never moves or resizes SHALL render byte-identically to its pre-change appearance — centered at its current CSS size with no inline positioning or sizing applied.

#### Scenario: Untouched modal is unchanged

- **WHEN** a modal opens and is never dragged or resized
- **THEN** the hook SHALL apply no `left`, `top`, `width`, or `height` inline style
- **AND** the modal's existing centering and size classes SHALL remain in effect

#### Scenario: First interaction seeds from live geometry

- **WHEN** the user first moves or resizes the modal
- **THEN** the hook SHALL seed `{x, y, w, h}` from the panel's live `getBoundingClientRect()`
- **AND** SHALL switch to `position: fixed` with inline `left`/`top`/`width`/`height` so the panel does not visually jump

### Requirement: Move By Header Drag

When `allowMove` is enabled, dragging the modal's header SHALL reposition the panel via `position: fixed` and inline `left`/`top` (never a CSS transform). Pointer targets that are buttons, links, or form inputs within the header SHALL be exempt from initiating a move. Pointer-move updates SHALL be throttled with `requestAnimationFrame`.

#### Scenario: Header drag moves the panel

- **WHEN** the user presses on the header drag-zone and moves the pointer
- **THEN** the panel's `left`/`top` SHALL follow the pointer delta
- **AND** the panel SHALL use `position: fixed` and SHALL NOT use `transform: translate`

#### Scenario: Interactive header elements do not start a move

- **WHEN** the user presses on a button, link, or input inside the header
- **THEN** no move gesture SHALL begin and the element SHALL receive its normal interaction

### Requirement: Resize By Corner And Edge Grips

The hook SHALL expose eight resize grips (four corners, four edges). A corner grip SHALL adjust two dimensions; an edge grip SHALL adjust one. Top and left grips SHALL adjust the dimension while shifting `left`/`top` so the opposite edge stays anchored. Dimensions SHALL be clamped to `width ∈ [minWidth, innerWidth − 16]` and `height ∈ [minHeight, innerHeight − 16]`. Grips SHALL use semantic theme tokens only.

#### Scenario: Corner grip resizes two dimensions

- **WHEN** the user drags a corner grip
- **THEN** both the width and the height SHALL change according to the pointer delta, clamped to the configured minimums and the viewport

#### Scenario: Top-left grip anchors the opposite edge

- **WHEN** the user drags the top-left grip
- **THEN** the width and height SHALL change AND `left`/`top` SHALL shift so the bottom-right corner stays fixed

### Requirement: Off-Screen Jail Guard

After any move or resize, the hook SHALL clamp `left`/`top` so that the modal header remains on-screen with at least 48px of height and 120px of width visible, including the close button. A `reset()` SHALL restore the modal to its centered default.

#### Scenario: Header stays reachable

- **WHEN** the user drags the modal toward a viewport edge
- **THEN** the panel SHALL stop such that at least 48px×120px of the header (including the close button) remains visible

#### Scenario: Reset re-centers the modal

- **WHEN** `reset()` is invoked (e.g. via the keyboard `0` key on a grip)
- **THEN** `panelStyle` SHALL return to empty and the modal SHALL render centered at its default size

### Requirement: Viewport Gate

Move and resize SHALL be hard-disabled below a shared `MODAL_FLOAT_VIEWPORT_MIN` width of 900px. When the viewport shrinks below the threshold while a modal is floating, the modal SHALL auto-collapse to its centered default.

#### Scenario: Below the gate the feature is inert

- **WHEN** the viewport width is below `MODAL_FLOAT_VIEWPORT_MIN`
- **THEN** the hook SHALL return `enabled: false`, apply no inline geometry, and render no resize grips

#### Scenario: Shrinking below the gate collapses a floating modal

- **WHEN** a modal is floating and the viewport is resized below `MODAL_FLOAT_VIEWPORT_MIN`
- **THEN** the modal SHALL auto-collapse to its centered default

### Requirement: No Persistence In v1

Modal size and position SHALL NOT be persisted across opens. Every time a modal opens it SHALL start at its centered default.

#### Scenario: Re-opening resets geometry

- **WHEN** the user resizes or moves a modal, closes it, and re-opens it
- **THEN** the modal SHALL open centered at its default size with no retained position or size

### Requirement: Keyboard And Accessibility For Grips

Each resize grip SHALL be focusable with `role="separator"`, an `aria-orientation` matching its axis, and an sr-only `aria-label`. Arrow keys SHALL adjust the relevant dimension by ±16px, Shift+Arrow by ±64px, Home/End SHALL set the dimension to its minimum/maximum, and `0` SHALL reset the modal. The hook SHALL NOT register any Escape-key handler.

#### Scenario: Arrow keys resize from a focused grip

- **WHEN** a grip is focused and the user presses an arrow key
- **THEN** the corresponding dimension SHALL change by ±16px (±64px with Shift), clamped to the configured bounds

#### Scenario: Hook does not intercept Escape

- **WHEN** the modal is open and the user presses Escape
- **THEN** the hook SHALL NOT consume the event and the modal's existing close behavior SHALL apply unchanged

### Requirement: Pointer-Capture Safety

The hook SHALL call `setPointerCapture` inside a try/catch (for jsdom safety), clear its in-flight gesture reference on `pointerup`/`pointercancel`, and remove all window pointer listeners in effect cleanup. A backdrop click occurring within one tick after a drag or resize ends SHALL be suppressed.

#### Scenario: Listeners cleaned on unmount mid-drag

- **WHEN** a modal unmounts while a drag is in progress (e.g. project switch closes the modal)
- **THEN** the in-flight gesture reference SHALL be cleared and all window pointer listeners SHALL be removed

#### Scenario: Drag overshoot onto backdrop does not close

- **WHEN** a move or resize gesture ends with the pointer over the backdrop
- **THEN** the backdrop click that immediately follows SHALL be suppressed and the modal SHALL stay open
