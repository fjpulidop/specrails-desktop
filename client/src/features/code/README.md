# code

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/ai-edit/AiEditShell.tsx](components/ai-edit/AiEditShell.tsx)
- [components/code-explorer/TicketFilesTouched.tsx](components/code-explorer/TicketFilesTouched.tsx)
- [lib/git-refresh.ts](lib/git-refresh.ts)
- [pages/CodePage.tsx](pages/CodePage.tsx)

## Feature dependencies

- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/code`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
