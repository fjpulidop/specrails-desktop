# flow

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/FlowMissionsBridge.tsx](components/FlowMissionsBridge.tsx)

## Feature dependencies

- [background](../background/README.md)
- [missions](../missions/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

## Repository target

In a workspace (folder primary) or a project with several Git repositories,
`FlowEntryCard` shows where the Flow runs: the Git members from
`GET /api/projects/:id/repositories` (`flowApi.repositories`,
`flowRepositoryChoice`), preselected from the `flow-offer` block's
`repositoryId`. It sends `repositoryId` only for such projects; a
single-repository project never shows or sends it.

Run the adjacent tests with `npm run test --prefix client -- src/features/flow`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
