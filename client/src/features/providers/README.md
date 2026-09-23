# providers

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AiEngineSelector.tsx](components/AiEngineSelector.tsx)
- [components/CustomModelAliasInput.tsx](components/CustomModelAliasInput.tsx)
- [hooks/useAvailableProviders.ts](hooks/useAvailableProviders.ts)
- [hooks/useProviderDetection.ts](hooks/useProviderDetection.ts)
- [lib/last-engine.ts](lib/last-engine.ts)
- [lib/model-alias.ts](lib/model-alias.ts)
- [lib/provider-capabilities.ts](lib/provider-capabilities.ts)

## Feature dependencies

- [loops](../loops/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/providers`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
