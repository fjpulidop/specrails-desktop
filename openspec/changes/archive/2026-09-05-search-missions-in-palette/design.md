## Context

The ⌘K palette (`client/src/components/CommandPalette.tsx`, cmdk 1.x) lists Projects (from `useDesktop`), Spec commands + 10 recent Jobs (fetched on open), and Navigation. It is opened by the shortcut, the macOS title-bar pill, and the Agent-Mode ArcSidebar **Search** button (a synthetic ⌘K keydown). Missions live app-globally in `desktop.sqlite` (`agent_conversations` / `agent_messages`, better-sqlite3 12.8 → SQLite 3.51.3 with FTS5, trigram tokenizer and `remove_diacritics` all compiled in). `AgentChatContext` already holds every conversation (`conversations`, newest-first, limit 100 today), the per-conversation live state (`liveByConversation`), `selectConversation(id)` (also exits Builder mode) and `open()` for the floating panel. `useUiMode()` exposes `'kanban' | 'agent'`.

Measured on a real machine: 82 missions, 752 messages, ~650 KB of content; a full `LIKE` scan takes ~1 ms. Speed is therefore a latency-architecture problem (network round trip, debounce, render), not an engine problem — but the corpus is unbounded over the app's life, so the index is still the right long-term shape.

## Goals / Non-Goals

**Goals:**
- Missions searchable by title and content from the palette every user already opens, with results that feel instantaneous.
- Mission-first experience in Agent Mode without forking the palette.
- Zero maintenance burden on existing message writers; zero wire-compat risk.
- Honest results: only real message text (user/assistant) matches; nothing synthesized.

**Non-Goals:**
- Builder (`blueprint_*`) and per-project Explore/sidebar chats (`chat_conversations`).
- Jump-to-message / scroll-to-hit on Enter (v2 candidate; the endpoint already returns the matched message id so it costs nothing later).
- Live re-query while a mission streams; a message becomes searchable when it persists.
- Replacing the mission selector's own title filter.

## Decisions

### D1 — Two-phase results: in-memory titles first, server content second
Every keystroke filters `agentChat.conversations` by title synchronously (case- and diacritics-insensitive substring via `String.prototype.normalize('NFD')` strip), so the group repaints in the same frame. In parallel a debounced (~80 ms) `GET /api/agent/search?q=` runs; the previous in-flight request is aborted with `AbortController`; on arrival server rows are merged by conversation id (a server row REPLACES the title-only row, adding snippet + match kind). No spinner: rows enrich in place.
*Alternatives*: server-only (every keystroke waits a round trip — feels laggy even at 5 ms because of debounce); client-only over all message bodies (needs the whole corpus in the browser, ~650 KB today and unbounded; refetch/invalidation story is worse than an index).

### D2 — Standard FTS5 table with trigram tokenizer + diacritics folding
The desktop-db migration adds `agent_messages_fts USING fts5(conversation_id UNINDEXED, message_id UNINDEXED, role UNINDEXED, content, tokenize='trigram remove_diacritics 1')` plus three triggers (`AFTER INSERT`, `AFTER DELETE`, `AFTER UPDATE OF content, role, conversation_id`) that delete-then-reinsert by `message_id`, and runs `rebuildAgentSearchIndex` once so existing history is indexed on upgrade.
*Why a standard (own-content) table, not external-content*: `agent_messages` has a TEXT primary key, so its rowid is IMPLICIT and a `VACUUM` may renumber it — an external-content index keyed on that rowid would desync silently. The copy costs ~650 KB today (unbounded but linear) and buys a join-free query (`role` filter and `conversation_id` grouping live in the index) and a clean delete-by-id path. `rebuildAgentSearchIndex` stays the escape hatch for bulk writers that bypass SQL triggers.
*Why trigram*: users search chats by a remembered fragment ("etris", "scor"), i.e. substring semantics; trigram gives that WITH an index and `highlight()`/`bm25()`. `unicode61` would require prefix queries and miss mid-word fragments. Queries shorter than 3 characters (the trigram minimum) fall back to a bounded `LIKE` scan — sub-millisecond at current sizes.
*Snippet*: `snippet()` counts trigram TOKENS (≈ characters), so it cannot produce a readable window; the query uses `highlight()` on the full content with private-use markers and the store windows it in JS (~60 chars each side of the first match, whitespace collapsed) before converting markers to `[start, end)` ranges.
*Why `remove_diacritics 1`*: the user base writes Spanish; "mision" must find "misión".

### D3 — Exclude `system` rows at query time, not in the index
The triggers index every row (simplest, no role branching in SQL); the search query joins back to `agent_messages` and filters `role IN ('user','assistant')`. `system` rows are app-authored JSON envelopes (PR-decision cards) whose uuids/keys would otherwise match any id-like query.
*Alternative*: `WHERE role != 'system'` inside the insert trigger — rejected because a later `updateAgentMessageContent` on a system row would desync the index unless every trigger repeats the branch.

### D4 — One row per mission, best hit wins, ranked server-side
`searchAgentConversations(db, q, limit)` returns at most `limit` conversations: title matches (`agent_conversations.title LIKE` with diacritics folded via the same FTS on a tiny virtual table is overkill — a `LOWER(title) LIKE` plus client fold is enough) unioned with content matches grouped by `conversation_id`, keeping per conversation the best `bm25` row and its `snippet(agent_messages_fts, 0, '<mark>', '</mark>', '…', 12)`. Order: title match first, then bm25 rank, then `updated_at DESC`. The snippet is returned as plain text with `mark` boundaries encoded as a `[start,end]` pair per fragment, not HTML — the client renders `<mark>` itself, so no `dangerouslySetInnerHTML`.

### D5 — cmdk keeps its filter OFF for the Missions group
cmdk filters items by `value`/`keywords` with its own fuzzy scorer; a content hit whose title doesn't contain the query would be hidden. The palette sets `shouldFilter={false}` and applies its own per-group filtering: the existing groups (projects, commands, jobs, navigation) reuse cmdk's exported `defaultFilter` semantics through a tiny local matcher (case-insensitive substring over value + keywords — the practical behavior users see today), and the Missions group renders exactly what the merge in D1 produced. This keeps one `Command.Dialog`, one input, one keyboard model.
*Alternative*: injecting the query into each mission item's `keywords` so cmdk "matches" — fragile and it still reorders by cmdk's score, defeating server ranking.

### D6 — Mode-aware ordering and copy, single component
`useUiMode()` decides group order and placeholder: `agent` → Missions, Projects, Jobs, Navigation and `commands:palette.searchPlaceholderAgent`; `kanban` → Projects, Missions, Jobs, Navigation and the existing placeholder. Empty query shows the 8 most recent missions (`conversations` slice) so the group is discoverable before typing. Selecting a mission calls `selectConversation(id)`; in `kanban` mode it additionally calls `open()` so the floating panel appears on that mission.

### D7 — Premium row, honest metadata
Row = mission title (or the same untitled fallback the mission selector uses) · snippet with highlighted fragments (content hits) or nothing (title hits) · pinned project name resolved from `useDesktop().projects` (Home when null) · relative time from `updated_at` via date-fns with `getDateFnsLocale()` · the live pulse dot when `liveByConversation[id]?.isStreaming` is true (same primitive as the mission selector). No counts, no "N matches" — the endpoint doesn't compute totals and the UI must not invent them.

## Risks / Trade-offs

- [FTS table drifts from `agent_messages` if a future writer bypasses SQL triggers (e.g. bulk import)] → the migration's `rebuild` is idempotent; expose it as a one-line helper (`rebuildAgentSearchIndex`) and call it from the migration and from tests; document in `desktop-db.ts`.
- [Trigram needs ≥3 chars; 1–2 char queries] → fall back to `LIKE` with `limit`; both paths share the same row shape so the client never knows.
- [Very large single messages (48 KB observed)] → `snippet()` bounds output; the endpoint never returns full content.
- [`conversations` in context is capped at 100 rows] → title phase covers the newest 100; the server phase covers everything, so older missions still surface by title through the server union. Raise the cap only if profiling shows the need.
- [Palette test suite renders cmdk in jsdom] → keep new logic in a pure module (`client/src/lib/mission-search.ts`: fold, title match, merge, ordering) with unit tests; the component test asserts group order per mode and the Enter → `selectConversation`/`open` wiring with a mocked API.
- [Coverage gates 80/70] → server: `agent-store` search tests over a `:memory:` DB (title hit, content hit, diacritics, system-row exclusion, short-query fallback, trigger sync on insert/update/delete); router test for `400` on missing `q`.

## Migration Plan

Additive only. The migration creates the FTS table + triggers + rebuild inside the existing migration runner (`desktop-db.ts`), so a fresh install and an upgrade converge. Rollback: remove the Missions group from the palette; the virtual table and triggers are harmless if unused. No flag — the feature has no cost when the palette is closed and the endpoint is loopback-only like every `/api/agent/*` route.

## Open Questions

None blocking. Jump-to-message on Enter is deferred; the search response already carries `messageId` so it can be added without an API change.
