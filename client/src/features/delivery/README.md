# delivery

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/LocalStashNotice.tsx](components/LocalStashNotice.tsx)
- [components/LoopChip.tsx](components/LoopChip.tsx)
- [components/RailPrDecisionStrip.tsx](components/RailPrDecisionStrip.tsx)
- [components/RepositoryDeliveries.tsx](components/RepositoryDeliveries.tsx)
- [components/TargetPrLaunchDialog.tsx](components/TargetPrLaunchDialog.tsx)
- [components/TopRiskLine.tsx](components/TopRiskLine.tsx)
- [context/RailPrDecisionContext.tsx](context/RailPrDecisionContext.tsx)
- [lib/pr-delivery.ts](lib/pr-delivery.ts)
- [lib/pr-follow-up-scope.ts](lib/pr-follow-up-scope.ts)
- [pages/ReviewPacketPage.tsx](pages/ReviewPacketPage.tsx)

## Feature dependencies

- [builder](../builder/README.md)
- [code](../code/README.md)
- [jobs](../jobs/README.md)
- [projects](../projects/README.md)
- [rails](../rails/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

The review packet's **Changes** tab lives in
[components/review-packet/ChangesTab.tsx](components/review-packet/ChangesTab.tsx) (tree, virtualised
diff, annotations, ask-the-agent addendum, viewed marks, `j k n p v` keys) over the pure
[lib/changes-model.ts](lib/changes-model.ts) and [lib/viewed-files.ts](lib/viewed-files.ts). The editor
URL builder and preference are shared in `client/src/lib/open-in-editor.ts`. See
[the review packet guide](../../../../docs/internals/review-packet.md#changes-tab-in-app-diff-review).

Run the adjacent tests with `npm run test --prefix client -- src/features/delivery`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
