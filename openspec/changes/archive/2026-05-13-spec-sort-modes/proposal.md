## Why

Today the Specs column only supports a custom drag-order persisted per project. Users with many specs cannot quickly group by priority or scan by ticket number — they must drag manually. Adding explicit sort modes turns the column into a usable triage surface without sacrificing the drag-order that power users already rely on.

## What Changes

- Add a sort control to the Specs column header, placed immediately to the left of the `+ Add` button.
- The control exposes three sort modes: `Default` (current custom drag-order), `Ticket #`, and `Priority`.
- A separate direction toggle (asc / desc) applies to `Ticket #` and `Priority` modes.
- The same sort mode + direction applies to both the active specs section and the Done section below the splitter.
- When a sort mode other than `Default` is active and the user drags a card to reorder, the mode flips back to `Default` and the new manual order is persisted.
- Sort mode and direction persist per project in `localStorage`.
- Priority sort uses bucket order `critical > high > medium > low > null`, with `id` ascending as a stable tiebreaker (reversed when direction is asc).

## Capabilities

### New Capabilities
- `spec-sort-modes`: A sort control in the Specs column that lets users switch between custom drag-order, ticket-number order, and priority-bucket order, in either direction, with the choice persisted per project.

### Modified Capabilities
<!-- none — current spec ordering lives only in DashboardPage code, not in a published spec -->

## Impact

- `client/src/features/specs/components/SpecsBoard.tsx` — header layout adds the new sort control next to `+ Add`.
- `client/src/features/specs/components/SpecSortControl.tsx` — new component (chip + arrow).
- `client/src/features/dashboard/pages/DashboardPage.tsx` — ordering pipeline for `specTickets` and `doneSpecTickets`; drag-end handler flips mode to `Default` when leaving a non-default mode.
- `localStorage` adds two per-project keys: `specrails-hub:spec-sort-mode:<projectId>`, `specrails-hub:spec-sort-dir:<projectId>`.
- No server changes. No schema changes. No API changes.
- Tests: `SpecsBoard.test.tsx`, new `SpecSortControl.test.tsx`, and ordering coverage where `DashboardPage` is exercised.
