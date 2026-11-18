# diagnostics

Explains local server crashes and lets a person save a problem report. The
server side is [server/modules/diagnostics](../../../../server/modules/diagnostics/README.md);
the desktop host side is `src-tauri/src/sidecar_supervisor.rs`.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/ReportProblemDialog.tsx](components/ReportProblemDialog.tsx)
- [components/ServerRecoveryBanner.tsx](components/ServerRecoveryBanner.tsx)
- [components/ServerResponsiveness.tsx](components/ServerResponsiveness.tsx)

## Feature dependencies

No direct feature dependencies.

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

## Surfaces

| Surface | Where it shows | Source |
| --- | --- | --- |
| Crash banner | Above the main content, after a reconnect or on the next start, when the host left crash markers the person has not dismissed | [ServerRecoveryBanner](components/ServerRecoveryBanner.tsx), [useServerCrashNotices](hooks/useServerCrashNotices.ts) |
| Report a problem | The banner, Settings ▸ About and ⌘K (`reportProblem`) | [ReportProblemDialog](components/ReportProblemDialog.tsx) |
| Responsiveness | App resources popover in the status bar (plain language, no request names) | [ServerResponsiveness](components/ServerResponsiveness.tsx) |

## Rules

- The dialog shows the server-built, already redacted files and saves the ZIP of
  that same preview (`GET /api/diagnostics/report/:id/zip`), so what the person
  read is what they save. Nothing is uploaded.
- In the desktop app the ZIP goes through `desktop_save_bytes` (raw IPC body,
  host save dialog); in a browser it is a Blob download (`lib/save-text-file.ts`).
- Dismissing the banner or choosing Report a problem acknowledges the crashes up
  to the newest one; the acknowledgement lives on the server, so every window and
  the next start agree.
- Notices are re-read whenever the shared WebSocket reconnects: that is when a
  relaunched server is back. The host's `specrails:backend-restarting` event only
  adds a "Restarting…" toast in the desktop app.
- Responsiveness polls `/api/diagnostics/stalls` only while the popover is open.

Run `npm run test --prefix client -- src/features/diagnostics`.
