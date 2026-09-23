# projects

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AddProjectDialog.tsx](components/AddProjectDialog.tsx)
- [components/OnboardingWizard.tsx](components/OnboardingWizard.tsx)
- [components/ProjectErrorBoundary.tsx](components/ProjectErrorBoundary.tsx)
- [components/RepositoryScopeSelector.tsx](components/RepositoryScopeSelector.tsx)
- [hooks/usePrerequisites.ts](hooks/usePrerequisites.ts)
- [lib/project-repositories.ts](lib/project-repositories.ts)
- [types/multi-repo.ts](types/multi-repo.ts)

## Feature dependencies

- [integrations](../integrations/README.md)
- [settings](../settings/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/projects`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
