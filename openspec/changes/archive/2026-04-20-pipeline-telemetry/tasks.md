## 1. Data model (server)

- [x] 1.1 [backend] Add `pipelineTelemetryEnabled BOOLEAN NOT NULL DEFAULT 0` column to the per-project settings table in `server/db.ts`; write migration that is idempotent for existing projects.
- [x] 1.2 [backend] Add `telemetry_blobs(jobId TEXT PRIMARY KEY, path TEXT, byteSize INTEGER, startedAt INTEGER, endedAt INTEGER, state TEXT CHECK(state IN ('active','compacted','expired')))` table to per-project schema.
- [x] 1.3 [backend] Add `telemetry_summaries(jobId TEXT, phase TEXT, durationMs INTEGER, tokensInput INTEGER, tokensOutput INTEGER, tokensCache INTEGER, toolCalls TEXT, apiErrors INTEGER, costUsd REAL, PRIMARY KEY (jobId, phase))` table.
- [x] 1.4 [backend] Expose `getSettings` / `updateSettings` in the project router for the new flag; ensure the REST surface returns the new field with a default of `false`.

## 2. Telemetry receiver (server)

- [x] 2.1 [backend] Create `server/modules/accounting/runtime/telemetry-receiver.ts` with `POST /otlp/v1/traces`, `POST /otlp/v1/metrics`, `POST /otlp/v1/logs` Express handlers that parse OTLP/JSON bodies.
- [x] 2.2 [backend] Extract `specrails.job_id` and `specrails.project_id` from `resource.attributes`; return HTTP 400 if either is missing, HTTP 404 if the jobId is unknown in that project's `jobs.sqlite`.
- [x] 2.3 [backend] Implement append-only gzipped NDJSON writer keyed by `(projectId, jobId)`, writing to `~/.specrails/projects/<slug>/telemetry/<jobId>.ndjson.gz`. One line per payload with `{signal, receivedAt, payload}` shape.
- [x] 2.4 [backend] Create/update pointer rows in `telemetry_blobs` on first and subsequent payloads (`state`, `startedAt`, `endedAt`, `byteSize`).
- [x] 2.5 [backend] Enforce 10 MB uncompressed cap per blob: drop further `logs` payloads once reached, append a single `{signal:"control", event:"logs_truncated", at}` marker, keep accepting `traces` and `metrics`.
- [x] 2.6 [backend] Back the writer with a bounded in-memory append queue (cap 10k events); drop with a warning log when exceeded to avoid starving the Express event loop.
- [x] 2.7 [backend] Mount the receiver routes in `server/index.ts` before mode branching so they are reachable in hub mode. Not mounted in legacy mode.

## 3. QueueManager env injection

- [x] 3.1 [backend] In `server/modules/execution/runtime/queue-manager.ts`, read the project's `pipelineTelemetryEnabled` flag at spawn time (not at constructor time) so toggles take effect on the next job.
- [x] 3.2 [backend] When ON, merge the OTEL env block (`CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_EXPORTER_OTLP_ENDPOINT` pointing at `http://127.0.0.1:<hubPort>/otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_TRACES_EXPORTER`, and `OTEL_RESOURCE_ATTRIBUTES=specrails.job_id=<jobId>,specrails.project_id=<projectId>`) into the spawn env.
- [x] 3.3 [backend] Add a small helper `buildTelemetryEnv(jobId, projectId, hubPort)` so the logic is unit-testable without full spawn.
- [x] 3.4 [backend] Confirm `ChatManager` and `SetupManager` call sites remain unchanged (no injection there) — add a brief code comment at each spawn site explaining why.

## 4. Retention and compaction (server)

- [x] 4.1 [backend] Add `server/modules/accounting/runtime/telemetry-compactor.ts` with a `runCompaction(projectContext, now)` function.
- [x] 4.2 [backend] Compaction logic: find `telemetry_blobs` rows with `state="active"` older than 7 days; read and parse the NDJSON; group metrics/traces by phase; compute per-phase aggregates (duration, tokens in/out/cache, tool call counts, API error count, cost USD).
- [x] 4.3 [backend] Insert aggregated rows into `telemetry_summaries`, delete the blob file, update pointer row to `state="compacted"` and `path=NULL`.
- [x] 4.4 [backend] On `ProjectRegistry.removeProject`, delete the project's telemetry directory and drop its telemetry rows.
- [x] 4.5 [backend] Call `runCompaction` for every active project at server startup (after registry hydration).

## 5. Export diagnostic (server)

- [x] 5.1 [backend] Add `GET /api/projects/:projectId/jobs/:jobId/diagnostic` endpoint that streams a zip response.
- [x] 5.2 [backend] Zip contents: `job-metadata.json` (job row + phases), `telemetry.ndjson` (decompressed from blob if `active`; header line only if `compacted`), `logs.txt` (existing hub log), `summary.md` (generated from raw or summary rows).
- [x] 5.3 [backend] If the job's blob ever hit the 10 MB cap (detected by presence of the `logs_truncated` control line), prepend `truncated: true` note to `summary.md`.
- [x] 5.4 [backend] Return HTTP 404 if no row in `telemetry_blobs` exists for that job; return HTTP 410 with an explanatory message if the row exists but state is `expired` (deletion-in-progress safety).

## 6. Client UI

- [x] 6.1 [frontend] Add `Pipeline Telemetry` toggle to `SettingsPage` with a short description ("Capture token usage, phase durations, and subagent activity for diagnostic export. Off by default.").
- [x] 6.2 [frontend] Wire the toggle to `getSettings` / `updateSettings` via `getApiBase()`; ensure the new field threads through `useProjectCache` consumers without forcing a refetch loop.
- [x] 6.3 [frontend] Add `[Export diagnostic]` button to the **job detail page** actions area (next to Re-execute / Cancel). Use `hasTelemetry` on the job payload to decide visibility. The recent-jobs row SHALL NOT render the button in any state.
- [x] 6.4 [frontend] Render as an `<a download href=…/diagnostic>` wrapped in the outline Button (premium visual parity with Re-execute). Browser handles the zip download.
- [x] 6.5 [frontend] Gate the toggle on hub mode; hide in legacy mode to match server behavior.

## 7. Tests

- [x] 7.1 [backend] Unit test `buildTelemetryEnv` covers ON vs OFF and correct resource attribute formatting.
- [x] 7.2 [backend] Unit test OTLP receiver: valid payload routed to correct blob; missing attributes → 400; unknown jobId → 404; oversize blob drops logs but keeps traces/metrics; marker line written exactly once.
- [x] 7.3 [backend] Unit test compactor: active blob older than 7d compacts to summary rows; blob younger stays; project deletion removes all telemetry.
- [x] 7.4 [backend] Unit test diagnostic endpoint: active job returns full zip, compacted job returns summary-only zip, missing telemetry returns 404, truncated blob flags `truncated: true` in summary.
- [ ] 7.5 [backend] Integration test: spawn a stub `claude` process that writes an OTLP/JSON POST to the receiver, verify the end-to-end path writes a blob and the zip export round-trips.
- [x] 7.6 [frontend] Component test for `SettingsPage` toggle (default OFF, persists, triggers PATCH).
- [x] 7.7 [frontend] Component test for **JobDetailPage**: button visible iff `hasTelemetry` is true; href points to `/api/.../diagnostic`; absent when false or undefined.

## 8. Docs

- [x] 8.1 [backend] Update `CLAUDE.md` with a short section on pipeline telemetry: default state, storage paths, retention policy, and the `QueueManager`-only scope.
- [x] 8.2 [backend] Add a note in `CLAUDE.md` clarifying that `specrails-core` is intentionally not modified for this feature.
