# projects

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AddProjectDialog.tsx](components/AddProjectDialog.tsx)
- [components/CloneRepositoryDialog.tsx](components/CloneRepositoryDialog.tsx)
- [components/OnboardingWizard.tsx](components/OnboardingWizard.tsx)
- [components/ProjectErrorBoundary.tsx](components/ProjectErrorBoundary.tsx)
- [components/RepositoryScopeSelector.tsx](components/RepositoryScopeSelector.tsx)
- [hooks/usePrerequisites.ts](hooks/usePrerequisites.ts)
- [lib/project-repositories.ts](lib/project-repositories.ts)
- [types/multi-repo.ts](types/multi-repo.ts)

## Feature dependencies

- [integrations](../integrations/README.md)
- [providers](../providers/README.md)
- [settings](../settings/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Run the adjacent tests with `npm run test --prefix client -- src/features/projects`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

## Existing projects from GitHub

`CloneRepositoryDialog` is shared by Add Project (primary and additional roots)
and the repository section in Project Settings. It clones first through the desktop
`POST /api/repositories/clone` endpoint, then supplies the completed local path to
the existing registration flow. Each entry keeps its original project ownership.
HTTPS and SSH GitHub URLs use the computer's configured Git credentials. The user
chooses a new absolute destination under an existing parent; existing directories
are never reused. A failed clone removes its own partial directory. A successful
clone is retained if registration is cancelled or fails, so the local-path flow
can retry without another download. Cloning has a five-minute timeout and no
interactive credential prompts; it does not install dependencies or register a
project automatically. Tests cover destination protection, transport validation,
errors, duplicate submissions and passing the completed path back to the form.
