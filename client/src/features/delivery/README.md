# delivery

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/RailPrDecisionStrip.tsx](components/RailPrDecisionStrip.tsx)
- [components/RepositoryDeliveries.tsx](components/RepositoryDeliveries.tsx)
- [components/TargetPrLaunchDialog.tsx](components/TargetPrLaunchDialog.tsx)
- [context/RailPrDecisionContext.tsx](context/RailPrDecisionContext.tsx)
- [lib/pr-delivery.ts](lib/pr-delivery.ts)
- [lib/pr-follow-up-scope.ts](lib/pr-follow-up-scope.ts)
- [pages/ReviewPacketPage.tsx](pages/ReviewPacketPage.tsx)

## Feature dependencies

- [builder](../builder/README.md)
- [code](../code/README.md)
- [projects](../projects/README.md)
- [rails](../rails/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/delivery`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
