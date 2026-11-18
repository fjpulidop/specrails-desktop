# Server recovery and problem reports

How the desktop app keeps the local Node server (the *sidecar*) alive, how a
crash is explained afterwards, how event-loop stalls are measured, and what the
local "Report a problem" ZIP contains. User guide:
[If the local server stops](../guide/en/settings/9-server-recovery-and-problem-reports.md).

| Piece | Source |
| --- | --- |
| Relaunch, circuit breaker, crash markers, host logs | [`src-tauri/src/sidecar_supervisor.rs`](../../src-tauri/src/sidecar_supervisor.rs), `launch_sidecar` / `recover_from_exit` in [`src-tauri/src/lib.rs`](../../src-tauri/src/lib.rs) |
| Binary save (`desktop_save_bytes`) | [`src-tauri/src/desktop_actions.rs`](../../src-tauri/src/desktop_actions.rs) |
| Crash notices, stall probe, report builder, redaction, routes | [`server/modules/diagnostics`](../../server/modules/diagnostics/README.md) |
| Banner, report dialog, Resources line | [`client/src/features/diagnostics`](../../client/src/features/diagnostics/README.md) |

## Relaunch contract

The host owns the sidecar. When it exits and the exit was not planned (quit,
tray Exit and update restart set `stopping` first), the host:

1. records the exit in the breaker (`RestartBreaker`, at most **3 relaunches in
   a rolling 60 s**; refused attempts are not recorded, so they never extend the
   window; history survives a successful relaunch because a server that becomes
   ready and crashes again is still a loop);
2. writes a crash marker (below) *before* relaunching, so the new server can
   explain it;
3. emits `specrails:backend-restarting` `{ attempt, maxRestarts, exit }` to every
   window, waits 0.5 s / 2 s / 5 s (attempts 1–3), waits for the port to be free
   (10 s) and launches a new generation.

The relaunch rebuilds the exact first-start command: same port
(`host_profile::current().server_port`), same `SPECRAILS_HOST_CONTROL_TOKEN`
(generated once per host process), same data home and bundled resources. The
webview keeps working without a reload:

- HTTP: `API_ORIGIN` is fixed per build and the desktop API token is persisted
  in `~/.specrails/.specrails/desktop.token`, so it survives the restart. A 401
  still triggers the existing single token refresh and replay
  (`client/src/lib/auth.ts`).
- WebSocket: the shared socket reconnects with jittered backoff
  (`client/src/lib/reconnect-backoff.ts`) and re-reads the token.
- Running work: the new server's normal startup recovery handles jobs, rails and
  sessions that were running in the old process
  ([startup recovery](startup-recovery-audit.md)).

When the breaker refuses, or a relaunch fails (port still busy, spawn error),
the marker is rewritten with `outcome: "stopped"`, `specrails:backend-unavailable`
is emitted and a native dialog explains it with **Try again** (resets the
breaker and launches) and **Close**. Quit/restart take the `spawn_lock` after
setting `stopping`, so a relaunch in flight is either finished (and then
stopped) or refused; on Windows the identity check tracks the creation time of
the current generation.

## Host files

All in the host log folder (`~/Library/Logs/Specrails`, `Specrails Dev` for dev
builds), passed to the server as `SPECRAILS_HOST_LOG_DIR`:

| File | Writer | Contents |
| --- | --- | --- |
| `sidecar.log` | host | Timestamped `[OUT]`, `[ERR]`, `[TAURI_ERR]`, `[EXIT]` lines of every generation |
| `desktop.log` | host | Launches, readiness, exits, breaker decisions, relaunches |
| `crashes/crash-<epoch ms>-<pid>.json` | host | One per unexpected exit (newest 20 kept), written atomically |
| `crashes/acknowledged.json` | server | `{ "throughMs" }`: crashes the person has seen |

Both logs rotate once (`.1`) past 8 MB at launch. Marker schema (v1):
`id, atMs, at, pid, exitCode, signal, uptimeMs, wasReady, outcome
("restarted" | "stopped"), recentRestarts, maxRestarts, windowSecs,
stderrTail` (last 60 stderr lines, raw on disk; redacted before it reaches the
interface or a report). The server validates every marker and skips malformed ones.

## Stall probe

`createEventLoopProbe` (server) keeps one unref'd 1 s timer that measures its own
lateness. While event-loop utilization over the last tick is above 5 % (or a
stall was just seen) it also arms `monitorEventLoopDelay` (20 ms resolution) for
an exact maximum, and disarms it after 10 quiet ticks: an idle server pays one
timer per second. A delay of 200 ms or more is recorded (newest 50, plus total
and longest) and logged as `[event-loop] stall of N ms during <operation>` at
most every 10 s. `operationTiming()` measures each HTTP request's synchronous
handler time (two `performance.now()` calls) and names the request when it
caused the stall; ids, hashes and query strings are removed from the label.
Stalls from timers or sockets show no operation. The operation name stays in
the log and the problem report; the App resources popover only says how long the
app took to respond.

## Problem report

`POST /api/diagnostics/report` collects, redacts and keeps the preview in
memory (15 min, newest 3); `GET /api/diagnostics/report/:id/zip` zips those same
strings (`server/util/zip.ts`, shared with the per-job diagnostic export, which
is unchanged). Files: `README.txt`, `system.json` (app/Core/API versions, OS,
Node, memory, project count), `settings.json` (`desktop_settings`; secret-named
keys, `env` and `headers` removed at any depth), `server.log` (in-memory output
of this server process, 1 MB), `sidecar-stderr.log` and `desktop.log` (desktop
app only, last 512 KB), `crashes.json`, `stalls.json`. Each file is capped at
512 KB.

Redaction reuses existing code: the exact values of the tokens this server
holds (desktop API, host control, MCP), the audit's `redactProse` (PEM keys,
credentials in URLs, Authorization/Cookie headers, Bearer tokens, `name=value`
secrets, GitHub/OpenAI/Anthropic/Slack/AWS/Google/GitLab/npm token shapes), the
mobile gateway's `stripHome` (home folder → `~`), and a quoted-JSON-field rule
(`"apiKey": "…"`). Removed values read `***` (audit rules) or `[REDACTED]`
(known tokens, settings keys, JSON fields). Nothing is uploaded; the client saves the ZIP through the
host's save dialog (`desktop_save_bytes`, raw IPC body) or a browser download.

## Verify

```bash
npx vitest run server/modules/diagnostics server/modules/architecture.test.ts
npm run test --prefix client -- src/features/diagnostics src/lib/__tests__/save-text-file.test.ts
cd src-tauri && TAURI_CONFIG='{"bundle":{"active":false,"externalBin":[],"resources":[]}}' cargo test --lib sidecar_supervisor desktop_actions
```

Manual check in the packaged app: `kill -9` the `specrails-server` process; the
status bar shows Reconnecting, the app reconnects, and the banner explains the
stop. Kill it four times within a minute to see the stopped-server dialog.
