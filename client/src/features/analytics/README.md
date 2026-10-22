# analytics

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/ExportDropdown.tsx](components/ExportDropdown.tsx)
- [components/TicketSpendingLine.tsx](components/TicketSpendingLine.tsx)
- [hooks/useActivity.ts](hooks/useActivity.ts)
- [pages/ActivityFeedPage.tsx](pages/ActivityFeedPage.tsx)
- [pages/AnalyticsPage.tsx](pages/AnalyticsPage.tsx)
- [pages/DesktopAnalyticsPage.tsx](pages/DesktopAnalyticsPage.tsx)

## Feature dependencies

- [providers](../providers/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/analytics`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
