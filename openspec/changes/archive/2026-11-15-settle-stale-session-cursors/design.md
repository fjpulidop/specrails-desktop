# Design

## Context

`POST /agent/conversations/:id/archive` refuses with `MISSION_LIVE` when `manager.isBusy`, when `conversationSessionState` (the busiest of the mission's Core session cursors) is non-idle or has live sub-agents, or when a background process is starting/running. `isBusy` is in memory and background processes are reconciled at startup by `BackgroundProcessStore.recover()`. Session cursors had no reconciliation: they are written only by `MissionSessionProjector` for sessions `MissionCoreSessions` tracks, and tracking starts lazily at a turn.

## Decisions

- **Settle at startup, unconditionally.** Core hosts are spawned per scope by Desktop (`specrails-core runtime host --stdio`) and stopped with `host.shutdown` plus tree-kill. When the server starts, no host, provider process or sub-agent from a previous run is alive, so any non-idle/live cursor is stale by construction. This mirrors `recover()` for background processes and `recoverPendingAgentInputs` for queued input. Alternative considered: asking Core per session at startup — needs hosts to be started eagerly for every scope with a stale row and adds a startup dependency on Core for a value that is known.
- **Keep `last_seq`.** Resetting it would make the next tracking replay the whole journal and re-apply its final (possibly stale) phase. Keeping it means only events after the settled point are applied.
- **`session.closed` settles to idle, without releasing the capability.** A closed session cannot be running. The capability belongs to the mission, not the session; renewal closes an old generation while a new one may be resident, so releasing on close could revoke a capability still in use.
- **Sub-agent rows are untouched.** Only the counters the archive guard and `/active-turns` read are settled; sub-agent history stays as projected.

## Risks / Trade-offs

- Two servers sharing one `desktop.sqlite` is not a supported setup (each holds its own host and journal lock); with it, the second start would settle the first one's live cursors. Accepted.
- If Core resumes a session after a restart and its journal emits no new phase event, the mission shows idle until it does. Previously it showed a phase that could be wrong in either direction.
