# Startup and update recovery audit

Date: 2026-09-05. Branch: `feat/codex-gpt-6-astra`.

The reported symptom was an intermittently disconnected desktop with no visible
projects after an update or a cold start. Source inspection found several paths
that produce this symptom without deleting project data. The local sidecar log
also contains an older project hydration failure (an unavailable provider), but
does not establish which path caused every reported incident. No SQLite
corruption was found in that log. User databases were not modified.

## Causes and corrections

| Failure | Correction |
| --- | --- |
| Authentication gave up after 20 attempts spaced 300 ms apart; a later healthy server never repaired the cached missing token. | Share bounded token refreshes between failed API authentication and WebSocket reconnects. Refresh a rejected credential and replay the rejected request at most once, preserving its body, headers and cancellation. |
| Failed initial project requests were treated as a successful empty database. | Preserve the last authoritative catalog and loading state, retry with bounded backoff, and refresh on reconnect, focus and network recovery. |
| Views opened during a database lock could remain empty after that project recovered. | Retry only explicit `project_unavailable` reads for a bounded window; consume the recovery event in specs, rails, pipeline and mission views to refetch without discarding conversation drafts. Both WebSocket hooks recover after an extended outage. |
| An older REST response could overwrite a newer WebSocket project list. | Track catalog revisions and discard responses captured before a newer catalog event. A real browser regression reproduced the original failure. |
| Windows `http://tauri.localhost` could be mistaken for a normal website before the IPC bridge appeared. | Recognize the Tauri virtual hostname when choosing API and WebSocket origins. |
| The native host treated any response from the authenticated `/api/state` endpoint as proof of readiness and terminated the app after a 30-second timeout. | Verify the public `/api/health` contract over direct IPv4 loopback. Keep a live slow-starting sidecar running and retry readiness; report an actual process exit separately. |
| Update restart proceeded even when the previous server still occupied port 4200. | Wait for port release, deduplicate restart requests, and report a delayed restart instead of launching into a known conflict. Validate sidecar process identity before termination. |
| The initial WebSocket catalog contained only successfully hydrated project contexts, unlike REST's persistent registry. | Use the durable catalog for WebSocket initialization and health counts. A registered but temporarily unavailable project returns 503 instead of a misleading 404. |
| A transient SQLite write lock during project startup prevented that project from loading for the entire process lifetime. | Retry failed DB opens after 1, 2 and 5 seconds, then every 30 seconds while the error remains BUSY/LOCKED. Cancel retries on removal or shutdown; corruption and failures after context construction starts are not blindly retried. |
| Two startups could read the same old migration version before either obtained SQLite's write lock. | Acquire the write lock with `BEGIN IMMEDIATE` and recheck each version inside the same transaction as its migration and version record. Close failed initialization handles. |
| A failed legacy `hub.sqlite` rename was logged and ignored, allowing a new empty `desktop.sqlite` to be created. | Fail explicitly and retain the existing data for a later retry; do not replace an inaccessible catalog with an empty one. |

## Validation

- Server/CLI/MCP coverage: 273 files, 7,274 passing tests. Statements 85.45%,
  branches 77.63%, functions 89.52%, lines 87.83%; all configured thresholds pass.
- Client coverage: 348 files, 4,335 passing tests. Statements/lines 89.14%,
  branches 82.87%, functions 74.36%; all configured thresholds pass.
- Native host: `cargo test --lib --offline`, 20 passing tests covering false
  health responses, slow readiness, occupied ports, process identity and expected
  versus unexpected shutdown.
- `npm run typecheck`, `npm run build`, `npm run check-core-compat` and
  `git diff --check` pass. The build retains the existing Vite chunk-size advisory.
- Final Chromium smoke: all three startup/restart/stale-response scenarios pass,
  with no uncaught page errors.

Total: 11,629 passing automated tests plus the three browser smoke scenarios.

SQLite regressions use temporary databases, including a real WAL write lock and
two connections sharing a migration. The native tests do not terminate the user's
server. An installed-app update was not executed as part of this validation.

## Reproducible browser check

Run `node scripts/smoke-startup-recovery.mjs` from the repository root. It bundles
the actual auth, shared WebSocket and desktop project providers and exercises
them in Chromium against a temporary loopback fixture. It never opens the
installed app or a user database. Playwright's Chromium must already be installed;
`SPECRAILS_SMOKE_BROWSER` can select an existing Chromium executable.

The check covers an eight-second startup, a restarted server with a replacement
credential, saved project selection, and an old REST response arriving after a
newer WebSocket catalog. All three scenarios passed after the corrections.
