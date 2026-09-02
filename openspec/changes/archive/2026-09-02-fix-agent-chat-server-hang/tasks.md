## 1. Reproduce and Instrument the Failure Boundaries

- [x] 1.1 Add deterministic fixtures for a large/deep repository, denied directories, symlinks, slow filesystem batches, and concurrent all-files requests without invoking an AI provider.
- [x] 1.2 Add structured Code Explorer diagnostics for scan duration, visited/returned counts, cache reuse, safety-bound termination, and watcher startup failure.
- [x] 1.3 Add agent lifecycle diagnostics that identify accepted, active, timed-out, aborted, interrupted, and terminal turns without logging prompts or capability secrets.

## 2. Make Code Explorer Discovery Responsive and Bounded

- [x] 2.1 Refactor all-files discovery to asynchronous batched traversal that yields to the event loop, applies deny rules before descent, and never follows symbolic links.
- [x] 2.2 Chunk `.gitignore` classification and enforce configurable elapsed-time and visited-entry limits with an explicit typed truncated/retryable response.
- [x] 2.3 Deduplicate in-flight scans per project/filter and retain compatible short-TTL snapshot pagination with pages capped at 2,000 entries.
- [x] 2.4 Move file-summary watcher attachment outside the response-critical path and explicitly disable symlink following while preserving build/dot-directory pruning.
- [x] 2.5 Add router tests proving health/provider-style requests can complete during a slow tree scan, concurrent pages share work, bounds are reported truthfully, and watcher failures degrade safely.

## 3. Guarantee Agent-Turn Terminalization

- [x] 3.1 Introduce an idempotent per-conversation turn lifecycle that records the active turn start and permits exactly one terminal disposition.
- [x] 3.2 Add a configurable provider inactivity watchdog refreshed by text, tool-use, tool-result, and other meaningful progress events; terminate the owned child and emit `agent_error` on expiry.
- [x] 3.3 Route timeout, provider failure, abort, deletion, disposal, and normal completion through the terminal lifecycle so race order cannot produce conflicting events or stranded active state.
- [x] 3.4 Persist non-empty partial assistant output before settling an unsuccessful provider exit and represent it explicitly as interrupted/failed without recording success.
- [x] 3.5 Add manager tests using fake children and injected time for stalled MCP activity, watchdog refresh, partial output plus non-zero exit, no-output failure, and competing terminal paths.
- [x] 3.6 Harden Stop process ownership: cancel SIGKILL escalation on child close, revalidate the owned child/group before escalation, and prove the sidecar and unrelated turns are never signal targets.

## 4. Reconcile Client State After Sidecar Recovery

- [x] 4.1 Expose an authenticated read API containing authoritative active agent turns and a snapshot boundary/version suitable for race-safe reconciliation.
- [x] 4.2 Add the agent API client call and reconcile `liveByConv` whenever the shared WebSocket transitions from non-connected to connected.
- [x] 4.3 Clear server-absent optimistic streams with one inline interruption message while retaining the user message and never auto-retrying the provider call.
- [x] 4.4 Preserve or restore server-active turns and guard against an older reconciliation snapshot clearing a newer locally accepted turn.
- [x] 4.5 Add client tests for sidecar restart, transient disconnect with a still-active turn, stale reconciliation races, message deduplication, and successful creation of another mission after recovery.
- [x] 4.6 Add a multi-client integration test proving Stop settles only its target conversation while the shared WebSocket and provider/new-mission endpoints remain available to another connected client.

## 5. Compatibility and Verification

- [x] 5.1 Keep new Code Explorer response fields, agent lifecycle fields, and events additive so existing clients retain their current pagination and terminal-event behavior.
- [x] 5.2 Run focused Code Explorer, MCP, agent-manager, agent-chat context, and shared-WebSocket test suites with all provider invocations mocked.
- [x] 5.3 Run repository type checks and the standard CI test command, documenting selected safety limits and confirming no Claude, Codex, or Gemini quota is consumed by tests.

## 6. Fix Provider/Model and Contract Layer Ownership

- [x] 6.1 Clear stale model/catalog state immediately on Add Spec provider changes and include model resolution in every button and keyboard submit guard.
- [x] 6.2 Remove the hard-coded `sonnet` Explore fallback, preserve latest-request ordering, and submit only a provider/model pair validated for the same provider.
- [x] 6.3 Remove the installed-provider scan that silently selects Claude for conversation-less agent-authored Contract Layer requests; use the originating provider or return an explicit unsupported/skipped outcome.
- [x] 6.4 Add UI tests for rapid provider switching, submit-during-load prevention, out-of-order model responses, and non-Claude default resolution.
- [x] 6.5 Add server tests proving a Codex, Gemini, or Kimi-authored commit never invokes Claude for Contract Layer and a supported provider retains its own model/provider pairing.

## 7. Bound MCP Code Explorer Payloads

- [x] 7.1 Cap MCP tree pages to a context-safe default, preserve cursor pagination, and omit verbose entry metadata unless provenance is explicitly requested.
- [x] 7.2 Accept `file` as a backwards-compatible alias for `path` on file-oriented Code Explorer actions.

## 8. Bound MCP Spec Listings

- [x] 8.1 Return compact, paginated `specrails_specs(list)` summaries and direct agents to `get(id)` for full spec bodies.
