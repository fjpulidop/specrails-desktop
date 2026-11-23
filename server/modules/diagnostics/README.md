# diagnostics

Server side of three resilience features: crash notices for the local server
sidecar, the event-loop stall probe and the local "Report a problem" ZIP.
Desktop host side: [sidecar_supervisor.rs](../../../src-tauri/src/sidecar_supervisor.rs).
Client: [features/diagnostics](../../../client/src/features/diagnostics/README.md).
Guide: [server recovery and problem reports](../../../docs/internals/server-recovery-and-diagnostics.md).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Crash-marker schema and validation, acknowledgement rule, stall records, request labels, report file list, structured/settings redaction | [domain.ts](domain.ts) (pure) |
| Report collector and crash-marker store contracts | [ports.ts](ports.ts) |
| Preview kept in memory (15 min, newest 3), crash list/acknowledge | [application.ts](application.ts) |
| Host log folder (`SPECRAILS_HOST_LOG_DIR`): markers, `acknowledged.json`, log tails | [adapters/host-files.ts](adapters/host-files.ts) |
| Text redaction (known tokens + audit `redactProse` + mobile `stripHome`) | [adapters/redaction.ts](adapters/redaction.ts) |
| `desktop_settings` read | [adapters/sqlite.ts](adapters/sqlite.ts) |
| `/api/diagnostics/*` routes | [adapters/http.ts](adapters/http.ts); composed by [adapters/runtime.ts](adapters/runtime.ts), mounted in [server/index.ts](../../index.ts) |
| Stall probe and request timing middleware | [runtime/event-loop-probe.ts](runtime/event-loop-probe.ts) |
| In-memory server output | [runtime/log-ring.ts](runtime/log-ring.ts) |

## Invariants

- Nothing leaves the machine. The ZIP is returned to the local client only and
  is never written to disk by the server.
- The ZIP contains exactly the files of the preview it was built from (same
  strings); a preview cannot change after it is shown.
- Every report file goes through the redactor; settings are redacted by key
  first (tokens, keys, passwords, `env`, `headers`, webhooks), then as text.
- The host writes crash markers and logs; the server writes only
  `crashes/acknowledged.json`. A malformed marker is skipped.
- The probe costs one unref'd 1 s timer while idle; `monitorEventLoopDelay` is
  armed only while event-loop utilization is above 5 % (or a stall was seen).

Run `npx vitest run server/modules/diagnostics server/modules/architecture.test.ts`.
