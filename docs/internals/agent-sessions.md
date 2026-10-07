# Core agent sessions in Desktop

Specrails Core runs conversational agent work as **resident sessions**: one
provider process per conversation that survives between turns, owns its
sub-agents and records everything in a durable journal. Desktop hosts that
runtime, projects its events into its own tables and renders them. This page is
the map for that split. The OpenSpec change
[`core-agent-sessions-host`](../../openspec/changes/core-agent-sessions-host/design.md)
holds the decisions; Core's side is documented in Core's `docs/agent-sessions/`.

## Who owns what

| Concern | Owner |
| --- | --- |
| Provider processes, provider frames, sub-agent lifecycle, steering, interrupt | Core drivers (Claude stream-json, Codex app-server) |
| Usage normalisation (per-turn deltas, billed vs estimated cost) | Core |
| Durable journal `~/.specrails/sessions/<scope>/sessions.sqlite` | Core (single writer per scope) |
| Host supervision (one host per scope), protocol client, generic projection | Desktop [`server/modules/agent-sessions`](../../server/modules/agent-sessions/README.md) |
| Surface tables, accounting rows, WebSocket events, UI | Desktop surfaces (missions today) |
| Queue, receipts, MCP capability, tiers, titles, PR/rail cards | Desktop product rules (unchanged) |

Desktop never interprets provider frames and never branches on provider ids:
it relies on the driver capabilities Core declares in `initialize`.

## Scopes and hosts

A scope is a project slug, or `global` for missions without a pinned project.
Desktop starts `specrails-core runtime host --stdio --scope <scope>` lazily on
the first session of that scope ([`CoreHostLauncher`](../../server/modules/agent-sessions/adapters/host-process.ts))
and supervises it in the [`SessionHostRegistry`](../../server/modules/agent-sessions/runtime/session-host-registry.ts):

- pings with a timeout; unexpected exits restart with capped backoff;
- after a restart, tracked sessions are resumed and replayed from their cursors;
- repeated failures mark the scope `degraded`: new turns use the legacy
  transport and the mission shows a notice with Retry;
- causes a restart cannot fix degrade at once: another host owns the journal
  (`journal_locked`), the protocol does not match, or Core lacks the host;
- removing a project stops its host; app shutdown sends `host.shutdown`, then
  tree-kills.

## Turns: the runner seam

Missions run turns through `nativeLiveSessionRunner(adapter) ?? runAiCliInvocation`.
[`createCoreSessionRunner`](../../server/modules/missions/runtime/core-session-runner.ts)
is a third implementation of that contract. [`MissionCoreSessions.prepareTurn`](../../server/modules/missions/runtime/mission-core-sessions.ts)
selects it when the scope is available and Core lists a driver for the
conversation's provider. The runner opens or resumes the session, sends the
prompt as one input, maps user-turn events to `AdapterEvent`s, delivers steer
through `session.send`, and returns Core's normalised usage. Stop goes through a
`TurnHandle` (`session.interrupt`); deleting a mission calls `session.close`.

MCP: each turn mints a capability and rewrites the conversation's capability
file; the bridge re-reads it per request, so a resident provider always presents
the current turn's capability. The capability outlives the turn while
background work may still call Specrails tools, until the next turn rotates it
or Core retires the process. Structured MCP specs include the Specrails bridge,
external servers and app-installed plugin servers.

## Projection

```
Core journal ──session.event──▶ SessionEventPump ──ProjectionOp[]──▶ ProjectionSink (surface)
                (seq, dedupe,      (domain/projection.ts,             one transaction:
                 gap fill)          pure reducer)                      rows + cursor, then WS
```

- [`SessionEventPump`](../../server/modules/agent-sessions/application/session-event-pump.ts)
  applies each `(sessionId, seq)` once and in order; gaps and `session.lagged`
  are filled from `session.events`. On attach it rebuilds in-memory state up to
  the sink cursor without re-applying.
- [`MissionSessionProjector`](../../server/modules/missions/runtime/mission-session-projector.ts)
  is the missions sink. It persists what happens outside user turns: sub-agents
  (`agent_subagents`) and their output (`agent_subagent_events`), resident phase
  and cursor (`agent_session_cursors`), and continuation turns as messages with
  `turn_origin` `subagent`/`system` plus invocations with `origin`. User turns
  are settled by the mission manager.
- Continuation turns get a deterministic invocation id, so replay never records
  a turn twice. `POST /api/agent/conversations/:id/session/rebuild` resets the
  derived rows and replays the journal silently (see the
  [API reference](api-reference.md)).

## Sub-agent policy

[`resolveSubagentPolicy`](../../server/modules/agent-sessions/domain/subagent-policy.ts)
maps `(surface, project setting, app setting)` to `policy.subagents`. A
conversation with a project follows the project's "Allow sub-agents" setting.
A conversation without a project follows the app setting. Both default to off.
Implement pipelines are not a surface, so they never resolve a policy. The
composition root wires the resolver into `MissionCoreSessions`. Settings
routes call `ProjectRegistry.notifySettingsChanged`, and
`MissionCoreSessions.refreshSubagentPolicy` then sends the complete policy to
each open session of that scope. Core's `session.update` replaces the policy as
a whole and ignores unchanged configurations, so the resident process is not
restarted for nothing. A session with running sub-agents reports the change as
deferred, and the mission offers "Stop agents and apply now". If Core rejects
a policy with `policy_unenforceable`, the mission shows a localized error that
names the provider and the setting.

## Sub-agent runtime (who launches them)

The hybrid runtime decides who launches sub-agents once the policy allows them.
[`resolveSubagentRuntime`](../../server/modules/agent-sessions/domain/subagent-policy.ts)
maps the "Run sub-agents with" choice (project setting `subagentRuntime`, or the
app setting for missions without a project), the mission's provider and the
Core capabilities to `policy.subagentRuntime`:

| Choice | Mission provider | Runtime sent to Core |
| --- | --- | --- |
| `null` (same as the mission agent) | any | `{ mode: 'native' }` |
| provider P, model M, effort E | P | `{ mode: 'native', model?, effort? }`. Only overrides the driver declares through `capabilities.subagentModel` / `subagentEffort` are sent (Claude: model only, Codex: both) |
| provider P, model M, effort E | not P | `{ mode: 'delegated', driver: P, model: M, effort? }` |

When Core lacks `capabilities.delegation`, or P is not one of its drivers, the
mission stays native and receives an `agent_session_notice` with code
`subagents.delegation_unsupported` or `subagents.driver_unavailable` and the
`provider`. A setting change refreshes open sessions like the policy does.

In a delegated session Core disables the provider's own sub-agent tool and the
mission agent launches sub-agents through the Specrails MCP: `specrails_mission`
actions `subagent_start`, `subagent_wait`, `subagent_list` and `subagent_stop`
call `AgentChatManager.delegateSubagent` / `waitSubagents` / `stopSubagents`,
which map to Core's `session.delegate`, `session.waitSubagents` and
`session.stopSubagents`. `MissionCoreSessions` adds a short system prompt
addendum that tells the agent how to delegate. Each delegated sub-agent is a
Core child session (its own process, no shared prompt cache), mirrored into the
mission's tree with `delegated: { driver, model }`; results nobody waited for
arrive as a system continuation turn. Its usage is billed separately
(`subagent.usage` with `billing: 'separate'`): the projector records it as its
own invocation (`core-subagent:<conversation>:<subagent>:<seq>`, origin
`subagent`, the child's provider) on top of the parent's cost. Migration 34
adds `delegated_driver` / `delegated_model` to `agent_subagents`.

## UI

The client keeps session state in [`MissionSessionsContext`](../../client/src/features/missions/context/MissionSessionsContext.tsx)
over a pure reducer ([`mission-sessions.ts`](../../client/src/features/missions/lib/mission-sessions.ts)).
Each launch renders as a compact line under the message whose `core_turn_id`
started it. `agent_done` carries `coreTurnId`, so the anchor exists without a
reload. A launch whose reply has no text sits after the message that preceded
it. The line is expanded while agents work and folds once they finish. The
sidebar keeps a live dot for missions with background work. Details are in the
[missions feature guide](../../client/src/features/missions/README.md).

## Rollout

`SPECRAILS_CORE_SESSIONS` (`off` | `auto` | `on`, see
[configuration](configuration.md)) gates the Core path. It only takes effect
when the selected Core advertises `sessions` and its session contract matches
([`core-compat.ts`](../../server/core-compat.ts)). Otherwise, missions keep
their legacy transports.

## Verify

```bash
npx vitest run server/modules/agent-sessions server/modules/missions
npm run test --prefix client -- src/features/missions
```
