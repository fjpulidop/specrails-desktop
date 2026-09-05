## 1. Server — index and search

- [x] 1.1 Add a desktop-db migration creating `agent_messages_fts` (FTS5, `content='agent_messages'`, `content_rowid='rowid'`, `tokenize='trigram remove_diacritics 1'`), the three sync triggers (insert / delete / update of content), and the initial `'rebuild'`; expose `rebuildAgentSearchIndex(db)` for reuse
- [x] 1.2 Implement `searchAgentConversations(db, q, limit)` in `server/agent-store.ts`: title `LIKE` match ∪ FTS content match (`role IN ('user','assistant')`, best `bm25` row per conversation, `snippet()` converted to plain text + highlight ranges), ordered title → rank → `updated_at DESC`; substring fallback when `q` is shorter than 3 characters
- [x] 1.3 Add `GET /api/agent/search` to `server/agent-chat-router.ts` (`q` required, 400 on blank; `limit` default 20, max 50) returning `{ results: MissionSearchResult[] }`
- [x] 1.4 Server tests (`:memory:` DB): trigger sync on insert/update/delete, title hit, content hit with snippet ranges, diacritics fold, system-row exclusion, ranking order, short-query fallback, router 400 + limit clamp

## 2. Client — pure search model

- [x] 2.1 Create `client/src/lib/mission-search.ts`: `foldText` (lowercase + NFD strip), `matchMissionTitles(conversations, q, max)`, `mergeMissionResults(titleHits, serverHits)` (dedupe by id, server row wins, order title → server rank → `updated_at`), `groupOrderForMode(uiMode)`; add `searchMissions(q, limit, signal)` to `client/src/lib/agent-api.ts`
- [x] 2.2 Unit tests for the pure module: fold, title match, merge dedupe/ordering, empty-query recents, mode ordering

## 3. Client — palette integration

- [x] 3.1 In `CommandPalette.tsx` switch to `shouldFilter={false}` with a local matcher for the existing groups (case-insensitive substring over value + keywords), preserving today's visible behavior
- [x] 3.2 Add the Missions group fed by `useAgentChat()` (`conversations`, `liveByConversation`, `selectConversation`, `open`) + the debounced (~80 ms) aborted server search; empty query = 8 most recent
- [x] 3.3 Render the premium mission row: title / untitled fallback, snippet with `<mark>` from highlight ranges, pinned project name from `useDesktop().projects` (Home fallback), relative `updated_at` with `getDateFnsLocale()`, streaming pulse dot
- [x] 3.4 Mode-aware group order + placeholder via `useUiMode()`; selection → `selectConversation(id)` and `open()` in `kanban` mode; close palette
- [x] 3.5 Component tests in `CommandPalette.test.tsx`: group order per mode, title row before server resolve, server merge adds snippet, stale response discarded, Enter wiring per mode

## 4. i18n and docs

- [x] 4.1 `commands` namespace ×8: `palette.groups.missions`, `palette.searchPlaceholderAgent`, `palette.missions.untitled`, `palette.missions.home`, `palette.missions.empty` (locale-parity test green)
- [x] 4.2 Update CLAUDE.md (desktop agent chat section: ⌘K mission search, FTS index, endpoint) and `docs/guide/<lang>/integrations/6-agent-chat.md` ×8 with a short "Find a mission" paragraph

## 5. Gates

- [x] 5.1 `npm run typecheck`, `npm test`, `npm run test:coverage` (server 80/70), `cd client && npm run test:coverage` (client 80/70); iterate until green
- [ ] 5.2 Manual: Agent Mode ⌘K → Missions first, type a content fragment → row enriches with snippet, Enter opens mission; Board mode → floating panel opens; accented query finds unaccented text and vice versa
