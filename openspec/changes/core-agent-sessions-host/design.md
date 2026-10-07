## Context

Core change `agent-session-runtime` (specrails-core) adds a long-lived session host, `runtime host --stdio --scope`. It speaks JSON-RPC and owns the following:

- provider drivers: Claude resident stream-json and Codex resident app-server, with executor-backed drivers for the others;
- the provider-neutral session model, including continuation turns and a re-entrant sub-agent tree;
- session policy (sub-agents enabled or disabled, completion reaction, tools, permissions, MCP set, limits);
- usage semantics;
- a durable journal in `~/.specrails/sessions/<scope>/`.

Its evidence base is the provider spike in Core's `openspec/changes/agent-session-runtime/reference/`.

Desktop today:

- Missions (`agent-chat-manager.ts`, 1522 lines) spawn one provider process per turn and kill it on the first `result`.
- Desktop owns product rules around that call: durable queue and steering (`agent-input-store`, `agent-steering`), receipts, Specrails MCP capability files (`agent-mcp-config.ts`), external MCP registry, tiers, attachments, PR and rail cards, titles, accounting (`ai-invocations`), and a WS event contract consumed by `AgentChatContext`.
- Implementation runs already follow the target split: Desktop freezes configuration and projects Core's NDJSON events, while Core executes.

Engineering conventions ([modular architecture](../../../docs/internals/modular-architecture.md), [server modules](../../../server/modules/README.md)):

- capability modules with selective ports and adapters;
- domain and application files restricted by import allowlists in `architecture.test.ts`;
- composition at the roots;
- no DI container, service locator or base manager;
- interfaces only where variation is real;
- fakes that honour production contracts;
- transactions and lifecycle ownership preserved;
- append-only migrations;
- project isolation;
- `getApiBase()` and current-project refs on the client;
- 8 locales.

## Goals / Non-Goals

**Goals:**
- Missions execute on Core sessions with identical product behaviour plus native sub-agents for Claude and Codex.
- A Desktop-side architecture any conversational surface can adopt later without touching the host integration again.
- Honest, durable, replayable UI state across WebSocket reconnects, sidecar restarts and Core host restarts.
- Safe coexistence with the legacy transports until every surface migrates.
- The sub-agent toggle lands last and needs no protocol change, because the policy field exists from day one.

**Non-Goals:**
- Migrating explore, blueprint, agent refine, interactive jobs, loops' AI steps or one-shot features. Each gets its own follow-up change using the port introduced here.
- Deleting `server/providers/*`. That happens after the last surface migrates.
- Any provider-specific logic in Desktop. Desktop branches on Core-declared capabilities, never on provider ids.

## Decisions

### D1. New capability module `server/modules/agent-sessions/` (ports and adapters where variation is real)

```
server/modules/agent-sessions/
  domain/           pure: protocol/event types mirror (from Core's exported types), projection reducers,
                    host state machine (absent → starting → ready → degraded → restarting → stopped), backoff policy
  application/      use cases: ensureHost(scope), openSession, send, interrupt, stopSubagents, update, close,
                    replayFrom(cursor), applyEvent(projection) — depend only on domain + ports
  ports.ts          SessionHostClient (typed RPC + event stream), HostProcessLauncher, ProjectionStore, Clock
  adapters/
    host-process.ts   spawns `node <core>/cli.js runtime host --stdio --scope` via existing Core runtime
                      resolution + resolveBundledNodeExe/windowsSpawnEnv; owns stdio + tree-kill
    rpc-client.ts     NDJSON JSON-RPC client (request ids, timeouts, backpressure, line limit)
    sqlite-projection.ts  desktop DB projection writes (messages, invocations, subagents, cursors) in one tx
  runtime/
    session-host-registry.ts  one supervised host per scope (project key | 'global'); lazy start, health, restart with
                              capped exponential backoff, graceful stop; bound per project at composition
  index.ts          public API for features (no adapters re-exported)
  README.md
```

Ports exist only where there are real substitutes:

- `SessionHostClient`: in-process fake for tests, real stdio client in production.
- `HostProcessLauncher`: fake process versus real spawn.
- `ProjectionStore`: in-memory versus SQLite.

`architecture.test.ts` gains the fixed allowlist for `domain/` and `application/`, and the module is added to `boundaries.json` after review. The protocol types are imported from Core's exported package types, `specrails-core/agent-runtime/session`. Where packaging forbids a runtime import, they are vendored as a generated `.d.ts` checked by `check-core-compat`. Desktop never re-declares them by hand.

*Alternative rejected:* embedding Core's session runtime in-process. Core is ESM with `node:sqlite`, while Desktop's sidecar is a CommonJS/pkg build. The existing runtime bridge already avoids dynamic ESM imports for this reason. A separate process also isolates provider crashes from the sidecar.

### D2. Conversation transport port (Strategy chosen at composition)

```ts
interface ConversationTransport {          // owned by the missions application layer
  readonly kind: 'core-session' | 'legacy'
  capabilities(provider): TransportCapabilities  // resident, subagents, steer, continuation
  startTurn(ctx: TurnContext, sink: TurnSink): Promise<TurnHandle>
  send(input: QueuedInput): Promise<DeliveryReceipt>
  interrupt(conversationId): Promise<void>
  stopSubagents(conversationId, ids?): Promise<void>
  retire(conversationId, reason): Promise<void>
}
```

- `CoreSessionTransport` adapts the agent-sessions API.
- `LegacyTransport` wraps today's `nativeLiveSessionRunner ?? runAiCliInvocation` path unchanged.
- The composition root picks per provider: Core when the installed Core advertises `sessions` and lists a driver for that provider, unless `SPECRAILS_CORE_SESSIONS=off`. Otherwise it picks legacy.
- `AgentChatManager` keeps queue, steering, receipts, MCP capability, persistence ownership and WS broadcasting, and talks only to the port. This is the seam through which later changes migrate the other surfaces.
- The port carries narrow, use-case-owned methods. It is not a mirror of every class method.

### D3. Projection: Core journal is the execution source of truth; Desktop DB is a rebuildable read model

- Each Core `session.event` is applied by one pure reducer (`domain/projection.ts`) that yields projection operations.
- `sqlite-projection.ts` applies them in **one transaction** together with `agent_session_cursors.last_seq`. A crash replays from the cursor, and application is idempotent by `(sessionId, seq)`.
- Projected state:
  - assistant messages, with intent `subagent_continuation` for continuation turns;
  - input receipts, mapped onto `agent_inputs.receipt`;
  - `agent_invocations` from `usage.turn` events, with a new `origin` column and billed vs `_estimated` kept as reported;
  - `agent_subagents` and the bounded `agent_subagent_events`, which hold the projection only;
  - resident phase.
- New tables and columns are appended migrations.
- WS broadcasts are emitted **after** the projection commit, mirroring Core's commit-before-notify.
- Rebuild: an operator command replays a session from seq 0 into an empty projection. A test asserts that live and rebuilt projections are equal.

### D4. Mapping product rules onto Core sessions

| Product rule (stays in Desktop) | Core mechanism used |
| --- | --- |
| Durable queue, Steer per message, edit/delete before delivery | `session.send {inputId, delivery}`; Desktop sends only when its queue releases an input; `inputId` = queue id for idempotency |
| Receipts sent / received / read | sent = Desktop accepted; received = Core `input.started` (or `queued` acknowledged); read = existing explicit agent acknowledgement via Specrails MCP |
| Specrails MCP capability | minted at `session.open`, bound to `(conversation, db, coreSessionId, hostEpoch)`, revoked on `session.closed`/host loss; passed in `policy.mcp.servers` |
| External MCP registry | resolved by Desktop into `policy.mcp` (`inheritUserScope` mirrors today's behaviour per provider) |
| Tiers, model, effort, system prompt, attachments | `session.open` / `session.update` (applied or deferred → UI notice) |
| Stop | `session.interrupt` + `session.stopSubagents` |
| Inactivity / limits | Core policy limits; Desktop configuration documents defaults and env overrides |
| Titles, PR/rail cards, run-failure rows | unchanged Desktop features, fed by projected messages |

### D5. Host supervision and project isolation

- There is one host per scope. The scope key is the project slug (the same key Core uses under `~/.specrails/projects/<slug>`), or `global` for missions without a pinned project.
- Hosts start lazily on the first session open for that scope and are bound when the project registry composes a project.
- The host state machine is pure and tested with a fake clock:
  - health checks are pings with a timeout;
  - on unexpected exit, the host restarts with capped exponential backoff;
  - after a restart, open sessions are re-opened with `resume` and replayed from their cursors;
  - on repeated failure, the scope becomes `degraded` and its conversations fall back to the legacy transport for new turns, with an explicit UI notice.
- Removing a project closes its sessions and stops its host. Other scopes are unaffected.
- Sidecar shutdown sends `host.shutdown` with a grace period, then tree-kills (`transient-children` ownership).
- `journal_locked` from Core, for example a second Desktop instance on the same machine, is surfaced as a clear error. Desktop never starts a second writer.

### D6. Mission sub-agent UI (unchanged intent, now fed by Core events)

- `AgentChatContext` keeps `subagents`, `residentPhase` and the open-turn origin per conversation, reconciled from an extended active-turns snapshot that also restores live tools.
- Components reuse the mission card family (`AgentPrDecisionCard`/`LoopStepSection` visuals, `PulseDot`, `title-shimmer`):
  - **Sub-agents card**: status, description, agent type, live elapsed time; usage and estimated cost are revealed at finish, following the honest-live-metrics rule.
  - **Expandable sub-agent stream**: paged HTTP history plus a throttled live feed.
  - **Activity chip and log** group tools by sub-agent.
  - **Continuation messages** carry an origin label.
  - **Composer pill**: count, elapsed time, Stop.
  - **Deferred-settings notice**: offers "Stop agents and apply now".
  - **Interrupted rows**: a Relaunch action that drafts a composer message.
- Re-entrant status is rendered from Core's `phase` plus `settled`, so the card never trusts the parent's prose: the spike showed agents claiming completion early.

### D7. Sub-agent policy toggle (last phase)

- Project settings domain gains `allowSubagents: boolean`, default `false`. It follows the module's existing domain → application → SQLite/HTTP path, as a key/value entry with no migration.
- An app-global setting covers missions without a project, also default `false`.
- A single pure resolver (`domain/subagent-policy.ts`) maps `(surface, projectSetting, globalSetting)` to `policy.subagents`. Implement pipelines are excluded by construction.
- Turning the toggle off while sub-agents run applies through `session.update`. It is reported as deferred, and the UI offers "Stop agents and apply now".
- Until this phase ships, the resolver returns `enabled`, which keeps current behaviour without any protocol change.

### D8. Compatibility, packaging and rollout

- **Capability detection** through the existing loader (`runtime api` capability `sessions`) and `initialize` negotiation. `check-core-compat` validates the `agentRuntime.sessions` contract block and event types.
- **Bundled Core:** the pin is bumped to the release containing the host. The native smoke launches `runtime host` and completes open/send/close with a fake driver on macOS, Windows and Linux.
- **Rollout flag:** `SPECRAILS_CORE_SESSIONS` with values `auto` (default once hardened), `on` and `off`. It starts as `off` by default while phases land, then flips to `auto`.

## Risks / Trade-offs

- [Two transports coexist for a while] → Single port, legacy path untouched and covered by existing tests; removal is an explicit later change.
- [Projection divergence from Core journal] → Idempotent cursor-based application in one transaction; rebuild command; live-vs-rebuild equality test.
- [Host crash affects all missions of a project] → Per-scope isolation, supervised restart with resume + replay, degraded fallback to legacy for new turns.
- [Receipt semantics drift] → Mapping table tested against Core fixtures; "read" still requires explicit agent acknowledgement.
- [MCP capability lifetime widens] → Bound to Core session and host epoch; revoked on close/host loss; tests for retired-epoch callers.
- [Release coupling across repos] → Core first, capability-gated Desktop; flag default off until manual smoke passes.
- [Windows packaged spawn traps] → Reuse `resolveBundledNodeExe`, `windowsSpawnEnv`, cross-spawn; native smoke on Windows.

## Migration Plan

1. Land `agent-sessions` module with fake host client and projection (no production wiring).
2. Wire host supervision + negotiation behind `SPECRAILS_CORE_SESSIONS=off` default.
3. Introduce the transport port in missions; legacy transport wraps current code (no behaviour change).
4. Core session transport for missions; projection, accounting, MCP binding; manual smoke with Claude and Codex.
5. Sub-agent UI.
6. Hardening, packaging, flip flag to `auto`.
7. Sub-agent policy toggle (default off) — last.
Rollback at any step: `SPECRAILS_CORE_SESSIONS=off`.

## Open Questions

- Should the global scope host start eagerly at app launch to reduce first-message latency? Default: lazy; measure.
- Projection retention aligned with Core journal retention (90 days closed sessions) — confirm with user before deleting historical mission data.
