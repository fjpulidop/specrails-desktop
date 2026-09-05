## Why

Missions (app-level agent conversations) pile up fast — a real machine already holds 80+ — and the only ways to find one are scrolling the ArcSidebar tree or the mission selector's title-only filter (which appears only above 8 rows). The Agent-Mode sidebar even ships a **Search** button, but it opens the ⌘K command palette, which knows nothing about missions. Finding "that mission where we talked about the Tetris scoring bug" is guesswork today.

## What Changes

- **Missions become a first-class ⌘K result group.** Typing in the command palette matches missions by **title AND message content** (user + assistant turns). Each row shows the mission title, a highlighted snippet of the matching text, the pinned project name and a relative date. Enter opens the mission (in Agent Mode it becomes the active mission; in Board mode the floating panel opens on it).
- **Mission-first ordering in Agent Mode.** When the UI is in Agent Mode the Missions group renders FIRST and the placeholder reads "Search missions, projects…"; in Board mode it renders after Projects. Same palette, same shortcut, same title-bar pill and sidebar button — only the ordering and copy change.
- **Two-phase speed.** Title matches come from the conversations already held in memory by `AgentChatContext` and render synchronously on every keystroke; content matches arrive from a new server search endpoint (debounced, previous request aborted) and merge in without a spinner. Empty query shows the most recent missions.
- **Server-side full-text index.** `desktop.sqlite` gains an FTS5 external-content index over `agent_messages.content` (trigram tokenizer with diacritics folding, so substring and accent-insensitive matching work — "misio" finds "misión"), kept in sync by triggers. `system`-role rows (app-authored PR-decision JSON envelopes) are excluded so a uuid or "projectId" never produces noise hits. New REST: `GET /api/agent/search?q=&limit=`.
- Out of scope: Builder (`blueprint_*`) and per-project Explore/sidebar chats (`chat_conversations`); jump-to-message on Enter; live re-query while a mission is streaming.

## Capabilities

### New Capabilities
- `mission-search`: full-text search over missions (title + message content) surfaced as a ⌘K palette group with mode-aware ordering, snippet highlighting, project/date metadata, and a server FTS5 index + endpoint behind it.

### Modified Capabilities
<!-- No existing requirement changes. `mac-titlebar-search` ("Search pill opens command palette") and the Agent-Mode sidebar Search button keep their behavior byte-identical; they simply now reach a palette that also lists missions. -->

## Impact

- **Server**: `server/desktop-db.ts` (one additive migration: `agent_messages_fts` virtual table + 3 sync triggers + initial rebuild), `server/agent-store.ts` (`searchAgentConversations`), `server/agent-chat-router.ts` (`GET /search`). Every existing writer of `agent_messages` (`addAgentMessage`, `updateAgentMessageContent`, `deleteAgentMessagesByIds`, cascade deletes) stays untouched — the triggers own index maintenance.
- **Client**: `client/src/components/CommandPalette.tsx` (Missions group, mode-aware order, own filtering for content hits since cmdk's fuzzy filter would hide rows whose title doesn't contain the query), `client/src/lib/agent-api.ts` (`searchMissions`), a small pure module for merging/ranking title hits with server hits, `AgentChatContext` consumers (`selectConversation`, `open`, `conversations`, `liveByConversation`).
- **i18n**: `commands` namespace ×8 (group heading, mode-specific placeholder, empty state, "N more" overflow).
- **Docs**: CLAUDE.md agent-chat section + `docs/guide/<lang>/integrations/6-agent-chat.md` ×8 (one paragraph: search missions from ⌘K).
- **Wire compat**: no changes to the mobile gateway, MCP tools, or the frozen `hub.*` messages. Rollback = drop the group from the palette; the FTS table is additive and harmless when unused.
