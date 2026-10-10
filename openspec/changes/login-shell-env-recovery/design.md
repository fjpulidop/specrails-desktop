## Context

`resolveWorktreeEnvPassthrough(db)` (in `server/project-env.ts`) runs at spawn time for queued jobs, loop executors and retained runtime controls. For each configured name missing from `process.env`, it calls `readEnvFromLoginShellSync`. That function:

- runs `spawnSync($SHELL, ['-l','-i','-c', printf-with-sentinels])` with a 1.5 s timeout;
- returns `{}` when there is an error, a timeout or a non-zero status;
- caches the result per project for 30 s.

A GUI-launched Desktop with a slow interactive profile therefore never receives the credential, and nothing tells the user why.

## Goals / Non-Goals

**Goals:**
- Recover configured names reliably from slow or noisy profiles, without blocking the event loop.
- Make every configured name's resolution observable (UI, API, run log) without exposing values.

**Non-Goals:**
- Reading values from the Keychain or from `.env` files.
- Changing which names are configured, or how they are stored (names only, in project settings).
- Windows. Behaviour stays inherited-only there.

## Decisions

1. **Async probe with a warm cache. Keep the sync path only as a cold fallback.**
   - Spawn sites are synchronous today (the `env()` callbacks). Making all of them async would ripple through the loop executors and the queue.
   - Warming the cache on project open and on settings change, and refreshing it before expiry, keeps spawn-time reads synchronous and cheap.
   - Alternative: raise the sync timeout to 10 s. Rejected, because it could freeze the server for 10 s on every cold spawn.

2. **Accept on sentinels, not on exit status.**
   - The printf block is bracketed by sentinels.
   - Profiles often end with a failing conditional, or `zsh -i` returns non-zero for reasons unrelated to the printed values.
   - The sentinel block is the real proof that the probe produced its output.

3. **Separate lifetimes for success and failure.**
   - A success is valid for up to 10 minutes, and the background refresh rotates credentials well inside that window.
   - Failures and empty results are retried after 30 s, as today, so a fixed profile is picked up quickly.
   - The "within 30 s" clause of the canonical requirement is narrowed to failures.

4. **The status is the unit of observability.**
   - One small, value-free record per name (`inherited | recovered | not-defined | probe-timeout | probe-failed`, plus shell and time) feeds the route, the UI chips, the MCP `env` tool and the run-log warning.
   - Each of those surfaces derives from the same record, so they never drift apart.

5. **One warning per run.**
   - Unresolved names produce a single, aggregated line at spawn time. This avoids noise from the per-spawn retries inside a run.

## Risks / Trade-offs

- [The background probe runs the user's interactive profile periodically] → It runs only for projects with configured names that are missing from `process.env`, refreshes at most every few minutes, and has a bounded timeout.
- [A profile prints prompts or banners to stdout] → Sentinel parsing already ignores text outside the block.
- [A value could leak through status or logs] → The status type has no value field. A test asserts that the route, MCP and log output never contain a fixture secret.
- [Cold first spawn right after the app opens] → The sync fallback is unchanged, and the warm-up starts as soon as the project opens.

## Migration Plan

There is no persisted data change. Rollback is a revert. `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` is optional.

## Open Questions

- Should the main window show a global toast when a configured name is unresolved at project open? Proposal: no. The settings chip and the run-log warning are enough. Revisit if users still miss it.
