# agent-sessions

Desktop as the host of Core's agent session runtime
(`specrails-core runtime host --stdio --scope <projectKey|global>`). Core owns
providers, sub-agents, usage semantics and the durable session journal.
This module owns:

- supervision of one host per scope;
- the protocol client;
- the surface-neutral projection of Core events into Desktop state.

Design: [`openspec/changes/core-agent-sessions-host/design.md`](../../../openspec/changes/core-agent-sessions-host/design.md).
Protocol: Core's `docs/agent-sessions/protocol.md`.

## Where to change behavior

| Change | Owner |
| --- | --- |
| Wire types Desktop consumes, contract drift check | [domain/protocol.ts](domain/protocol.ts) |
| Typed protocol errors | [domain/errors.ts](domain/errors.ts) |
| Core events → surface-neutral projection operations (dedupe, gaps) | [domain/projection.ts](domain/projection.ts) |
| Host supervision policy (start, backoff, degrade, retry, stop) | [domain/host-state.ts](domain/host-state.ts) |
| Apply events exactly once to a surface sink; rebuild and replay | [application/session-event-pump.ts](application/session-event-pump.ts) |
| Ports (host client, launcher, projection sink, clock) | [ports.ts](ports.ts) |
| JSON-RPC over stdio | [adapters/rpc-client.ts](adapters/rpc-client.ts) |
| Launching Core's host (Core and Node resolution, Windows-safe env, tree-kill) | [adapters/host-process.ts](adapters/host-process.ts) |
| One supervised host per scope, tracked sessions, restart and resume | [runtime/session-host-registry.ts](runtime/session-host-registry.ts) |
| Public imports | [index.ts](index.ts) |

## Invariants

- **No provider logic:** Desktop never interprets provider frames or branches on provider ids. It relies on the capabilities Core declares for each driver.
- **Projection:** Core's journal is the execution source of truth. A surface's tables are a rebuildable projection: the sink writes operations and the cursor in one transaction, events apply once by `(sessionId, seq)`, and gaps are filled from `session.events`.
- **Unknown event types** from a newer Core are skipped. Contract drift is reported by `checkSessionContract`.
- **Degraded scope:** after repeated failures within the window, new turns in that scope must use the legacy transport until a manual retry.
- **One host per scope:** a project's sessions live in Core's `~/.specrails/sessions/<scope>/`. Desktop never starts a second host for a scope.

## Verify

```bash
npx vitest run server/modules/agent-sessions server/modules/architecture.test.ts
```

The launcher test runs against `../specrails-core/dist` when a Core build with
sessions is present; otherwise it is skipped.

## Reviewed public entry points

- [index.ts](index.ts)
- [adapters/host-process.ts](adapters/host-process.ts)
- [runtime/session-host-registry.ts](runtime/session-host-registry.ts)
