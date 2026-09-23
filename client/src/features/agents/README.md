# agents

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/RailEffortSelector.tsx](components/RailEffortSelector.tsx)
- [components/RailEngineSelector.tsx](components/RailEngineSelector.tsx)
- [components/RailLoopSelector.tsx](components/RailLoopSelector.tsx)
- [components/RailModelSelector.tsx](components/RailModelSelector.tsx)
- [components/RailProfileSelector.tsx](components/RailProfileSelector.tsx)
- [components/types.ts](components/types.ts)
- [pages/AgentsPage.tsx](pages/AgentsPage.tsx)

## Feature dependencies

- [code](../code/README.md)
- [loops](../loops/README.md)
- [missions](../missions/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/agents`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
