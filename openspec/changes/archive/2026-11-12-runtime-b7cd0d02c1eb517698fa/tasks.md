# Tasks

## 1. Filter helper

- [x] 1.1 Create `client/src/lib/filterActiveConversations.ts` exporting `filterActiveConversations(conversations, liveIds, activeId)` (generic over `{ id: string }`, keeps `liveIds.has(id) || id === activeId`, preserves order) and `client/src/lib/filterActiveConversations.test.ts` covering live-only, open-idle kept, null/undefined activeId, empty input, order preserved. Verify with `npm run test --prefix client -- src/lib/filterActiveConversations.test.ts`.

## 2. Locales

- [x] 2.1 Add `arcSidebar.activeFilter.label`, `.tooltip` and `.empty` ("No active missions") to `client/src/locales/{de,en,es,fr,it,ja,pt,zh}/nav.json`, translated per locale. Verify any locale-parity test in `client` still passes and the JSON parses.

## 3. Sidebar wiring

- [x] 3.1 In `client/src/components/ArcSidebar.tsx` add `ACTIVE_ONLY_KEY`, `loadActiveOnly` (true only for `'true'`), `saveActiveOnly` (try/catch) and `activeOnly` state, plus the memoized `visibleFavorites`, `visibleGrouped`, `visibleHome` (unfiltered references when off). Use them for group gates, rollups, rows, `ProjectItem` `conversations`/`hasTree`. Add tests in `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx`: filtering across Favorites/Home/project, restore on off, open idle mission kept, live-change reactivity on re-render, persistence and corrupt value fallback, collapsed rail still filtered.
- [x] 3.2 Render the icon toggle in the Projects label row (expanded and Mission mode only) with `aria-pressed`, i18n `aria-label`/`title`, focus ring and lit style, and the "No active missions" line when filtering leaves nothing. Add tests for button presence/absence (expanded vs rail, Mission vs non-Mission in `ArcSidebar.test.tsx`), `aria-pressed` toggling, keyboard activation and the empty state. Verify with `npm run test --prefix client -- src/components/__tests__/ArcSidebar.test.tsx src/components/__tests__/ArcSidebarAgentConversations.test.tsx`.

## 4. Docs index

- [x] 4.1 Regenerate `docs/internals/source-map.md` with `npm run docs:source-map` and verify it lists the new helper and its test.
