# analytics

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/CostValue.tsx](components/CostValue.tsx)
- [components/ExportDropdown.tsx](components/ExportDropdown.tsx)
- [components/TicketSpendingLine.tsx](components/TicketSpendingLine.tsx)
- [hooks/useActivity.ts](hooks/useActivity.ts)
- [lib/format.ts](lib/format.ts)
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
<!-- audit-client-features:end -->

## Budget panel

[BudgetCard](components/BudgetCard.tsx) (project analytics page and the Desktop overlay) shows spend against the daily,
weekly and monthly caps (project and app-wide), edits them together with the per-run soft cap, and shows the month-end
projection (an estimate, labelled) and the what-if pricer ([WhatIfPanel](components/WhatIfPanel.tsx)). Pure parsing and
cent arithmetic live in [lib/budget.ts](lib/budget.ts). A provider that is not positively metered (`isMeteredBilled`)
shows turns and plan limits instead of dollars, and nothing dollar-shaped renders while the billing mode is unknown.
`?panel=budget` scrolls to the panel (the inbox's Raise cap and the launch forecast use `openBudgetPanel()`).

Run the adjacent tests with `npm run test --prefix client -- src/features/analytics`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
