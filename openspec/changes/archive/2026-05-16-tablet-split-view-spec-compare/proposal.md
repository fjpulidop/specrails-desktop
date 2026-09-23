## Why

Comparing two specs side-by-side today requires opening one, memorising it, closing, opening another — friction that breaks reasoning about scope overlap, naming consistency, or duplicated requirements. A tablet-style split-view (drag a spec modal to the screen edge to summon the ToDo picker on the opposite side) gives users an iPad/Samsung-grade compare experience without leaving the modal context.

## What Changes

- New drag affordance on `TicketDetailModal` header: dragging past 20% of viewport width snaps the modal to the left or right half of the screen.
- When snapped, the opposite half renders a **picker** — the user's currently-active dashboard view (`SpecsBoard`/`TicketGridView`/`TicketListView`/`TicketPostItView`) re-used as-is, filtered to `status='todo'`, honouring the dashboard's active filters, sort, and excluding ticket(s) already on screen.
- Clicking a picker card replaces that side with a full second `TicketDetailModal` mounted side-by-side with the first. Both panels are independent, scrollable, fully interactive.
- A new **"Comparar"** button in the modal toolbar triggers split mode without requiring a drag (discoverability).
- **Symmetry**: dragging right → spec stays right, picker on left. Dragging left → spec stays left, picker on right.
- **Splitter**: starts at 50/50, redimensionable via mid-divider drag. Size is ephemeral (resets on close).
- **Exit rules**:
  - Click backdrop → close both panels (current behaviour preserved).
  - Click `×` on side B's header → that panel returns to picker; side A stays.
  - Click `×` on side A's header → close both panels.
  - Following an intra-spec link to a third ticket (e.g., `Continue Explore`, ticket mention, deep link) → split-view collapses, single centered modal opens for the third ticket.
- **URL persistence**: split state encoded as `?compare=<ticketId>&compareSide=left|right` so a browser refresh restores the comparison.
- **Animation**: drag follows pointer 1:1; spring-snap when crossing 20% threshold; spring-snap on release.
- **Viewport gating**: drag and "Comparar" button are disabled / hidden below 900px viewport width.
- `TicketDetailModalContext` extended from a single active ticket to `{ left, right, side }` while preserving the existing single-modal API for non-split callers.

## Capabilities

### New Capabilities
- `spec-compare-split-view`: Tablet-style split-view comparison of two spec tickets summoned by dragging the active modal to a screen edge, with a same-view picker on the opposite side and intra-spec link navigation that auto-exits split.

### Modified Capabilities
<!-- None: TicketDetailModal lives in app code, not in any current capability spec. -->

## Impact

- **Affected components** (client):
  - `client/src/features/specs/components/TicketDetailModal.tsx` — add drag handle on header, "Comparar" toolbar button, side-aware close handler.
  - `client/src/features/specs/context/TicketDetailModalContext.tsx` — extend state shape from single ticket id to `{ leftTicketId, rightTicketId, originSide, splitRatio }`; preserve current API for non-split openers.
  - `client/src/features/specs/components/SpecsBoard.tsx`, `TicketGridView.tsx`, `TicketListView.tsx`, `TicketPostItView.tsx` — verified reusable as embedded picker (no route assumptions); add a `mode='picker'` prop that disables drag-and-drop, hides headers/filters chrome, and emits `onSelectTicket(id)`.
  - `client/src/App.tsx` — route reads `?compare=` query and restores split via context on mount.
- **No server changes**: feature is entirely client-side; no schema, REST, or WS surface added.
- **No new dependencies**: drag/snap built on existing `useDashboardSplit` primitive plus framer-motion (already a dep) for spring animation. If framer-motion is not present today, CSS transitions + `requestAnimationFrame` fallback documented in design.md.
- **Tests**: split-view state machine, URL round-trip, third-spec exit, viewport gating, picker filter respect.
- **Coverage**: client thresholds (80% lines/statements, 70% functions) must hold.
- **Out of scope** (deferred): persisting splitter ratio across sessions, comparing non-todo statuses (draft/done), a trimmed compare view, triple+ panel split, mobile/touch <900px split UX.
