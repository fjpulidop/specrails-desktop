# Proposal

## Why

In Mission mode the left sidebar (ArcSidebar) lists every mission grouped under Favorites, Home and one folder per project. With many open missions, the few that are running right now are scattered across groups, and the person must expand each group and scan for the live indicator. The sidebar already knows which missions are live (`liveConversationIds`) but offers no way to narrow the list to them.

## What Changes

- Add an icon-only toggle button (`aria-pressed`) at the right end of the "Projects" section label, shown only when the sidebar is expanded and Mission mode is on.
- When on, Favorites, Home and every project tree list only live missions, plus the currently open mission so the person keeps their place. Groups without matching missions are hidden; project rows stay visible.
- When on and nothing remains, show a "No active missions" empty-state line.
- The filter is derived state, so it updates without reload as missions start or stop being live; it also applies in the collapsed rail.
- Persist the boolean in localStorage (new key beside the expanded-tree key); invalid values fall back to off.
- Add i18n keys (label, tooltip, empty state) to every `nav.json` locale.
- No server, API, schema or WebSocket change.

## Capabilities

### New Capabilities
- `mission-sidebar-active-filter`: toggle that narrows the Mission-mode sidebar mission list to live missions, with persistence, empty state and accessibility behavior.

### Modified Capabilities

None. No existing spec covers the sidebar.

## Impact

- Client only: `client/src/components/ArcSidebar.tsx`, a new pure helper in `client/src/lib/`, eight `client/src/locales/*/nav.json` files and tests.
- No dependency, API or persisted server data change.
