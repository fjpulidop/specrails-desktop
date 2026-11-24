# background

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AppResourcesFooter.tsx](components/AppResourcesFooter.tsx)
- [components/BackgroundProcessChip.tsx](components/BackgroundProcessChip.tsx)
- [components/BackgroundProcessHistoryModal.tsx](components/BackgroundProcessHistoryModal.tsx)
- [components/BackgroundProcessLogsModal.tsx](components/BackgroundProcessLogsModal.tsx)
- [components/BackgroundProcessesPanel.tsx](components/BackgroundProcessesPanel.tsx)
- [components/MissionResourcesPanel.tsx](components/MissionResourcesPanel.tsx)
- [components/RetainedWorktreesSection.tsx](components/RetainedWorktreesSection.tsx)
- [components/SafetyArchivesSection.tsx](components/SafetyArchivesSection.tsx)
- [context/BackgroundProcessesContext.tsx](context/BackgroundProcessesContext.tsx)
- [hooks/useMissionResourceHistory.ts](hooks/useMissionResourceHistory.ts)
- [lib/background-processes-api.ts](lib/background-processes-api.ts)

## Feature dependencies

- [delivery](../delivery/README.md)
- [diagnostics](../diagnostics/README.md)
- [missions](../missions/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Run the adjacent tests with `npm run test --prefix client -- src/features/background`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

## Mission resources history

`useMissionResourceHistory` reads live totals and persisted `history` from the
project-scoped resources endpoint while the popover is open. Sampling and SQLite
retention belong to the server recorder, so closing the popover or reloading the
client does not interrupt collection during an active mission turn. The hook
ignores responses from a previously selected project or mission.

## App-wide resources

`AppResourcesFooter` (status bar, after the provider quota footer) reads
`GET /api/resources` through `useAppResources`. Its button is available as soon as
the status bar renders and shows the work-process count when measured. It fetches once on mount, every 30 s for the
trigger summary (skipped while the window is hidden) and every 3 s while the popover
is open. The popover shows CPU, memory and process totals, a memory trend from the
server's in-memory history, memory split by source and expandable rows per source.
While the popover is open, `useRunPorts` also reads `GET /api/resources/ports` every 5 s
and `RunPortsSection` lists the ports served from run worktrees: port, rail · ticket ·
project, process and how it was attributed (working folder or command line). A foreign
process listening inside a run's assigned block is flagged with the warning lamp
(AlertTriangle): that run's server would fail with "address already in use".

## Retained run worktrees

`RetainedWorktreesSection` is the body of **Settings ▸ Storage**. The status-bar App resources popover links to it
with `openAppSettings('storage', 'retainedWorktrees')`.

- `useRetainedWorktrees(active)` reads `GET /api/worktrees/retained` only while the pane is shown.
- It then asks `POST /api/worktrees/retained/sizes` for every listed worktree, and polls only the ones still scanning
  every 1.5 s.
- The pure model `lib/retained-worktrees-model.ts` maps a worktree to the status vocabulary:
  - `working` when a run or decision holds it;
  - `done` for **Nothing to lose**;
  - `review` for **Waiting for you**.
  It also filters by label, idle days and known size, and groups rows by project.
- Rows that cannot be removed (uncommitted changes, ignored files that exist only there, Intent-owned, recently
  active, unknown) have a disabled checkbox that names the reason.
- Removal posts the confirmed `head` of each selected worktree, plus `deleteBranch` only for worktrees the server
  marked `branchDeletable` when **Also delete branches that hold nothing new** is checked. It then shows the
  per-item outcome and warnings and refreshes the list.
