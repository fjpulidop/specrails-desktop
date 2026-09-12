## Context

Background applications already have stable execution identities, scoped logs and confirmed termination. Their output is only in memory for ten minutes, and terminal chips disappear after two minutes. Development evidence shows the Specrails server on IPv4 127.0.0.1:4200 and a project frontend on IPv6 [::1]:4200; Vite proxies through ambiguous localhost and receives project HTML.

## Goals / Non-Goals

**Goals:** Recoverable diagnostics across disconnects/restarts, reachable mission history, bounded durable storage, truthful process ownership and reliable mission API addressing.

**Non-Goals:** Adopt unknown processes after restart, reconstruct logs already discarded by older versions, retain unlimited logs, or change the user's project launch configuration.

## Decisions

1. Use `background-processes.sqlite` beside the desktop catalog with existing SQLite/WAL and filesystem protections. Keeping log traffic separate from conversation tables avoids contention and independent schema upgrades do not change mission data.
2. Persist metadata at lifecycle boundaries and line upserts in bounded batches every 250ms. Preserve line sequences for partial-line replacement. Flush before final notification and graceful shutdown. Persistence failures remain explicit and never prevent stopping a live process; startup failure leaves mission chat available.
3. Retain a bounded history: thirty days, at most 1,000 terminal executions and 256 MiB of retained log text, with up to 10,000 lines of 4,000 characters per execution. Memory and rendered views remain separately bounded. Disclose trimming and the small pending-batch loss window after a hard crash.
4. Recovery changes persisted active states to `interrupted`, with recovery metadata explaining that supervision ended and current OS status is unknown. Historical records never populate the map of signalable children. UUID, project and chat remain mandatory ownership checks for supplied references.
5. Keep the existing short-lived process chips, but add a searchable Processes history entry point that survives reconnects and chip expiry. Selecting an execution opens the existing inspector; all controls and states remain localized.
6. Use the explicit IPv4 address matching the server listener for internal development/native traffic. Keep configurable port resolution aligned and prevent silent Vite port fallback. Decode API failures deliberately, retain drafts and request identity, and never automatically replay a message with uncertain acceptance.
7. Mission guidance discovers retained executions before restart, reads persisted failure logs and treats background application readiness checks as part of the launch request.

## Risks / Trade-offs

- Hard process crashes can lose the current unflushed batch → keep a short, bounded write interval and flush normal lifecycle boundaries.
- Disk errors or lock contention → show persistence errors separately from process errors, preserve bounded pending output, and keep Stop available.
- Old PIDs can be reused → recovered records are inspectable history only; never infer ownership from PID existence.
- Numeric ports can match across IPv4/IPv6 → explicit routing and regression tests with an unrelated HTML endpoint.
- Large histories can affect performance → bound database retention, fetch scoped metadata and keep rendered logs capped.

## Migration Plan

Create the dedicated history schema on normal server startup. Existing in-memory-only logs cannot be restored retrospectively. Existing GET/stop URLs remain compatible; `interrupted` and persistence diagnostics are additive fields/states. Older binaries can ignore the separate history file.
