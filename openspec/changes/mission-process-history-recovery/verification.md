# Verification — persistent process history and mission API recovery

Verified on macOS on 2026-09-06 in `codex/multi-repo-projects`.

## Confirmed cause of the reported chat failure

Read-only inspection found Specrails listening on `127.0.0.1:4200` and a different project frontend on `[::1]:4200`. Vite's API proxy and injected WebSocket URL used `localhost`, allowing requests to reach the IPv6 frontend and receive HTML instead of Specrails JSON.

The corrected proxy and internal/native API addressing use explicit IPv4. The existing development instance at `http://localhost:4201/api/health` was checked after the change and returned HTTP 200 with JSON from Specrails. No mission message or paid provider request was sent during this verification.

## Server checks

**68 suites / 1,665 tests passed** in the final affected regression run:

```sh
npx vitest run server/agent server/mcp server/providers server/transient-children.test.ts server/transient-children.integration.test.ts server/background-process-control.test.ts server/background-process-persistence.test.ts server/background-process-store.test.ts server/background-process-flow.test.ts server/project-router-background-processes.test.ts server/project-registry.test.ts server/project-router.test.ts server/process-admission.test.ts server/desktop-db.test.ts server/spawn-lifecycle.test.ts server/interactive-job-session.test.ts server/util/cli-prompt.test.ts server/dev-ports.test.ts --maxWorkers=2 --reporter=dot
```

The persistent-store and lifecycle regressions verify:

- Reopening a real SQLite database preserves metadata, final outcomes, sequence IDs and partial lines.
- A failed application launched by a disposable server worker remains readable through REST and MCP after that worker exits. The reader never owned its in-memory records.
- Reads merge durable and pending output beyond the 2,000-line memory ring; completed logs survive memory expiry.
- Writes are batched, failed attempts stay bounded, quiet processes retry without new output, and persistence errors do not block Stop or shutdown drain.
- Failed initialization reports unavailable history rather than empty/expired data; a throttled retry reopens the same file after storage recovers. Intentional close does not reopen it.
- Recovered active records become disconnected history, never regain process control, and their old PIDs are refused by REST/MCP stop operations.
- Scope, execution identity, deletion, retention by age/count/bytes, transaction rollback and concurrent-store ownership are enforced.
- An IPv4 JSON server and IPv6 HTML server can share a temporary numeric port without sending API traffic to the HTML server. Unknown API paths return JSON errors.

All real child-process fixtures and databases are disposable. Windows process-tree behavior remains unit-simulated; this run does not constitute a Windows or packaged Tauri runtime test.

## Client checks

**14 suites / 277 tests passed** across process state/history/inspector, mission context/composer, API decoding, auth, Vite configuration, WebSocket addressing and locale parity. The final run is recorded in `/tmp/specrails-history-client-final.log`.

Checks include preserving draft text, references, attachments and the same request ID after HTML, invalid or unconfirmed send responses; no automatic replay; history retention across reconnect and chip expiry; authoritative removal of pruned history; visible read/write errors; and no Stop action for disconnected executions. A failed history load does not claim the history is empty.

Real React browser smoke tests passed at 1440×1000 and 800×850 with device scale factor 2: history search, saved/disconnected logs after reload, unknown OS-state notice, no signalling/polling of recovered PIDs, back navigation preserving search, close preserving the draft, and no page errors or horizontal overflow. Fixture files, browser and Vite server were cleaned up. Evidence: `/tmp/specrails-process-history-smoke-report.json` and `/tmp/specrails-process-history-{1440,800}-{history,saved-disconnected}.png`.

## Build and specification checks

- `npm run typecheck`: passed for server, CLI, MCP bridge and client.
- `npm run build`: passed for server, client and CLI; Vite retains its non-blocking large-chunk advisory.
- `git diff --check`: passed.
- `OPENSPEC_TELEMETRY=0 openspec validate mission-process-history-recovery --strict`: passed.

Detailed server and build outputs are in `/tmp/specrails-history-server-final.log`, `/tmp/specrails-history-types-final.log` and `/tmp/specrails-history-build-final.log`.

## Retention and recovery limits

Persistence keeps up to 30 days, 1,000 finished executions, 10,000 lines per execution and 256 MiB of log text. The UI remains a bounded tail. A hard crash may lose the current unflushed batch; ordinary lifecycle completion flushes it. Historical OS state cannot be reconstructed from a PID alone, and output already discarded by older in-memory-only versions cannot be recovered retrospectively.

User documentation: [mission-processes.md](../../../docs/mission-processes.md).
