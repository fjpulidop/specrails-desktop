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
through `session.send`, and returns Core's normalised usage. `input.state` `queued`/`started` marks the turn input `received`; the
first `turn.output` (or a clean completion) lets the manager mark it `read`
server-side, so the prompt asks for no `acknowledge_inputs` call
([read receipts](../../server/modules/missions/README.md#input-read-receipts)). Stop goes through a
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
- A conversation can own more than one Core session: its own (id = the
  conversation id) and, in Intent, `flow:<flowId>`. Each is projected by its own
  `MissionSessionProjector`: the cursor is keyed by `(conversation_id,
  core_session_id)` and every sub-agent row records `core_session_id`
  (desktop migration 35). The Intent projector bills its continuation turns and
  delegated sub-agents with `surface: 'flow'` (so they land in
  `GET /flow/:flowId/cost` and the mission's `flowCostUsd`), and tags its
  WebSocket messages with `coreSessionId`. The client keys them by
  conversation, so the sub-agents card shows an Intent session's agents while in Intent;
  the resident state it receives is the conversation's across its sessions.
- A Core session keeps the driver that opened it, so the mission's own session
  has generations (desktop migration 36, `agent_core_sessions`): generation 0
  keeps the conversation id, generation n is `<conversationId>:g<n>`, and the
  table records the provider the current generation was opened with. A turn on
  another provider (after a switch, also after a restart) or on a closed
  session closes the current generation and opens the next one, seeded with
  the conversation history through the fresh-session prompt path. The runner
  also verifies the driver Core reports when it resumes a session; a mismatch
  or a closed session (`session_driver_mismatch` / `session_closed`, nothing
  sent) renews once and retries. A model or effort change on the same provider
  stays in the session (`session.update`). Later generations project as the
  mission's own (untagged broadcasts, `agent-chat` billing, ids keyed by the
  generation's session id).
- Continuation turns get a deterministic invocation id, so replay never records
  a turn twice. Ids of an Intent session include its session id
  (`core-turn:<conversation>:flow:<flowId>:<turn>`,
  `core-subagent:<conversation>:flow:<flowId>:<subagent>:<seq>`), so the two
  sessions never collide; a rebuild replays every session of the conversation. `POST /api/agent/conversations/:id/session/rebuild` resets the
  derived rows and replays the journal silently (see the
  [API reference](api-reference.md)).

## Sub-agent policy

[`resolveSubagentPolicy`](../../server/modules/agent-sessions/domain/subagent-policy.ts)
maps `(surface, project setting, app setting)` to `policy.subagents`. A
conversation with a project follows the project's "Allow sub-agents" setting.
A conversation without a project follows the app setting. Both default to on
(only a stored `false` turns them off). Implement pipelines are not a surface, so they never resolve a policy. The
composition root wires the resolver into `MissionCoreSessions`. Settings
routes call `ProjectRegistry.notifySettingsChanged`, and
`MissionCoreSessions.refreshSubagentPolicy` then sends the complete policy to
each open session of that scope. Core's `session.update` replaces the policy as
a whole and ignores unchanged configurations, so the resident process is not
restarted for nothing. A session with running sub-agents reports the change as
deferred, and the mission offers "Stop agents and apply now". If Core rejects
a policy with `policy_unenforceable`, the mission shows a localized error that
names the provider and the setting.

### The sub-agent tool follows the setting

With sub-agents off, the mission's Claude process has no `Agent` tool at all
(its definition is ~5.4k characters, ~1.5k tokens, on every request). The
setting above is the only source, on both transports:

- Core sessions: `policy.subagents: 'disabled'`. Core's Claude driver then
  launches `--tools Read,Grep,Glob` plus `--disallowedTools Agent,Task`
  (enabled: `--tools Read,Grep,Glob,Agent,Task`); verified in the bundled Core 6.11.
- Legacy stream-json turns: `missionSpawnPolicy(adapter, subagents)` sets
  `nativeSubagents: 'disabled'`, and the Claude adapter drops `Agent` from the
  read-only set (`Read,Grep,Glob,WebFetch,WebSearch`) or, with the read-only
  kill switch off, adds `--disallowedTools Agent,Task`.
- Codex, Gemini, Kimi and local engines have no sub-agent tool and ignore it.

The operator core never mentions sub-agents or the `Agent` tool, so one static
core serves both states. The delegated-runtime addendum is only sent while
sub-agents are on (`MissionCoreSessions.delegates` is false otherwise).

Toggling mid-mission keeps the conversation. Claude fixes its tools when the
process starts, so the change applies to the next turn: Core's
`session.update` with a changed policy retires the idle provider process
(deferred while sub-agents run) and the next turn starts a new one that resumes
the same provider session (`--resume`), in the same Core session and
generation. Each turn also re-sends the policy, so a toggle that no refresh
reached (e.g. after a Desktop restart) still applies. Legacy turns spawn a
process per turn with `--resume`. Either way, the first request after a toggle
has a different tool list, so it rewrites the provider's prompt cache once.

## Connectors in missions

Besides the Specrails bridge, External MCP servers and plugin servers, a
mission session loads the provider's own connectors, filtered by the app
setting "Connectors in missions" (rules in the
[missions module](../../server/modules/missions/README.md#connectors-in-missions)).
`MissionCoreSessions` asks the injected `connectors` port for a plan per turn
and sets `policy.mcp`:

- Codex: `inheritUserScope: false` with a name-only spec per enabled server.
  Core's Codex driver disables each declared server that is not listed and,
  for a spec without transport, only emits `mcp_servers.<name>.enabled=true`,
  so no Core change is needed.
- Claude: `inheritUserScope: true`. Core's `--setting-sources project,local`
  already leaves the `~/.claude.json` servers out; the claude.ai account
  connectors load and are switched off through `deniedMcpServers` in the
  mission cwd's `.claude/settings.local.json`.

Measured with throwaway replicas (Claude: the Core argv with `--tools
Read,Grep,Glob`, the captured Specrails tool list on a stub server, haiku, a
one-tool-call prompt; Codex: `codex exec`, gpt-6-luna, a one-word reply):

| Run | Request 1 input | Request 2 cache write |
| --- | --- | --- |
| Claude, today (Drive and Docs connected; Gmail and Calendar need sign-in) | 39.8k | 14.8k (connector definitions arrive mid-turn, `toolSearchAbsent: true`) |
| Claude, Google Drive denied | 39.8k | 3.9k |
| Claude, every account connector denied | 39.8k | 0.2k |
| Claude, `ToolSearch` in `--tools` | 7.5k | 0.9k (every MCP tool deferred, Specrails' too) |
| Claude, `ToolSearch` + Specrails tools `anthropic/alwaysLoad` except two | 38.1k | 2.5k (cache kept) |
| Claude, `ToolSearch` + every Specrails tool `alwaysLoad` | 39.8k | 40.8k (full rewrite: deferral, and its beta, only start mid-turn) |

So Google Drive costs ~10.9k tokens and Claude Docs ~3.7k per Claude
request, sent in full. The user-scope servers would cost more if loaded
without deferral (definitions measured with `tools/list`): premiere-pro 367
tools ~200k tokens, tokensave 81 ~23k, blender 10 ~7.3k, headroom 3 ~0.5k.
That is why Claude user-scope servers are only injected when the Claude
driver declares `capabilities.deferredMcpTools`.

Codex already defers MCP tools (tool search, one line per server in the
prompt): with every user server off a turn read 15,474 input tokens; with
node_repl, openaiDeveloperDocs, premiere-pro or blender alone 16,074–16,124,
and with all of them 16,178. A run where only the config-disabled
computer-use was "enabled" also read 16,074, so most of the ~600 is run
variance, not the servers: the whole set costs under ~700 tokens a turn.

### Claude tool search needs a Core change

Claude Code's tool search (deferred MCP tool loading) is on by default in
2.1.322 (`ENABLE_TOOL_SEARCH` unset), but only when the `ToolSearch` tool is
available. Core's read-only Claude sessions pass `--tools Read,Grep,Glob[,Agent,Task]`,
which removes it; `--allowedTools` and `ENABLE_TOOL_SEARCH=true|force` do not
bring it back (verified). The Core change: add `ToolSearch` to
`CLAUDE_READ_ONLY_TOOLS` (`drivers/claude/argv.ts`) and declare
`capabilities.deferredMcpTools: true` on the Claude driver. Resumed sessions
that ran without tool search stay without it until compacted unless the
host sets `ENABLE_TOOL_SEARCH=true`. To keep the Specrails tools loaded while
connectors defer, the bridge can mark them `_meta["anthropic/alwaysLoad"]`,
leaving at least one tool deferred so the tool-search beta is on from the
first request (the last two rows above).

## Permission boundary

Mission sessions are read-only. `MissionCoreSessions.prepareTurn` takes the
`permissions` and `tools` fields from `missionSessionBoundary`. For Claude that
is `bypass` plus `tools: { mode: 'read-only' }`, because plan mode would block
Specrails MCP calls. For Codex it is `permissions: 'read-only'`, the read-only
sandbox. A tool restriction is only requested from a driver that advertises
`toolFiltering`. See [read-only missions](mission-read-only-policy.md).

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

## Context used indicator

A mission resumes one provider session per conversation, so its context grows
until the provider compacts it. After each settled turn,
[`mission-context-usage.ts`](../../server/modules/missions/runtime/mission-context-usage.ts)
measures how full that window is from what the provider reported, and nothing else:

- Core sessions (the default path): Core's own `turn.completed.context`
  (`{ usedTokens, windowTokens, model, compacted? }`, Core 6.12+), which the
  Core session runner forwards as an `other` event of type `core-context-usage`.
  It wins over every fallback below; a missing window falls back to the last
  window this mission measured, then to `[1m]`.
- Claude: input + cache write + cache read of the newest root (non-sub-agent)
  `assistant` frame. Output tokens are never added and frames are never summed.
  The window is `result.modelUsage[<main model>].contextWindow`; a `[1m]` model
  is 1,000,000. A `compact_boundary` frame makes the usage unknown until the
  next response.
- Codex: the last `token_count` in the session rollout
  (`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl`, tail only, see
  [`codex-rollout-reader.ts`](../../server/modules/missions/runtime/codex-rollout-reader.ts)).
- Claude through a Core that does not report `context` yet: the session
  transcript tail (below).
- Other providers, and turns without the data, store no snapshot.

The snapshot is stored on `agent_conversations.context_usage` (migration 40),
returned as `contextUsage` on the conversation, and announced with
`agent_context_usage` (`contextUsage: null` = cleared). A provider session
reset (failure, stale resume, new Core generation, provider switch) clears it.
Intent turns never touch it. The composer ring
([`AgentContextUsageRing`](../../client/src/features/missions/components/AgentContextUsageRing.tsx))
is hidden without a window (except as the neutral entry point of "Start fresh with a summary", below) and turns warning at 75% and destructive at 90%.
Its popover offers "Start fresh with a summary" (highlighted from 75%): the
server writes a summary of the mission, stores it as a transcript marker,
clears the provider session and the snapshot and, for Core missions, opens the
next generation. The next turn is seeded with the summary instead of the raw
history. See the [missions module](../../server/modules/missions/README.md#start-fresh-with-a-summary).

Core session turns map provider frames to normalised events, and Core's
`Usage` is a per-turn delta with no context window. For a Claude mission on the
Core path, Desktop therefore reads the tail of the Claude Code transcript
(`$CLAUDE_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl`, see
[`claude-transcript-reader.ts`](../../server/modules/missions/runtime/claude-transcript-reader.ts)).
The session id is the one Core reports in `session.provider-ref`. The
transcript has no window either. The window is the last one this mission
measured from a stream-json turn, or 1,000,000 for a `[1m]` model; otherwise it
stays null and the ring is hidden. No per-model table is used.

## Context budget

A fresh mission turn sends the provider its system prompt, the cwd instruction
files the CLI auto-loads, the MCP tool list and the turn (project snapshot,
bounded history, message). The operator text used to be two layers: a 69.6k
character manual written to `~/.specrails/agent-cwd/CLAUDE.md` (Claude injects
it as project instructions, about 24.5k tokens) plus an 11.6k character system
prompt. It is now one compact core (`buildOperatorSystemPrompt()`, about 17k
characters, ~6k tokens) sent as the system prompt, with the cwd files reduced to a short
pointer. The detail moved verbatim into `specrails_guide` topics that the agent
reads on demand (see the [missions module](../../server/modules/missions/README.md#operator-core-and-guide-topics)
and [the MCP guide](../mcp.md#guide-topics)).

Measured with a throwaway replica of the Core Claude argv (`--setting-sources
project,local --system-prompt-file`, read-only tools, the captured Specrails
tool list on a stub MCP, `--model haiku`, empty cwd), a "Hola" turn's first
request went from 64,733 to 42,978 input tokens (−21.8k, −34%): the operator
text went from ~28.0k tokens to ~6.3k (core 5,980 plus the cwd pointer). The
rest (~36.7k) is the MCP tool list and Claude Code's own context. Codex,
Gemini and Kimi read the core from their cwd instructions file (`AGENTS.md`,
`GEMINI.md`, `.kimi-code/AGENTS.md`) once per session instead of the 69.6k
manual, and it is no longer repeated in every user turn, so it does not pile
up in a resumed session's history. Only local engines, which read no file,
still get it folded into the turn.

## Rollout

`SPECRAILS_CORE_SESSIONS` (`auto` by default, `on` or `off`, see
[configuration](configuration.md)) gates the Core path. It only takes effect
when the selected Core advertises `sessions` and its session contract matches
([`core-compat.ts`](../../server/core-compat.ts)). Otherwise, missions keep
their legacy transports.

## Verify

```bash
npx vitest run server/modules/agent-sessions server/modules/missions
npm run test --prefix client -- src/features/missions
```
