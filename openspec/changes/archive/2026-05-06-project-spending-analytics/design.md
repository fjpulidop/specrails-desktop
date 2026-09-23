## Context

Today the hub captures cost/tokens/turns/duration only for `claude` jobs spawned by `QueueManager` (table `jobs` in the per-project SQLite). Three other surfaces invoke the same CLIs and emit identical `result` events, but discard them: Quick spec generation in `server/project-router.ts:1460` (claude or codex via `--output-format stream-json`), Explore conversations via `server/modules/conversations/runtime/chat-manager.ts` driven by the `/specrails:explore-spec` skill, and AI Edit refines via `server/modules/agents/runtime/agent-refine-manager.ts`. The chat sidebar (also routed through `ChatManager`) and the setup wizard (`SetupManager`) are explicitly excluded from this change.

The current `/analytics` page (`client/src/features/analytics/pages/AnalyticsPage.tsx` + `server/analytics.ts`) reads from `jobs` only and exposes a CSV export that is broken three ways: (1) `ExportDropdown.handleCsv` uses `window.open(url, '_blank')`, which in the Tauri webview opens an internal frame instead of triggering a download; (2) the server only serializes `analytics.commandPerformance` (six columns out of the visible page); (3) failures surface as the JSON error response rendered as a page, with no toast.

`ChatManager` is shared between the chat sidebar (excluded) and Explore (included). At the data layer `chat_conversations` does not distinguish them — currently the difference is implicit in how the client invokes the routes (system prompt + skill name).

## Goals / Non-Goals

**Goals:**
- A single per-project SQLite table `ai_invocations` that captures every billable AI invocation across the four in-scope surfaces.
- A redesigned `/analytics` page that answers "what is this project costing me, by surface, over time, and which tickets/runs are outliers" within one viewport plus a raw filterable table.
- A working CSV/JSON export that respects the active filter state and ships both Summary and Raw flavours.
- One source of truth for all dashboard widgets (`getSpending(projectId, filters)`) so adding a new surface in the future is a one-line capture call plus a colour token.

**Non-Goals:**
- Backfilling historical jobs into `ai_invocations`. Existing `jobs` rows stay where they are; the dashboard reads only `ai_invocations`. Empty state must communicate "Tracking started <date>".
- Capturing chat-sidebar or setup-wizard invocations.
- Cost alerts / budget enforcement on the new surfaces. The existing per-job alert path stays as-is and continues to fire from `QueueManager`. Alerts on Quick/Explore/AI-Edit are deferred to a follow-up change.
- Per-message granularity inside Explore. One row per CLI invocation (= one turn) is the unit; per-message detail can be derived from `chat_messages` if needed later.
- Forecast / projection of future spending.
- Comparison across projects (hub-level dashboard); this change is per-project.

## Decisions

### D1. Single unified table `ai_invocations`, not per-surface tables

```
CREATE TABLE ai_invocations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,         -- denormalised for cross-project queries
  surface TEXT NOT NULL,            -- 'job' | 'quick-spec' | 'explore-spec' | 'ai-edit'
  surface_ref_id TEXT,              -- job_id | conversation_id | refine_id
  ticket_id INTEGER,                -- nullable; FK-soft to tickets.yaml id
  conversation_id TEXT,             -- only set for surface='explore-spec'
  model TEXT,
  status TEXT NOT NULL,             -- 'success' | 'failed' | 'aborted'
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  duration_api_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cache_read INTEGER,
  tokens_cache_create INTEGER,
  total_cost_usd REAL,
  num_turns INTEGER,
  session_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ai_inv_project_started ON ai_invocations(project_id, started_at DESC);
CREATE INDEX idx_ai_inv_project_surface ON ai_invocations(project_id, surface);
CREATE INDEX idx_ai_inv_project_ticket ON ai_invocations(project_id, ticket_id) WHERE ticket_id IS NOT NULL;
```

**Why one table over four:** every surface emits the same `result` event shape (claude CLI `--output-format stream-json` or codex equivalent). Aggregating across surfaces is the *primary* user pain point; a unified shape makes "total project cost" a single `SUM`, and breakdowns are filters on the same query. Per-surface tables would force `UNION ALL` everywhere, with surface-specific schema drift over time.

**Alternative considered:** extend the existing `jobs` table with a `surface` column and reuse it. Rejected because (a) `jobs` carries operational state (queue position, exit code, command line) that doesn't apply to Quick/Explore/AI-Edit; (b) Explore writes one row per turn — bloating `jobs` with non-job rows would distort queue UI queries.

### D2. Capture site lives in each manager's "process exit" path, not in the route

For each surface, the spawned subprocess emits a final `result` event (or, on failure, the process exits before emitting one). The capture rule:
- On `result` event seen → insert with `status='success'` and the parsed metrics.
- On process exit without `result` (non-zero exit code or kill) → insert with `status='failed'`, metrics NULL, `started_at`/`finished_at` from process timestamps.
- On user-initiated cancellation → insert with `status='aborted'`.

Capture sites:
| Surface | Manager / handler | New helper |
|---|---|---|
| `job` | `QueueManager.spawnJob` `child.on('close')` | `recordInvocation({surface:'job', ...})` next to existing `finishJob` |
| `quick-spec` | `POST /tickets/generate-spec` exit handler in `project-router.ts` | same helper |
| `explore-spec` | `ChatManager`'s `child.on('close')`, gated by `conversation.kind === 'explore'` | same helper |
| `ai-edit` | `AgentRefineManager` exit handler | same helper |

Helper exported from `server/modules/accounting/runtime/ai-invocations.ts`. All five managers receive the helper via constructor injection (or import directly — none of them are unit-testable in isolation today, so the looser coupling is fine).

**Alternative considered:** OTLP-style central receiver where each manager POSTs a payload. Rejected — adds a network hop in-process for zero benefit.

### D3. Differentiate Explore from chat-sidebar via a `kind` column on `chat_conversations`

```
ALTER TABLE chat_conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'sidebar';
```

`POST /chat/conversations` accepts an optional `kind` field. The Explore client (`ExploreSpecShell`) sends `kind: 'explore'`. `ChatManager` reads `conversation.kind` at process exit and only inserts into `ai_invocations` when `kind === 'explore'`. Sidebar chat continues uninstrumented.

**Why:** today the manager has no way to know what kind of conversation it is running. Adding the column is one migration and zero behaviour change for sidebar.

**Alternative considered:** wire a separate `ExploreManager` class. Rejected — duplicates ChatManager wholesale for a one-flag difference.

### D4. One row per turn for Explore, with `conversation_id` for aggregation

Each call to `ChatManager.sendMessage` spawns one CLI invocation and produces one `result`. Each → one row. Aggregating per Explore session is `SUM(...) WHERE conversation_id = ?`. A ticket created from an Explore session gets `ticket_id` written *retroactively* on existing rows when `POST /tickets/from-draft` succeeds — `UPDATE ai_invocations SET ticket_id = ? WHERE conversation_id = ? AND ticket_id IS NULL`. This keeps the join one-step.

**Trade-off:** rows created before the ticket exists carry `ticket_id = NULL` until the user clicks "Create ticket". If the user abandons the conversation, the rows stay null forever — they still count toward the total but are not attributable to a ticket. The "Top tickets" widget therefore reports "Unattributed Explore" as a synthetic line when applicable.

### D5. `getSpending(projectId, filters)` is the only query path

Server side:
- `server/modules/accounting/runtime/spending.ts` exports `getSpending(db, opts) → SpendingResponse`. Single SQL query (with CTEs) returning all data needed by the seven dashboard blocks: `summary`, `dailyTimeline`, `byMode` (Quick vs Explore), `byModel`, `scatter`, `topTickets`, plus `totals`.
- `getInvocations(db, opts)` returns the raw rows for the table block and Raw export (paginated, with hard cap of 10 000 for export).
- `server/analytics.ts` is repurposed to call into `server/modules/accounting/runtime/spending.ts` for the new endpoints. The legacy `getAnalytics()` is kept for one release for backwards compatibility but emits a deprecation log line, then removed in a follow-up.

Filters accepted: `period` (`7d`/`30d`/`90d`/`all`/`custom`+`from`/`to`), `surface` (CSV multi-select), `model` (CSV), `status`, `minCostUsd`, `ticketId`.

### D6. Single source of filter state on the page; secondary filters scoped to the table

`AnalyticsPage` holds `filters` state at the top. Period selector + surface chip group push to it. Every dashboard block reads from the same `useSpending(filters)` hook (stale-while-revalidate via `useProjectCache`).

The raw-table block (block 7) layers *additional* secondary filters (`model`, `status`, `minCostUsd`) that affect only that block via `useInvocations(filters + secondary)`. This avoids the "every widget has its own filter UI" anti-pattern while still letting power users drill in the table.

**Why:** users will compare blocks visually (e.g. "the timeline went up because of opus runs" → click `opus 4.7` in the model breakdown to filter the page). That only works if filters are page-scoped. Per-widget filters would defeat the comparison.

### D7. CSV export: `fetch → blob → anchor.click()`, two flavours, filter-aware

`ExportDropdown.handleCsv` now mirrors `handleJson`: fetch the URL, wrap as `Blob`, create object URL, click hidden `<a download>`. Works in Tauri webview and browsers identically. The dropdown grows two CSV entries:
- **Summary CSV** — composite document: section banners + KPI block + daily timeline rows + per-surface breakdown + per-model breakdown + top tickets. Multi-sheet feel inside one CSV file (separated by blank rows + section markers `# Daily totals` etc.).
- **Raw CSV** — one row per invocation, all columns from `ai_invocations` plus `ticket_title` join. Capped at 10 000 rows; if truncated, append a final row `# truncated_at=10000 of <total>` (prefixed with `#` so spreadsheets show it but treat as comment-able).

JSON export remains unchanged for both summary and raw modes.

Filename: `<slug>-analytics-<period>-<YYYY-MM-DD>.csv` for Summary, `<slug>-invocations-<period>[-<surface>]-<YYYY-MM-DD>.csv` for Raw. `Content-Disposition: attachment; filename="..."` set server-side.

Empty state: button is `disabled` with tooltip "No data for current filters" when the query would return zero rows. Server still returns 200 + headers-only payload if hit directly, so `curl` users aren't surprised.

Errors: `fetch` rejection or non-2xx → `toast.error('Export failed')` via existing sonner. No console spam.

### D8. Ticket → analytics deep link

`TicketDetailModal` adds a single line under the title:

```
$0.71 · 12 turns · 3m 24s active · explore + 1 quick   →
```

The `→` links to `/analytics?ticketId=<id>` which seeds the page filters. The aggregate is computed client-side from a tiny new endpoint `GET /tickets/:id/spending-summary` (one row, four numbers). No N+1 — the endpoint runs one indexed query.

### D9. WebSocket invalidation, not push of new rows

When `recordInvocation` writes a row, it broadcasts `spending.invalidated` (project-scoped, no payload). The client invalidates the spending query for the active project. This avoids streaming heavy aggregate payloads over WS for every `result` event; the next render fetches the up-to-date snapshot. Since the page is rarely open during heavy job batches, this is the right trade-off.

## Risks / Trade-offs

- [Explore session minimised then resumed days later may write rows after the originally-attached ticket is deleted] → The `ticket_id` FK is soft (no SQL FK constraint). The Top Tickets widget joins against `tickets.yaml` and renders a dim "deleted ticket #N" row when the join misses, mirroring how `JobTicketHeader` already handles deleted tickets.

- [10 000 row cap on Raw export may surprise heavy users] → The cap row (`# truncated_at=10000`) plus a non-blocking client-side note in the dropdown ("Raw export limited to 10k most-recent rows") communicates this. JSON export does not have the cap; users with >10k rows can use it. We can revisit raising the cap once we see real usage.

- [`status='failed'` rows have NULL metrics, distorting averages if naïvely averaged] → Aggregations explicitly filter to `status='success'` for `avgCostUsd`, `avgDurationMs`, etc. Failed rows count toward `totalRuns` and `failureRate` only. Documented in the spec scenarios.

- [Adding `kind` column to `chat_conversations` migrates an existing table on user devices] → SQLite `ALTER TABLE ADD COLUMN` with `DEFAULT 'sidebar'` is O(rows-already-existing) but trivial in practice (these tables hold tens of rows, not millions). Migration is in the standard `MIGRATIONS` array in `db.ts`.

- [Capturing AI Edit refines depends on `agent-refine-manager` emitting `result` reliably] → Verified that the manager spawns claude with `--output-format stream-json`. If the binary changes in a future refactor, the capture site becomes dead code silently. Mitigation: add an integration test that spawns a stub binary printing a fake `result` event and asserts the row is written; this lives alongside the existing manager tests.

- [Coverage thresholds (80% server, 80% client lines/statements)] → `server/modules/accounting/runtime/spending.ts` and the new components are net-new code; they need their own unit tests. Estimate ~25 new server tests and ~20 client component tests. Tracked explicitly in tasks.

- [Concurrent project switches while spending request is in flight] → Existing `useProjectCache` invalidates by `activeProjectId`; the new hook reuses it. Pattern is the established one.

## Migration Plan

1. Land DB migration: `ai_invocations` table + `chat_conversations.kind` column. Behavior unchanged at this point — all reads still go through `getAnalytics()` and `jobs`.
2. Add capture in all four managers behind a feature flag `SPECRAILS_AI_INVOCATIONS_CAPTURE !== 'false'` (default on). One commit per manager so any regression is easy to bisect.
3. Land `server/modules/accounting/runtime/spending.ts` + new endpoints. Old `/analytics/export` keeps working in parallel.
4. Land redesigned `/analytics` page. Old export still served by old endpoint until the page rewrite is merged; then `ExportDropdown` is wired to the new endpoint.
5. Remove legacy `getAnalytics()` and the old export endpoint in a follow-up release after one beta cycle.

Rollback: setting `SPECRAILS_AI_INVOCATIONS_CAPTURE=false` stops new captures; the redesigned page keeps working with existing data. The legacy code path is gone after step 5; rollback past that requires a revert.

## Open Questions

- **Codex `result` event shape parity.** Quick spec supports `provider=codex` (`gpt-5.4-mini`). The `result` event from `codex exec` is *not* identical to claude's. Do we lossy-map (best effort: tokens + cost when present, NULL otherwise) or skip codex captures entirely in v1? Default in design: lossy-map, mark codex rows with `model='codex-*'` so they're filterable. To confirm during implementation by reading a real `codex exec` stream.
- **Should the burn-meter "vs prev period" baseline use the same surface filter?** Probably yes (apples-to-apples), but the prev-period query doubles the data fetched. Default: yes, filter applied; performance budget = single indexed query so the cost is negligible.
- **Naming of the page in the right sidebar: keep `Analytics` (per user vote) or `Spending`?** Decision per user input: keep `Analytics`. No code change needed in the sidebar.
