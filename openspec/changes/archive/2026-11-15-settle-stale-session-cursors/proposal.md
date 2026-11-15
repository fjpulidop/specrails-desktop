# Proposal

## Why

A mission could not be archived ("Wait for this mission to finish its work before archiving it", `409 MISSION_LIVE`) long after all its work had ended. The archive guard reads the projected resident state of every Core session of the mission (`agent_session_cursors`). That state only changes when a *tracked* session receives journal events. When a Core host was killed, the server stopped, or an Intent session's journal ended without reaching `idle`, the cursor stayed at `turn`/`background`, `process_alive = 1` or `live_subagents > 0` forever: nothing reset it at startup, `Stop agents` only reaches tracked sessions, and the rebuild endpoint replays the same journal. One real install had 23 such rows.

## What Changes

- At server startup (`AgentChatManager` construction, next to `recoverPendingAgentInputs`), every Core session cursor is settled to `idle`, `process_alive = 0`, `live_subagents = 0`, keeping `last_seq`. Desktop supervises the Core hosts as child processes and kills them at shutdown, so no session can still run when the server starts. A session tracked again replays only newer journal events, which overwrite this state if Core resumes it.
- A `session.closed` projection op settles that session's resident state to idle (a closed session runs nothing). It does not release the mission capability, so closing an old generation cannot revoke the current one's.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `mission-archive`: "Refuse archive while live" adds that stale session state left by a restart or a closed session does not keep a mission live.

## Impact

- `server/modules/missions/runtime/agent-session-store.ts` (`settleOrphanedSessionCursors`), `agent-chat-manager.ts` (constructor), `mission-session-projector.ts` (`session.closed`), their tests, and the missions README.
- No migration, route, response shape or WebSocket contract change.
