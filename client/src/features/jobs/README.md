# jobs

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/JobDetailModal.tsx](components/JobDetailModal.tsx)
- [components/LogViewer.tsx](components/LogViewer.tsx)
- [components/job-run/useRuntimeRuns.ts](components/job-run/useRuntimeRuns.ts)
- [hooks/useAssembleProgress.ts](hooks/useAssembleProgress.ts)
- [hooks/useCompareUrlSync.ts](hooks/useCompareUrlSync.ts)
- [hooks/useLogTicketActions.ts](hooks/useLogTicketActions.ts)
- [hooks/usePipeline.ts](hooks/usePipeline.ts)
- [hooks/useRunVitals.ts](hooks/useRunVitals.ts)
- [lib/cancel-job.ts](lib/cancel-job.ts)
- [lib/job-time.ts](lib/job-time.ts)
- [pages/JobDetailPage.tsx](pages/JobDetailPage.tsx)
- [pages/JobsPage.tsx](pages/JobsPage.tsx)

## Feature dependencies

- [analytics](../analytics/README.md)
- [browser](../browser/README.md)
- [loops](../loops/README.md)
- [missions](../missions/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/jobs`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
