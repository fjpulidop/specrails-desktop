# Restart continuity

Durable markers for mission turns in flight, resume offers after a restart
(quit, update, crash), the runs a graceful restart interrupted, and the
"is anything running?" check behind "Install when nothing is running". Nothing
is ever replayed without the person. Feature guide:
[agent policy and continuity](../../../docs/internals/agent-policy-and-continuity.md).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Marker/offer vocabulary, staleness (session root), shutdown stamping | [domain.ts](domain.ts) (pure) |
| Use cases: start/settle, shutdown, startup promotion, offers, settle | [application.ts](application.ts) |
| Persistence contract | [ports.ts](ports.ts) |
| State file (`<home>/.specrails/turn-continuity.json`, 0600, atomic) | [adapters/file-store.ts](adapters/file-store.ts) |
| Routes under `/api/continuity/*` | [adapters/http.ts](adapters/http.ts) |

Composition: `server/index.ts` (observer on `AgentChatManager`, startup
promotion, `recordShutdown()` first thing in `shutdown()`, routes and the
active-work count). Client: `client/src/features/continuity`,
`client/src/lib/continuity-api.ts`, `client/src/hooks/useDesktopUpdateNotifier.tsx`.

## Invariants

- Every method is synchronous and never throws; a storage failure is logged.
- A turn cut by the shutdown keeps its marker; settles after shutdown began are ignored.
- Offers are only turned into turns by the person (the client sends the
  continuation message through the normal send path).

## Verify a change

```bash
npx vitest run server/modules/continuity server/modules/architecture.test.ts
npm run test --prefix client -- src/features/continuity src/hooks/__tests__/useDesktopUpdateNotifier.test.tsx
```

## Reviewed public entry points

- [index.ts](index.ts)
- [adapters/file-store.ts](adapters/file-store.ts)
- [adapters/http.ts](adapters/http.ts)
