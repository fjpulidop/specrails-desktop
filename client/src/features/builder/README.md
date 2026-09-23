# builder

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

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

Run the adjacent tests with `npm run test --prefix client -- src/features/builder`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
