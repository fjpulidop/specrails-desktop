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
- [components/MissionConversationMenu.tsx](components/MissionConversationMenu.tsx)
- [context/MissionSplitViewsContext.tsx](context/MissionSplitViewsContext.tsx)
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

## Launch repository scope

Mission launch proposals show launch repositories and the saved assignments of
each spec, including single-repository projects. Edit a spec's assignments in
place with **Edit → Save repositories** or **Cancel**. Save updates its durable
scope for future launches; selecting extra launch targets only affects this run.
At least one target must remain, and context-only folders are not implementation
targets. Missing or unavailable targets block Play with their names.

The card loads and writes to its pinned project. It reconciles current spec
requirements with the proposal, retains extra launch targets, and removes stale
workspace entries when a target is removed. **Refresh** reloads current
assignments. Failed loads expose **Retry loading**; failed saves retain the draft.
Server admission still checks the latest scope before execution.

## Split view and compact composer

Right-click a sidebar mission (or press Shift+F10 on its row) and choose
**Split view** to add it beside the current conversation. Existing panes are focused instead of duplicated. Layout belongs to the current window and survives
a Mission/Board mode switch within that window.

At sufficient width the layout uses at most two columns: the first two panes are
side by side, subsequent panes divide those columns into rows. Narrow areas stack
panes vertically. Closing a pane removes only that view; remaining panes keep
their mounted transcripts and composers, and a single remaining pane fills the
space. The original empty mission can also be closed while splits are open.
Closing all additional panes restores the original mission. Closing a view never
deletes its conversation or stops the server turn.

Additional panes reuse AgentChatProvider in fixed-conversation mode with unique
WebSocket subscriptions, independent workspace state and scoped composer animation
IDs. They do not change the global active project or create floating chat panels.
Native handoff ownership still blocks editing missions assigned to other windows
and pending transfers. Detach/attach actions remain owned by the primary mission.

The composer uses one flat, rounded surface and a bottom control row. Autonomy
follows **+**, process history is an icon, and one model/effort trigger opens the
effort slider, model list and provider list. Custom aliases and capability-driven
effort options remain supported. Text and controls share the same font size;
narrow composers replace selector labels with icons while keeping tooltips and
accessible labels. The thinking halo is attached to this surface and follows its
1.5rem radius rather than an outer card or another pane's animation.

Mission welcomes use twenty translated phrases per language, selected randomly
for a composer’s conversation and kept stable while typing. Aurora Light,
Obsidian Dark and Specrails give this surface additional contrast without adding
an inner border. Bottom controls share a centered 32px height.

Detached mission windows show the conversation without the right workspace
sidebar or its pin/resize controls. The conversation area has no extra top
toolbar; Split view is accessed from the sidebar conversation context menu.

The composer project dropdown is rendered outside pane clipping boundaries. It
opens above the bottom controls when space permits, otherwise uses the roomier
side, and stays within the viewport while resizing or scrolling.

The primary split pane is a flex column with a constrained height, even when it
is the only visible pane. Message lists shrink within that height and scroll
independently, keeping the composer visible for long conversations.

The conversation Split view action uses a multiple-panel icon and is suppressed for conversations already visible in the primary or a split pane, including keyboard context-menu requests.
