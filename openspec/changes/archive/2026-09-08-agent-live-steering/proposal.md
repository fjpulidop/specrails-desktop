## Why

Mission follow-ups currently wait for the entire provider invocation to finish. Corrections such as “include frontend and backend” therefore arrive after the agent may already have created the wrong spec or launched work with an outdated scope.

## What Changes

- Deliver new mission instructions through Claude/Codex native input during active work, retaining safe MCP delivery for other transports and preserving running tool operations and the original objective.
- Show pending and delivered messages honestly, retain attachments and repository references, and keep Send and Stop independently accessible.
- Preserve pending input across reconnects and prevent duplicate delivery, cross-conversation leakage, or automatic replay after Stop/restart.
- Continue with undelivered input after the current invocation if the provider offers no further safe delivery point; do not present this fallback as immediate native interruption.

## Capabilities

### New Capabilities

- `agent-live-steering`: Accept, deliver and reconcile mission instructions while the agent is working.

### Modified Capabilities

None. Existing idle-turn, provider selection, permissions and project binding contracts remain in force.

## Impact

Agent chat manager and persistence, authenticated MCP dispatch, agent operator instructions, chat HTTP/WebSocket contracts, mission composer and transcript, translations and regression tests. Existing multi-repository work stays on the current feature branch. Rails already launched remain independently managed; a mission follow-up does not silently rewrite a running rail job.
