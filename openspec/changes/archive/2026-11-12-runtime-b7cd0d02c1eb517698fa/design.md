# Design

## Context

Everything lives in `client/src/components/ArcSidebar.tsx` (observed):
- `liveConversationIds` (useMemo, ~L771) = streaming ∪ background ids; used for the `streaming` prop of rows and for rollups.
- `grouped` (~L781) excludes favorites and folds pins to removed projects into `HOME_KEY`; `favoriteConversations` (~L793); `homeConversations = grouped.get(HOME_KEY) ?? []` (~L797, not memoized).
- `favoritesRollup`/`homeRollup` use `rollupMissions(...)`; `ProjectItem` computes its own rollup from the `conversations` prop (~L466) and shows a chevron when `hasTree`.
- Render: Favorites group (L1169) gated on `favoriteConversations.length > 0`; `SECTION_LABEL` row (L1199, `aria-hidden`); Home group (L1201); `projects.map` with `convs = grouped.get(project.id) ?? []` (L1230).
- Persistence precedent: `TREE_EXPAND_KEY = 'specrails-desktop:agentTreeExpanded'`, `loadExpanded`/`saveExpanded` with try/catch (L34, L55-68).
- i18n: `arcSidebar.*` keys in `client/src/locales/{de,en,es,fr,it,ja,pt,zh}/nav.json` (L31-44 in es).

## Goals / Non-Goals

**Goals:**
- One toggle that filters all three render sites through one memoized path.
- Defaults for the open questions (below), implemented and tested.

**Non-Goals:**
- No server, API, schema or WebSocket change.
- No attention-state (pending decision / failed) filtering, no text search.
- No filter in the non-Mission sidebar or the Project Right Sidebar.
- No second liveness definition; no hiding of project rows.
- No refactor of unrelated ArcSidebar code (for example memoizing `homeConversations` beyond what the filter needs).

## Decisions

1. **Pure helper in a new file** `client/src/lib/filterActiveConversations.ts` (kebab/utility convention; keeps the component file free of non-component exports). Signature `filterActiveConversations(conversations, liveIds, activeId, activeOnly)` is replaced by the contract form: with the flag handled by the caller, `filterActiveConversations(conversations, liveIds, activeId)` keeps `liveIds.has(c.id) || c.id === activeId`, preserving order. Callers skip it (return the original array reference) when the filter is off, so memo identity is stable and "off" is byte-identical to today. Generic over `{ id: string }` so tests need no full `AgentConversation`.
2. **Derived state, computed in ArcSidebar** with `useMemo` keyed on `liveConversationIds`, `activeOnly`, `agentChat.active?.id` and the unfiltered lists: `visibleFavorites`, `visibleGrouped` (Map, same shape as `grouped`), `visibleHome`. Rollups, `hasTree`, `ProjectItem.conversations` and the group gates all read the visible lists, so the rail and expanded views agree (and the collapsed rail keeps filtering). Liveness updates flow from existing hooks, giving no-reload reactivity for free.
3. **Persistence**: new `ACTIVE_ONLY_KEY = 'specrails-desktop:agentActiveOnly'`, `loadActiveOnly()` returns true only for the exact string `'true'`; `saveActiveOnly` writes `'true'`/`'false'` inside try/catch. State initialised lazily like `expandedTree`. Chosen over session-only because the sibling tree state persists.
4. **Open-question defaults** (taken from the ticket): persisted; empty Favorites/Home groups hidden (they are already gated on `length > 0`, now on the visible list); project rows stay visible (they are navigation, not mission groups) with `hasTree` false so no chevron; the open mission stays visible.
5. **Empty state**: when `agentMode && activeOnly && expanded` and favorites, home and every project's visible list are all empty, render a `<p>` with `arcSidebar.activeFilter.empty` above the project rows (project rows and "Add project" remain usable). Not rendered in the rail.
6. **Button**: lucide `ListFilter`/`Filter` icon inside the Projects label row. The label becomes a flex row (`flex items-center justify-between`) keeping `SECTION_LABEL` styling; the text stays `aria-hidden`, the button has `aria-label` + `title` from `arcSidebar.activeFilter.label`/`.tooltip`, `aria-pressed`, `ROW_FOCUS`, lit style `bg-accent-primary/15 text-accent-primary` when on (mirror an existing lit toggle in the file when implementing). Rendered only when `expanded && agentMode`. Selecting the toggle does not touch tree expansion.
7. **i18n**: add `arcSidebar.activeFilter.{label,tooltip,empty}` to all eight `nav.json` files (translated, not English copies).

Rejected: server-side filter (liveness is client state); a second liveness source; passing `activeOnly` into `ProjectItem` (pre-filtered lists keep its contract unchanged); hiding project rows (breaks navigation).

## Local reference patterns

- Persisted client flag: `loadExpanded`/`saveExpanded` and `TREE_EXPAND_KEY` in `client/src/components/ArcSidebar.tsx`.
- Liveness/rollup: `liveConversationIds`, `rollupMissions` in the same file.
- Tests: `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx` (mission lists, live streaming ids, `window.localStorage.clear()` in setup, pinned-collapsed rail via `specrails-desktop:sidebar-mode:left`) and `ArcSidebar.test.tsx`. Reuse their provider mocks; assert the live-change case by re-rendering with a changed streaming/background id set. State updates are synchronous React state; use `userEvent`/`fireEvent` inside the file's existing `act` conventions.
- Equivalent filter helper: none exists; confirm React/Vitest versions from `client/package.json` when implementing.

## Assumptions

- Should the filter state be remembered between sessions? Assumed yes (localStorage).
- What to do with groups that become empty? Assumed hidden (Favorites/Home); project rows stay visible without a tree.
- Should the open mission stay visible when not live? Assumed yes.

## Risks / Trade-offs

- [Open mission visible though idle may look like a filter bug] → it is the active row highlight; documented in spec.
- [Project rows stay while their trees are empty] → intentional; the empty-state line explains the list.
- [Stale memo when `agentChat.active` changes] → included in memo deps; covered by a test.
- [localStorage unavailable] → try/catch, defaults to off.

## Blast radius

- `client/src/components/ArcSidebar.tsx`: toggle, state + persistence, visible lists, empty state.
- `client/src/lib/filterActiveConversations.ts` (create): pure helper.
- `client/src/lib/filterActiveConversations.test.ts` (create): helper unit tests.
- `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx`: toggle, aria-pressed, filtering, empty state, live change, persistence, corrupt value, rail.
- `client/src/components/__tests__/ArcSidebar.test.tsx`: button absent outside Mission mode (extend only if needed).
- `client/src/locales/{de,en,es,fr,it,ja,pt,zh}/nav.json`: three new keys each.
- `docs/internals/source-map.md`: regenerate via `npm run docs:source-map` because a file is added.

## Out-of-scope findings

- `homeConversations` is not memoized (new array each render); left as is.
