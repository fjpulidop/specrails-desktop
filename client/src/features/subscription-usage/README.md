# subscription-usage

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/SubscriptionUsageFooter.tsx](components/SubscriptionUsageFooter.tsx)
- [components/SubscriptionUsagePanel.tsx](components/SubscriptionUsagePanel.tsx)

## Feature dependencies

- [builder](../builder/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/subscription-usage`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

The footer menu omits the section title, divider and refresh spinner. During collection it reuses BuilderHalo around the menu outline, with reduced-motion support.

Provider rows share the outer menu surface, with no individual card borders or backgrounds; a subtle horizontal divider separates Claude and Codex.

Enterprise consumption observations replace Claude's window rows with monthly measured spend and the current assigned cap. `EnterpriseSpendMeter` shares localized currency, percentage, reset, stale and over-limit rendering between the menu and settings panel. The footer includes monetary-only Claude accounts; unknown or unlimited caps display no invented percentage. Normal subscription windows and Codex retain their presentation. The additive `spend` field is validated against the confirmed Enterprise plan, monetary value semantics and absence of meaningful traditional windows; snapshots from older servers without the field remain accepted.
