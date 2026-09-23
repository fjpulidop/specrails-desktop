# rails

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/FreestyleLaunchDialog.tsx](components/FreestyleLaunchDialog.tsx)
- [components/LaunchAllDialog.tsx](components/LaunchAllDialog.tsx)
- [components/MoveToRailPopover.tsx](components/MoveToRailPopover.tsx)
- [components/RailControls.tsx](components/RailControls.tsx)
- [components/RailTargetPrSelector.tsx](components/RailTargetPrSelector.tsx)
- [components/RailsBoard.tsx](components/RailsBoard.tsx)
- [context/RailMetricsContext.tsx](context/RailMetricsContext.tsx)
- [lib/rail-id.ts](lib/rail-id.ts)
- [lib/rail-launch-draft.ts](lib/rail-launch-draft.ts)
- [lib/rail-launch-intents.ts](lib/rail-launch-intents.ts)
- [lib/rail-loops.ts](lib/rail-loops.ts)
- [lib/worktree-progress.ts](lib/worktree-progress.ts)

## Feature dependencies

- [agents](../agents/README.md)
- [browser](../browser/README.md)
- [delivery](../delivery/README.md)
- [loops](../loops/README.md)
- [missions](../missions/README.md)
- [providers](../providers/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/rails`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
