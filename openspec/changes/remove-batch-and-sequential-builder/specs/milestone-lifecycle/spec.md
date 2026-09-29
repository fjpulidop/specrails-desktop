## MODIFIED Requirements

### Requirement: Launch Milestone 1 CTA
After a successful commit, the Builder's final screen SHALL offer "Launch Milestone 1": it SHALL call the server milestone launch route (`POST /:projectId/blueprint/milestones/1/launch { autoAdvance }`) with the user's stored auto-continue preference (ON by default), which orders the M1-labeled `todo` tickets by their dependencies, puts ONE spec on each rail, launches through the ordinary rails launch path with the Implement factory loop (worktree isolation + ask-first PR), and chains each later spec on the previous spec's delivered branch server-side. There SHALL be no Sequential/Parallel choice. The client SHALL keep no launch plan in browser storage. After a launch the done screen SHALL show the live milestone progress card and keep "Open the project" as the exit. The CTA SHALL be skippable; the same action SHALL be available later from the sidebar entry.

#### Scenario: Launch from the done screen
- **WHEN** the user activates "Launch Milestone 1" with 3 M1 tickets
- **THEN** one rail launches carrying 1 spec, the chain row holds the remaining two specs, and the done screen shows M1 as running with that rail listed

#### Scenario: Auto-continue can be turned off
- **WHEN** the user turns the done screen's auto-continue switch off and launches
- **THEN** the chain stops at a checkpoint after each delivered rail

#### Scenario: Skippable
- **WHEN** the user closes the final screen without launching
- **THEN** the project remains fully usable and the CTA reappears in the sidebar entry

### Requirement: Sidebar re-entry
A sidebar entry SHALL appear (board and mission modes, inside the active project only) when the active project's workspace contains `blueprint.json`. It SHALL render each milestone from the server-derived live progress model (`GET /:projectId/blueprint` `progress` + the `blueprint.milestone_progress` broadcast): a segmented bar (done / in review / in progress / failed / pending), counts that distinguish delivered from done, the milestone's rails with state and a Review action, and the launch chain state — never a `done`-only count and never a board fetch on open. It SHALL expose "Launch Milestone 1" (while M1 has launchable tickets and no active chain) with the auto-continue switch and a one-spec-per-rail hint (no Sequential | Parallel toggle), chain Resume / Cancel when applicable, and "Generate M<next>".

#### Scenario: Entry visibility
- **WHEN** the active project has no `blueprint.json`
- **THEN** no Builder sidebar entry renders

#### Scenario: Delivered milestone reads honestly
- **WHEN** all 8 M1 tickets are `on_review`
- **THEN** the entry shows the in-review segment filling the bar and reads the milestone as delivered / awaiting review, not `0/8 done`

#### Scenario: Live update without reopening
- **WHEN** the flyout is open and a chunk run settles
- **THEN** the M1 bar and rail row update from the broadcast without any fetch triggered by the flyout

#### Scenario: Board-derived progress
- **WHEN** the user manually moves an M1 ticket to `done`
- **THEN** the sidebar milestone progress reflects it on the next progress broadcast without any blueprint write
