# project-terminal-panel Specification

## Purpose
Define per-project terminal panel state, persistence, shortcuts, resizing, and lifecycle controls.

## Requirements

### Requirement: Per-project bottom panel visibility states
Each project SHALL have an independent bottom terminal panel with three mutually exclusive visibility states: **hidden**, **restored**, and **maximized**. The state MUST be tracked per `projectId` so switching projects does not affect another project's panel state.

#### Scenario: Panel defaults to hidden on first project open
- **WHEN** a project is opened for the first time in a session and no persisted state exists
- **THEN** the panel is in **hidden** state and no terminal UI is visible in the project viewport
- **AND** a chevron-up icon (`△`) is visible in the StatusBar at the far right

#### Scenario: Opening panel restores previous height
- **WHEN** the user clicks the StatusBar chevron on a hidden panel
- **THEN** the panel transitions to **restored** state using the user's last dragged height (default 320px if unset)
- **AND** the active terminal receives keyboard focus

#### Scenario: Minimizing panel preserves PTYs
- **WHEN** the user clicks the top-bar chevron (`▽`) on a restored or maximized panel
- **THEN** the panel transitions to **hidden** state
- **AND** no `kill` is sent to any PTY
- **AND** all terminal sessions remain in the server-side registry

#### Scenario: Maximize fills viewport above StatusBar
- **WHEN** the user clicks the maximize button (`▲`)
- **THEN** the panel transitions to **maximized** state, occupying the full project viewport height minus the StatusBar
- **AND** the user's dragged `userHeight` is preserved unchanged

#### Scenario: Restore returns to user height
- **WHEN** the user clicks the restore button on a maximized panel
- **THEN** the panel returns to **restored** state with the exact `userHeight` recorded before maximize

### Requirement: Panel persistence across sessions
The panel's visibility state and `userHeight` SHALL be persisted per project in client-side storage. Persistence MUST NOT attempt to store terminal session IDs or scrollback content, because terminals die with the server process.

#### Scenario: Panel state survives page reload
- **WHEN** the user has panel open with height 420px on project X, then reloads the page
- **THEN** on next visit to project X the panel opens at 420px with zero terminals listed

#### Scenario: Per-project state isolation
- **WHEN** the user sets project A panel to maximized and switches to project B with hidden panel
- **THEN** project B shows hidden state regardless of project A's state
- **AND** switching back to project A restores the maximized state

### Requirement: Cmd+J keyboard shortcut
The panel SHALL be toggleable via `Cmd+J` on macOS and `Ctrl+J` on other platforms. Opening via shortcut MUST focus the active terminal. The shortcut MUST be scoped to the active project view and MUST NOT fire when modal dialogs or inputs are focused.

#### Scenario: Shortcut opens and focuses panel
- **WHEN** the user presses `Cmd+J` while the panel is hidden
- **THEN** the panel opens to the user's last height
- **AND** the active terminal's xterm instance receives focus

#### Scenario: Shortcut closes panel
- **WHEN** the user presses `Cmd+J` while the panel is restored or maximized
- **THEN** the panel transitions to hidden without killing any PTY

#### Scenario: Shortcut ignored when modal is open
- **WHEN** a modal dialog is open and the user presses `Cmd+J`
- **THEN** the panel state does not change

### Requirement: Pixel-perfect chevron alignment
The collapse chevron in the panel top-bar (visible when panel is open) and the expand chevron in the StatusBar (visible when panel is hidden) SHALL occupy the same viewport screen coordinates (within 1px) to produce an illusion of toggle continuity. Both toolbars MUST have equal height and the chevron MUST be positioned at identical `right` offset.

#### Scenario: Chevron position stable across toggle
- **WHEN** the user toggles the panel open then closed repeatedly
- **THEN** the chevron's center pixel position on the screen is identical in both states (within 1px tolerance for subpixel rendering)

### Requirement: Manual height resize
The panel SHALL have a drag handle along its top edge allowing the user to resize it between a minimum of 120px and a maximum of `viewportHeight - statusBarHeight - 40px`. The dragged value updates `userHeight` and persists.

#### Scenario: Drag resize updates live
- **WHEN** the user drags the top handle from 320px to 500px
- **THEN** the panel renders at 500px live during drag (throttled with rAF)
- **AND** `userHeight` is set to 500 on drag end

#### Scenario: Drag constrained by min/max
- **WHEN** the user attempts to drag below 120px or above the maximum
- **THEN** the panel height clamps to the boundary without visual jitter

### Requirement: Terminal lifecycle actions
The panel SHALL expose actions to create, rename, kill, and switch between terminals. The maximum number of concurrent terminals per project MUST be 10; the create button MUST be disabled and show a tooltip when the limit is reached.

#### Scenario: Create new terminal
- **WHEN** the user clicks the `+` button in the top-bar
- **THEN** a new PTY session is requested from the server with `cwd = project.path` and `shell = process.env.SHELL`
- **AND** the new terminal becomes the active terminal
- **AND** the sidebar shows an entry for it with auto-generated name (`zsh`, `zsh (2)`, etc.)

#### Scenario: Create button disabled at limit
- **WHEN** 10 terminals exist for the current project
- **THEN** the `+` button is disabled with tooltip "Max 10 terminals per project"

#### Scenario: Switch active terminal via sidebar click
- **WHEN** the user clicks a terminal entry in the sidebar
- **THEN** that terminal becomes active and receives focus
- **AND** the previous active terminal's DOM stays mounted but hidden (no scrollback loss, no reinit)

#### Scenario: Rename terminal
- **WHEN** the user double-clicks a sidebar entry and types a new name
- **THEN** on Enter the terminal's `name` is updated both client-side and on the server
- **AND** Escape cancels without changes

#### Scenario: Kill individual terminal direct
- **WHEN** the user clicks the close button on a sidebar entry or the trash icon in the top-bar
- **THEN** the PTY is killed immediately with no confirmation, even if a process is running
- **AND** the session is removed from both client and server state
- **AND** if it was the active terminal, focus moves to the next terminal in the list

#### Scenario: Empty state after last close
- **WHEN** the user closes the last terminal in an open panel
- **THEN** the panel remains open showing an empty state with a "Click + to create a terminal" placeholder

### Requirement: Persistent xterm DOM per terminal
Each terminal's xterm.js instance SHALL remain mounted in the DOM from creation until explicit kill. Switching projects, switching active terminal, or toggling panel visibility MUST NOT unmount the xterm container or call its `dispose()` method. Inactive terminals MUST be hidden via CSS `display: none` only. Render-mode changes (canvas ↔ WebGL) and shell-integration toggle changes MUST NOT cause the xterm instance to dispose; instead, the policy described in `terminal-settings` (next-spawn application) applies.

#### Scenario: No reinit on project switch
- **WHEN** the user has terminal T1 running in project A with output history, switches to project B, then back to A
- **THEN** T1's xterm shows the same scrollback and cursor position as before the switch
- **AND** no new `Terminal()` constructor call occurred for T1

#### Scenario: No glitch on active switch
- **WHEN** the user switches from terminal T1 to T2 within the same project and back
- **THEN** T1's rendered content is identical, including cursor blink position

#### Scenario: Render mode change does not dispose live session
- **WHEN** the user toggles `renderMode` from `auto` to `canvas` while session T1 is alive
- **THEN** T1's `Terminal` instance is not disposed and continues operating in its boot-time renderer
- **AND** the next newly-created session uses canvas

### Requirement: Auto-attach on panel open with empty terminal list
When the panel is opened (by any means) and the project has zero existing terminals, the panel SHALL NOT auto-create a terminal. The user MUST explicitly click `+` or press `Cmd+J` a second time (no — explicit click only).

#### Scenario: No auto-create on first open
- **WHEN** the user opens a never-used panel
- **THEN** the panel is open but empty, with the placeholder visible
- **AND** no PTY spawn request is sent to the server

### Requirement: Search overlay above terminal viewport
The panel SHALL render a closable search overlay above the active terminal viewport when invoked via `Cmd+F` (macOS) / `Ctrl+F` (others) while the terminal is focused. The overlay MUST surface controls for next, previous, case-sensitivity, regex, and whole-word toggles, plus a match-count badge. The overlay MUST stack above the terminal without resizing the PTY.

#### Scenario: Overlay renders without triggering PTY resize
- **WHEN** the user presses `Cmd+F` while a terminal session is active
- **THEN** the overlay appears anchored top-right of the viewport
- **AND** the underlying terminal cols/rows are unchanged
- **AND** no `resize` control frame is sent

#### Scenario: Match count badge updates as user types
- **WHEN** the user types into the overlay's search input
- **THEN** a "X of Y" badge updates with the count of matches in the visible scrollback buffer

### Requirement: Right-click context menu in viewport
The panel SHALL display a context menu when the user right-clicks inside the active terminal viewport. The menu items MUST be: Copy, Paste, Select All, Clear, Search, Save scrollback to file, and "Open this directory" (only when shell integration has reported a CWD for the session). The menu MUST close on outside-click and on Escape and MUST NOT cover the StatusBar.

#### Scenario: Menu position clamped to viewport bounds
- **WHEN** the user right-clicks near the bottom-right corner of the viewport
- **THEN** the menu appears flipped (anchored above-and-left of the click point) so it does not overflow the panel bounds

#### Scenario: Open this directory hidden when no CWD known
- **WHEN** the active session has no CWD mark recorded
- **THEN** the "Open this directory" item is omitted from the menu

### Requirement: Prompt navigation gutter
When the active session has any prompt mark recorded for its scrollback, the panel SHALL render a 4-pixel-wide left-margin gutter inside the terminal viewport drawing one marker per prompt mark visible in the buffer. Each marker MUST be coloured by the exit code of its corresponding command (neutral for success, error theme colour for non-zero exit). The gutter MUST be a passive overlay (no input absorption) and MUST scroll with the buffer.

#### Scenario: Gutter draws one mark per prompt
- **WHEN** the buffer contains 5 commands all completed
- **THEN** 5 gutter markers are drawn at the corresponding row positions, scrolling in sync with the terminal

#### Scenario: Gutter hidden when no marks
- **WHEN** the active session has zero prompt marks recorded (shell integration disabled or shim never bootstrapped)
- **THEN** the gutter is not rendered and the viewport occupies its full width

### Requirement: Drag-drop visual highlight
When a file is being dragged over the active terminal viewport, the panel SHALL render a soft visual highlight (outline + low-opacity overlay) around the viewport bounds. The highlight MUST appear regardless of whether the runtime is Tauri or browser. In a non-Tauri runtime, releasing the drag MUST dismiss the highlight without inserting any text.

#### Scenario: Highlight on dragover
- **WHEN** an external file is dragged over the active viewport
- **THEN** the viewport border is rendered with the configured accent colour and a subtle internal overlay
- **AND** the highlight is removed on `dragleave` or `drop`

### Requirement: Per-session font-size hot-reload
Toggling the active session's font size via `Cmd+=` / `Cmd+-` / `Cmd+0` SHALL immediately re-render the live xterm at the new size and persist the change to the per-project settings override. Inactive sessions for the same project MUST also re-render on the next adoption into the viewport (so `<TerminalViewport>` mounts at the new size).

#### Scenario: Cmd+= rerenders without scrollback loss
- **WHEN** a session has visible output and the user presses `Cmd+=`
- **THEN** the rendered grid uses the new font size on the very next animation frame
- **AND** no PTY `resize` is sent until the trailing-debounced ResizeObserver fires
- **AND** scrollback content is preserved

### Requirement: Resize-debounce settles in one final frame
The viewport SHALL coalesce ResizeObserver-driven `fit.fit()` invocations through a trailing 120ms debounce. When an ancestor sidebar's CSS transition ends, the viewport SHALL refit synchronously. The cumulative effect MUST be at most one PTY `resize` message per stable geometry transition.

#### Scenario: Sidebar collapse produces single resize
- **WHEN** the user collapses a sidebar that animates over 200ms
- **THEN** during the animation the panel content does not visibly jitter
- **AND** exactly one `resize` control frame is sent on the terminal WS once the animation settles
