# loops

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/LoopPreviewModal.tsx](components/LoopPreviewModal.tsx)
- [components/loop-log/LoopStepExplorer.tsx](components/loop-log/LoopStepExplorer.tsx)
- [components/loop-log/NarratedProgress.tsx](components/loop-log/NarratedProgress.tsx)
- [lib/loop-run-models.ts](lib/loop-run-models.ts)
- [lib/loop-ticket-need.ts](lib/loop-ticket-need.ts)
- [lib/loops-api.ts](lib/loops-api.ts)
- [pages/LoopBuilderPage.tsx](pages/LoopBuilderPage.tsx)
- [pages/LoopsPage.tsx](pages/LoopsPage.tsx)

## Feature dependencies

- [browser](../browser/README.md)
- [jobs](../jobs/README.md)
- [missions](../missions/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [settings](../settings/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/loops`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

The log explorer consumes Core's public `runtime-graph.graph` through the pure
`runtime-topology` parser. `RuntimeGraphExplorer` renders its actual transitions,
supports nested components, and focuses exact scoped attempts in the existing log
pipeline. It cannot edit or execute a graph; those actions belong to the builder
and server control routes. Recorded trace identifiers are optional.
