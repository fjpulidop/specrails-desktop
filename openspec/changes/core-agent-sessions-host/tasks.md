## 1. Preconditions

- [ ] 1.1 Core change `agent-session-runtime` released with `sessions: 1`, `runtime host` and the `agentRuntime.sessions` contract block; record the minimum Core version
- [ ] 1.2 Write `docs/internals/agent-sessions.md` (Desktop/Core split, module layout, transport port, projection, host supervision, rollout flag) and link it from the internals index and AGENTS.md feature map

## 2. agent-sessions module (no production wiring)

- [ ] 2.1 Scaffold `server/modules/agent-sessions/` (domain, application, ports, adapters, runtime, index, README); add allowlists to `server/modules/architecture.test.ts` and review `boundaries.json`
- [ ] 2.2 Protocol types from Core's exported session types (or vendored generated `.d.ts` validated by `check-core-compat`)
- [ ] 2.3 Pure host state machine and backoff policy with fake-clock tests
- [ ] 2.4 Pure projection reducer (events → projection ops) with fixture-driven tests from Core's recorded sessions
- [ ] 2.5 Ports and in-memory fakes (`SessionHostClient`, `HostProcessLauncher`, `ProjectionStore`, `Clock`) honouring production contracts
- [ ] 2.6 Application use cases (ensureHost, open, send, interrupt, stopSubagents, update, close, replayFrom, applyEvent) tested against fakes

## 3. Adapters and host supervision

- [ ] 3.1 `rpc-client.ts`: NDJSON JSON-RPC client (ids, timeouts, line limit, backpressure, notification stream) with duplex-stream tests
- [ ] 3.2 `host-process.ts`: launch `runtime host --stdio --scope` through existing Core resolution, `resolveBundledNodeExe`, `windowsSpawnEnv`, cross-spawn; tree-kill via transient-children ownership
- [ ] 3.3 `session-host-registry.ts`: one host per scope, lazy start, health pings, restart with resume + cursor replay, degraded fallback, project-removal and shutdown paths, `journal_locked` handling
- [ ] 3.4 Capability detection via the runtime loader (`sessions`) and `initialize` negotiation; `SPECRAILS_CORE_SESSIONS` (`off` default during rollout, `auto`, `on`) documented in configuration
- [ ] 3.5 Extend `server/core-compat.ts` / `check-core-compat` for the sessions contract; extend `scripts/smoke-agent-runtime-pair.mjs` to drive a host with a fake driver

## 4. Persistence and accounting

- [ ] 4.1 Append migrations: `agent_session_cursors`, `agent_subagents`, `agent_subagent_events`, `agent_invocations.origin` (default `user`), core session reference on `agent_conversations`
- [ ] 4.2 `sqlite-projection.ts`: single-transaction apply with cursor, idempotent by `(sessionId, seq)`, broadcasts after commit; crash/replay tests
- [ ] 4.3 Accounting from `usage.turn`: billed vs estimated, null preservation, origin, sub-agent breakdown excluded from totals; `spending.invalidated` for pinned projects
- [ ] 4.4 Projection rebuild command and live-vs-rebuild equality test

## 5. Missions on Core sessions

- [ ] 5.1 Introduce `ConversationTransport` port in missions; `LegacyTransport` wraps the current live-session/one-shot path with zero behaviour change (existing mission tests green)
- [ ] 5.2 `CoreSessionTransport`: open/resume, send with queue ids as input ids, interrupt, stopSubagents, update (applied/deferred), retire
- [ ] 5.3 Composition-root selection per provider (Core driver listed + flag) without provider-id branches in mission code
- [ ] 5.4 Receipt mapping (Core input events → sent/received; read stays explicit) and steering paths in background/continuation phases; no-replay guarantees on host loss
- [ ] 5.5 Specrails MCP capability bound to Core session + host epoch; external MCP registry resolved into `policy.mcp`; retired-epoch rejection tests
- [ ] 5.6 Continuation turns persisted with intent `subagent_continuation`; titles, PR/rail cards and run-failure rows unchanged
- [ ] 5.7 Integration tests: two turns on one session, background sub-agents surviving turn end, continuation turns, stop, host crash + resume, project removal isolation, legacy fallback

## 6. Wire contracts and API

- [ ] 6.1 WS events `agent_resident_state`, `agent_subagent`, throttled `agent_subagent_event`, `agent_turn_started`; optional `turnId`/`subagentId` on existing events
- [ ] 6.2 Active-turns snapshot extended with resident phase, live sub-agents, open-turn origin and live tools
- [ ] 6.3 HTTP: list sub-agents, page sub-agent output, stop sub-agents; route precedence preserved; API reference updated
- [ ] 6.4 Specrails MCP mission surface: roster read and stop with existing tiering

## 7. Mission sub-agent UI

- [ ] 7.1 `AgentChatContext` state + handlers + snapshot reconciliation (current-project ref rules)
- [ ] 7.2 Sub-agents card, expandable stream drawer, grouped activity log, chip label "Agent · <description>"
- [ ] 7.3 Continuation labels, unread marking, composer background pill with Stop, sidebar indicator
- [ ] 7.4 Deferred-settings notice with "stop agents and apply now"; interrupted rows with Relaunch drafting
- [ ] 7.5 i18n in all 8 locales; reduced motion; accessible labels; component and context tests

## 8. Hardening and rollout

- [ ] 8.1 Bundled Core pin bump; native smoke launches the host on macOS, Windows and Linux
- [ ] 8.2 Manual smoke (Claude and Codex): background sub-agents, chat while they work, continuation turns, Stop, app restart with live sub-agents, host kill, legacy fallback
- [ ] 8.3 Gates: `npm run typecheck`, `npx vitest run server/modules server/providers`, client mission tests, root and client `test:coverage`, `npm run build`, `npm run check:package`, `npm run audit:architecture`, `npm run docs:source-map`
- [ ] 8.4 Flip `SPECRAILS_CORE_SESSIONS` default to `auto`; update operations runbook and user docs

## 9. Sub-agent policy toggle (last)

- [ ] 9.1 Project settings `allowSubagents` (default false) through domain/application/SQLite/HTTP; app-global setting for project-less missions
- [ ] 9.2 Pure resolver `(surface, project, global) → policy.subagents`, excluding Implement pipelines; wire into session open/update
- [ ] 9.3 Deferred application to running sessions; `policy_unenforceable` error UI
- [ ] 9.4 Settings UI (project + app modal) with cost/behaviour explanation in 8 locales; Specrails MCP settings surface
- [ ] 9.5 Tests and docs for the toggle

## 10. Follow-up changes (tracked, not in this change)

- [ ] 10.1 Open follow-up OpenSpec changes to migrate explore, blueprint, agent refine, interactive jobs and one-shot features onto the transport port, then remove `server/providers/*`
