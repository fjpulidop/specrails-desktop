# specs

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/CreateTicketModal.tsx](components/CreateTicketModal.tsx)
- [components/SpecCard.tsx](components/SpecCard.tsx)
- [components/SpecComparePicker.tsx](components/SpecComparePicker.tsx)
- [components/SpecsBoard.tsx](components/SpecsBoard.tsx)
- [components/TicketDetailModal.tsx](components/TicketDetailModal.tsx)
- [components/explore-spec/useSmoothStream.ts](components/explore-spec/useSmoothStream.ts)
- [context/SmashTrackerContext.tsx](context/SmashTrackerContext.tsx)
- [context/TicketDetailModalContext.tsx](context/TicketDetailModalContext.tsx)
- [hooks/useContractRefineTracker.tsx](hooks/useContractRefineTracker.tsx)
- [hooks/useSpecGenTracker.tsx](hooks/useSpecGenTracker.tsx)
- [hooks/useTickets.ts](hooks/useTickets.ts)
- [lib/spec-addenda-core.ts](lib/spec-addenda-core.ts)
- [lib/spec-draft.ts](lib/spec-draft.ts)
- [lib/spec-sort.ts](lib/spec-sort.ts)
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

Run the adjacent tests with `npm run test --prefix client -- src/features/specs`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
