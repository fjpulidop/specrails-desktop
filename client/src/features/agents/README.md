# agents

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/RailEffortSelector.tsx](components/RailEffortSelector.tsx)
- [components/RailEngineSelector.tsx](components/RailEngineSelector.tsx)
- [components/RailLoopSelector.tsx](components/RailLoopSelector.tsx)
- [components/RailModelSelector.tsx](components/RailModelSelector.tsx)
- [components/RailProfileSelector.tsx](components/RailProfileSelector.tsx)
- [components/types.ts](components/types.ts)
- [pages/AgentsPage.tsx](pages/AgentsPage.tsx)

## Feature dependencies

- [code](../code/README.md)
- [loops](../loops/README.md)
- [missions](../missions/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/agents`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

## Core roles in Agent Studio

Custom agents expose source access, artifact policy, optional OpenSpec skill and
Core engine settings in the structured editor. Omitted access/artifacts mean
read/none; choosing a skill is explicit. Provider-native fields and instructions
survive structured edits. Frontmatter formatting is normalized when edited.
Invalid YAML must be corrected before structured edits can be applied.

File identity remains `custom-<role>` across providers; built-in Core roles cannot
be shadowed. The server validates the same execution descriptor for manual saves
and AI refinement application, including force-apply. Project runtime role
overrides take precedence when the launch configuration is frozen.
