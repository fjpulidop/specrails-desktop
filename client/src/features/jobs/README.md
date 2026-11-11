# jobs

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
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
- [recovery](../recovery/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Run the adjacent tests with `npm run test --prefix client -- src/features/jobs`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

Run detail navigation is shared by the page and mission modal in `RunDetailTabs`.
Diagnosed failed/canceled jobs start on Failure reasons; an answerable pending
question also makes that tab available without inventing a diagnosis. Other jobs
start on Log, with bounded Details there. Loop evidence has Execution graph and
Log detail sections. Tab controls remain outside the bounded scrolling body.
Visited evidence uses React Activity: unvisited views are lazy, hidden views
retain DOM/state while their effects disconnect. This preserves graph exploration
and paused log scroll, while active following reconnects on return.
The Log section and Details expansion persist independently per surface; the
modal maps Details to the existing `glass` preference and the page keeps `page`.
Top-level tabs reset on each visit. Plain jobs force Log detail without replacing
the stored loop section. Invalid or unavailable storage uses session defaults.
`JobRunHeader` owns diagnosis eligibility, metric calculation and the single
runtime polling/action hook. Its additive `renderRunDetails` callback returns
layout as a sibling of compact header chrome; shared tabs own only navigation
and disclosure state. A repeatable question request selects Failure reasons and
opens Details. Ordinary navigation leaves runtime drafts and action ownership intact.
Both production surfaces provide separate graph and raw/narrated detail slots;
Story|Log remains inside Log detail and keeps its existing preference. Open-logs
remedies reveal the evidence first, then use the current surface's visible root
for lookup. The modal retains glass chrome, sizing, focus trap and fork actions.
Question requests focus the answer field inside the bounded Details body.

Focused navigation checks:
`npm run test --prefix client -- src/features/jobs/components/job-run/RunDetailTabs.test.tsx src/features/jobs/components/job-run/__tests__/JobRunHeader.test.tsx src/features/jobs/components/job-run/__tests__/job-run-model.test.ts src/features/jobs/pages/__tests__/JobDetailPage.test.tsx src/features/jobs/components/__tests__/JobDetailModal.test.tsx src/lib/__tests__/i18n.test.ts src/lib/__tests__/a11y-guard.test.ts`.
