## Context

The registry starts detached shells but stops them with a PID tree rediscovery. Parent close cancels escalation and lifecycle methods mark killed before termination. Client DELETE ignores failures, state is keyed by PID and hydration only merges. Logs already have a bounded REST/MCP tail but no user inspector; readline buffers partial output without a bound.

## Goals / Non-Goals

**Goals:** Reliably stop owned applications, retain truthful state and errors, let users inspect startup/runtime/exit logs, and keep repository/chat ownership consistent.

**Non-Goals:** Replace the interactive terminal, supervise arbitrary processes launched outside Specrails, guarantee containment of deliberately daemonized applications, or persist unlimited logs across app restarts.

## Decisions

1. Assign a UUID processId in addition to PID. New UI requests include it; legacy callers remain compatible. Validate project/chat and execution identity before reading or signalling. Timer and hydration updates never target a newer execution that reused a PID.
2. Use stopping until confirmed exit. POSIX detached processes are signalled as a group; escalation survives the shell's exit and polls the owned group. Windows uses its process-tree mechanisms with checked results and explicit errors. Repeated stop requests are idempotent; failures remain visible and retryable. Shutdown awaits a bounded background-process drain before exiting.
3. Bound output accumulation before newline, decode split UTF-8 and sanitize terminal controls as plain text. Retain sequence-tagged stdout/stderr lines, including partial lines, up to 2000 lines of 4000 characters and a bounded set of 32 finished processes for ten minutes. Disclose truncation. Full bounded snapshots while the dialog is open avoid partial-line cursor races and global WebSocket output traffic.
4. A chip has sibling inspect and stop buttons. The dialog preserves the selected execution independently of chip retention, displays metadata and searchable/filterable logs, follows live output unless paused/scrolled away, and copies/downloads the visible log view. Polling is abortable and only runs for an open active inspector.
5. Client state uses execution identity, captures ownership before async requests, reconciles fresh scoped snapshots after reconnect and does not let stale hydration override lifecycle events. Failed HTTP stops surface errors instead of hiding the process. Recent terminal chips remain inspectable briefly.
6. Share lifecycle broadcast and cwd validation helpers across REST and MCP. Both paths select a registered repository and constrain cwd to it. MCP adds scoped listing and returns execution identities, actual status and log metadata; operator instructions require checking logs for readiness/errors rather than equating spawn acceptance with app readiness.

## Risks / Trade-offs

- Process group descendants can outlive their shell → track group existence independently and test a real child that ignores TERM.
- Explicit daemonization can escape group ownership → do not claim OS-level containment; report failures without signalling unrelated processes.
- Very noisy output → bound partial buffers, retained lines, finished records and rendered content; disclose missing/truncated data.
- Network/event ordering → scope requests, ignore stale completions and recover from authoritative snapshots.
- Polling a large tail → poll only the selected live process while visible; terminal views stop polling and retain their snapshot.

## Migration Plan

Additive API fields and one stopping status; no database migration or new dependency. Existing PID-only clients remain supported; current UI passes execution identity. Existing tests and targeted real-process probes cover compatibility before rollout.
