# missions

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AgentActivityChip.tsx](components/AgentActivityChip.tsx)
- [components/AgentBrowserCaptureHost.tsx](components/AgentBrowserCaptureHost.tsx)
- [components/AgentMessage.tsx](components/AgentMessage.tsx)
- [components/AgentModeSurface.tsx](components/AgentModeSurface.tsx)
- [components/AgentModelSelector.tsx](components/AgentModelSelector.tsx)
- [components/AgentPrPinnedDock.tsx](components/AgentPrPinnedDock.tsx)
- [components/AgentToolbarSelector.tsx](components/AgentToolbarSelector.tsx)
- [components/AgentWorkspaceSidebar.tsx](components/AgentWorkspaceSidebar.tsx)
- [components/MissionWindowAction.tsx](components/MissionWindowAction.tsx)
- [components/MissionWindowBindings.tsx](components/MissionWindowBindings.tsx)
- [components/MissionWindowSurface.tsx](components/MissionWindowSurface.tsx)
- [components/agent-run-failure.ts](components/agent-run-failure.ts)
- [context/AgentChatContext.tsx](context/AgentChatContext.tsx)
- [context/AgentWorkspaceContext.tsx](context/AgentWorkspaceContext.tsx)
- [context/MinimizedChatsContext.tsx](context/MinimizedChatsContext.tsx)
- [context/MissionWindowsContext.tsx](context/MissionWindowsContext.tsx)
- [hooks/useAgentRefActions.ts](hooks/useAgentRefActions.ts)
- [lib/agent-api.ts](lib/agent-api.ts)
- [lib/agent-refs.ts](lib/agent-refs.ts)
- [lib/mission-search.ts](lib/mission-search.ts)
- [lib/mission-windows.ts](lib/mission-windows.ts)

## Feature dependencies

- [agents](../agents/README.md)
- [analytics](../analytics/README.md)
- [background](../background/README.md)
- [browser](../browser/README.md)
- [builder](../builder/README.md)
- [code](../code/README.md)
- [delivery](../delivery/README.md)
- [jobs](../jobs/README.md)
- [loops](../loops/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)
- [terminals](../terminals/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.

Run the adjacent tests with `npm run test --prefix client -- src/features/missions`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
