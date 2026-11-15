# Tasks

## 1. Settle stale session cursors

- [x] 1.1 Add `settleOrphanedSessionCursors(db)` to `server/modules/missions/runtime/agent-session-store.ts`: set `resident_phase = 'idle'`, `process_alive = 0`, `live_subagents = 0` on every non-idle/live cursor, keep `last_seq`, return the count.
- [x] 1.2 Call it from the `AgentChatManager` constructor after `recoverPendingAgentInputs(db)`.
- [x] 1.3 In `MissionSessionProjector`, settle the session to idle on `session.closed` (shared `applyResident` helper with `resident.phase`), without signalling a process end.

## 2. Tests and docs

- [x] 2.1 Store test: settles turn/background/live rows across conversations, keeps `last_seq`, leaves idle rows and returns the count; archive is then allowed.
- [x] 2.2 Manager test: constructing `AgentChatManager` settles a stale cursor.
- [x] 2.3 Projector test: `session.closed` after `session.phase: turn` leaves the cursor idle and broadcasts the state, without `onProcessEnded`.
- [x] 2.4 Document the startup reconciliation in `server/modules/missions/README.md`.
- [x] 2.5 Run `npx vitest run server/modules/missions`, `npm run typecheck`, `npm run audit:architecture`.
