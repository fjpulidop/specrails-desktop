# dashboard

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [pages/DashboardPage.tsx](pages/DashboardPage.tsx)

## Feature dependencies

- [delivery](../delivery/README.md)
- [integrations](../integrations/README.md)
- [loops](../loops/README.md)
- [provider-quota](../provider-quota/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Run the adjacent tests with `npm run test --prefix client -- src/features/dashboard`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

## Board structure

[DashboardPage](pages/DashboardPage.tsx) composes the board from focused hooks in [hooks/](hooks/):
rails state ([useBoardRails](hooks/useBoardRails.ts)), server sync ([useRailServerSync](hooks/useRailServerSync.ts)),
WebSocket events ([useRailWsEvents](hooks/useRailWsEvents.ts)), rail CRUD and configuration
([useRailCrud](hooks/useRailCrud.ts), [useRailConfigHandlers](hooks/useRailConfigHandlers.ts)), spec columns and moves
([useBoardSpecColumns](hooks/useBoardSpecColumns.ts), [useRailTicketMoves](hooks/useRailTicketMoves.ts)), drag and drop
([useBoardDnd](hooks/useBoardDnd.ts)), view preferences, launch ([useRailLaunch](hooks/useRailLaunch.ts)) and the command
palette entries ([useBoardPalette](hooks/useBoardPalette.ts)). Pure rail helpers live in [lib/board-rails.ts](lib/board-rails.ts).
Keep new board behaviour in the hook that owns that state instead of growing the page.
