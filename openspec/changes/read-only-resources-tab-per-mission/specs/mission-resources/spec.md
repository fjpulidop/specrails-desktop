# Spec Delta

## Purpose

Expose resource measurements and retained activity history from mission chat so users can inspect live load and completed activity without controlling processes.

## ADDED Requirements

### Requirement: Mission chat exposes read-only resource inspection
A mission with a project context SHALL expose Resources beside Processes as a non-modal popover opened by mouse hover, keyboard focus or click. Resources SHALL show CPU, memory and process totals and per-root measurements, ordered by descending memory, without stop, kill, delete, cleanup or manual refresh controls. Resource labels SHALL be available in the application's eight locales.

#### Scenario: Open Resources
- **WHEN** the user hovers, focuses or clicks Resources for an existing mission with a project context
- **THEN** the Resources popover SHALL open without blocking interaction with the composer
- **AND** the panel SHALL expose measurement information and an optional disk scan control, with no destructive process controls

#### Scenario: Pointer moves to the panel
- **WHEN** the pointer leaves the trigger and enters the popover before the close delay
- **THEN** the popover SHALL remain open
- **AND** leaving both surfaces without focus inside SHALL close it after a short delay

#### Scenario: Dismiss without trapping focus
- **WHEN** the user presses Escape or interacts with a pointer outside the trigger and panel
- **THEN** the popover SHALL close

#### Scenario: Reverse keyboard traversal
- **WHEN** the user presses Shift+Tab from a panel control and then from its trigger
- **THEN** focus SHALL return through the trigger to the preceding control
- **AND** the composer's tier shortcut SHALL not consume those Tab events

#### Scenario: Keyboard access to panel controls
- **WHEN** keyboard focus reaches the trigger and the user presses forward Tab while the panel is open
- **THEN** focus SHALL move to the first available panel control
- **AND** the panel SHALL remain open while focus is inside
- **AND** moving focus outside both trigger and panel SHALL close the popover

### Requirement: Resource snapshots measure selected process trees
The resources endpoint SHALL return entries and CPU, memory and process-count totals for provider roots, registered background roots scoped to the requested project/chat, and roots whose command lines reference the mission worktree. Descendants SHALL be attributed once per snapshot, under the first claiming root. A selected root missing from the process table SHALL report not running and zero load. Worktree matches SHALL respect leading argument and trailing path boundaries.

#### Scenario: Overlapping and unrelated trees
- **WHEN** a registered background root is a descendant of an agent root and another process belongs to neither tree
- **THEN** the descendant SHALL count only under the first root
- **AND** the unrelated process SHALL contribute nothing to the totals

#### Scenario: Worktree activity
- **WHEN** a process command references the mission worktree and its parent is not a matching root
- **THEN** the process SHALL appear as mission activity with its descendants
- **AND** a similarly named worktree with a longer path segment SHALL not match

#### Scenario: Embedded worktree lookalikes
- **WHEN** the selected worktree is /w/ticket-1 and an otherwise unrelated process command references /archive/w/ticket-1/script.js, --cwd=/archive/w/ticket-1 or a quoted prefix/w/ticket-1/script.js
- **THEN** that process SHALL not be selected as mission activity
- **AND** neither it nor its descendants SHALL contribute to mission totals
- **AND** the same leading-boundary check SHALL apply to normalized Windows paths

#### Scenario: Valid worktree arguments
- **WHEN** a command references the worktree at the start of the command, after whitespace or quotes, or as an argument assignment such as --cwd=/w/ticket-1 or --cwd="/w/ticket-1"
- **THEN** that valid reference SHALL select the process as mission activity
- **AND** an earlier embedded lookalike in the same command SHALL not prevent a later valid reference from matching

#### Scenario: Core missions share a host
- **WHEN** two missions run provider processes under the same Core host
- **THEN** each mission SHALL select only process roots whose command lines match its own session capability-file marker
- **AND** the shared host, the other mission's roots and capability filenames merely extending that marker SHALL not be selected
- **AND** a table containing only the shared host SHALL yield no Core provider root

#### Scenario: Desktop mission is requested through another project
- **WHEN** a desktop mission pinned to project p1 is requested through project p2
- **THEN** live entries and totals SHALL be empty and zero, and the worktree SHALL be absent
- **AND** after repinning to p2 those live measurements SHALL move to p2
- **AND** retained history SHALL remain in the project database where it was recorded

#### Scenario: Selected root exits
- **WHEN** a selected root PID is absent from the sampled table
- **THEN** its entry SHALL report not running with zero processes, CPU and memory

### Requirement: Platform sampling reports available measurements
Process measurement SHALL support macOS/Linux and Windows. CPU SHALL be a percentage of one core and memory SHALL be bytes. Windows CPU SHALL be derived from cumulative-time deltas, with zero CPU for a new baseline, regressed CPU time or zero elapsed time. Failed process-table reads SHALL produce an unavailable-metering response rather than fabricated process usage.

#### Scenario: Windows baseline and later sample
- **WHEN** a Windows process is first measured and then measured again with 500 ms more CPU over 1000 ms elapsed
- **THEN** its first CPU measurement SHALL be zero and its later measurement SHALL be 50 percent

#### Scenario: Windows path and query handling
- **WHEN** Windows command lines use different path case or slash direction
- **THEN** worktree matching SHALL normalize those differences
- **AND** concurrent Windows reads SHALL share an in-flight scan and reuse results younger than 500 ms

#### Scenario: Metering is unavailable
- **WHEN** the process-table reader fails
- **THEN** the endpoint SHALL set supported to false with empty entries and zero totals
- **AND** the panel SHALL explain that resource metering is unavailable

### Requirement: Open resource views refresh within their mission scope
The client SHALL fetch resources on opening and every three seconds while open. All refreshes, including those following a disk scan, SHALL belong to the open view's cancellation lifecycle. Closing or unmounting SHALL stop polling, cancel pending refreshes and prevent further refresh requests while closed or unmounted. Late success or failure results and responses from a previously selected project or chat SHALL not update the view.

#### Scenario: Switch mission during a request
- **WHEN** a request for mission A completes after the selection changes to mission B
- **THEN** A's snapshot SHALL not replace B's displayed resources

#### Scenario: Reopen resources
- **WHEN** the user opens Resources
- **THEN** the client SHALL fetch a current snapshot without requiring a Refresh button

#### Scenario: Close or unmount during a request
- **WHEN** the resource view closes or its owner unmounts while a request is pending
- **THEN** its request signal SHALL be aborted and polling SHALL stop
- **AND** a delayed response after close SHALL not populate the view

#### Scenario: Close or unmount during a post-scan refresh
- **WHEN** a disk-scan callback starts resource refreshes and Resources closes or its owner unmounts before they settle
- **THEN** all pending resource refresh requests SHALL have their cancellation signals aborted
- **AND** late successful snapshots and failed responses SHALL leave the retained snapshot and error unchanged

#### Scenario: Disk-scan callback arrives after close or unmount
- **WHEN** a retained disk-scan completion callback attempts to refresh resources while the view is closed or unmounted
- **THEN** no resource fetch SHALL start
- **AND** no polling SHALL resume

#### Scenario: Request fails and polling recovers
- **WHEN** a resource fetch fails and a subsequent three-second poll succeeds
- **THEN** the client SHALL expose the failure for the current scope
- **AND** the successful snapshot SHALL clear the error and populate that scope

### Requirement: Worktree disk measurement is explicit and asynchronous
A mission worktree SHALL initially show not scanned. A scan request SHALL return asynchronously with scan state; repeated requests while scanning SHALL share that scan. The view SHALL show scanning, measured bytes or failure and allow rescan after completion or failure. Missions without a worktree SHALL have no disk row and scan requests SHALL return 404.

#### Scenario: Scan a worktree
- **WHEN** the user requests a worktree scan
- **THEN** the endpoint SHALL respond with HTTP 202 without waiting for disk traversal
- **AND** later resource reads SHALL expose the result cached for that project and chat

#### Scenario: Windows disk traversal
- **WHEN** disk usage is measured on Windows
- **THEN** regular file sizes SHALL be summed recursively without following symlinks

#### Scenario: Pending scan fails and is retried
- **WHEN** repeated scan requests target the same project/chat while traversal is pending
- **THEN** the same scanning state SHALL be returned with only one traversal
- **AND** rejection SHALL expose a failed state
- **AND** a subsequent scan SHALL start a new traversal and replace the failure with measured bytes when it succeeds
- **AND** another project's disk cache SHALL remain not scanned

### Requirement: Server recording persists bounded mission history
Each open project SHALL record totals every three seconds independently of popover visibility for active local conversations and desktop/Core turns pinned there. After observing live processes, recording SHALL continue to one closing zero sample; idle zeros SHALL add nothing. History SHALL survive database reopening, retain the newest 600 points per mission and return the newest 300 oldest first.

#### Scenario: Popover remains closed during a turn
- **WHEN** a pinned desktop mission or local conversation owns processes during an active turn
- **THEN** the project's recorder SHALL persist samples even with Resources closed
- **AND** another project's recorder SHALL not collect that desktop mission based on its pin

#### Scenario: Activity ends
- **WHEN** a recorded mission's processes reach zero after its turn ends
- **THEN** one closing zero point SHALL be stored
- **AND** further idle ticks SHALL not fill history with zeros

#### Scenario: Restart and bounded history
- **WHEN** the database reopens after samples were saved
- **THEN** its retained mission samples SHALL remain available
- **AND** new samples beyond the retention limit SHALL remove only that mission's oldest points

#### Scenario: Repinning during a draining measurement
- **WHEN** a mission moves from p1 to p2 while p1 awaits its process-table measurement
- **THEN** p1 SHALL recheck ownership after the read and discard that measurement
- **AND** p1 SHALL stop draining that mission without adding a sample
- **AND** its previously retained history SHALL remain

### Requirement: Resource history remains readable after activity ends
For a supported snapshot without live processes, the Resources panel SHALL display the last active totals when retained history has activity, with a finished-time indicator. With at least two samples it SHALL show separate CPU and memory charts with titles, peaks, time range and time/value tooltips. A mission without retained activity SHALL show the empty state.

#### Scenario: Inspect a completed mission
- **WHEN** history contains active samples followed by zero load
- **THEN** the displayed summary SHALL retain the last active figures
- **AND** charts SHALL show the retained CPU/memory history and its peaks instead of replacing the summary with zeros

#### Scenario: Read each retained chart sample
- **WHEN** a completed mission has retained active samples followed by a zero sample
- **THEN** the CPU chart SHALL plot those CPU percentages and the memory chart SHALL plot those memory byte measurements in sample order
- **AND** the displayed range SHALL identify the first and last retained sample times
- **AND** focusing either chart and moving through its samples with ArrowRight SHALL display a tooltip naming the metric, that sample's local time and its formatted value
- **AND** CPU values SHALL include percent units and memory values SHALL use the displayed byte-size units, including zero values

### Requirement: Resource history follows permanent mission deletion
Trash and restoration SHALL preserve history without age-based expiry for existing missions. Permanent deletion, including expired-trash purge, SHALL request cleanup across open projects. On project open, history for IDs absent from both local chats and desktop missions SHALL be pruned; moved missions and restorable trash SHALL survive. An existence lookup failure SHALL leave the sweep's samples intact.

#### Scenario: Trash, restore and permanently delete
- **WHEN** a mission is soft-deleted and restored
- **THEN** its history SHALL remain
- **AND** permanently deleting it SHALL remove its samples from open projects without removing other missions' samples

#### Scenario: Closed project recovers cleanup
- **WHEN** a project opens with history for a permanently deleted mission
- **THEN** the orphan history SHALL be removed before recording starts
- **AND** history for an existing mission pinned elsewhere or in trash SHALL remain

#### Scenario: Cleanup failure
- **WHEN** an open project's cleanup callback fails after permanent deletion
- **THEN** the failure SHALL be logged without undoing mission deletion
- **AND** the orphan SHALL be eligible for cleanup on project reopen

### Requirement: Recorder lifecycle prevents stale writes
Recorder ticks SHALL not overlap. Measurement failures SHALL not terminate recording of other candidates. Stopping a project recorder SHALL be idempotent and SHALL prevent pending measurements from touching the history store. Conversation existence SHALL be rechecked after asynchronous measurement to prevent recreating deleted history.

#### Scenario: Deletion during measurement
- **WHEN** a mission is permanently deleted while measurement is pending
- **THEN** completion of that measurement SHALL not recreate its history

#### Scenario: Project stops during measurement
- **WHEN** the recorder stops before a pending measurement finishes
- **THEN** it SHALL neither read nor append history after that measurement completes
