# Agent actions audit

Records what each run's agents read, wrote, executed, called over MCP or fetched,
from the streams Desktop already consumes. Exports JSONL/CSV and applies a
per-project retention. Feature guide:
[agent actions audit](../../../docs/internals/agent-actions-audit.md).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Tool → kind mapping, stream shapes, redaction, target normalisation, export formats, retention cutoff | [domain.ts](domain.ts) (pure, no imports) |
| Batched writer, stream taps, export/prune use cases | [application.ts](application.ts) |
| Persistence contract | [ports.ts](ports.ts) |
| SQL (batch insert in one transaction, queries, delete) | [adapters/sqlite.ts](adapters/sqlite.ts) |
| Per-project composition: sha256, retention timers, dispose | [adapters/runtime.ts](adapters/runtime.ts) |
| HTTP exports | [adapters/http.ts](adapters/http.ts), registered by [project-router-jobs.ts](../../project-router-jobs.ts) |
| Public imports | [index.ts](index.ts) |

Producers live with their streams: `QueueManager`, `InteractiveJobSession`
(`onProviderEvent`), `LoopRunManager`, `MissionSessionProjector`,
`AgentChatManager`, `recordMissionMcpAction` in `server/mcp/tools/types.ts` and
`recordProvenanceForJob` (direct insert in the provenance transaction).
Composition: `server/project-registry.ts` (one runtime per project connection)
and `server/index.ts` (missions resolve the pinned project's recorder).

## Invariants

- `record()` never throws and never does IO. Storage errors are counted and
  rate-limit logged; they never reach the run.
- Contents, outputs, patches, environment values and MCP arguments are never
  stored. Commands are redacted before storage.
- A store is bound to one project connection. Missions write to their pinned
  project only.
- Reads are only as complete as each provider's stream.

## Verify a change

```bash
npx vitest run server/modules/audit server/mcp/tools/jobs-audit.test.ts
npx vitest run server/modules/execution/runtime/queue-manager.test.ts -t "agent actions audit"
npx vitest run server/modules/loops/runtime/loop-run-manager.test.ts -t "agent actions"
npx vitest run server/modules/missions/runtime/mission-session-projector.test.ts server/modules/code/runtime/file-provenance.test.ts server/modules/delivery/runtime/review-packet.test.ts
npm run typecheck && npm run audit:architecture
```

## Reviewed public entry points

- [adapters/http.ts](adapters/http.ts)
- [adapters/runtime.ts](adapters/runtime.ts)
- [adapters/sqlite.ts](adapters/sqlite.ts)
- [index.ts](index.ts)
