## ADDED Requirements

### Requirement: `provider` column on `ai_invocations`

The per-project SQLite schema SHALL include a `provider` column on the `ai_invocations` table. The column SHALL be populated at insert time from the resolved adapter's `id`. Existing rows from before the migration SHALL be backfilled to `'claude'`.

#### Scenario: Schema includes provider column
- **WHEN** the per-project database is at the latest schema version
- **THEN** `PRAGMA table_info(ai_invocations)` includes a row for `provider` of type `TEXT`

#### Scenario: New codex row carries the right provider
- **WHEN** a codex job completes and `recordInvocation` writes its row
- **THEN** the row's `provider` column equals `'codex'`

#### Scenario: Backfill marks pre-migration rows as claude
- **WHEN** the per-project database is migrated from a pre-`provider` schema
- **THEN** every existing `ai_invocations` row has `provider = 'claude'`

### Requirement: `total_cost_usd_estimated` flag on `ai_invocations`

The per-project SQLite schema SHALL include a `total_cost_usd_estimated INTEGER NOT NULL DEFAULT 0` column on `ai_invocations`. A value of `1` indicates the cost was computed via the local pricing table (estimated); `0` indicates the cost (if any) came directly from the provider's terminal event (authoritative).

#### Scenario: Schema includes the estimated flag
- **WHEN** the per-project database is at the latest schema version
- **THEN** `PRAGMA table_info(ai_invocations)` includes a row for `total_cost_usd_estimated` of type `INTEGER` with default `0`

#### Scenario: Claude row has the flag at 0
- **WHEN** a claude job completes and emits a `result` event carrying `total_cost_usd`
- **THEN** the inserted row has `total_cost_usd_estimated = 0`

#### Scenario: Codex row has the flag at 1 when cost was estimated
- **WHEN** a codex job completes with token usage but no native cost
- **AND** `estimateCostUsd` returns a non-null value
- **THEN** the inserted row has `total_cost_usd_estimated = 1` and `total_cost_usd = <estimated value>`

#### Scenario: Codex row keeps the flag at 0 when model is not in the pricing table
- **WHEN** a codex job completes with token usage but its model is not in `server/modules/accounting/runtime/pricing.ts`
- **AND** `estimateCostUsd` returns `null`
- **THEN** the inserted row has `total_cost_usd IS NULL` and `total_cost_usd_estimated = 0`

### Requirement: Pricing-table fallback for non-native-cost providers

The hub SHALL maintain a local pricing table at `server/modules/accounting/runtime/pricing.ts` keyed by `<providerId>:<model>` and SHALL populate `total_cost_usd` for `ai_invocations` rows whose resolved adapter declares `capabilities.nativeCostUsd === false`, using only the captured token usage and the table entry. The pricing module SHALL expose `estimateCostUsd(providerId, model, usage): number | null` and `lastReviewedAt(): string`. Rows whose model is not in the table SHALL be inserted with `total_cost_usd IS NULL` and `total_cost_usd_estimated = 0`.

#### Scenario: Cost is estimated for codex jobs
- **GIVEN** the pricing table contains an entry for `codex:gpt-5.4-mini`
- **WHEN** a codex rail job completes with `tokens_in=100, tokens_out=200, tokens_cache_read=50` and `model='gpt-5.4-mini'`
- **THEN** the inserted row's `total_cost_usd` equals `estimateCostUsd('codex','gpt-5.4-mini', {tokens_in:100,tokens_out:200,tokens_cache_read:50})`
- **AND** `total_cost_usd_estimated = 1`

#### Scenario: Cost is authoritative for claude jobs
- **WHEN** a claude rail job completes with a `result` event carrying `total_cost_usd=0.0237`
- **THEN** the inserted row's `total_cost_usd = 0.0237`
- **AND** `total_cost_usd_estimated = 0`
- **AND** the pricing table is not consulted

#### Scenario: Unknown model results in null cost
- **WHEN** a codex job completes with a model name not present in the pricing table
- **THEN** the inserted row has `total_cost_usd IS NULL` and `total_cost_usd_estimated = 0`
- **AND** no exception is thrown during `recordInvocation`

### Requirement: AnalyticsPage surfaces an "estimated" badge

The Analytics dashboard SHALL render a `~` (tilde) prefix on every cost cell where the underlying `ai_invocations` row has `total_cost_usd_estimated = 1`. The tilde MUST be tooltipped with a brief explanation ("Cost is estimated from a local pricing table; this provider does not report cost natively."). The Hero burn meter MUST aggregate authoritative and estimated costs into the same totals without separating them, but SHALL display a small footnote whenever the period contains at least one estimated row ("Includes estimated costs for non-native-cost providers.").

#### Scenario: Tilde rendered on estimated rows
- **WHEN** the Raw invocations table renders a row with `total_cost_usd_estimated = 1` and `total_cost_usd = 0.0123`
- **THEN** the cost cell shows `~$0.012` (or similar formatting) with a tooltip explaining the tilde

#### Scenario: No tilde for authoritative rows
- **WHEN** the row has `total_cost_usd_estimated = 0` and `total_cost_usd = 0.0237`
- **THEN** the cost cell shows `$0.024` without a tilde

#### Scenario: Hero footnote appears only when mixed totals
- **WHEN** the active period contains at least one row with `total_cost_usd_estimated = 1`
- **THEN** the Hero burn meter renders a small footnote noting that estimated costs are included

#### Scenario: Hero footnote absent on all-authoritative periods
- **WHEN** the active period contains zero estimated rows
- **THEN** the Hero burn meter does not render the estimated-cost footnote

### Requirement: byProvider analytics breakdown

`getSpending(db, opts)` SHALL return a `byProvider` array of shape `{ provider: string; count: number; costUsd: number; estimatedCostUsd: number }[]` derived from `GROUP BY provider`. Each entry MUST distinguish the authoritative cost contribution (sum where `total_cost_usd_estimated = 0`) from the estimated cost contribution (sum where `total_cost_usd_estimated = 1`).

#### Scenario: byProvider returns mixed totals
- **GIVEN** a project with 3 claude rows ($0.10 each, all authoritative) and 5 codex rows ($0.02 each, all estimated) in the period
- **WHEN** `getSpending` is called
- **THEN** `byProvider` contains `[{ provider: 'claude', count: 3, costUsd: 0.30, estimatedCostUsd: 0 }, { provider: 'codex', count: 5, costUsd: 0, estimatedCostUsd: 0.10 }]`

## MODIFIED Requirements

### Requirement: Unified per-project AI invocation table

The system SHALL persist one row per AI CLI invocation in a per-project SQLite table `ai_invocations` with the columns: `id`, `project_id`, `provider`, `surface`, `surface_ref_id`, `ticket_id`, `conversation_id`, `model`, `status`, `started_at`, `finished_at`, `duration_ms`, `duration_api_ms`, `tokens_in`, `tokens_out`, `tokens_cache_read`, `tokens_cache_create`, `total_cost_usd`, `total_cost_usd_estimated`, `num_turns`, `session_id`, `created_at`. The indices `idx_ai_inv_project_started`, `idx_ai_inv_project_surface`, `idx_ai_inv_project_ticket`, and `idx_ai_inv_project_provider` MUST be present.

#### Scenario: Schema present after migration
- **WHEN** a project's database is migrated to the latest schema version
- **THEN** the `ai_invocations` table exists with the columns listed above (including the new `provider` and `total_cost_usd_estimated` columns)
- **AND** the four indices listed above are present

#### Scenario: Surface column constrained to known values
- **WHEN** a row is inserted via the `recordInvocation` helper
- **THEN** the `surface` value MUST be one of `job`, `quick-spec`, `explore-spec`, `ai-edit`
- **AND** any other value MUST be rejected at the helper level before reaching SQLite

#### Scenario: Provider column is populated from adapter
- **WHEN** any callsite invokes `recordInvocation`
- **THEN** the `provider` value passed MUST equal the resolved adapter's `id`
- **AND** rows with `provider IS NULL` MUST NOT be insertable after the migration runs

### Requirement: Capture from QueueManager (`surface='job'`)

The system SHALL insert one `ai_invocations` row for every job spawned by `QueueManager`, populated from the normalised result extracted by `adapter.extractResult` over the captured event stream. When the adapter declares `capabilities.nativeCostUsd === false`, the system SHALL invoke `estimateCostUsd(adapter.id, normalised.model, normalised.usage)` to populate `total_cost_usd` and SHALL set `total_cost_usd_estimated = 1` when the result is non-null.

#### Scenario: Claude job completes successfully
- **WHEN** a claude job's spawned process emits a `result` event and exits with code 0
- **THEN** a new `ai_invocations` row exists with `surface='job'`, `provider='claude'`, `surface_ref_id=<jobId>`, `status='success'`, and `tokens_*`, `total_cost_usd`, `num_turns`, `duration_ms`, `duration_api_ms`, `model`, `session_id` populated from the result event
- **AND** `total_cost_usd_estimated = 0`
- **AND** the existing `jobs` row is also updated as before (no regression in queue UI)

#### Scenario: Codex job completes successfully
- **WHEN** a codex job's spawned process emits a `turn.completed` event with `usage` and exits with code 0
- **THEN** a new `ai_invocations` row exists with `surface='job'`, `provider='codex'`, `surface_ref_id=<jobId>`, `status='success'`, and `tokens_in`, `tokens_out`, `tokens_cache_read`, `num_turns`, `duration_ms`, `model`, `session_id` populated from `adapter.extractResult`
- **AND** `total_cost_usd` populated from the pricing table when the model is known
- **AND** `total_cost_usd_estimated = 1` whenever `total_cost_usd` was set from the pricing table

#### Scenario: Job process exits before emitting `result`
- **WHEN** a job's spawned process exits with non-zero code without ever emitting a `result` event (claude) or `turn.completed` event (codex)
- **THEN** an `ai_invocations` row is inserted with `status='failed'`, `provider` set from the adapter, `model` from the spawn args (best-effort), all token/cost columns NULL, and `started_at`/`finished_at` from process timestamps
- **AND** `total_cost_usd_estimated = 0`

#### Scenario: Job is cancelled by the user
- **WHEN** a job is killed via the cancel endpoint before the terminal event arrives
- **THEN** an `ai_invocations` row is inserted with `status='aborted'`, `provider` set from the adapter, and metric columns NULL
- **AND** `total_cost_usd_estimated = 0`

### Requirement: Aggregation and querying via `getSpending`

The system SHALL expose a single server function `getSpending(db, opts)` that returns the data for all dashboard widgets in one response, supporting filters: `period` (`7d`/`30d`/`90d`/`all`/`custom`+`from`/`to`), `surface[]`, `provider[]`, `model[]`, `status`, `minCostUsd`, `ticketId`. The function's `totals` and breakdowns MUST aggregate authoritative and estimated cost rows together into `costUsd` totals; a separate `estimatedCostUsd` total MUST also be returned so the UI can render the "Includes estimated costs" footnote.

#### Scenario: Total cost matches sum across surfaces and providers
- **WHEN** five `success` rows exist with costs $1.00, $0.50, $0.25, $0.10, $0.05 in the requested period (regardless of provider)
- **THEN** `summary.totalCostUsd` returned by `getSpending` equals 1.90

#### Scenario: Estimated portion is reported separately
- **GIVEN** three rows: claude $1.00 (authoritative), codex $0.50 (estimated), codex $0.25 (estimated)
- **WHEN** `getSpending` is called
- **THEN** `summary.totalCostUsd` equals 1.75 and `summary.totalEstimatedCostUsd` equals 0.75

#### Scenario: Filter by provider narrows totals
- **WHEN** `getSpending` is called with `provider=['codex']`
- **THEN** the returned totals and every breakdown reflect only `provider='codex'` rows

#### Scenario: Filter by surface narrows totals
- **WHEN** `getSpending` is called with `surface=['quick-spec']`
- **THEN** the returned `totals` and every breakdown reflect only `surface='quick-spec'` rows

#### Scenario: Failed rows excluded from averages
- **WHEN** the dataset contains 2 `success` rows ($1.00 and $3.00) and 1 `failed` row (cost NULL) in the period
- **THEN** `summary.avgCostPerSpec` (or per-job, per-refine) equals $2.00, not $1.33
- **AND** `summary.totalRuns` equals 3 and `summary.failureRate` equals 1/3

#### Scenario: Daily timeline is stacked by surface (unchanged)
- **WHEN** the response includes `dailyTimeline`
- **THEN** each entry has shape `{ date, jobsCostUsd, quickCostUsd, exploreCostUsd, aiEditCostUsd }`
- **AND** there is exactly one entry per day in the period (zero-filled for days with no rows)

#### Scenario: Top tickets aggregate cross-surface (unchanged)
- **WHEN** a ticket `T` has 2 job rows ($5.00 each), 1 explore row ($2.00), and 0 quick rows
- **THEN** `topTickets[i] = { ticketId: T, totalCostUsd: 12.00, breakdown: { job: 10.00, 'explore-spec': 2.00 } }` for some `i`

#### Scenario: Previous-period delta is computed with the same filter set (unchanged)
- **WHEN** filters select `surface=['quick-spec']` over `period='30d'`
- **THEN** `summary.prevTotalCostUsd` is the total for `surface='quick-spec'` in the previous 30-day window
- **AND** `summary.deltaPct` equals `(curr - prev) / prev * 100` (or `null` if `prev === 0`)
