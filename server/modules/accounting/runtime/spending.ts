import type { DbInstance } from '../../../db'
import type { Surface, SpendSurface, VirtualSurface, InvocationStatus, InvocationRow } from './ai-invocations'
import {
  SPEND_CATEGORIES, buildCategoryBreakdown, categoryForSurface, isSpendCategory, surfacesForCategories,
  type CategoryBreakdownEntry, type SpendCategory, type SurfaceSpendAggregate,
} from './spend-categories'

export type Period = '7d' | '30d' | '90d' | 'all' | 'custom'

export interface SpendingFilters {
  period?: Period
  from?: string
  to?: string
  /** Surfaces to include, recorded or virtual ('mission' / 'intent'). */
  surface?: SpendSurface[]
  /** Spend categories to include (intersected with `surface` when both are set). */
  category?: SpendCategory[]
  model?: string[]
  status?: InvocationStatus
  minCostUsd?: number
  ticketId?: number
  /** Provider ids to include (multi-provider segmentation). Empty/undefined = all. */
  provider?: string[]
  /**
   * Provider-aligned model filter (BUG-ANALYTICS-30/31). When set, the model
   * predicate is scoped to `(provider, model)` pairs instead of a bare
   * `model IN (...)`, so a click on a `byModel` row (which is now keyed on
   * provider+model) filters to exactly that provider's rows. When undefined the
   * legacy bare-`model` filter is used unchanged. `provider` here is the
   * COALESCE'd value (legacy NULL → 'claude'). Single-provider claude projects
   * never populate this, so their behaviour is byte-identical.
   */
  modelKeys?: Array<{ provider: string; model: string }>
  /**
   * Minutes to add to the stored UTC `started_at` before bucketing the
   * dailyTimeline by calendar day (BUG-ANALYTICS-21). Positive = east of UTC.
   * Default 0 ⇒ UTC bucketing, byte-identical to legacy behaviour. The client
   * passes its local offset so "today" lines up with the user's wall clock.
   */
  tzOffsetMinutes?: number
}

export interface InvocationsFilters extends SpendingFilters {
  limit?: number
  offset?: number
  cap?: number
  /**
   * Row ordering for the raw invocations table (BUG-ANALYTICS-35). 'recency'
   * (default) = `started_at DESC` (legacy). 'cost' = `total_cost_usd DESC`
   * (NULLs last) so the costliest rows surface on page 1 for outlier hunting.
   */
  sortBy?: 'recency' | 'cost'
}

export interface BySurfaceCount {
  surface: SpendSurface
  count: number
  costUsd: number
  /** Invocations omitted from costUsd because no cost telemetry was available. */
  unpricedCount?: number
}
export interface ByModelEntry {
  model: string
  /**
   * Provider that produced this model's rows (COALESCE'd, legacy NULL →
   * 'claude'). byModel is keyed on (provider, model) so codex/gemini estimated
   * spend never merges into a claude bar of the same id (BUG-ANALYTICS-29/30/31).
   */
  provider: string
  count: number
  /** Total cost (authoritative + estimated). */
  costUsd: number
  /**
   * Portion of `costUsd` from rows flagged `total_cost_usd_estimated=1`
   * (codex/gemini pricing-table fallback). Lets ModelBreakdown render a `~`
   * (BUG-ANALYTICS-08). 0 for a pure-claude model.
   */
  estimatedCostUsd: number
  /** Invocations for which the provider exposed no native/estimable cost. */
  unpricedCount?: number
}
export interface DailyEntry {
  date: string
  jobsCostUsd: number
  quickCostUsd: number
  exploreCostUsd: number
  aiEditCostUsd: number
  smashCostUsd: number
  fileSummaryCostUsd: number
  loopCostUsd: number
  /** Agent ledger turns pinned to the project (virtual surfaces 'mission' + 'intent'). */
  missionCostUsd: number
  totalCostUsd: number
  /** The day's cost per spend category (every surface folded into its category); sums to totalCostUsd. */
  byCategory: Record<SpendCategory, number>
  /** Invocations on this day whose provider did not expose cost telemetry. */
  unpricedCount?: number
}
export interface ScatterPoint {
  id: string
  surface: SpendSurface
  costUsd: number
  numTurns: number | null
  durationMs: number | null
  ticketId: number | null
  startedAt: string
}
export interface TopTicketEntry {
  ticketId: number | null
  ticketTitle: string | null
  totalCostUsd: number
  totalRuns: number
  /** Runs omitted from totalCostUsd because cost telemetry was unavailable. */
  unpricedCount?: number
  bySurface: Record<SpendSurface, { count: number; costUsd: number; unpricedCount?: number }>
  isUnattributed?: boolean
  isDeleted?: boolean
}
export interface ByModeEntry {
  mode: 'quick' | 'explore'
  totalRuns: number
  ticketsCreated: number
  totalCostUsd: number
  /**
   * Portion of `totalCostUsd` from estimated rows (codex/gemini). Lets
   * QuickVsExploreCard render a `~` on the per-spec figure (BUG-ANALYTICS-33).
   * 0 for a pure-claude mode.
   */
  estimatedCostUsd: number
  /** Runs excluded from cost averages because their cost is unavailable. */
  unpricedCount?: number
  avgCostPerSpec: number | null
  avgDurationMs: number | null
  dominantModel: string | null
  sparkline: number[] // last N days, total cost per day
}

export interface ByProviderEntry {
  provider: string
  count: number
  /** Authoritative (provider-reported) cost, in USD. */
  costUsd: number
  /** Cost computed via local pricing-table fallback. */
  estimatedCostUsd: number
  /** Rows with a numeric (including zero) native or estimated cost. */
  pricedCount?: number
  /** Rows whose provider did not expose enough data to determine cost. */
  unpricedCount?: number
  /** Rows that exposed at least one token counter (including an explicit zero). */
  usageReportedCount?: number
  /** Rows with no token telemetry at all. */
  usageUnavailableCount?: number
}

export interface SpendingResponse {
  summary: {
    totalCostUsd: number
    /** Of `totalCostUsd`, the portion contributed by rows where
     *  `total_cost_usd_estimated === 1` (currently codex). Drives the
     *  "Includes estimated costs" footnote in the AnalyticsPage Hero. */
    totalEstimatedCostUsd: number
    /** Real total tokens across all matching rows = fresh input + output +
     *  cache-read + cache-create. Cache tiers (esp. cache_read) dominate
     *  agentic Claude runs, so this is far larger than input+output alone. */
    totalTokens: number | null
    totalRuns: number
    /** Coverage metadata keeps a known subtotal from being mistaken for a full total. */
    pricedRuns?: number
    unpricedRuns?: number
    usageReportedRuns?: number
    usageUnavailableRuns?: number
    prevUnpricedRuns?: number
    failureRate: number
    prevTotalCostUsd: number
    deltaPct: number | null
    avgCostPerRun: number | null
  }
  bySurface: BySurfaceCount[]
  /** The "why": spend folded into the five categories, costliest first. */
  byCategory: CategoryBreakdownEntry[]
  byModel: ByModelEntry[]
  byMode: ByModeEntry[]
  byProvider: ByProviderEntry[]
  dailyTimeline: DailyEntry[]
  scatter: ScatterPoint[]
  /**
   * Total count of priced rows (`total_cost_usd IS NOT NULL`) in the window
   * (BUG-ANALYTICS-34). When `scatterTruncated`, this exceeds `scatter.length`
   * so CostScatter can show a "showing N of M — costliest may be hidden" notice.
   */
  scatterTotal: number
  /** True when more than the cap of priced rows exist (`scatterTotal > scatter.length`). */
  scatterTruncated: boolean
  topTickets: TopTicketEntry[]
  trackingStartedAt: string | null
  rangeFrom: string
  rangeTo: string
  /** Top mission conversations (agent ledger), present when the ledger was readable. */
  agentMissions?: AgentMissionSpending
}

export interface InvocationsResponse {
  rows: InvocationWithTicket[]
  total: number
  truncated: boolean
  totalAvailable: number
}

export interface InvocationWithTicket extends Omit<InvocationRow, 'surface'> {
  surface: SpendSurface
  ticket_title: string | null
  /** 'agent' for a row read from the app-level agent ledger (mission / Intent turn);
   *  its `conversation_id` is the agent conversation and `ticket_title` its title.
   *  Absent for project `ai_invocations` rows. */
  ledger?: 'agent'
}

// The surfaces enumerated in the bySurface breakdown. Keep the original seven
// analytics surfaces first (stable ordering / column layout), then the
// cost-accounting-audit additions so a newly-recorded billable surface is
// enumerated and its per-ticket bucket exists (a missing key would crash the
// `entry.bySurface[r.surface]` aggregation below). The grand-total summary is
// surface-agnostic (`SUM(total_cost_usd)`), so new surfaces always counted in
// the headline regardless.
const ALL_SURFACES: Surface[] = [
  'job', 'quick-spec', 'explore-spec', 'ai-edit', 'smash', 'file-summary', 'loop',
  'chat-sidebar', 'spec-launcher', 'proposal', 'agent-studio', 'setup', 'flow', 'triage',
  'failure-analysis',
]
/** Recorded surfaces followed by the read-only virtual agent-ledger surfaces. */
const SPENDING_SURFACES: SpendSurface[] = [...ALL_SURFACES, 'mission', 'intent']

/** Fresh zeroed per-surface bucket covering every SpendSurface, so aggregation
 *  writes (`bySurface[r.surface]`) can never index an undefined key. */
function emptyBySurface(): Record<SpendSurface, { count: number; costUsd: number; unpricedCount?: number }> {
  const out = {} as Record<SpendSurface, { count: number; costUsd: number; unpricedCount?: number }>
  for (const s of SPENDING_SURFACES) out[s] = { count: 0, costUsd: 0, unpricedCount: 0 }
  return out
}

/**
 * The surfaces a filter admits: `surface` intersected with the surfaces of
 * `category`. `undefined` = no surface constraint; `[]` = matches nothing (a
 * category/surface combination with no overlap). An empty `surface` array alone
 * keeps the legacy "no constraint" meaning.
 */
export function effectiveSurfaces(filters: SpendingFilters): SpendSurface[] | undefined {
  let surfaces = filters.surface && filters.surface.length > 0 ? filters.surface : undefined
  if (filters.category && filters.category.length > 0) {
    const fromCategory = surfacesForCategories(filters.category)
    surfaces = surfaces ? surfaces.filter((s) => fromCategory.includes(s)) : fromCategory
  }
  return surfaces
}

export interface ResolvedRange {
  from: string
  to: string
  prevFrom: string
  prevTo: string
}

/**
 * A `<input type="date">` custom bound is a bare `YYYY-MM-DD` local calendar
 * day, but `started_at` is a full UTC ISO instant (HIGH-7). Comparing
 * `'2026-07-02T09:15:00.000Z' <= '2026-07-02'` is FALSE, so every row started
 * on the range's end date was silently dropped. Normalise a bare date to the
 * UTC instant of the user's local day boundary; a full ISO instant (with a
 * 'T') is a precise instant and is kept verbatim.
 *
 * `edge='start'` → local-day 00:00:00.000 (inclusive lower bound).
 * `edge='end'`   → local-day 23:59:59.999 (inclusive upper bound, so the whole
 * final day is included under buildWhere's `started_at <= ?`).
 */
function normalizeCustomBound(raw: string, edge: 'start' | 'end', tzOffsetMinutes: number): string {
  if (raw.includes('T')) return raw // precise instant — keep verbatim
  const dayStartUtc = Date.parse(`${raw}T00:00:00Z`)
  if (Number.isNaN(dayStartUtc)) return raw
  // Shift the UTC-parsed day boundary back to the user's local wall clock: a
  // user at +120min asking for 2026-07-02 means [2026-07-01T22:00Z, 2026-07-02T22:00Z).
  const localStartUtc = dayStartUtc - tzOffsetMinutes * 60_000
  if (edge === 'start') return new Date(localStartUtc).toISOString()
  return new Date(localStartUtc + 86_400_000 - 1).toISOString()
}

export function resolveRange(filters: SpendingFilters, now: Date = new Date()): ResolvedRange {
  const period = filters.period ?? '30d'
  const tzOffset = filters.tzOffsetMinutes ?? 0
  // Only take the custom branch when BOTH dates parse — otherwise
  // `new Date(NaN).toISOString()` throws a RangeError (surfaced as a 500).
  // Unparseable custom dates fall through to the default 30d range below.
  const customFromMs = filters.from ? new Date(filters.from).getTime() : NaN
  const customToMs = filters.to ? new Date(filters.to).getTime() : NaN
  if (period === 'custom' && !Number.isNaN(customFromMs) && !Number.isNaN(customToMs)) {
    // HIGH-7: extend a bare-date 'to' to the end of its (local) day so rows
    // started on the final day are not dropped; 'from' anchors to day start.
    const fromBound = normalizeCustomBound(filters.from as string, 'start', tzOffset)
    const toBound = normalizeCustomBound(filters.to as string, 'end', tzOffset)
    const fromMs = new Date(fromBound).getTime()
    const span = new Date(toBound).getTime() - fromMs
    return {
      from: fromBound,
      to: toBound,
      prevFrom: new Date(fromMs - span).toISOString(),
      prevTo: fromBound,
    }
  }
  if (period === 'all') {
    return {
      from: '1970-01-01T00:00:00Z',
      to: now.toISOString(),
      prevFrom: '1970-01-01T00:00:00Z',
      prevTo: '1970-01-01T00:00:00Z',
    }
  }
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30
  const toMs = now.getTime()
  const fromMs = toMs - days * 86_400_000
  const prevFromMs = fromMs - days * 86_400_000
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    prevFrom: new Date(prevFromMs).toISOString(),
    prevTo: new Date(fromMs).toISOString(),
  }
}

function buildWhere(
  projectId: string,
  filters: SpendingFilters,
  range: { from: string; to: string },
  alias = ''
): { sql: string; params: unknown[] } {
  const a = alias ? `${alias}.` : ''
  const conditions: string[] = [`${a}project_id = ?`]
  const params: unknown[] = [projectId]
  conditions.push(`${a}started_at >= ?`)
  params.push(range.from)
  conditions.push(`${a}started_at <= ?`)
  params.push(range.to)
  const surfaces = effectiveSurfaces(filters)
  if (surfaces && surfaces.length === 0) {
    conditions.push('0 = 1')
  } else if (surfaces) {
    const placeholders = surfaces.map(() => '?').join(',')
    conditions.push(`${a}surface IN (${placeholders})`)
    params.push(...surfaces)
  }
  if (filters.modelKeys && filters.modelKeys.length > 0) {
    // Provider-aligned model filter (BUG-ANALYTICS-30/31): scope each model id
    // to its provider so a (provider, model) click never pulls another
    // provider's rows that happen to share the model string. Coalesce legacy
    // NULL provider to 'claude' to match byModel's keying.
    const clauses = filters.modelKeys.map(() => `(COALESCE(${a}provider, 'claude') = ? AND ${a}model = ?)`)
    conditions.push(`(${clauses.join(' OR ')})`)
    for (const k of filters.modelKeys) {
      params.push(k.provider, k.model)
    }
  } else if (filters.model && filters.model.length > 0) {
    const placeholders = filters.model.map(() => '?').join(',')
    conditions.push(`${a}model IN (${placeholders})`)
    params.push(...filters.model)
  }
  if (filters.provider && filters.provider.length > 0) {
    // Coalesce legacy NULL provider rows to 'claude' so a 'claude' filter still
    // surfaces pre-migration invocations.
    const placeholders = filters.provider.map(() => '?').join(',')
    conditions.push(`COALESCE(${a}provider, 'claude') IN (${placeholders})`)
    params.push(...filters.provider)
  }
  if (filters.status) {
    conditions.push(`${a}status = ?`)
    params.push(filters.status)
  }
  // LOW-4: apply the minimum-cost predicate ONLY for a positive threshold.
  // `total_cost_usd >= 0` looks like a no-op but SQLite evaluates `NULL >= 0`
  // to NULL, silently dropping every unpriced (aborted/killed) row — exactly
  // the rows a user typing 0 to "show everything" wants to see. 0 must be a
  // true no-op that keeps NULL-cost rows.
  if (typeof filters.minCostUsd === 'number' && filters.minCostUsd > 0) {
    conditions.push(`${a}total_cost_usd >= ?`)
    params.push(filters.minCostUsd)
  }
  if (typeof filters.ticketId === 'number') {
    conditions.push(`${a}ticket_id = ?`)
    params.push(filters.ticketId)
  }
  return { sql: conditions.join(' AND '), params }
}

/**
 * Calendar day (YYYY-MM-DD) of a UTC ISO instant shifted by `tzOffsetMinutes`
 * (BUG-ANALYTICS-21). Offset 0 ⇒ the raw UTC day, byte-identical to legacy
 * `iso.slice(0,10)`. The same shift is applied in the day-bucketing SQL via
 * `datetime(started_at, '<sign>N minutes')`, so eachDay's labels and the SQL
 * buckets stay aligned.
 */
function localDay(iso: string, tzOffsetMinutes = 0): string {
  if (!tzOffsetMinutes) return iso.slice(0, 10)
  // A bare YYYY-MM-DD (already a bucketed day, e.g. the period-'all' clamp
  // pulled from dayRows) is returned as-is — shifting it would double-apply
  // the offset. Only full ISO instants (with a 'T') get the tz shift.
  if (iso.length === 10 && !iso.includes('T')) return iso
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return iso.slice(0, 10)
  return new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

function eachDay(fromIso: string, toIso: string, tzOffsetMinutes = 0): string[] {
  const out: string[] = []
  const fromDay = new Date(localDay(fromIso, tzOffsetMinutes) + 'T00:00:00Z').getTime()
  const toDay = new Date(localDay(toIso, tzOffsetMinutes) + 'T00:00:00Z').getTime()
  for (let t = fromDay; t <= toDay; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/**
 * SQLite expression that yields the tz-shifted calendar day for `started_at`.
 * `datetime(started_at, '+N minutes')` honours SQLite's modifier grammar; when
 * the offset is 0 we keep the cheaper `substr(...)` so the UTC path is unchanged.
 */
function dayBucketExpr(tzOffsetMinutes: number): string {
  if (!tzOffsetMinutes) return `substr(started_at, 1, 10)`
  const sign = tzOffsetMinutes >= 0 ? '+' : '-'
  const abs = Math.abs(Math.trunc(tzOffsetMinutes))
  return `substr(datetime(started_at, '${sign}${abs} minutes'), 1, 10)`
}

interface RowAggDay {
  day: string
  surface: Surface
  cost: number | null
  unpriced: number | null
}
interface RowAggTicket {
  ticket_id: number | null
  surface: Surface
  cnt: number
  cost: number | null
  estCost: number | null
  unpriced: number | null
  tokens: number | null
}

/**
 * Resolves a committed ticket id to its current title, or returns
 * `{ title: null, deleted: true }` when the id no longer exists in the store
 * (BUG-ANALYTICS-18/36). The route (rest-export group) injects a reader backed
 * by the YAML ticket store; when omitted, topTickets keeps the legacy
 * `ticketTitle: null` / no `isDeleted` shape so existing callers are unchanged.
 */
export type TicketTitleResolver = (ticketId: number) => { title: string | null; deleted: boolean }

// ─── Agent ledger (desktop.sqlite) as virtual surfaces ───────────────────────
//
// Mission / Agent-Chat and Intent turns record to `agent_invocations` in the
// APP-level desktop.sqlite (project_id = the mission's pinned project; NULL for
// Home). They never touch the project's `ai_invocations`, so folding the pinned
// rows in here cannot double count. Home (unpinned) turns belong to no project
// and are excluded.

/** One agent-ledger row projected onto the spending read model. */
export interface AgentLedgerRow {
  id: string
  conversation_id: string | null
  conversation_title: string | null
  provider: string
  /** Virtual surface: 'intent' for ledger surface 'flow', 'mission' otherwise. */
  surface: VirtualSurface
  model: string | null
  status: string
  started_at: string
  finished_at: string | null
  duration_ms: number | null
  duration_api_ms: number | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cache_read: number | null
  tokens_cache_create: number | null
  total_cost_usd: number | null
  total_cost_usd_estimated: number
  num_turns: number | null
  session_id: string | null
  created_at: string
}

export function agentLedgerSurface(ledgerSurface: string | null): VirtualSurface {
  return ledgerSurface === 'flow' ? 'intent' : 'mission'
}

/**
 * Pinned agent-ledger rows matching the filters within `range`. The ticket
 * filter excludes every row (agent turns carry no ticket); the surface/category
 * filter is applied on the virtual surface.
 */
export function readAgentLedgerRows(
  agentDb: DbInstance | undefined,
  projectId: string,
  filters: SpendingFilters,
  range: { from: string; to: string },
): AgentLedgerRow[] {
  if (!agentDb) return []
  if (typeof filters.ticketId === 'number') return []
  const surfaces = effectiveSurfaces(filters)
  if (surfaces && !surfaces.includes('mission') && !surfaces.includes('intent')) return []
  // Reuse the shared predicate for project, window, provider, model, status and
  // min cost; surface and ticket are handled above (different columns here).
  const where = buildWhere(projectId, { ...filters, surface: undefined, category: undefined, ticketId: undefined }, range, 'ai')
  let rows: Array<Omit<AgentLedgerRow, 'surface'> & { ledger_surface: string | null }>
  try {
    rows = agentDb.prepare(`
    SELECT ai.id, ai.conversation_id, ac.title AS conversation_title,
           COALESCE(ai.provider, 'claude') AS provider, ai.surface AS ledger_surface,
           ai.model, ai.status, ai.started_at, ai.finished_at, ai.duration_ms, ai.duration_api_ms,
           ai.tokens_in, ai.tokens_out, ai.tokens_cache_read, ai.tokens_cache_create,
           ai.total_cost_usd, ai.total_cost_usd_estimated, ai.num_turns, ai.session_id, ai.created_at
    FROM agent_invocations ai
    LEFT JOIN agent_conversations ac ON ac.id = ai.conversation_id
    WHERE ${where.sql}
  `).all(...where.params) as typeof rows
  } catch (err) {
    // An unreadable app ledger must never break the project dashboard.
    console.error('[spending] agent ledger unavailable (project ledger only):', err)
    return []
  }
  const out: AgentLedgerRow[] = []
  for (const { ledger_surface, ...row } of rows) {
    const surface = agentLedgerSurface(ledger_surface)
    if (surfaces && !surfaces.includes(surface)) continue
    out.push({ ...row, surface })
  }
  return out
}

function hasUsage(r: { tokens_in: number | null; tokens_out: number | null; tokens_cache_read: number | null; tokens_cache_create: number | null }): boolean {
  return r.tokens_in != null || r.tokens_out != null || r.tokens_cache_read != null || r.tokens_cache_create != null
}

function rowTokens(r: { tokens_in: number | null; tokens_out: number | null; tokens_cache_read: number | null; tokens_cache_create: number | null }): number {
  return (r.tokens_in ?? 0) + (r.tokens_out ?? 0) + (r.tokens_cache_read ?? 0) + (r.tokens_cache_create ?? 0)
}

export function getSpending(
  db: DbInstance,
  projectId: string,
  filters: SpendingFilters = {},
  resolveTitle?: TicketTitleResolver,
  /** App-level desktop DB holding `agent_invocations`; its pinned rows count as the
   *  virtual 'mission' / 'intent' surfaces. Omitted = project ledger only. */
  agentDb?: DbInstance,
): SpendingResponse {
  const range = resolveRange(filters)
  const where = buildWhere(projectId, filters, { from: range.from, to: range.to })
  const tzOffset = filters.tzOffsetMinutes ?? 0
  const agentRows = readAgentLedgerRows(agentDb, projectId, filters, { from: range.from, to: range.to })
  const prevAgentRows = readAgentLedgerRows(agentDb, projectId, filters, { from: range.prevFrom, to: range.prevTo })

  // summary
  const summaryRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_cost_usd), 0) AS totalCost,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS totalEstimatedCost,
      COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)
                   + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_create, 0)), 0) AS totalTokens,
      COUNT(*) AS totalRuns,
      COUNT(total_cost_usd) AS pricedRuns,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedRuns,
      SUM(CASE WHEN tokens_in IS NOT NULL OR tokens_out IS NOT NULL
                    OR tokens_cache_read IS NOT NULL OR tokens_cache_create IS NOT NULL
               THEN 1 ELSE 0 END) AS usageReportedRuns,
      SUM(CASE WHEN tokens_in IS NULL AND tokens_out IS NULL
                    AND tokens_cache_read IS NULL AND tokens_cache_create IS NULL
               THEN 1 ELSE 0 END) AS usageUnavailableRuns,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'success' AND total_cost_usd IS NULL THEN 1 ELSE 0 END) AS successfulUnpriced,
      COALESCE(SUM(CASE WHEN status = 'success' THEN total_cost_usd END), 0) AS successCostSum,
      COUNT(CASE WHEN status = 'success' THEN total_cost_usd END) AS successPriced
    FROM ai_invocations WHERE ${where.sql}
  `).get(...where.params) as {
    totalCost: number
    totalEstimatedCost: number
    totalTokens: number
    totalRuns: number
    pricedRuns: number
    unpricedRuns: number | null
    usageReportedRuns: number | null
    usageUnavailableRuns: number | null
    failed: number | null
    successfulUnpriced: number | null
    successCostSum: number
    successPriced: number
  }
  // Fold the agent-ledger rows into the same summary counters.
  for (const r of agentRows) {
    const cost = r.total_cost_usd
    summaryRow.totalCost += cost ?? 0
    if (r.total_cost_usd_estimated === 1) summaryRow.totalEstimatedCost += cost ?? 0
    summaryRow.totalRuns += 1
    if (cost == null) summaryRow.unpricedRuns = (summaryRow.unpricedRuns ?? 0) + 1
    else summaryRow.pricedRuns += 1
    if (hasUsage(r)) {
      summaryRow.usageReportedRuns = (summaryRow.usageReportedRuns ?? 0) + 1
      summaryRow.totalTokens += rowTokens(r)
    } else {
      summaryRow.usageUnavailableRuns = (summaryRow.usageUnavailableRuns ?? 0) + 1
    }
    if (r.status === 'failed') summaryRow.failed = (summaryRow.failed ?? 0) + 1
    if (r.status === 'success') {
      if (cost == null) summaryRow.successfulUnpriced = (summaryRow.successfulUnpriced ?? 0) + 1
      else { summaryRow.successCostSum += cost; summaryRow.successPriced += 1 }
    }
  }
  const avgCost = summaryRow.successPriced > 0 ? summaryRow.successCostSum / summaryRow.successPriced : null

  // prev period
  const prevWhere = buildWhere(projectId, filters, { from: range.prevFrom, to: range.prevTo })
  const prevRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_cost_usd), 0) AS totalCost,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedRuns
    FROM ai_invocations WHERE ${prevWhere.sql}
  `).get(...prevWhere.params) as { totalCost: number; unpricedRuns: number | null }
  for (const r of prevAgentRows) {
    prevRow.totalCost += r.total_cost_usd ?? 0
    if (r.total_cost_usd == null) prevRow.unpricedRuns = (prevRow.unpricedRuns ?? 0) + 1
  }

  const deltaPct = (summaryRow.unpricedRuns ?? 0) === 0
    && (prevRow.unpricedRuns ?? 0) === 0
    && prevRow.totalCost > 0
    ? ((summaryRow.totalCost - prevRow.totalCost) / prevRow.totalCost) * 100
    : null

  // byModel (top 10) + per-mode dominant models — one GROUP BY model, surface
  // query serves both (H24: previously byModel plus two per-mode dominant-model
  // queries re-scanned the same rows).
  // byModel is keyed on (provider, model) — BUG-ANALYTICS-29/30/31: a codex
  // `gpt-*` estimated bar must never merge into a claude bar of the same id, and
  // the per-model cost carries an authoritative-vs-estimated split (BUG-08).
  const modelRows = db.prepare(`
    SELECT
      COALESCE(provider, 'claude') AS provider,
      model, surface,
      COUNT(*) AS cnt,
      COALESCE(SUM(total_cost_usd), 0) AS cost,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS estCost,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM ai_invocations WHERE ${where.sql} AND model IS NOT NULL
    GROUP BY provider, model, surface
  `).all(...where.params) as Array<{
    provider: string
    model: string
    surface: Surface
    cnt: number
    cost: number | null
    estCost: number | null
    unpriced: number | null
  }>
  const modelTotals = new Map<string, {
    provider: string
    model: string
    cnt: number
    cost: number
    est: number
    unpriced: number
  }>()
  for (const r of modelRows) {
    const key = `${r.provider}\0${r.model}`
    const agg = modelTotals.get(key) ?? {
      provider: r.provider,
      model: r.model,
      cnt: 0,
      cost: 0,
      est: 0,
      unpriced: 0,
    }
    agg.cnt += r.cnt
    agg.cost += r.cost ?? 0
    agg.est += r.estCost ?? 0
    agg.unpriced += r.unpriced ?? 0
    modelTotals.set(key, agg)
  }
  for (const r of agentRows) {
    if (r.model == null) continue
    const key = `${r.provider}\0${r.model}`
    const agg = modelTotals.get(key) ?? { provider: r.provider, model: r.model, cnt: 0, cost: 0, est: 0, unpriced: 0 }
    agg.cnt += 1
    agg.cost += r.total_cost_usd ?? 0
    if (r.total_cost_usd_estimated === 1) agg.est += r.total_cost_usd ?? 0
    if (r.total_cost_usd == null) agg.unpriced += 1
    modelTotals.set(key, agg)
  }
  const byModel: ByModelEntry[] = Array.from(modelTotals.values())
    .map((t) => ({
      provider: t.provider,
      model: t.model,
      count: t.cnt,
      costUsd: t.cost,
      estimatedCostUsd: t.est,
      ...(t.unpriced > 0 ? { unpricedCount: t.unpriced } : {}),
    }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10)
  // dominantModel is the most-frequent model per surface (provider-agnostic —
  // the label only needs the model id). Fold provider+model rows back per model.
  const dominantBySurface = new Map<Surface, { model: string; cnt: number }>()
  const dominantTally = new Map<string, number>()
  for (const r of modelRows) {
    const k = `${r.surface}\0${r.model}`
    dominantTally.set(k, (dominantTally.get(k) ?? 0) + r.cnt)
  }
  for (const [k, cnt] of dominantTally.entries()) {
    const sep = k.indexOf('\0')
    const surface = k.slice(0, sep) as Surface
    const model = k.slice(sep + 1)
    const cur = dominantBySurface.get(surface)
    if (!cur || cnt > cur.cnt) dominantBySurface.set(surface, { model, cnt })
  }

  // dailyTimeline (zero-filled, stacked by surface). Bucketed by tz-shifted
  // calendar day (BUG-ANALYTICS-21): the client passes its local offset so
  // "today" lines up with the user's wall clock; offset 0 ⇒ legacy UTC days.
  const dayRows = db.prepare(`
    SELECT
      ${dayBucketExpr(tzOffset)} AS day,
      surface,
      COALESCE(SUM(total_cost_usd), 0) AS cost,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced
    FROM ai_invocations WHERE ${where.sql}
    GROUP BY day, surface
  `).all(...where.params) as RowAggDay[]
  const agentDays = agentRows.map((r) => ({ day: localDay(r.started_at, tzOffset), row: r }))
  // B63: period 'all' resolves range.from to 1970, which would make eachDay emit
  // ~20,000 zero-filled days (a huge payload + 20k-bar chart). Clamp the zero-fill
  // start to the first day that actually has data (or a single day when empty).
  let timelineFrom = range.from
  if (filters.period === 'all') {
    const allDays = [...dayRows.map((r) => r.day), ...agentDays.map((d) => d.day)]
    timelineFrom = allDays.length > 0
      ? allDays.reduce((min, day) => (day < min ? day : min), allDays[0])
      : localDay(range.to, tzOffset)
  }
  const days = eachDay(timelineFrom, range.to, tzOffset)
  const dayMap = new Map<string, DailyEntry>()
  for (const day of days) {
    dayMap.set(day, {
      date: day, jobsCostUsd: 0, quickCostUsd: 0, exploreCostUsd: 0, aiEditCostUsd: 0, smashCostUsd: 0, fileSummaryCostUsd: 0, loopCostUsd: 0, missionCostUsd: 0, totalCostUsd: 0,
      byCategory: Object.fromEntries(SPEND_CATEGORIES.map((category) => [category, 0])) as Record<SpendCategory, number>,
      unpricedCount: 0,
    })
  }
  for (const r of dayRows) {
    const entry = dayMap.get(r.day)
    if (!entry) continue
    const c = r.cost ?? 0
    if (r.surface === 'job') entry.jobsCostUsd += c
    else if (r.surface === 'quick-spec') entry.quickCostUsd += c
    else if (r.surface === 'explore-spec') entry.exploreCostUsd += c
    else if (r.surface === 'ai-edit') entry.aiEditCostUsd += c
    else if (r.surface === 'smash') entry.smashCostUsd += c
    else if (r.surface === 'file-summary') entry.fileSummaryCostUsd += c // B58
    else if (r.surface === 'loop') entry.loopCostUsd += c
    entry.byCategory[categoryForSurface(r.surface)] += c
    entry.totalCostUsd += c
    entry.unpricedCount = (entry.unpricedCount ?? 0) + (r.unpriced ?? 0)
  }
  for (const { day, row } of agentDays) {
    const entry = dayMap.get(day)
    if (!entry) continue
    entry.missionCostUsd += row.total_cost_usd ?? 0
    entry.byCategory.missions += row.total_cost_usd ?? 0
    entry.totalCostUsd += row.total_cost_usd ?? 0
    if (row.total_cost_usd == null) entry.unpricedCount = (entry.unpricedCount ?? 0) + 1
  }
  const dailyTimeline = Array.from(dayMap.values())
  for (const day of dailyTimeline) {
    if ((day.unpricedCount ?? 0) === 0) delete day.unpricedCount
  }

  // byMode (Quick vs Explore) — one GROUP BY surface query for both modes;
  // dominant models come from modelRows and sparklines from dayRows, which
  // already carry exactly these aggregates (H24: previously 3 extra queries
  // per mode re-scanned the same rows).
  // M18: count DISTINCT tickets, not rows. An Explore session writes one
  // ai_invocations row per turn (and contract-refine adds another), all
  // back-filled with the same ticket_id — so SUM(ticket_id IS NOT NULL) counted
  // turns and inflated "N created". avgCostPerSpec is likewise per-spec:
  // total success cost of ticket-bearing rows / distinct successful tickets.
  const modeAggRows = db.prepare(`
    SELECT
      surface,
      COUNT(*) AS totalRuns,
      COUNT(DISTINCT ticket_id) AS ticketsCreated,
      COALESCE(SUM(total_cost_usd), 0) AS totalCost,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS estCost,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpricedRuns,
      COALESCE(SUM(CASE WHEN status = 'success' AND ticket_id IS NOT NULL THEN total_cost_usd ELSE 0 END), 0) AS specCostSum,
      COUNT(DISTINCT CASE WHEN status = 'success' AND ticket_id IS NOT NULL THEN ticket_id END) AS specCount,
      COUNT(DISTINCT CASE WHEN status = 'success' AND ticket_id IS NOT NULL
                               AND total_cost_usd IS NULL THEN ticket_id END) AS unpricedSpecCount,
      AVG(CASE WHEN status = 'success' THEN duration_ms END) AS avgDur
    FROM ai_invocations WHERE ${where.sql} AND surface IN ('quick-spec', 'explore-spec')
    GROUP BY surface
  `).all(...where.params) as Array<{
    surface: Surface
    totalRuns: number
    ticketsCreated: number | null
    totalCost: number
    estCost: number
    unpricedRuns: number | null
    specCostSum: number
    specCount: number
    unpricedSpecCount: number
    avgDur: number | null
  }>
  const modeAggBySurface = new Map(modeAggRows.map((r) => [r.surface, r]))
  const costByDaySurface = new Map<string, number>()
  for (const r of dayRows) costByDaySurface.set(`${r.day}|${r.surface}`, r.cost ?? 0)
  const byMode: ByModeEntry[] = (['quick-spec', 'explore-spec'] as const).map((surface) => {
    const modeKey: 'quick' | 'explore' = surface === 'quick-spec' ? 'quick' : 'explore'
    const r = modeAggBySurface.get(surface)
    // A partial average over only providers that report cost is worse than no
    // average: it looks authoritative while silently excluding Kimi. Preserve
    // unavailable until every successful ticket in the denominator is priced.
    const avgCostPerSpec =
      r && r.specCount > 0 && r.unpricedSpecCount === 0
        ? r.specCostSum / r.specCount
        : null
    const sparkline = days.map((d) => costByDaySurface.get(`${d}|${surface}`) ?? 0)
    return {
      mode: modeKey,
      totalRuns: r?.totalRuns ?? 0,
      ticketsCreated: r?.ticketsCreated ?? 0,
      totalCostUsd: r?.totalCost ?? 0,
      estimatedCostUsd: r?.estCost ?? 0,
      ...((r?.unpricedRuns ?? 0) > 0 ? { unpricedCount: r?.unpricedRuns ?? 0 } : {}),
      avgCostPerSpec,
      avgDurationMs: r?.avgDur ?? null,
      dominantModel: dominantBySurface.get(surface)?.model ?? null,
      sparkline,
    }
  })

  // scatter (capped at 500 most-recent points to avoid heavy payloads).
  // BUG-ANALYTICS-34: the whole point of the chart is to surface cost outliers,
  // so the costliest priced row is UNION-ed in even when it falls outside the
  // recency cap, and scatterTotal/scatterTruncated tell the client when points
  // were dropped.
  const SCATTER_CAP = 500
  const scatterTotalRow = db.prepare(`
    SELECT COUNT(*) AS total FROM ai_invocations
    WHERE ${where.sql} AND total_cost_usd IS NOT NULL
  `).get(...where.params) as { total: number }
  const agentPriced = agentRows.filter((r) => r.total_cost_usd != null)
  const scatterTotal = scatterTotalRow.total + agentPriced.length
  const scatterRows = db.prepare(`
    SELECT id, surface, total_cost_usd, num_turns, duration_ms, ticket_id, started_at
    FROM ai_invocations WHERE ${where.sql} AND total_cost_usd IS NOT NULL
    ORDER BY started_at DESC LIMIT ${SCATTER_CAP}
  `).all(...where.params) as Array<{
    id: string
    surface: Surface
    total_cost_usd: number
    num_turns: number | null
    duration_ms: number | null
    ticket_id: number | null
    started_at: string
  }>
  const agentPoints: ScatterPoint[] = agentPriced.map((r) => ({
    id: r.id,
    surface: r.surface,
    costUsd: r.total_cost_usd as number,
    numTurns: r.num_turns,
    durationMs: r.duration_ms,
    ticketId: null,
    startedAt: r.started_at,
  }))
  const scatter: ScatterPoint[] = [...scatterRows.map((r) => ({
    id: r.id,
    surface: r.surface as SpendSurface,
    costUsd: r.total_cost_usd,
    numTurns: r.num_turns,
    durationMs: r.duration_ms,
    ticketId: r.ticket_id,
    startedAt: r.started_at,
  })), ...agentPoints]
  if (agentPoints.length > 0) {
    // Both ledgers share the recency cap.
    scatter.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
    scatter.splice(SCATTER_CAP)
  }
  const scatterTruncated = scatterTotal > scatter.length
  if (scatterTruncated) {
    // Always include the single costliest priced row so a budget-blowing outlier
    // older than the recency window is never invisible. Skip if already present.
    const have = new Set(scatter.map((p) => p.id))
    const outlier = db.prepare(`
      SELECT id, surface, total_cost_usd, num_turns, duration_ms, ticket_id, started_at
      FROM ai_invocations WHERE ${where.sql} AND total_cost_usd IS NOT NULL
      ORDER BY total_cost_usd DESC LIMIT 1
    `).get(...where.params) as {
      id: string
      surface: Surface
      total_cost_usd: number
      num_turns: number | null
      duration_ms: number | null
      ticket_id: number | null
      started_at: string
    } | undefined
    const agentOutlier = agentPoints.reduce<ScatterPoint | null>((max, p) => (!max || p.costUsd > max.costUsd ? p : max), null)
    const costliest: ScatterPoint | null = outlier && (!agentOutlier || outlier.total_cost_usd >= agentOutlier.costUsd)
      ? {
          id: outlier.id,
          surface: outlier.surface,
          costUsd: outlier.total_cost_usd,
          numTurns: outlier.num_turns,
          durationMs: outlier.duration_ms,
          ticketId: outlier.ticket_id,
          startedAt: outlier.started_at,
        }
      : agentOutlier
    if (costliest && !have.has(costliest.id)) scatter.push(costliest)
  }

  // topTickets (cross-surface aggregation)
  const ticketRows = db.prepare(`
    SELECT
      ticket_id,
      surface,
      COUNT(*) AS cnt,
      COALESCE(SUM(total_cost_usd), 0) AS cost,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS estCost,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
      COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)
                   + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_create, 0)), 0) AS tokens
    FROM ai_invocations WHERE ${where.sql}
    GROUP BY ticket_id, surface
  `).all(...where.params) as RowAggTicket[]
  const ticketMap = new Map<string, TopTicketEntry>()
  for (const r of ticketRows) {
    const key = r.ticket_id === null ? '__unattributed__' : String(r.ticket_id)
    // A surface written by a newer build must not crash the per-ticket buckets.
    if (!SPENDING_SURFACES.includes(r.surface)) continue
    if (!ticketMap.has(key)) {
      ticketMap.set(key, {
        ticketId: r.ticket_id,
        ticketTitle: null,
        totalCostUsd: 0,
        totalRuns: 0,
        unpricedCount: 0,
        bySurface: emptyBySurface(),
        isUnattributed: r.ticket_id === null ? true : undefined,
      })
    }
    const entry = ticketMap.get(key)!
    entry.bySurface[r.surface].count += r.cnt
    entry.bySurface[r.surface].costUsd += r.cost ?? 0
    entry.bySurface[r.surface].unpricedCount =
      (entry.bySurface[r.surface].unpricedCount ?? 0) + (r.unpriced ?? 0)
    entry.totalRuns += r.cnt
    entry.totalCostUsd += r.cost ?? 0
    entry.unpricedCount = (entry.unpricedCount ?? 0) + (r.unpriced ?? 0)
  }
  const topTickets = Array.from(ticketMap.values())
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, 10)
  for (const ticket of topTickets) {
    if ((ticket.unpricedCount ?? 0) === 0) delete ticket.unpricedCount
    for (const bucket of Object.values(ticket.bySurface)) {
      if ((bucket.unpricedCount ?? 0) === 0) delete bucket.unpricedCount
    }
  }
  // BUG-ANALYTICS-18/36: resolve committed-ticket titles + deleted state via the
  // injected store reader so the card (and the summary-CSV / modal consumers
  // built on this same shape) show names instead of "Deleted ticket #N". Without
  // a resolver the legacy `ticketTitle: null` / no-`isDeleted` shape is kept.
  if (resolveTitle) {
    for (const t of topTickets) {
      if (t.ticketId === null) continue // unattributed bucket — no title
      const resolved = resolveTitle(t.ticketId)
      t.ticketTitle = resolved.title
      t.isDeleted = resolved.deleted
    }
  }

  // bySurface — derived from ticketRows (same WHERE, grouped by
  // ticket_id+surface): summing across tickets equals a GROUP BY surface
  // (H24: previously a dedicated query re-scanned the same rows).
  // The agent-ledger rows add the virtual 'mission' / 'intent' surfaces.
  const surfaceTotals = new Map<SpendSurface, { cnt: number; cost: number; est: number; unpriced: number; tokens: number }>()
  const addSurface = (surface: SpendSurface, cnt: number, cost: number, est: number, unpriced: number, tokens: number) => {
    const agg = surfaceTotals.get(surface) ?? { cnt: 0, cost: 0, est: 0, unpriced: 0, tokens: 0 }
    agg.cnt += cnt
    agg.cost += cost
    agg.est += est
    agg.unpriced += unpriced
    agg.tokens += tokens
    surfaceTotals.set(surface, agg)
  }
  for (const r of ticketRows) addSurface(r.surface, r.cnt, r.cost ?? 0, r.estCost ?? 0, r.unpriced ?? 0, r.tokens ?? 0)
  for (const r of agentRows) {
    const cost = r.total_cost_usd ?? 0
    addSurface(r.surface, 1, cost, r.total_cost_usd_estimated === 1 ? cost : 0, r.total_cost_usd == null ? 1 : 0, rowTokens(r))
  }
  // Canonical surfaces first, then any surface a newer build wrote.
  const reportedSurfaces = [
    ...SPENDING_SURFACES,
    ...Array.from(surfaceTotals.keys()).filter((s) => !SPENDING_SURFACES.includes(s)),
  ]
  const bySurface: BySurfaceCount[] = reportedSurfaces.map((s) => {
    const t = surfaceTotals.get(s)
    return {
      surface: s,
      count: t?.cnt ?? 0,
      costUsd: t?.cost ?? 0,
      ...((t?.unpriced ?? 0) > 0 ? { unpricedCount: t?.unpriced ?? 0 } : {}),
    }
  })
  const byCategory = buildCategoryBreakdown(reportedSurfaces.map((s): SurfaceSpendAggregate => {
    const t = surfaceTotals.get(s)
    return { surface: s, costUsd: t?.cost ?? 0, estimatedCostUsd: t?.est ?? 0, count: t?.cnt ?? 0, tokens: t?.tokens ?? 0, unpricedCount: t?.unpriced ?? 0 }
  }))

  // tracking start (project's first invocation)
  const trackingRow = db.prepare(`
    SELECT MIN(started_at) AS first FROM ai_invocations WHERE project_id = ?
  `).get(projectId) as { first: string | null }
  let trackingStartedAt = trackingRow.first
  if (agentDb) {
    try {
      const agentFirst = (agentDb.prepare('SELECT MIN(started_at) AS first FROM agent_invocations WHERE project_id = ?').get(projectId) as { first: string | null }).first
      if (agentFirst && (!trackingStartedAt || agentFirst < trackingStartedAt)) trackingStartedAt = agentFirst
    } catch { /* ledger unreadable: keep the project ledger's start */ }
  }

  // byProvider — split authoritative vs estimated cost so the UI can render
  // the `~` tilde + Hero footnote without re-querying. Rows persisted with
  // NULL provider (pre-migration backfill missed somehow) coalesce to
  // `claude` to match the migration default.
  const providerRows = db.prepare(`
    SELECT
      COALESCE(provider, 'claude') AS provider,
      COUNT(*) AS cnt,
      COUNT(total_cost_usd) AS priced,
      SUM(CASE WHEN total_cost_usd IS NULL THEN 1 ELSE 0 END) AS unpriced,
      SUM(CASE WHEN tokens_in IS NOT NULL OR tokens_out IS NOT NULL
                    OR tokens_cache_read IS NOT NULL OR tokens_cache_create IS NOT NULL
               THEN 1 ELSE 0 END) AS usageReported,
      SUM(CASE WHEN tokens_in IS NULL AND tokens_out IS NULL
                    AND tokens_cache_read IS NULL AND tokens_cache_create IS NULL
               THEN 1 ELSE 0 END) AS usageUnavailable,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 0 THEN total_cost_usd ELSE 0 END), 0) AS authoritativeCost,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS estimatedCost
    FROM ai_invocations WHERE ${where.sql}
    GROUP BY provider
    ORDER BY (authoritativeCost + estimatedCost) DESC
  `).all(...where.params) as Array<{
    provider: string
    cnt: number
    priced: number
    unpriced: number | null
    usageReported: number | null
    usageUnavailable: number | null
    authoritativeCost: number
    estimatedCost: number
  }>
  const byProvider: ByProviderEntry[] = providerRows.map((r) => ({
    provider: r.provider,
    count: r.cnt,
    costUsd: r.authoritativeCost,
    estimatedCostUsd: r.estimatedCost,
    pricedCount: r.priced,
    unpricedCount: r.unpriced ?? 0,
    usageReportedCount: r.usageReported ?? 0,
    usageUnavailableCount: r.usageUnavailable ?? 0,
  }))
  if (agentRows.length > 0) {
    for (const r of agentRows) {
      let entry = byProvider.find((p) => p.provider === r.provider)
      if (!entry) {
        entry = { provider: r.provider, count: 0, costUsd: 0, estimatedCostUsd: 0, pricedCount: 0, unpricedCount: 0, usageReportedCount: 0, usageUnavailableCount: 0 }
        byProvider.push(entry)
      }
      entry.count += 1
      const cost = r.total_cost_usd
      if (cost == null) entry.unpricedCount = (entry.unpricedCount ?? 0) + 1
      else {
        entry.pricedCount = (entry.pricedCount ?? 0) + 1
        if (r.total_cost_usd_estimated === 1) entry.estimatedCostUsd += cost
        else entry.costUsd += cost
      }
      if (hasUsage(r)) entry.usageReportedCount = (entry.usageReportedCount ?? 0) + 1
      else entry.usageUnavailableCount = (entry.usageUnavailableCount ?? 0) + 1
    }
    byProvider.sort((a, b) => (b.costUsd + b.estimatedCostUsd) - (a.costUsd + a.estimatedCostUsd))
  }

  // Top mission conversations (and the ledger summary) for the missions category.
  let agentMissions: AgentMissionSpending | undefined
  if (agentDb) agentMissions = summariseAgentMissions(agentRows, prevAgentRows)

  return {
    summary: {
      totalCostUsd: summaryRow.totalCost,
      totalEstimatedCostUsd: summaryRow.totalEstimatedCost,
      totalTokens:
        (summaryRow.usageReportedRuns ?? 0) > 0
          ? summaryRow.totalTokens
          : summaryRow.totalRuns > 0
            ? null
            : 0,
      totalRuns: summaryRow.totalRuns,
      pricedRuns: summaryRow.pricedRuns,
      unpricedRuns: summaryRow.unpricedRuns ?? 0,
      usageReportedRuns: summaryRow.usageReportedRuns ?? 0,
      usageUnavailableRuns: summaryRow.usageUnavailableRuns ?? 0,
      prevUnpricedRuns: prevRow.unpricedRuns ?? 0,
      failureRate: summaryRow.totalRuns > 0 ? (summaryRow.failed ?? 0) / summaryRow.totalRuns : 0,
      prevTotalCostUsd: prevRow.totalCost,
      deltaPct,
      avgCostPerRun:
        (summaryRow.successfulUnpriced ?? 0) > 0
          ? null
          : avgCost,
    },
    bySurface,
    byCategory,
    byModel,
    byMode,
    byProvider,
    dailyTimeline,
    scatter,
    scatterTotal,
    scatterTruncated,
    topTickets,
    trackingStartedAt,
    rangeFrom: range.from,
    rangeTo: range.to,
    ...(agentMissions ? { agentMissions } : {}),
  }
}

/**
 * Produce a short identifying label from an Explore conversation's first
 * user message. Strips leading slash-command lines and resolved-command
 * frontmatter, takes the first non-empty line, and truncates to a few
 * words so the analytics TICKET column stays readable.
 */
export function summariseExplorePrompt(raw: string): string | null {
  if (!raw) return null
  let text = raw
  // Strip the slash-command head (`/specrails:explore-spec ...` plus any
  // trailing blank lines until the user's content).
  text = text.replace(/^\/[^\n]*\n+/, '')
  // Find the first non-frontmatter, non-empty, non-heading line.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  let first = lines.find((l) =>
    !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('//') && !l.startsWith('>'),
  ) ?? lines[0] ?? ''
  // Strip markdown emphasis / inline code so the chip reads clean.
  first = first.replace(/[*_`]/g, '').trim()
  if (!first) return null
  const words = first.split(/\s+/).filter(Boolean)
  const top = words.slice(0, 4).join(' ')
  return words.length > 4 ? `${top}…` : top
}

export function getInvocations(
  db: DbInstance,
  projectId: string,
  filters: InvocationsFilters = {},
  /** App-level desktop DB: its pinned `agent_invocations` rows join the list as
   *  'mission' / 'intent' rows marked `ledger: 'agent'`. */
  agentDb?: DbInstance,
): InvocationsResponse {
  const range = resolveRange(filters)
  const where = buildWhere(projectId, filters, { from: range.from, to: range.to })
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total FROM ai_invocations WHERE ${where.sql}
  `).get(...where.params) as { total: number }
  const agentRows = readAgentLedgerRows(agentDb, projectId, filters, { from: range.from, to: range.to })
  const cap = filters.cap
  const limit = cap ?? Math.min(filters.limit ?? 50, 200)
  const offset = filters.offset ?? 0
  // With agent rows in play, read the first offset+limit project rows and page
  // the merged, re-sorted list (both sources share the same ordering).
  const projectLimit = agentRows.length > 0 ? offset + limit : limit
  const projectOffset = agentRows.length > 0 ? 0 : offset
  // BUG-ANALYTICS-35: offer a cost-sorted order so the costliest rows surface on
  // page 1 for outlier hunting (NULL cost sorts last); recency (started_at DESC)
  // stays the default so the legacy table ordering is unchanged.
  const orderBy = filters.sortBy === 'cost'
    ? 'total_cost_usd DESC NULLS LAST, started_at DESC'
    : 'started_at DESC'
  const rows = db.prepare(`
    SELECT * FROM ai_invocations WHERE ${where.sql}
    ORDER BY ${orderBy} LIMIT ? OFFSET ?
  `).all(...where.params, projectLimit, projectOffset) as InvocationRow[]
  // For Explore rows (conversation_id non-null) without a committed ticket,
  // surface the conversation title as the provisional ticket label so the
  // analytics table is useful before commit.
  const convIds = Array.from(new Set(
    rows.filter((r) => r.conversation_id).map((r) => r.conversation_id as string),
  ))
  const titleByConv = new Map<string, string | null>()
  if (convIds.length > 0) {
    const placeholders = convIds.map(() => '?').join(',')
    const titleRows = db.prepare(
      `SELECT id, title FROM chat_conversations WHERE id IN (${placeholders})`,
    ).all(...convIds) as Array<{ id: string; title: string | null }>
    for (const tr of titleRows) titleByConv.set(tr.id, tr.title)
    // Fallback: first user message for convs without a title yet (Explore
    // lightweight mode never auto-titles unless saved as draft).
    const missing = convIds.filter((id) => !titleByConv.get(id))
    if (missing.length > 0) {
      const p2 = missing.map(() => '?').join(',')
      const msgRows = db.prepare(
        `SELECT conversation_id, content FROM chat_messages
         WHERE role = 'user' AND conversation_id IN (${p2})
         ORDER BY conversation_id, id ASC`,
      ).all(...missing) as Array<{ conversation_id: string; content: string }>
      const seen = new Set<string>()
      for (const mr of msgRows) {
        if (seen.has(mr.conversation_id)) continue
        seen.add(mr.conversation_id)
        const summary = summariseExplorePrompt(mr.content)
        if (summary) titleByConv.set(mr.conversation_id, summary)
      }
    }
  }
  let enriched: InvocationWithTicket[] = rows.map((r) => ({
    ...r,
    ticket_title: r.conversation_id ? (titleByConv.get(r.conversation_id) ?? null) : null,
  }))
  if (agentRows.length > 0) {
    const agentInvocations: InvocationWithTicket[] = agentRows.map(({ conversation_title, ...r }) => ({
      ...r,
      project_id: projectId,
      surface_ref_id: null,
      ticket_id: null,
      status: r.status as InvocationStatus,
      ticket_title: conversation_title,
      ledger: 'agent' as const,
    }))
    const byRecency = (a: InvocationWithTicket, b: InvocationWithTicket) =>
      (a.started_at < b.started_at ? 1 : a.started_at > b.started_at ? -1 : 0)
    const compare = filters.sortBy === 'cost'
      ? (a: InvocationWithTicket, b: InvocationWithTicket) => {
          if (a.total_cost_usd == null || b.total_cost_usd == null) {
            if (a.total_cost_usd == null && b.total_cost_usd == null) return byRecency(a, b)
            return a.total_cost_usd == null ? 1 : -1
          }
          return b.total_cost_usd - a.total_cost_usd || byRecency(a, b)
        }
      : byRecency
    enriched = [...enriched, ...agentInvocations].sort(compare).slice(offset, offset + limit)
  }
  const totalAvailable = totalRow.total + agentRows.length
  return {
    rows: enriched,
    total: cap ? Math.min(enriched.length, cap) : enriched.length,
    truncated: cap !== undefined && totalAvailable > cap,
    totalAvailable,
  }
}

export function parseSpendingFilters(query: Record<string, unknown>): SpendingFilters & { sortBy?: 'recency' | 'cost' } {
  const f: SpendingFilters & { sortBy?: 'recency' | 'cost' } = {}
  if (typeof query.period === 'string') f.period = query.period as Period
  if (typeof query.from === 'string') f.from = query.from
  if (typeof query.to === 'string') f.to = query.to
  if (typeof query.surface === 'string') {
    // M17: validate against the canonical surface list. The old hardcoded subset
    // silently dropped 'smash'/'file-summary' — clicking those chips produced an
    // empty filter array, so buildWhere applied NO surface condition and the UI
    // showed ALL-surface totals while claiming a single-surface filter was active.
    f.surface = query.surface.split(',').filter((s) =>
      (SPENDING_SURFACES as string[]).includes(s)
    ) as SpendSurface[]
  }
  if (typeof query.category === 'string') {
    const categories = query.category.split(',').filter(isSpendCategory)
    if (categories.length > 0) f.category = categories
  }
  if (typeof query.model === 'string') {
    f.model = query.model.split(',').filter((s) => s.length > 0)
  }
  // Provider-aligned model filter (BUG-ANALYTICS-30/31). `modelProvider` is a CSV
  // index-aligned with `model` (e.g. model=gpt-5.5,sonnet & modelProvider=codex,claude);
  // when present and the lengths match it scopes each model id to its provider.
  if (typeof query.modelProvider === 'string' && f.model && f.model.length > 0) {
    const provs = query.modelProvider.split(',').filter((s) => s.length > 0)
    if (provs.length === f.model.length) {
      f.modelKeys = f.model.map((model, i) => ({ provider: provs[i], model }))
    }
  }
  if (typeof query.sortBy === 'string' && (query.sortBy === 'cost' || query.sortBy === 'recency')) {
    f.sortBy = query.sortBy
  }
  if (typeof query.tzOffsetMinutes === 'string') {
    const v = parseInt(query.tzOffsetMinutes, 10)
    // Clamp to the realistic UTC-offset range (±14h = ±840 min) to keep the
    // datetime modifier sane.
    if (!Number.isNaN(v) && Math.abs(v) <= 840) f.tzOffsetMinutes = v
  }
  if (typeof query.provider === 'string') {
    const provs = query.provider.split(',').filter((s) => s.length > 0)
    if (provs.length > 0) f.provider = provs
  }
  if (typeof query.status === 'string' && ['success', 'failed', 'aborted'].includes(query.status)) {
    f.status = query.status as InvocationStatus
  }
  if (typeof query.minCostUsd === 'string') {
    const v = parseFloat(query.minCostUsd)
    if (!Number.isNaN(v)) f.minCostUsd = v
  }
  if (typeof query.ticketId === 'string') {
    const v = parseInt(query.ticketId, 10)
    if (!Number.isNaN(v)) f.ticketId = v
  }
  return f
}

// ─── Agent-mission spending (desktop.sqlite ledger) ──────────────────────────
//
// Mission/Agent-Chat turns record to `agent_invocations` in the APP-level
// desktop.sqlite (project_id = the mission's pinned project; NULL for Home).
// This block folds a project's pinned-mission spend into its /spending payload
// so the Analytics page can surface it next to the pipeline surfaces. Home
// (unpinned) turns belong to no project and are deliberately excluded here.

export interface AgentMissionConversationRow {
  conversationId: string | null
  title: string | null
  costUsd: number
  estimatedCostUsd: number
  turns: number
  lastAt: string | null
}

export interface AgentMissionSpending {
  summary: {
    totalCostUsd: number
    estimatedCostUsd: number
    prevTotalCostUsd: number
    turns: number
    tokensIn: number
    tokensOut: number
    /** Part of totalCostUsd spent by Intent turns (surface='flow'). */
    flowCostUsd: number
    flowTurns: number
  }
  topConversations: AgentMissionConversationRow[]
}

export function getAgentMissionSpending(
  desktopDb: DbInstance,
  projectId: string,
  filters: SpendingFilters,
): AgentMissionSpending {
  const range = resolveRange(filters)
  return summariseAgentMissions(
    readAgentLedgerRows(desktopDb, projectId, filters, { from: range.from, to: range.to }),
    readAgentLedgerRows(desktopDb, projectId, filters, { from: range.prevFrom, to: range.prevTo }),
  )
}

/** Ledger summary + the five costliest conversations, from already-filtered rows. */
export function summariseAgentMissions(rows: readonly AgentLedgerRow[], prevRows: readonly AgentLedgerRow[]): AgentMissionSpending {
  const summary: AgentMissionSpending['summary'] = {
    totalCostUsd: 0, estimatedCostUsd: 0, prevTotalCostUsd: 0, turns: 0, tokensIn: 0, tokensOut: 0, flowCostUsd: 0, flowTurns: 0,
  }
  const conversations = new Map<string, AgentMissionConversationRow>()
  for (const r of rows) {
    const cost = r.total_cost_usd ?? 0
    summary.totalCostUsd += cost
    if (r.total_cost_usd_estimated === 1) summary.estimatedCostUsd += cost
    summary.turns += 1
    summary.tokensIn += r.tokens_in ?? 0
    summary.tokensOut += r.tokens_out ?? 0
    if (r.surface === 'intent') { summary.flowCostUsd += cost; summary.flowTurns += 1 }
    const key = r.conversation_id ?? '\0'
    const conv = conversations.get(key) ?? {
      conversationId: r.conversation_id, title: r.conversation_title, costUsd: 0, estimatedCostUsd: 0, turns: 0, lastAt: null,
    }
    conv.costUsd += cost
    if (r.total_cost_usd_estimated === 1) conv.estimatedCostUsd += cost
    conv.turns += 1
    if (!conv.lastAt || r.started_at > conv.lastAt) conv.lastAt = r.started_at
    conversations.set(key, conv)
  }
  for (const r of prevRows) summary.prevTotalCostUsd += r.total_cost_usd ?? 0
  const topConversations = Array.from(conversations.values())
    .sort((a, b) => b.costUsd - a.costUsd || b.turns - a.turns)
    .slice(0, 5)
  return { summary, topConversations }
}
