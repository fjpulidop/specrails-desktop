## Context

The Job Detail page (`client/src/features/jobs/pages/JobDetailPage.tsx`) currently has two visual problems:

1. **No live progress.** The metric card (`JobCompletionSummary`, `client/src/components/JobCompletionSummary.tsx`) is gated to `status === 'completed' | 'failed'`, so a running job shows only the streaming log viewer with no aggregated counters. Users can't tell at a glance how long it has been running, how many turns have happened, or how many tokens have been consumed.
2. **Job identity is the command, not the work.** The header treats `/specrails:implement #24 --yes` as the visual hero. A human identifying the job from a list naturally wants to see *what the ticket was about*.

Server-side, both the data we need is already produced today:

- `assistant` events from the Claude CLI stream-json output reach the client via the existing event feed (`appendEvent` in `queue-manager.ts:835` and broadcast). Each carries a `message.usage` block.
- `_extractTicketIds(command)` in `queue-manager.ts:457` already implements the `#(\d+)` regex semantics we need.
- `readStore(resolveTicketStoragePath(cwd))` from `ticket-store.ts` exposes ticket titles by id.
- `total_cost_usd`, `tokens_in`, `tokens_out`, `num_turns` are persisted on the `jobs` row at exit (in `_onJobExit`, `queue-manager.ts:957-970`).

What is missing is (a) a thin server endpoint shape change to attach resolved ticket titles to the job-detail response, and (b) client UI that shows the metric card while running and adds a ticket-identity card.

## Goals / Non-Goals

**Goals:**

- Show live Duration, Turns, Tokens for running jobs, with sub-second-perceptible updates for Duration.
- Identify a job by its ticket title at the top of the Job Detail page, with a clear visual hierarchy that demotes the command.
- Keep the existing "completed / failed" rendering of the panel pixel-equivalent — running mode is *additive*, not a redesign.
- Zero changes to `specrails-core`, `QueueManager`, `ChatManager`, the WebSocket protocol, or the job DB schema.

**Non-Goals:**

- Estimating Cost mid-run from token counts (rejected — display `—` until the authoritative `result` arrives).
- Persisting a snapshot of ticket titles on the `jobs` row (rejected — render live; accept that renames update historical jobs).
- Showing ticket titles in `RecentJobs` / Dashboard (deferred — same problem, separate change).
- Server-side aggregation/broadcast of mid-run counters (rejected — events already reach the client; derive there).
- A new route for ticket detail — clicks open an existing modal overlay.

## Decisions

### 1. Where to compute live counters: client, not server

Each `assistant` event already arrives at the client via the existing event WebSocket feed. The client maintains an `events` array per open Job Detail page (existing behaviour). Aggregation is therefore O(1) per event using a running accumulator.

**Why client:**

- Zero schema, zero new WS message, zero server change for the metric calculation.
- Running counter on reload is reconstructable by replaying events from `GET /jobs/:id/events`, which the page already loads.
- No risk of partial DB writes / races with `finishJob`.

**Why not server:**

- Would require either persisting per-event counters (write amplification) or holding in-memory state across `QueueManager` and broadcasting a new `job.stats` WS frame. Both add complexity for value that is already derivable downstream.

**Alternatives rejected:** server-side periodic aggregate broadcast (added complexity, no UX win). Client-side computation from the DB-only fields (`tokens_in`, etc.) — those are only written at exit, so they're always 0/null while running.

### 2. Aggregation strategy on the client: incremental accumulator

`JobCompletionSummary` today recomputes `extractModifiedFiles(events)` on every event with `useMemo`. For Turns and Tokens we don't want to re-sum the entire array on every new event; the array can grow to thousands of entries on long jobs.

**Approach:** `useReducer` (or `useRef + state`) keyed by the last event seq processed. On `events` change, iterate only the new tail (`events.slice(lastSeenIdx)`), update the accumulator, advance the cursor. The accumulator stores `{ turns: number; tokens: number; lastSeenSeq: number }`. Reset to zero when `job.id` changes (i.e. user navigated to a different job).

This is also robust against React Strict Mode double-invokes because the reducer keys updates by event seq, not by render.

### 3. Ticking the duration: single 1s `setInterval` on the panel

While `job.status === 'running'`, mount a `setInterval(() => setNow(Date.now()), 1000)` inside the panel. Clear on unmount and on transition to terminal status. Compute Duration from `now - new Date(started_at).getTime()`. Re-uses the existing `formatWallClock` helper after a small refactor that lets it accept `(start, endMs?: number)`.

We don't need `requestAnimationFrame` — second-level granularity is what the Duration text expresses.

**Drift:** the interval is allowed to drift by a few hundred ms; we re-derive elapsed time from absolute timestamps every tick, so drift accumulates only in *when* we re-render, not in *what* we render. Acceptable.

### 4. Cost as `—` until job exit

The `result` JSON event from `claude` stream-json is the only authoritative source of `total_cost_usd`. It is emitted only at the end of a phase. Per-turn `assistant` events do not include cost.

**Decision:** while `job.total_cost_usd` is null/undefined, show `—` in `text-muted-foreground`, no estimation. When the job exits, `total_cost_usd` is populated by `finishJob` and pushed via the existing `job.update` WS broadcast. The cell switches to the existing `text-yellow-400` styling.

This keeps multi-phase pipelines coherent: each finished phase shows real Cost, the active phase shows `—`. No half-truths.

### 5. Reuse `JobCompletionSummary`, rename to `JobStatusPanel`

The panel handles three states (`running`, `completed`, `failed`) and the existing component already encapsulates the metric grid, modified-files list, and pipeline-totals roll-up. Rather than introducing a sibling component, extend it and rename.

**Header label / icon mapping:**

| Status | Icon | Label | Border / bg |
|---|---|---|---|
| `running` | `Loader2` (animate-spin) | Job in progress | `border-info/20 bg-info/5` (use `accent-info` token) |
| `completed` | `CheckCircle2` | Job completed | unchanged |
| `failed` | `XCircle` | Job failed | unchanged |

`canceled` and `zombie_terminated` map to the `failed` style. (They render with the same severity today via the page-level fallback, so no scenario change.)

### 6. Server endpoint shape change: attach `tickets[]` to `GET /jobs/:id`

Not introducing a separate `/tickets` lookup endpoint — that creates N+1 round-trips, a race window, and no caching benefit since the per-project ticket store is already in memory at `ProjectContext` level (or trivially re-readable; it's a tiny JSON file).

**Resolution algorithm (server, in the route handler or a thin helper):**

```
extract ids = unique numeric ids from /#(\d+)/g over command.toString(), preserving first-occurrence order
for each id:
  title = readStore(resolveTicketStoragePath(cwd)).tickets[String(id)]?.title ?? null
return { id, title }[]
```

Reuse `_extractTicketIds` semantics — but extract the regex into a shared helper (`extractTicketIdsFromCommand` in a new `server/ticket-helpers.ts` or co-locate in `ticket-store.ts`) so both `QueueManager._buildImplementAttachmentContext` and the route can share a single canonical implementation.

Performance: `readStore` does a JSON parse of `<project>/.specrails/local-tickets.json` per call. The Job Detail endpoint is hit once on page load and on revalidation; this is fine. We do not memoise — title freshness on rename is an explicit goal.

### 7. Ticket header layout: dedicated component

Introduce `client/src/features/jobs/components/JobTicketHeader.tsx`:

```
JobTicketHeader({ tickets, command, status, startedAt, model, onTicketClick })
  if tickets.length === 0:        return null  // page falls back to legacy header
  if all tickets have null title: render "(deleted)" chips, no hero
  if 1 <= tickets.length <= 3:    list mode (chip + title per row)
  if tickets.length >= 4:         compact mode (first title + "+ N more" + expand)
```

Place it in `JobDetailPage.tsx` *above* the existing `<div className="flex items-start justify-between gap-3">` info row. When `JobTicketHeader` renders, the legacy info row demotes (smaller status badge, mono-coloured `code`, single secondary line). When `JobTicketHeader` returns null, the legacy info row keeps its current size.

### 8. Ticket modal trigger: reuse existing spec/ticket detail UI

The spec/ticket detail UI already exists — verify the canonical component during implementation (`SpecsBoard`-related modal). The chip click handler calls a hook/helper that opens that modal with the given ticket id. No new route, no URL change.

If the existing modal can only be opened from inside a specific page tree, we add a project-level modal context provider (similar to `MinimizedChatsProvider`) so the Job Detail page can dispatch the same intent. This is the smallest expected complication; if it materialises it gets its own task in `tasks.md`.

### 9. Premium visual polish — token contract

All colours go through the existing semantic Tailwind tokens (`accent-info`, `accent-success`, `surface`, `muted-foreground`, etc.) so the three built-in themes (`dracula`, `aurora-light`, `obsidian-dark`) all look right. No `dracula-*` brand-named tokens, per the global theme rule.

The ticket card's frame is `border-border/40 bg-card/40 rounded-xl` — same family as `JobCompletionSummary`'s frame, so the two stack cleanly on the page.

## Risks / Trade-offs

- **Risk:** A long-running job accumulates thousands of `assistant` events; recomputing aggregates on every render hurts. → **Mitigation:** incremental accumulator (Decision 2), iterate only the new tail.
- **Risk:** Live counters drift from the server-of-truth `tokens_in/out` written at job exit (e.g. if the CLI reports `usage` differently per turn vs at result time). → **Mitigation:** at job exit, replace the live-derived counters with the authoritative `JobSummary` fields. Users see at most a brief flicker as the cell snaps to its final value.
- **Risk:** Renaming `JobCompletionSummary` breaks imports and tests. → **Mitigation:** rename + co-locate; one PR-wide find/replace, plus updating `client/src/components/__tests__/JobCompletionSummary.test.tsx` to follow.
- **Risk:** `readStore` on every `GET /jobs/:id` has a measurable cost on large ticket stores. → **Mitigation:** the local-tickets JSON is small in practice; if profiling shows otherwise, add a per-request memoisation (resolve once per request, share across multiple ids in the same command).
- **Risk:** The "spec/ticket detail modal" component does not exist as a reusable surface. → **Mitigation:** if so, the implementation step adds a thin context provider and registers the existing modal under it. Surfaced as Open Question 1 below.
- **Trade-off:** No mid-run cost estimate means users with budget anxiety see `—` for the entire phase. Accepted: dishonest numbers are worse than no numbers, and the pipeline-total roll-up still surfaces real spend across finished phases.

## Migration Plan

No data migration. No schema migration. Pure feature addition + rename.

Rollback is trivial: revert the PR. The renamed component (`JobStatusPanel`) is unreferenced outside this change after the rename, so no consumer is left dangling.

## Open Questions

1. **Which existing component renders the spec/ticket detail modal?** `SpecsBoard` shows the per-project ticket list, but the actual detail UI may be a sub-component of it (e.g. an expanded card or a Radix `Dialog`). Confirm in-implementation; if no modal exists, build the smallest possible one wrapping today's detail rendering.
2. **Where does the `cwd` come from inside `GET /jobs/:id`?** Confirmed available via `ProjectContext` in `project-router.ts`. No issue, just flagging that the resolver needs access to the project's working directory.
3. **Compact-mode threshold** — set to 4 tickets in this design. Easy to tune to 3 or 5 later from a single constant.
