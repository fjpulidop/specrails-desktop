# integrations

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/jira/DiscardSpecDialog.tsx](components/jira/DiscardSpecDialog.tsx)
- [components/jira/JiraConnectWizard.tsx](components/jira/JiraConnectWizard.tsx)
- [components/jira/JiraConnectedCard.tsx](components/jira/JiraConnectedCard.tsx)
- [components/jira/JiraSpecDetailsPanel.tsx](components/jira/JiraSpecDetailsPanel.tsx)
- [context/JiraDiscardContext.tsx](context/JiraDiscardContext.tsx)
- [hooks/useJiraConnection.ts](hooks/useJiraConnection.ts)
- [lib/companion-signal.ts](lib/companion-signal.ts)
- [lib/companion.ts](lib/companion.ts)
- [lib/jira-api.ts](lib/jira-api.ts)
- [pages/IntegrationsPage.tsx](pages/IntegrationsPage.tsx)

## Feature dependencies

No direct feature dependencies.

## Jira status recovery

The connection's status map applies to both outbound transitions and inbound
ticket materialization. Pick a real destination status for each logical state
that needs an override; the API also accepts status IDs. An already-matching
destination is a no-op even when Jira assigns it a different category.

Pending Jira updates show the affected issue and destination. Counts and rows
refresh after sync/retry and ignore responses from a previously selected project.
An unavailable status catalog displays an error and retry action while preserving
the saved mapping. Superseded status operations remain server-side history and
are excluded from attention counts; independent comments and field updates remain
retryable. A genuine missing workflow transition still requires a valid Jira
workflow path or a corrected mapping.

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/integrations`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
