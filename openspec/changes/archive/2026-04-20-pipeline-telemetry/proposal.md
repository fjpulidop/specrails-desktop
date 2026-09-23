## Why

Specrails pipeline jobs spawned by the hub's `QueueManager` sometimes die mid-run (exit 0) with no visibility into what went wrong. Root cause analysis requires running `/specrails:implement` again with manual instrumentation. A recent 2h 17min run was abandoned at Phase 3b with no diagnostic trail — the only way we learned the architect ran for 2h 8min was by inspecting wall-clock timestamps in logs.

We need a low-friction way for users to capture deep telemetry from a pipeline run and ship it to a bug report, without forcing any setup or configuration.

## What Changes

- Add a per-project setting `pipelineTelemetryEnabled` (default OFF) in the project Settings page.
- When ON, `QueueManager` injects OpenTelemetry env vars (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`) when spawning `claude` processes, pointing at the hub's own receiver.
- Add an embedded OTLP/JSON receiver to the Express server under `/otlp/v1/{traces,metrics,logs}`.
- Persist raw telemetry per job as gzipped NDJSON blobs under `~/.specrails/projects/<slug>/telemetry/<jobId>.ndjson.gz`, with a pointer row in the project SQLite.
- Auto-compact raw blobs to per-phase summary rows after 7 days; cap raw size at 10MB per job.
- Add `[Export diagnostic]` button on the job card. Button visible if and only if a telemetry blob exists for that job (regardless of current setting state).
- Export produces a zip: `job-metadata.json`, `telemetry.ndjson`, `logs.txt`, `summary.md`.

## Capabilities

### New Capabilities
- `pipeline-telemetry`: per-project toggle, OTEL env injection at `QueueManager` spawn, embedded OTLP/JSON receiver, per-job telemetry storage with retention/compaction, and diagnostic zip export from the job card.

### Modified Capabilities
<!-- None. This change adds a new opt-in capability; no existing spec requirements change. -->

## Impact

- **Server**: new `server/modules/accounting/runtime/telemetry-receiver.ts` module and Express routes under `/otlp/*`; `server/modules/execution/runtime/queue-manager.ts` reads the per-project flag and injects env on spawn; new SQLite table `telemetry_blobs` in per-project `jobs.sqlite`.
- **Client**: new toggle in `SettingsPage`; new `[Export diagnostic]` button on existing job card (no new pages, no new visualizations).
- **Filesystem**: new directory `~/.specrails/projects/<slug>/telemetry/`.
- **Dependencies**: no new npm deps (OTLP/JSON parsed natively; gzip via node `zlib`).
- **Scope boundary**: only `QueueManager` spawns are instrumented. `ChatManager` and `SetupManager` are out of scope.
- **specrails-core**: no changes required. OTEL is transparent to skill code — env injection alone is sufficient.
