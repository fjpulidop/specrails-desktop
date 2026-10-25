# specs

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/CreateTicketModal.tsx](components/CreateTicketModal.tsx)
- [components/SpecCard.tsx](components/SpecCard.tsx)
- [components/SpecComparePicker.tsx](components/SpecComparePicker.tsx)
- [components/SpecTriageChip.tsx](components/SpecTriageChip.tsx)
- [components/SpecsBoard.tsx](components/SpecsBoard.tsx)
- [components/TicketDetailModal.tsx](components/TicketDetailModal.tsx)
- [components/explore-spec/useSmoothStream.ts](components/explore-spec/useSmoothStream.ts)
- [context/SmashTrackerContext.tsx](context/SmashTrackerContext.tsx)
- [context/SpecExtensionsContext.tsx](context/SpecExtensionsContext.tsx)
- [context/TicketDetailModalContext.tsx](context/TicketDetailModalContext.tsx)
- [hooks/useContractRefineTracker.tsx](hooks/useContractRefineTracker.tsx)
- [hooks/useSpecGenTracker.tsx](hooks/useSpecGenTracker.tsx)
- [hooks/useTickets.ts](hooks/useTickets.ts)
- [lib/bulk-actions.ts](lib/bulk-actions.ts)
- [lib/bulk-launch.ts](lib/bulk-launch.ts)
- [lib/bulk-report.ts](lib/bulk-report.ts)
- [lib/spec-addenda-core.ts](lib/spec-addenda-core.ts)
- [lib/spec-draft.ts](lib/spec-draft.ts)
- [lib/spec-sort.ts](lib/spec-sort.ts)
- [lib/spec-status-filter.ts](lib/spec-status-filter.ts)
- [lib/spec-triage.ts](lib/spec-triage.ts)
- [lib/specs-view-tier.ts](lib/specs-view-tier.ts)
- [lib/ticket-status-moves.ts](lib/ticket-status-moves.ts)
- [lib/trash-api.ts](lib/trash-api.ts)
- [types/spec-sort.ts](types/spec-sort.ts)

## Feature dependencies

- [analytics](../analytics/README.md)
- [browser](../browser/README.md)
- [chat](../chat/README.md)
- [code](../code/README.md)
- [delivery](../delivery/README.md)
- [integrations](../integrations/README.md)
- [loops](../loops/README.md)
- [missions](../missions/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

## Board toolbar

The Specs half of Board mode composes its header from
[`components/ui/board-toolbar`](../../components/ui/board-toolbar.tsx) (shared with
the Rails half so both rows align across the splitter):

- Row 1: [`SpecSearchField`](components/SpecSearchField.tsx) (ephemeral, `/` to focus,
  matching via [`lib/spec-search.ts`](lib/spec-search.ts)),
  [`SpecFiltersPopover`](components/SpecFiltersPopover.tsx) (labels, epic, sprint and
  Jira-status sections built from the `Spec*FilterOptions` lists),
  [`SpecsDisplayControls`](components/SpecsDisplayControls.tsx) (sort + view) and New spec.
- Row 2: [`SpecStatusFilter`](components/SpecStatusFilter.tsx), a radiogroup that
  collapses `full → compact → menu` by measured width and never scrolls.
- Row 3 (only while narrowed): [`SpecActiveFilters`](components/SpecActiveFilters.tsx).

Width tiers come from [`useElementWidth`](../../hooks/useElementWidth.ts); a `null`
width (jsdom) always means the roomiest tier. Persistence keys and URL params are
unchanged; search is never persisted.

## Multi-select, bulk actions and saved views

The board is multi-select when its host passes `bulk` ([`SpecBulkHandlers`](lib/bulk-actions.ts));
without it cards stay plain buttons (rails render `SpecCard` without a selection).

- **Selection model** ([`lib/board-selection.ts`](lib/board-selection.ts), pure): `x` toggles the
  focused card, ⌘/Ctrl-click toggles, Shift-click selects a range inside ONE column (the active
  bucket or the Done bucket; a range never crosses them), ⌘/Ctrl+A selects the focused column,
  Esc clears. `SpecsBoard` handles the keys only for events that start inside the board (menus and
  dialogs are portalled out of it) and never while typing. A selection holds only specs the board
  shows: a filter, a delete or a move that hides one drops it, and a project switch clears it.
  The list containers are `role="listbox"` + `aria-multiselectable`, cards `role="option"` +
  `aria-selected` (only while selectable), with a hover/focus checkbox ([`SpecSelectCheckbox`](components/SpecSelectCheckbox.tsx)).
- **Bulk bar** ([`SpecsBulkBar`](components/SpecsBulkBar.tsx), `role="toolbar"`, arrow-key roving):
  Move to, Label, Priority, Add to rail, Launch all, Delete, Clear. It only hands ids to the
  host's handlers; it never reaches the network. Menus open upwards (`DropdownMenuContent side="top"`).
- **One handler per item, one Undo per batch.** `useTickets` exposes `bulkDelete`,
  `bulkUpdateStatus`, `bulkUpdatePriority` and `bulkUpdateLabels`. Each runs the SAME per-spec
  mutation (`deleteTicket`, `updateTicketStatus`, ...) sequentially with `{ collect, refresh: false }`:
  the per-spec call hands its undo to the batch instead of toasting, the list is refetched once, and
  ONE `pushUndo` reverses everything that succeeded (in reverse order, each spec to ITS previous
  value). Failed specs are returned in `BulkResult.failed`; `reportBulk` ([`lib/bulk-report.ts`](lib/bulk-report.ts))
  turns that into a single toast (quiet when an Undo toast already says it; one warning with counts
  on partial failure).
- **Jira.** The Move to menu splits the selection: local specs get the local statuses, Jira-backed
  specs get the board's workflow statuses and move through `moveJiraSpecToStatus` (the outbox
  call, `quiet` so a batch reports once). Jira moves are not undoable locally.
- **Launch all** ([`dashboard/hooks/useSpecBulkActions.tsx`](../dashboard/hooks/useSpecBulkActions.tsx)):
  a spec on the board is not on a rail, so [`planBulkLaunch`](lib/bulk-launch.ts) gives each selected
  spec its own free rail (idle, empty, no pending PR decision, under the review WIP limit; blocked
  specs such as on-review without a PR are skipped). The plan opens `LaunchAllDialog`; confirming
  goes through `useLaunchBudgetGuard`, then `moveToRail` + the rail's own `doLaunchRail` (ticket
  sync, `POST /rails/:n/launch`, so spawn reservation and admission stay server-side), and ONE
  summary toast with the per-reason counts.
- **Saved views** ([`lib/spec-views.ts`](lib/spec-views.ts), [`SpecsViewsMenu`](components/SpecsViewsMenu.tsx)):
  status selector + labels/epic/sprint/Jira status + sort + density (never the search text), named,
  per project, in `localStorage` under `specrails-desktop:spec-views:<project>` (the same place and
  failure behaviour as the other board filters: try/catch, best-effort). Save current, apply,
  rename, update from the board, delete, copy link. A link is `?p=<project>&view=<id>`
  (`VIEW_PARAM` in `lib/places.ts`): it is NOT a place. The board applies the view, then removes the
  param in the same replace that mirrors the status params; picking a view never pushes history. A
  link for another project waits for that project; an unknown id shows a toast. Views live in this
  app's storage, so a link resolves only where the view exists.
- **⌘K.** `SpecsBoard` registers the `selection` palette surface: Select all in column, Clear
  selection, Save current view and Switch view always; Move / Label / Priority / Add to rail /
  Launch / Delete only while specs are selected, all through the same handlers as the bar.

## Extension seam

[`SpecExtensionsContext`](context/SpecExtensionsContext.tsx) lets a feature
built on top of specs add another way to start work on an existing spec,
next to the Implement door, without specs importing it: `StartAlternative`
renders in the board's spec context menu and the spec detail header. The
composition root (App.tsx) provides Flow's "Start in Flow". Without a
provider the slot is inert.

Run the adjacent tests with `npm run test --prefix client -- src/features/specs`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
