## Why

The hub already shows cost/tokens/turns/duration for `claude` jobs, but the project's other AI surfaces — Quick spec generation, Explore spec conversations, AI Edit refines — are fire-and-forget. The result is that "what is this project costing me" cannot be answered honestly: only ~70% of the AI spend is visible. As Quick/Explore become the default entry points for new tickets, this gap will only widen.

The current `/analytics` page also reflects only jobs and ships a CSV export that is broken in three ways (uses `window.open` so Tauri never downloads, only serializes a 6-column subset of the visible page, no error feedback). Users have asked for both project-wide spending visibility and a working export. This change closes the gap end-to-end.

## What Changes

- Introduce a single `ai_invocations` SQLite table per project, written to by every AI-spawning manager at process exit, capturing model, tokens (in/out/cache), `total_cost_usd`, `num_turns`, duration, status, surface, and optional `ticket_id`.
- Capture invocations from four surfaces: `job` (QueueManager), `quick-spec` (`POST /tickets/generate-spec`), `explore-spec` (Explore conversation manager, one row per turn with `conversation_id`), `ai-edit` (AI Refine manager). **BREAKING**: `jobs` table no longer the sole source of cost analytics — `getAnalytics()` reads from `ai_invocations` going forward.
- Out of scope: chat sidebar, setup wizard, backfill of pre-change history. Tracking starts on first deployment; empty state must communicate this honestly.
- Redesign `/analytics` page (route name preserved) into a project-wide spending dashboard with seven blocks: hero burn meter with stacked surface breakdown and prev-period delta, daily stacked timeline, Quick-vs-Explore card, model breakdown, cost-vs-turns scatter for outlier discovery, top tickets aggregated cross-surface, raw filterable table.
- Add a single source of filters at the top of the page (period + surface chips); secondary filters (model, status, ≥cost) live only in the raw table block.
- Link from `TicketDetailModal` to `/analytics?ticket=<id>` showing per-ticket aggregated cost across all surfaces.
- Fix CSV export end-to-end: replace `window.open(url, '_blank')` with `fetch → blob → anchor.click()` (works in Tauri webview), split into Summary CSV (totals + timeline + breakdowns) and Raw CSV (one row per invocation), respect all active filters, contextual filename (`<slug>-analytics-<period>-<date>.csv`), disable button when no data, toast on error, hard cap of 10k rows on Raw export with truncation warning.

## Capabilities

### New Capabilities
- `project-spending`: Cross-surface AI invocation tracking, persistence, aggregation, and filterable querying for a project.
- `analytics-dashboard`: The user-facing `/analytics` page composition — header filters, hero burn meter, timeline, Quick-vs-Explore, model breakdown, scatter, top tickets, raw table, and the empty/loading states for each block.
- `analytics-csv-export`: Summary and Raw CSV/JSON export, filename and filter behaviour, error and empty-state handling, row cap.

### Modified Capabilities
<!-- None: there is no existing analytics-dashboard or project-spending capability spec; the prior /analytics page is documented inline in CLAUDE.md and `analytics.ts`, not as an OpenSpec capability. -->

## Impact

**Server**
- `server/db.ts` — new migration adds `ai_invocations` table with indices on `(project_id, started_at)`, `(project_id, surface)`, `(project_id, ticket_id)`.
- `server/modules/execution/runtime/queue-manager.ts` — at job close, additionally insert into `ai_invocations` with `surface='job'`. Existing `jobs` row keeps its denormalised metrics for queue UI.
- `server/project-router.ts` — `/tickets/generate-spec` (Quick) intercepts the `result` event from spawned subprocess; new manager hook for Explore (likely `server/explore-spec-manager.ts` or wherever the conversation manager lives — to be confirmed in design); AI Edit refine manager hook.
- `server/analytics.ts` — rewritten to query `ai_invocations` instead of `jobs`. Introduces `getSpending(projectId, filters)` returning all data needed by the seven dashboard blocks plus a `rawInvocations(filters, cap)` for export.
- `server/project-router.ts` — `/analytics/export` extended with `mode=summary|raw`, honors surface/model/status/min-cost filters, applies row cap, sets descriptive filename header.

**Client**
- `client/src/features/analytics/pages/AnalyticsPage.tsx` — full rewrite. Same route, new layout.
- `client/src/features/analytics/components/ExportDropdown.tsx` — CSV path uses fetch+blob like JSON; submenu split between Summary CSV and Raw CSV.
- `client/src/features/specs/components/TicketDetailModal.tsx` — adds the cost summary line + link.
- New components: `SpendingHero`, `SpendingTimeline`, `QuickVsExploreCard`, `ModelBreakdown`, `CostScatter`, `TopTicketsCrossSurface`, `InvocationsTable` under `client/src/components/analytics/`.

**Telemetry contract**
- The OTLP receiver and pipeline-telemetry feature are unaffected; both continue writing to `telemetry_blobs` independently. `ai_invocations` is the simpler, always-on, low-cardinality counterpart used by the dashboard. No coupling.

**Docs**
- `CLAUDE.md` gets a new section under "Architecture" describing `ai_invocations` and the four capture sites.
