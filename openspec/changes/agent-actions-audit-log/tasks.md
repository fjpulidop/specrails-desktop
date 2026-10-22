## 1. Storage

- [x] 1.1 Append migration 73 to `server/db/migrations.ts`: `agent_actions` with the kind CHECK and `(run_id, ts)`, `(ts)` indexes.
- [x] 1.2 Migration test (columns, indexes, CHECK).

## 2. Audit module

- [x] 2.1 `server/modules/audit/domain.ts`: tool classification, stream extraction (Claude, Codex, Gemini, Core agent events), redaction, normalisation, JSONL/CSV, retention cutoff.
- [x] 2.2 `application.ts`: batched recorder (250 ms / 200 rows, failure isolation, pending cap), stream taps, export/prune service; `ports.ts`.
- [x] 2.3 Adapters: SQLite store, per-project runtime (sha256, retention timers, dispose), HTTP exports.
- [x] 2.4 Architecture rules, boundary manifest, module README, source map.
- [x] 2.5 Tests: classification per provider shape, redaction, batching/flush, failure isolation, formats, store, retention, HTTP.

## 3. Producers

- [x] 3.1 `QueueManager` stdout reader and interactive sessions (`InteractiveJobSession.onProviderEvent`).
- [x] 3.2 `LoopRunManager`: raw provider lines, Core agent-events, definition runtime events, interactive steps.
- [x] 3.3 Missions: Core session projector (`turn.tool`, sub-agent tools) and native sessions.
- [x] 3.4 `file_provenance` writes with the sha256 of the recorded diff.
- [x] 3.5 MCP mission wrapper in `registerTieredTool` (role `mission`, `tool:action`).
- [x] 3.6 Composition in `project-registry.ts` (one runtime per project, disposed before the DB closes) and `server/index.ts`.
- [x] 3.7 Tests per producer, including a throwing sink that leaves the run unaffected.

## 4. Export, packet, retention

- [x] 4.1 `GET /jobs/:runId/audit` and `GET /agent-actions` registered from `project-router-jobs.ts`.
- [x] 4.2 MCP `specrails_jobs` action `audit` (read tier) with tests.
- [x] 4.3 Review packet `agentActions` and the "What the agent did" section with downloads; tests.
- [x] 4.4 Project setting `agentAuditRetentionDays` (domain, SQLite, UI section); tests.
- [x] 4.5 i18n in 8 locales.

## 5. Documentation and verification

- [x] 5.1 `docs/internals/agent-actions-audit.md`, API reference, configuration, MCP guide, review packet, `SECURITY.md`, AGENTS feature map.
- [x] 5.2 `npm run typecheck`, targeted vitest, client tests, `npm run audit:architecture`, `npm run docs:source-map`, `openspec validate --strict`.
