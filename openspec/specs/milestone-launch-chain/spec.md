# milestone-launch-chain Specification

## Purpose
TBD - created by archiving change premium-milestone-progress. Update Purpose after archive.

## Requirements

### Requirement: Milestone launch is a server-owned chain
`POST /:projectId/blueprint/milestones/:n/launch { autoAdvance? }` SHALL gather that milestone's `M<n>` `todo` tickets, order them by their dependencies (a stable topological order over `prerequisites` restricted to those tickets, ties broken by `execution_order` — unset last — and then id; a dependency cycle SHALL NOT block the milestone), put exactly ONE spec on each rail (rails named `M<n> · #<id>`, launched with mode `implement`), persist ONE `milestone_launch_chains` row (per-project SQLite, additive migration) and launch through the ordinary rails launch path so every existing launch guard applies unchanged. Launches SHALL always be sequential: only the first spec launches immediately. A request carrying the retired `mode: 'parallel'` SHALL be accepted and run sequentially; any other `mode` value SHALL be rejected with 400. At most one non-terminal chain SHALL exist per milestone; a second launch while one exists SHALL return 409 `chain_active` with the chain id. The route SHALL return 202 `{ chainId, mode: 'sequential', launched: [{ railIndex, ticketIds }], pending: number[][] }`. The client "Launch Milestone" actions (Builder done screen, sidebar flyout) SHALL call this route, SHALL NOT offer a Sequential/Parallel choice and SHALL NOT keep any launch plan in browser storage. Completed chain rows recorded with `mode = 'parallel'` before this change SHALL still render.

#### Scenario: Sequential launch starts one rail with one spec
- **WHEN** M1 has 3 `todo` tickets and the user launches M1
- **THEN** one rail carrying 1 spec launches, the chain row records `next_chunk = 1` with two pending one-spec chunks, and the response lists the launched rail and the pending chunks

#### Scenario: Dependencies decide the order
- **WHEN** M1 spec #1 lists spec #2 as a prerequisite
- **THEN** spec #2 launches before spec #1 regardless of their ids

#### Scenario: A parallel request runs sequentially
- **WHEN** an old client posts `mode: 'parallel'`
- **THEN** the route returns 202 with `mode: 'sequential'` and only the first spec launches

#### Scenario: Guard rejection is typed
- **WHEN** the first spec's launch is rejected by an existing guard (for example `tickets_in_flight`)
- **THEN** the route returns that guard's status and error unchanged and no chain row remains active

#### Scenario: Duplicate launch refused
- **WHEN** a chain for M1 is `waiting` and the user launches M1 again
- **THEN** the route returns 409 `chain_active` with the chain id and launches nothing

### Requirement: The chain advances on run settlement and survives restarts
The chain SHALL advance from the server's delivery-settlement chokepoint (the `rail.pr_state` broadcast for the in-flight chunk's delivery; the engine's `onLoopRunFinished` only records the outcome and settles delivery-less chunks), never by client polling. When the current chunk's delivery settles successfully the chain SHALL set `head_branch` to the delivered branch and — when `autoAdvance` is on — launch the next chunk; a `no_changes` outcome keeps the previous head; a failed, stalled or stopped outcome SHALL move the chain to `paused` with a `pause_reason` (`chunk_failed | chunk_stalled | chunk_stopped | launch_rejected:<error> | head_missing | head_discarded | run_lost`). After the last chunk settles the chain SHALL be `completed`. Every transition SHALL be compare-and-set so a run is never advanced twice. On server startup, chains whose current runs are no longer live SHALL be re-evaluated from their delivery rows (settled → advance, missing → `paused` with `run_lost`) after orphan-run recovery and only once the HTTP server is listening.

#### Scenario: Chunk 2 launches when chunk 1 settles
- **WHEN** rail `M1 · 1` settles `success` with delivery branch `feat/1-batch-3-tickets` on a chain with `autoAdvance` on
- **THEN** the chain records that branch as `head_branch` and launches `M1 · 2` without any client involvement

### Requirement: Wave checkpoints
A sequential chain SHALL carry an `autoAdvance` flag (launch body `autoAdvance`, default true when omitted; the UI sends the user's stored preference whose default is ON). When `autoAdvance` is off and the current chunk's delivery settles successfully, the chain SHALL NOT launch the next chunk: it SHALL record the head, move to the non-terminal status `awaiting_approval`, broadcast `milestone.chain_changed`, and wait. `POST …/chains/:id/resume` SHALL launch the next chunk from `awaiting_approval` as well as from `paused`; `PATCH …/chains/:id { autoAdvance }` SHALL update the flag at any time and, when turning it on while `awaiting_approval`, SHALL launch the next chunk immediately. `awaiting_approval` SHALL count as active for the one-active-chain rule and SHALL be cancellable. The surfaces SHALL present the checkpoint as a healthy decision point ("Rail k delivered — launch the next rail?") with **Launch next rail**, an **auto-continue** toggle and **Cancel**, never as a failure; the app toast for a checkpoint SHALL offer Launch next and Auto-continue. A failure SHALL always pause the chain regardless of the flag.

#### Scenario: Auto-continue is on by default
- **WHEN** a user who never changed the preference launches M1 and rail `M1 · #1` settles `success`
- **THEN** the next spec launches automatically, stacked on the delivered branch

#### Scenario: Checkpoint after a delivered wave
- **WHEN** rail `M1 · #1` settles `success` on a chain launched with `autoAdvance: false`
- **THEN** the chain is `awaiting_approval` with `head_branch` recorded, no rail launches, and the chain row offers Launch next rail

#### Scenario: Launch next from the checkpoint
- **WHEN** the user activates Launch next rail on an `awaiting_approval` chain
- **THEN** chunk 2 launches stacked on the recorded head and the chain returns to `running`

#### Scenario: Switching to auto-continue mid-chain
- **WHEN** the user turns auto-continue on while the chain is `awaiting_approval`
- **THEN** the next chunk launches immediately and every later successful wave advances without a checkpoint

#### Scenario: Failure still pauses
- **WHEN** a wave fails on a chain with `autoAdvance` off
- **THEN** the chain is `paused` with the failure reason, not `awaiting_approval`

#### Scenario: Failure pauses, never skips
- **WHEN** rail `M1 · #2` settles `failed`
- **THEN** the chain is `paused` with `pause_reason = 'chunk_failed'` and the next spec is not launched

#### Scenario: Restart mid-chain
- **WHEN** the server restarts while `M1 · #1` is running and the run is recovered as settled `success`
- **THEN** the chain advances to chunk 2 exactly once after the server is listening

### Requirement: Sequential chunks stack on the previous delivered branch
In `sequential` mode every chunk after the first SHALL launch with the chain's `head_branch` as its explicit base branch, so its worktree starts from the previous chunk's delivered work and its delivery row records that branch as `base_branch`. The rails launch route SHALL accept an optional `baseBranch` (validated as a branch name that resolves locally; 400 `invalid_base_branch` otherwise, 400 `base_branch_requires_isolation` when the launch would not take the isolated path) and thread it as the explicit integration-branch override. A PR created for such a delivery SHALL target that base branch (stacked). If the head branch no longer exists when a chunk is due, the chain SHALL pause with `head_missing`.

#### Scenario: Walking skeleton accumulates
- **WHEN** chunk 2 launches after chunk 1 delivered the scaffold on `feat/1-batch-3-tickets`
- **THEN** chunk 2's worktree contains the scaffold and its delivery row records `base_branch = 'feat/1-batch-3-tickets'`

#### Scenario: Stacked PR base
- **WHEN** the user creates the PR for chunk 2 on a GitHub-backed project
- **THEN** the PR's base is chunk 1's branch, not the integration branch

#### Scenario: Missing head pauses
- **WHEN** the user deleted `feat/1-batch-3-tickets` before chunk 2 was due
- **THEN** the chain pauses with `pause_reason = 'head_missing'` and launches nothing

### Requirement: Stacked deliveries converge on merge
After any delivery of a chain reaches `merged` (merge-local or poll-merge), the server SHALL check the chain's other non-terminal deliveries and transition to `merged` — through the same compare-and-set decision path, ticket effect (`done`) and Jira hook — every one whose delivered head commit is an ancestor of the integration branch. Deliveries whose head is not an ancestor SHALL be left untouched. The sweep SHALL be scoped to deliveries of the same chain.

#### Scenario: Accepting chunk 2 first merges chunk 1
- **WHEN** chunk 2 (stacked on chunk 1) is integrated locally before chunk 1 was decided
- **THEN** chunk 1's delivery transitions to `merged`, its tickets become `done`, and its worktree/branch are swept exactly as a direct merge would

#### Scenario: Unrelated on_review delivery is untouched
- **WHEN** a chunk from a different milestone chain is still `on_review`
- **THEN** the sweep does not transition it

### Requirement: Chain visibility and control
The chain SHALL be part of the milestone progress model (`chain: { id, mode, status, pauseReason, nextChunk, totalChunks, currentRailIndex, headBranch }`) and every transition SHALL trigger the progress broadcast. `POST /:projectId/blueprint/chains/:id/resume` SHALL relaunch the paused chunk from the current head (409 unless `paused`); `POST /:projectId/blueprint/chains/:id/cancel` SHALL mark the chain `cancelled` without killing in-flight runs (they remain ordinary rails). The surfaces SHALL render the chain row ("Sequential · rail k of n · waiting for rail k-1" / paused reason with Resume / Cancel) and toasts for chunk launched, paused (with a Resume action), delivered and completed; no toast SHALL describe an undelivered or unmerged milestone as complete. Discard on a delivery that a later chunk builds on SHALL show a "later rails build on this" note, and discarding the chain's current head SHALL pause the chain with `head_discarded`.

#### Scenario: Paused chain is resumable
- **WHEN** the user activates Resume on a chain paused with `chunk_failed`
- **THEN** the failed chunk relaunches from the current `head_branch` and the chain returns to `waiting`

#### Scenario: Cancel leaves rails alone
- **WHEN** the user cancels a chain while `M1 · 2` is running
- **THEN** the chain is `cancelled`, `M1 · 2` keeps running, and no further chunk launches

### Requirement: Chain rails respect the rail limit
Before creating a rail for the next spec, the chain SHALL reuse a free builder-owned rail — the retried chunk's previous rail, a rail already named for the spec, a rail this chain used, then any rail named `M<n>` or `M<n> · …` — where free means no undecided delivery, no active job or loop run, and not the in-flight rail of another active chain. A reused rail SHALL be renamed after its spec (best effort).

#### Scenario: A decided PR frees its rail
- **WHEN** spec #1's PR was merged and spec #2 is due
- **THEN** spec #2 launches on spec #1's rail, renamed `M1 · #2`, and no new rail is created

#### Scenario: Busy or undecided rails are never reused
- **WHEN** a builder rail is running or holds a PR awaiting a decision
- **THEN** the chain does not assign the next spec to it

### Requirement: Rail exhaustion pauses or refuses the chain
When no rail is free and the rails route refuses to create one with `rail_limit_reached` (MAX_RAILS 12), a later spec SHALL pause the chain with `pause_reason = 'rail_limit_reached'`, localized as "every rail holds a PR awaiting your decision — decide pending PRs to free a rail, then resume"; Resume SHALL retry the same spec. When the FIRST spec cannot get a rail, nothing SHALL launch, no chain SHALL remain active, and the route SHALL return a localized 409 `rail_limit_reached`.

#### Scenario: Limit reached mid-chain
- **WHEN** every rail holds undecided work and the next spec is due
- **THEN** the chain is `paused` with `rail_limit_reached`, and after the user decides a PR, Resume launches that same spec

#### Scenario: Limit reached on the first spec
- **WHEN** the user launches a milestone while no rail is free and 12 rails exist
- **THEN** the route returns 409 `rail_limit_reached`, nothing launches and the client shows the localized explanation

### Requirement: Chain creation timestamp compatibility
Chain snapshots in milestone.chain_changed and milestone progress payloads SHALL include createdAt from the existing chain creation timestamp as an ISO 8601 string. This addition SHALL require no migration. Clients SHALL accept historical payloads with missing or invalid createdAt, normalize that field to null, and retain all otherwise valid chain data.

#### Scenario: Snapshot preserves original start
- **WHEN** a chain created at 10:00 is updated at 10:38 and serialized
- **THEN** createdAt represents 10:00 and updatedAt represents 10:38 in both chain and progress snapshots

#### Scenario: Older payload remains readable
- **WHEN** an otherwise valid chain payload omits createdAt or supplies null, a non-string or an invalid date
- **THEN** the client retains the chain and treats its start timestamp as unavailable

### Requirement: Unified milestone notification content
The five existing milestone toasts SHALL share a localized title containing the available project name, milestone label and event text, plus a secondary status and available total elapsed time. Rail launches and checkpoints SHALL retain rail k of n; pauses SHALL retain their reason; delivery SHALL retain review-count context. Project names SHALL resolve client-side by message projectId from the existing project list.

#### Scenario: Rail launch identifies its project
- **WHEN** rail 4 of 8 launches for project specrails and milestone M1, 38 minutes after the chain began
- **THEN** the title reads the localized equivalent of “specrails · M1 — rail 4 of 8 launched” and the description reads “Running · 38m total”

#### Scenario: Checkpoint shares the layout
- **WHEN** rail 1 of 3 delivers and the chain waits for approval
- **THEN** the title contains project, M1 and the rail 1 of 3 checkpoint prompt, and the description contains awaiting-approval status and available total chain time

#### Scenario: Pause shares the layout
- **WHEN** a chain pauses for a known reason
- **THEN** the title contains its project, milestone and localized pause reason, and the secondary line contains Paused and available total chain time

#### Scenario: Delivery is distinct from completion
- **WHEN** a milestone becomes delivered with eight specs on review
- **THEN** its title identifies project, milestone and eight specs waiting for review, and its secondary status says delivered/awaiting review rather than completed

#### Scenario: Completion shares the layout
- **WHEN** every milestone spec is merged and the existing completion event arrives
- **THEN** the title identifies project, milestone and completion, and its secondary line uses the localized “Completed in” wording when elapsed is available

### Requirement: Static total milestone elapsed time
Elapsed SHALL be static at toast creation and measured from chain creation, including waiting and paused periods. Active, checkpoint and paused events SHALL use receipt time; delivered/completed SHALL use the associated snapshot updatedAt as end, never receipt time. Durations SHALL clamp below zero and truncate to seconds below 60 seconds, minutes below 60 minutes, and hours with zero-padded minutes thereafter. No live ticker SHALL be introduced.

#### Scenario: Compact duration boundaries
- **WHEN** elapsed is respectively 45 seconds, 38 minutes, 60 minutes and 125 minutes
- **THEN** the durations are respectively 45s, 38m, 1h 00m and 2h 05m

#### Scenario: Terminal elapsed ignores late receipt
- **WHEN** a chain starts at 10:00, its associated end snapshot says 12:05 and the delivered or completion toast is built at 13:00
- **THEN** its elapsed is 2h 05m and remains unchanged while the toast is visible

#### Scenario: Future start clamps
- **WHEN** the start is later than the applicable receipt or end timestamp
- **THEN** elapsed renders as 0s rather than a negative value

#### Scenario: Completion uses preceding progress
- **WHEN** a project-scoped progress message includes a chain and is followed by a completion event without a chain
- **THEN** the completion toast uses timing associated with that project's milestone, including when no chain-change message was observed

### Requirement: Notification context degrades safely
Missing or blank project names SHALL omit the project segment. Missing or invalid start timestamps SHALL omit elapsed. Delivered/completed events without a valid end SHALL omit elapsed instead of substituting now. Remaining content SHALL preserve meaningful existing event wording and status, without undefined, NaN, empty separators, or timing borrowed from another project or milestone.

#### Scenario: Historical chain without timing
- **WHEN** an event has neither a resolvable project name nor a valid chain start
- **THEN** the toast retains milestone/event wording and status, with no empty project or elapsed segment

#### Scenario: Completion without known chain
- **WHEN** a completion event arrives without any associated chain snapshot
- **THEN** completion still appears with available project and milestone content but no invented elapsed time

#### Scenario: Project identity survives switches
- **WHEN** the user views project B while receiving a milestone event for project A
- **THEN** the toast identifies project A and uses only project A's matching milestone timing

#### Scenario: Refreshed project name is used
- **WHEN** the existing project list renames project A before a later milestone event
- **THEN** that event uses the refreshed name without resetting notification transition bookkeeping

### Requirement: Notification lifecycle and actions remain stable
The change SHALL preserve all existing event-emission guards, toast id formats, durations, severity and action behavior. It SHALL NOT synthesize historical toasts from initial progress snapshots or add replay on reload/reconnect. Chain-launch, chain-checkpoint, chain-paused, milestone-delivered and milestone-completed id prefixes and existing suffixes SHALL remain unchanged.

#### Scenario: Existing actions remain operational
- **WHEN** checkpoint Launch next or Auto-continue, pause Resume, or delivered Review is activated
- **THEN** the existing project-specific request or review navigation occurs with unchanged success/error handling and toast id reuse

#### Scenario: Default and explicit lifetimes stay stable
- **WHEN** the five existing notifications are formatted
- **THEN** launch keeps its default lifetime, checkpoint keeps 60000ms, pause and delivery keep 30000ms, and completion keeps 15000ms

#### Scenario: Initial progress is inert
- **WHEN** the app reloads and receives initial progress showing an already delivered milestone
- **THEN** the hook records its state and timing without showing a historical delivered notification

#### Scenario: Repeated frames retain existing guards
- **WHEN** the same launch, checkpoint, pause or delivered frame is received again
- **THEN** existing transition guards and stable ids continue preventing duplicate notifications, without new content-driven triggers

### Requirement: Milestone notification localization parity
All new milestone notification layout, event, status and elapsed text SHALL use milestoneProgress.toast translation keys. English and Spanish SHALL contain matching keys and localized copy. The other six shipped locales SHALL retain matching key trees and localized templates; existing shared action/reason keys SHALL remain available.

#### Scenario: English and Spanish rendering
- **WHEN** each of the five events is formatted in English and Spanish with known context
- **THEN** titles, status, elapsed wording and existing actions use the selected language without raw keys or untranslated new labels

#### Scenario: Shipped locale key parity
- **WHEN** builder translation key trees are compared across en, es, fr, de, pt, it, zh and ja
- **THEN** every new notification key exists with matching interpolation parameters in all eight locales
