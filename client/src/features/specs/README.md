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
- [lib/spec-addenda-core.ts](lib/spec-addenda-core.ts)
- [lib/spec-draft.ts](lib/spec-draft.ts)
- [lib/spec-sort.ts](lib/spec-sort.ts)
- [lib/spec-triage.ts](lib/spec-triage.ts)
- [lib/specs-view-tier.ts](lib/specs-view-tier.ts)
- [types/spec-sort.ts](types/spec-sort.ts)

## Feature dependencies

- [analytics](../analytics/README.md)
- [browser](../browser/README.md)
- [chat](../chat/README.md)
- [code](../code/README.md)
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
