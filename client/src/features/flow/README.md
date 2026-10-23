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

## Mission extension slots

`FlowMissionsBridge` fills the missions seam: the `flow-offer` fence card, the
conversation mode, the dock above the composer (`FlowDock`), the run card's
Back to Flow / Relaunch (`FlowRunCardActions`) and `RunFailureOutcome`
(`FlowRunFailure`): a Flow → Spec run that failed outright is explained in the
person's words — a localized headline per failing step
([`lib/flow-failure.ts`](lib/flow-failure.ts) maps the recipe's step ids), the
runtime's error as the cause, what happens next, the actions or "Returned to
Flow", and the codes only under **Technical details**. The same block renders
inside the Flow's return card. Flow API refusals read by code
(`flowErrorMessage`); the server detail is never the headline.

## Flow bar and hand-off

`FlowBar` shows the copyable branch (the mission's git strip steps aside via
`hideGitStrip`), a files ± stat that opens `FlowChangesDialog`, and a toolbar
with **Discard** apart from the primary **This is it**; disabled controls say
why. `FlowDiscardDialog` lists what is lost. `FlowDock` announces state
changes in a polite live region. `FlowHandOffCard` adds a one-line recap
(files ±, cost so far, the safety net) above the launch card, and the offer
stub's **View run** focuses the run card (missions' card focus bus).

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
