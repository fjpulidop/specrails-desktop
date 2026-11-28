# live-board

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/LiveBoardDialog.tsx](components/LiveBoardDialog.tsx)
- [components/LiveBoardWindow.tsx](components/LiveBoardWindow.tsx)
- [context/LiveBoardContext.tsx](context/LiveBoardContext.tsx)

## Feature dependencies

- [delivery](../delivery/README.md)
- [inbox](../inbox/README.md)
- [jobs](../jobs/README.md)
- [loops](../loops/README.md)
- [missions](../missions/README.md)
- [providers](../providers/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

## Live board

One view of every run of every project: rails, loops, Intent sessions and queue jobs. A fixed
**Live board** entry in the left sidebar (`ArcSidebar` nav items), `⌘⇧B` (`Ctrl+Shift+B` off macOS),
the ⌘K action *Open live board* and the place `?live=1` open it over whatever place the person is on.

- **Merge preview.** A delivery card with a `mergePreview` shows one short chip (*2 conflicts*, *Overlaps 1 run*,
  *Base moved*; conflicts in the `blocked` look) whose tooltip, on hover and focus, holds the full sentence.
- **Projection, not a store.** Cards come from `GET /api/live-board`
  ([server module](../../../../server/modules/live-board/README.md)), which reads each registered project's
  own database and places every card (column, lane, order). The client keeps no cross-project cache. While
  the board is shown it refetches on open, on app focus, every 60 s while visible, after local midnight, and
  (debounced 500 ms, at most one request every 2 s) on the WS events that move a card: `rail.pr_state`, `rail.merge_preview`,
  `rail.job_*`, `loop.run_*`, `job.stuck`, `job.finalized`, `job_started`, `queue`, `phase`,
  `jira.outbox_changed`, `flow.state`, `agent_title`, `agent_pr_decision`, `runtime.continuation` and project
  added/removed ([`hooks/useLiveBoardData.ts`](hooks/useLiveBoardData.ts)). One request per refresh; nothing
  runs while the board is closed.
- **Two layouts**, chosen in the header and remembered per viewer (`localStorage`
  `specrails-desktop:live-board:layout`, in try/catch): **By status** (Needs you · In progress · Done today) and
  **By mission** (one lane per mission, most urgent first, "Not from a mission" last). The
  server's order is kept: filters (project, kind, engine; component state, not a place) only hide cards and
  never reorder columns or lanes.
- **Needs you is the inbox.** One column holds every inbox item, reviews included (each card keeps its own
  run-state glyph; the column heading wears the inbox's neutral mark, not a state glyph). Those cards carry the
  inbox item itself (`attention`, read with `readInboxSnapshot`); the per-viewer Snooze / Done of the inbox hides
  them in layout A too (`isDismissed`), so the column count is the inbox count. **Open inbox** in the column header
  replaces the `?live=1` entry with `?inbox=1` (from the board's window it is forwarded as `{ action: 'inbox' }`).
  In layout B a mission shows every run it launched, a dismissed item included. An older server's `decide` column is
  read as `needs`.
- **Header counts are the columns' counts** (`countVisible`): *N need you · N in progress*, a paused run counted
  where it sits. A paused run always has the paused look (`loopRunRunState`), never the question look; only an inbox
  question item reads needs-input.
- **Said once.** A card names its project only when the board spans several projects (a lane only when it does);
  a question shown in its box is not repeated in the phrase line; an inbox item that is not a run is titled as the
  inbox titles it (`useInboxItemTextOf`).
- **State look** goes through the run-state vocabulary only ([`lib/live-board-run-state.ts`](lib/live-board-run-state.ts)):
  the server sends the domain status and the card maps it with the domain's own mapper (jobs, loops
  (`loopRunRunState`), deliveries; an inbox item by `inboxKindRunState`). Intent is a leaf feature nothing may
  import, so an Intent session reads through the missions extension seam (`MissionExtensions.runStateOf`, which
  the Intent bridge fills with `intentRunStateOf`; the board window mounts the same extensions). The phrase is the state's
  name plus the current step (`humanizeStepId`, the mission run strip's); an inbox item reads like its inbox
  row (`useInboxItemText`).
- **Actions reuse existing handlers** ([`context/LiveBoardContext.tsx`](context/LiveBoardContext.tsx)): an
  inbox item runs `useInbox().runPrimary` (Answer, Open review, Resume, Retry, Raise limit, with the
  inbox's project switching and per-run cap dialog); a review-ready card without one opens the review place
  (`inboxTarget`); **Open** opens the mission that launched the run (the command palette's opener:
  `useOpenMission` in Mission mode, the floating panel in Board mode), else the run detail (`?job=` /
  `/jobs/:id`, switching project one frame after the switch like the inbox). Opening something replaces the
  `?live=1` entry in place, so Back returns to where the person was before the board; Resume and Retry stay
  on the board.
- **Its own window** (desktop app, always; like Settings and job detail): sidebar, palette, ⌘⇧B and a `?live=1`
  entry all open or focus the `live-board` native surface (⌘⇧B shows or hides it; the in-page dialog is the
  browser's and the fallback when the window cannot open; `surface_windows.rs`, singleton, no
  params). The window reads the board itself. A run and a review open over the board, in the window
  (`boardWindowRoute`: Job detail and the review packet as in-window modals, the window's own project
  following the card): following work and deciding on one card never takes the person away from the
  board. A mission, and the inbox actions that are not "open this run / review" (resume, retry, raise a
  cap, resume a chain), are forwarded to the main window as a surface result
  (`{ action: 'primary' | 'open', card }`); the host brings the main window forward
  (`focus_opener_on_result`) and the board stays open behind it (it is not kept above its opener).
  There is no "open in window" button: the window is the board in the desktop app.

Run the adjacent tests with `npm run test --prefix client -- src/features/live-board`.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
