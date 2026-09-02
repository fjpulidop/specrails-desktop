## Context

The desktop server owns REST, the shared WebSocket, provider child processes, and the embedded MCP server in one Node.js process. The Code Explorer `filter=all` path currently performs a complete repository walk with synchronous filesystem calls and a synchronous `git check-ignore` before returning its first page. The same request lazily attaches a recursive file-summary watcher. An operator agent commonly falls back from a guessed file path to this all-files tree, so repository discovery runs on the same event loop needed to deliver tool results, provider terminal events, health checks, and reconnect traffic.

Agent chat marks a turn as streaming optimistically before the send request settles. That state is cleared only by an `agent_done`, `agent_error`, or local POST failure. If the WebSocket drops or the sidecar restarts after accepting the turn, the new process has no matching child but the client retains the optimistic state indefinitely. Provider output emitted before a non-zero exit is also discarded from durable chat even though it can explain the failure.

The observed incident involved a 9.8 GB repository, a recoverable file-read 404 followed by `specrails_code(tree, filter=all)`, loss of the sidecar endpoint, and no terminal agent event. The design treats the exact process-death mechanism as unproven and closes each unsafe boundary independently.

## Goals / Non-Goals

**Goals:**

- Keep the desktop HTTP and WebSocket control plane responsive during all-files discovery.
- Bound repository enumeration, watcher scope, Git filtering, response size, and elapsed work.
- Guarantee that every accepted agent turn reaches a terminal client state or is reconciled after reconnect.
- Retain useful partial provider output while representing the turn as failed.
- Make the failure modes deterministic and covered without invoking real AI providers.

**Non-Goals:**

- Diagnosing or changing provider quotas, authentication, or upstream provider reliability.
- Returning every file in pathological repositories in one materialized snapshot.
- Making agent-chat turns durable across a sidecar restart; the accepted request is preserved, but an interrupted provider process is reported as interrupted rather than silently resumed.
- Changing Code Explorer's deny-list or exposing ignored/secret files.

## Decisions

### 1. Cooperative, bounded tree snapshots

Replace the synchronous whole-tree function with an asynchronous scanner that yields between bounded batches. The scanner applies the deny-list before descending, never follows symbolic links, caps visited/returned entries and elapsed scan time, and runs Git ignore classification in bounded chunks. A completed snapshot may retain the existing short TTL and cursor slicing. If a safety bound is reached, the response returns a typed, retryable truncation/error result rather than hanging or silently claiming completeness.

This is preferred to merely increasing timeouts because a timeout around synchronous work cannot fire while the event loop is blocked. Worker threads were considered, but asynchronous directory iteration plus explicit limits is simpler and avoids copying a large result between isolates; a worker remains a future option if measurements show filesystem work is still CPU-heavy.

### 2. Separate watcher startup from latency-sensitive tool responses

Code Explorer reads SHALL NOT synchronously perform an unbounded watcher initialization. Watcher attachment remains idempotent, uses the shared build/dot-directory pruning policy, does not follow symlinks, and starts outside the response-critical path. Startup errors are logged and degraded without failing or delaying a read-only tool call.

Removing the watcher entirely was rejected because stale-summary notifications are existing product behavior.

### 3. Explicit terminal lifecycle and bounded MCP inactivity

Every accepted turn receives a server-side lifecycle record with a start time and state. Provider execution gets a configurable inactivity deadline that is refreshed by provider output or tool activity. A tool/provider stall terminates the owned child, records failure, and broadcasts one `agent_error`. The terminal helper is idempotent so timeout, child exit, abort, and shutdown races cannot emit contradictory outcomes.

An inactivity deadline is chosen over a short wall-clock deadline because autonomous missions may legitimately run for a long time while continuing to make progress.

### 4. Reconcile live state after every reconnect

Expose active agent-turn state through the existing agent API (either alongside conversation hydration or a dedicated read endpoint). On WebSocket transition back to connected, the client fetches authoritative active turns. It clears any local `isStreaming` state absent from the server snapshot and hydrates server-active turns that the client missed. If the sidecar restarted, the empty authoritative set settles orphaned spinners with an inline interruption message; it does not duplicate the user's message or automatically spend money by retrying.

Periodic polling was rejected as unnecessary steady-state traffic; WebSocket reconnection is the precise recovery boundary.

### 5. Preserve partial output as failed output

When a provider emits non-empty text and then exits unsuccessfully, persist that text as an assistant message before emitting the terminal error. The UI presents the partial response with a visible interrupted/failed treatment and still clears streaming state. A successful-looking partial response is never relabeled as success, and the provider session is reset as today.

Discarding partial output was rejected because it hides the only useful diagnostic context and makes a completed child look like an endless spinner when the terminal event is missed.

### 6. Observability at each boundary

Structured logs record scan duration/count/bound reached, watcher startup failure, turn timeout reason, terminal-event disposition, and reconnect reconciliation. Tests use injected clocks, filesystem adapters, and fake provider children; no real Claude, Codex, or Gemini invocation is part of verification.

### 7. Provider and model selection form one atomic choice

When the Add Spec provider changes, immediately clear the prior provider's model and catalog, mark resolution pending, and disable every submit path including keyboard submission. Once the selected provider response arrives, accept it only if it belongs to the latest request and contains a model valid for that same provider. Submission sends no hard-coded Claude fallback; omitting the model lets the server resolve the selected provider's default.

Keeping the stale model visible while loading was rejected because `canSubmit` currently ignores model loading and can send `sonnet` with `aiEngine=codex`, which the server correctly rejects as an invalid pair.

### 8. Contract Layer never changes provider implicitly

Post-commit enrichment is owned by the provider selected for the originating agent or Explore flow. If that adapter does not advertise `structuredActions`, Contract Layer is skipped with an explicit unsupported outcome. The server SHALL NOT scan the project's installed-provider list and select Claude as a fallback. Supporting Contract Layer on additional providers requires first implementing and testing their structured-action boundary; it is not achieved by borrowing another provider and its quota.

### 9. Stop terminates only the owned turn process group

Stopping a mission targets the exact provider child and its dedicated descendant process group, never the desktop sidecar or unrelated conversations. The graceful-termination escalation timer is cancelled as soon as that child closes, and any later escalation revalidates ownership before signaling. Stop settles only the target conversation, clears its queue, and leaves the shared HTTP/WebSocket control plane and other connected clients alive.

Relying only on a negative process-group PID was rejected because PID/group reuse and an uncancelled delayed `SIGKILL` create an avoidable cross-process risk. Killing only the root child was also rejected because provider-launched descendants could be orphaned.

## Risks / Trade-offs

- [A bounded tree can omit deep files in exceptionally large repositories] → Return an explicit truncated indicator and continuation guidance; never present a truncated snapshot as complete.
- [Async scans can overlap and duplicate work] → Deduplicate one in-flight scan per project/filter and share its completed TTL snapshot.
- [Git ignore chunking can produce inconsistent results if the working tree changes mid-scan] → Treat the tree as a short-lived observational snapshot and invalidate it promptly.
- [Timeouts can interrupt a slow but healthy provider] → Use inactivity rather than total duration, refresh it on progress, and keep the threshold configurable and conservative.
- [Reconnect reconciliation races with a newly accepted turn] → Include stable conversation identity and authoritative lifecycle state; apply snapshots idempotently and do not clear a turn newer than the snapshot boundary.
- [Preserved partial text may be mistaken for a complete answer] → Store/render explicit interrupted metadata or an adjacent system error and never emit `agent_done` for it.
- [Temporarily clearing the model makes the form unavailable during provider changes] → Show the existing loading state and disable submit only until the authoritative catalog resolves.
- [Non-Claude agent-authored specs no longer receive an automatic Contract Layer] → Report the capability as unsupported and keep the committed spec; never spend another provider's quota implicitly.
- [A provider descendant ignores graceful Stop] → Escalate only while the originally owned child/group is still registered; cancel escalation immediately on close.

## Migration Plan

No database migration is required if active lifecycle remains in memory and interrupted presentation uses the existing message/error shapes. Ship server bounds and terminalization first, then client reconciliation in the same release so old clients continue receiving ordinary terminal events. Rollback restores the previous behavior without data conversion; new optional response/event fields must be backwards compatible.

## Open Questions

- Choose final default limits from fixture benchmarks (candidate: 20,000 visited entries, 2,000 entries per response, five-second inactivity-safe scan budget).
- Decide whether interrupted partial output needs a new persisted message status column or can be represented by an assistant message plus the existing error message without ambiguity.
