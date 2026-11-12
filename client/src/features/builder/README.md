# builder

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/project-builder/BlueprintPanel.tsx](components/project-builder/BlueprintPanel.tsx)
- [components/project-builder/BlueprintReadiness.tsx](components/project-builder/BlueprintReadiness.tsx)
- [components/project-builder/BuilderConversation.tsx](components/project-builder/BuilderConversation.tsx)
- [components/project-builder/BuilderHalo.tsx](components/project-builder/BuilderHalo.tsx)
- [components/project-builder/BuilderSidebarEntry.tsx](components/project-builder/BuilderSidebarEntry.tsx)
- [hooks/useBuilderSession.ts](hooks/useBuilderSession.ts)
- [hooks/useMilestoneNotifications.ts](hooks/useMilestoneNotifications.ts)
- [hooks/useMilestoneProgress.ts](hooks/useMilestoneProgress.ts)
- [lib/milestone-launch.ts](lib/milestone-launch.ts)

## Feature dependencies

- [missions](../missions/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Run the adjacent tests with `npm run test --prefix client -- src/features/builder`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

Chain creation timestamps normalize to `createdAt: string | null`. Older servers
and malformed timestamps retain the chain with a null start, so notification
elapsed time can be omitted safely.

Notification durations are static compact totals: seconds below one minute,
whole minutes below one hour, then hours with two-digit minutes (`2h 05m`).
`formatElapsed` truncates fractions and clamps negative/nonfinite input to zero.

`formatMilestoneToast` composes localized project/milestone/event titles and
status/elapsed descriptions. Optional rail progress, pause reason and review
count retain event detail. Blank projects and invalid starts omit those segments;
delivered/completed events also require a valid end and never substitute receipt
time. Event semantics determine status, so delivered remains awaiting review
even when its launch chain has completed.

`useMilestoneNotifications` accepts the existing optional `projectsById` map
from App, reading refreshed names through a ref. Timing associations are scoped
to project and milestone and seeded by both chain and progress frames (including
initial/equal-state progress without replay). Authoritative null chains clear
stale timing; new chains replace it. All five notifications use
`<Project> · <Milestone> — <event>` plus status and a static total, preserving
their existing ids, lifetimes and actions. Active events sample receipt time;
delivered/completed use the observed snapshot's `updatedAt`. The store updates
that timestamp at chain completion and terminal controls reject further changes.
Delivery can precede integration completion, so its duration freezes at that
delivery progress sample rather than implying a later integration end. Missing
project/start/end context is omitted without inventing timing.
