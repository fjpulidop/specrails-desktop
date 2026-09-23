# chat

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AttachmentsSection.tsx](components/AttachmentsSection.tsx)
- [components/ChatPanel.tsx](components/ChatPanel.tsx)
- [components/ContextScopeChecks.tsx](components/ContextScopeChecks.tsx)
- [components/ContextScopeSlider.tsx](components/ContextScopeSlider.tsx)
- [components/RichAttachmentEditor.tsx](components/RichAttachmentEditor.tsx)
- [hooks/useChat.ts](hooks/useChat.ts)
- [hooks/useContextBudget.ts](hooks/useContextBudget.ts)
- [hooks/useContextScope.ts](hooks/useContextScope.ts)
- [lib/attachments.ts](lib/attachments.ts)
- [types/context-scope.ts](types/context-scope.ts)

## Feature dependencies

- [providers](../providers/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/chat`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
