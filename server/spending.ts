import type { DbInstance } from './db'
import type { Surface, InvocationStatus, InvocationRow } from './ai-invocations'

export type Period = '7d' | '30d' | '90d' | 'all' | 'custom'

export interface SpendingFilters {
  period?: Period
  from?: string
  to?: string
  surface?: Surface[]
  model?: string[]
  status?: InvocationStatus
  minCostUsd?: number
  ticketId?: number
  /** Provider ids to include (multi-provider segmentation). Empty/undefined = all. */
  provider?: string[]
}

export interface InvocationsFilters extends SpendingFilters {
  limit?: number
  offset?: number
  cap?: number
}

export interface BySurfaceCount { surface: Surface; count: number; costUsd: number }
export interface ByModelEntry { model: string; count: number; costUsd: number }
export interface DailyEntry {
  date: string
  jobsCostUsd: number
  quickCostUsd: number
  exploreCostUsd: number
  aiEditCostUsd: number
  smashCostUsd: number
  fileSummaryCostUsd: number
  totalCostUsd: number
}
export interface ScatterPoint {
  id: string
  surface: Surface
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
  bySurface: Record<Surface, { count: number; costUsd: number }>
  isUnattributed?: boolean
  isDeleted?: boolean
}
export interface ByModeEntry {
  mode: 'quick' | 'explore'
  totalRuns: number
  ticketsCreated: number
  totalCostUsd: number
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
    totalTokens: number
    totalRuns: number
    failureRate: number
    prevTotalCostUsd: number
    deltaPct: number | null
    avgCostPerRun: number | null
  }
  bySurface: BySurfaceCount[]
  byModel: ByModelEntry[]
  byMode: ByModeEntry[]
  byProvider: ByProviderEntry[]
  dailyTimeline: DailyEntry[]
  scatter: ScatterPoint[]
  topTickets: TopTicketEntry[]
  trackingStartedAt: string | null
  rangeFrom: string
  rangeTo: string
}

export interface InvocationsResponse {
  rows: InvocationWithTicket[]
  total: number
  truncated: boolean
  totalAvailable: number
}

export interface InvocationWithTicket extends InvocationRow {
  ticket_title: string | null
}

const ALL_SURFACES: Surface[] = ['job', 'quick-spec', 'explore-spec', 'ai-edit', 'smash', 'file-summary']

interface ResolvedRange {
  from: string
  to: string
  prevFrom: string
  prevTo: string
}

function resolveRange(filters: SpendingFilters, now: Date = new Date()): ResolvedRange {
  const period = filters.period ?? '30d'
  // Only take the custom branch when BOTH dates parse — otherwise
  // `new Date(NaN).toISOString()` throws a RangeError (surfaced as a 500).
  // Unparseable custom dates fall through to the default 30d range below.
  const customFromMs = filters.from ? new Date(filters.from).getTime() : NaN
  const customToMs = filters.to ? new Date(filters.to).getTime() : NaN
  if (period === 'custom' && !Number.isNaN(customFromMs) && !Number.isNaN(customToMs)) {
    const fromMs = customFromMs
    const span = customToMs - fromMs
    return {
      from: filters.from as string,
      to: filters.to as string,
      prevFrom: new Date(fromMs - span).toISOString(),
      prevTo: filters.from as string,
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
  if (filters.surface && filters.surface.length > 0) {
    const placeholders = filters.surface.map(() => '?').join(',')
    conditions.push(`${a}surface IN (${placeholders})`)
    params.push(...filters.surface)
  }
  if (filters.model && filters.model.length > 0) {
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
  if (typeof filters.minCostUsd === 'number') {
    conditions.push(`${a}total_cost_usd >= ?`)
    params.push(filters.minCostUsd)
  }
  if (typeof filters.ticketId === 'number') {
    conditions.push(`${a}ticket_id = ?`)
    params.push(filters.ticketId)
  }
  return { sql: conditions.join(' AND '), params }
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10)
}

function eachDay(fromIso: string, toIso: string): string[] {
  const out: string[] = []
  const fromDay = new Date(dateOnly(fromIso) + 'T00:00:00Z').getTime()
  const toDay = new Date(dateOnly(toIso) + 'T00:00:00Z').getTime()
  for (let t = fromDay; t <= toDay; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

interface RowAggDay { day: string; surface: Surface; cost: number | null }
interface RowAggTicket {
  ticket_id: number | null
  surface: Surface
  cnt: number
  cost: number | null
}

export function getSpending(
  db: DbInstance,
  projectId: string,
  filters: SpendingFilters = {}
): SpendingResponse {
  const range = resolveRange(filters)
  const where = buildWhere(projectId, filters, { from: range.from, to: range.to })

  // summary
  const summaryRow = db.prepare(`
    SELECT
      COALESCE(SUM(total_cost_usd), 0) AS totalCost,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS totalEstimatedCost,
      COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)
                   + COALESCE(tokens_cache_read, 0) + COALESCE(tokens_cache_create, 0)), 0) AS totalTokens,
      COUNT(*) AS totalRuns,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      AVG(CASE WHEN status = 'success' THEN total_cost_usd END) AS avgCost
    FROM ai_invocations WHERE ${where.sql}
  `).get(...where.params) as {
    totalCost: number
    totalEstimatedCost: number
    totalTokens: number
    totalRuns: number
    failed: number | null
    avgCost: number | null
  }

  // prev period
  const prevWhere = buildWhere(projectId, filters, { from: range.prevFrom, to: range.prevTo })
  const prevRow = db.prepare(`
    SELECT COALESCE(SUM(total_cost_usd), 0) AS totalCost
    FROM ai_invocations WHERE ${prevWhere.sql}
  `).get(...prevWhere.params) as { totalCost: number }

  const deltaPct = prevRow.totalCost > 0
    ? ((summaryRow.totalCost - prevRow.totalCost) / prevRow.totalCost) * 100
    : null

  // byModel (top 10) + per-mode dominant models — one GROUP BY model, surface
  // query serves both (H24: previously byModel plus two per-mode dominant-model
  // queries re-scanned the same rows).
  const modelRows = db.prepare(`
    SELECT model, surface, COUNT(*) AS cnt, COALESCE(SUM(total_cost_usd), 0) AS cost
    FROM ai_invocations WHERE ${where.sql} AND model IS NOT NULL
    GROUP BY model, surface
  `).all(...where.params) as Array<{ model: string; surface: Surface; cnt: number; cost: number | null }>
  const modelTotals = new Map<string, { cnt: number; cost: number }>()
  for (const r of modelRows) {
    const agg = modelTotals.get(r.model) ?? { cnt: 0, cost: 0 }
    agg.cnt += r.cnt
    agg.cost += r.cost ?? 0
    modelTotals.set(r.model, agg)
  }
  const byModel: ByModelEntry[] = Array.from(modelTotals.entries())
    .map(([model, t]) => ({ model, count: t.cnt, costUsd: t.cost }))
    .sort((a, b) => b.costUsd - a.costUsd)
    .slice(0, 10)
  const dominantBySurface = new Map<Surface, { model: string; cnt: number }>()
  for (const r of modelRows) {
    const cur = dominantBySurface.get(r.surface)
    if (!cur || r.cnt > cur.cnt) dominantBySurface.set(r.surface, { model: r.model, cnt: r.cnt })
  }

  // dailyTimeline (zero-filled, stacked by surface)
  const dayRows = db.prepare(`
    SELECT substr(started_at, 1, 10) AS day, surface, COALESCE(SUM(total_cost_usd), 0) AS cost
    FROM ai_invocations WHERE ${where.sql}
    GROUP BY day, surface
  `).all(...where.params) as RowAggDay[]
  // B63: period 'all' resolves range.from to 1970, which would make eachDay emit
  // ~20,000 zero-filled days (a huge payload + 20k-bar chart). Clamp the zero-fill
  // start to the first day that actually has data (or a single day when empty).
  let timelineFrom = range.from
  if (filters.period === 'all') {
    timelineFrom = dayRows.length > 0
      ? dayRows.reduce((min, r) => (r.day < min ? r.day : min), dayRows[0].day)
      : range.to.slice(0, 10)
  }
  const days = eachDay(timelineFrom, range.to)
  const dayMap = new Map<string, DailyEntry>()
  for (const day of days) {
    dayMap.set(day, {
      date: day, jobsCostUsd: 0, quickCostUsd: 0, exploreCostUsd: 0, aiEditCostUsd: 0, smashCostUsd: 0, fileSummaryCostUsd: 0, totalCostUsd: 0,
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
    entry.totalCostUsd += c
  }
  const dailyTimeline = Array.from(dayMap.values())

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
      COALESCE(SUM(CASE WHEN status = 'success' AND ticket_id IS NOT NULL THEN total_cost_usd ELSE 0 END), 0) AS specCostSum,
      COUNT(DISTINCT CASE WHEN status = 'success' AND ticket_id IS NOT NULL THEN ticket_id END) AS specCount,
      AVG(CASE WHEN status = 'success' THEN duration_ms END) AS avgDur
    FROM ai_invocations WHERE ${where.sql} AND surface IN ('quick-spec', 'explore-spec')
    GROUP BY surface
  `).all(...where.params) as Array<{
    surface: Surface
    totalRuns: number
    ticketsCreated: number | null
    totalCost: number
    specCostSum: number
    specCount: number
    avgDur: number | null
  }>
  const modeAggBySurface = new Map(modeAggRows.map((r) => [r.surface, r]))
  const costByDaySurface = new Map<string, number>()
  for (const r of dayRows) costByDaySurface.set(`${r.day}|${r.surface}`, r.cost ?? 0)
  const byMode: ByModeEntry[] = (['quick-spec', 'explore-spec'] as const).map((surface) => {
    const modeKey: 'quick' | 'explore' = surface === 'quick-spec' ? 'quick' : 'explore'
    const r = modeAggBySurface.get(surface)
    const avgCostPerSpec = r && r.specCount > 0 ? r.specCostSum / r.specCount : null
    const sparkline = days.map((d) => costByDaySurface.get(`${d}|${surface}`) ?? 0)
    return {
      mode: modeKey,
      totalRuns: r?.totalRuns ?? 0,
      ticketsCreated: r?.ticketsCreated ?? 0,
      totalCostUsd: r?.totalCost ?? 0,
      avgCostPerSpec,
      avgDurationMs: r?.avgDur ?? null,
      dominantModel: dominantBySurface.get(surface)?.model ?? null,
      sparkline,
    }
  })

  // scatter (capped at 500 points to avoid heavy payloads)
  const scatterRows = db.prepare(`
    SELECT id, surface, total_cost_usd, num_turns, duration_ms, ticket_id, started_at
    FROM ai_invocations WHERE ${where.sql} AND total_cost_usd IS NOT NULL
    ORDER BY started_at DESC LIMIT 500
  `).all(...where.params) as Array<{
    id: string
    surface: Surface
    total_cost_usd: number
    num_turns: number | null
    duration_ms: number | null
    ticket_id: number | null
    started_at: string
  }>
  const scatter: ScatterPoint[] = scatterRows.map((r) => ({
    id: r.id,
    surface: r.surface,
    costUsd: r.total_cost_usd,
    numTurns: r.num_turns,
    durationMs: r.duration_ms,
    ticketId: r.ticket_id,
    startedAt: r.started_at,
  }))

  // topTickets (cross-surface aggregation)
  const ticketRows = db.prepare(`
    SELECT ticket_id, surface, COUNT(*) AS cnt, COALESCE(SUM(total_cost_usd), 0) AS cost
    FROM ai_invocations WHERE ${where.sql}
    GROUP BY ticket_id, surface
  `).all(...where.params) as RowAggTicket[]
  const ticketMap = new Map<string, TopTicketEntry>()
  for (const r of ticketRows) {
    const key = r.ticket_id === null ? '__unattributed__' : String(r.ticket_id)
    if (!ticketMap.has(key)) {
      ticketMap.set(key, {
        ticketId: r.ticket_id,
        ticketTitle: null,
        totalCostUsd: 0,
        totalRuns: 0,
        bySurface: {
          job: { count: 0, costUsd: 0 },
          'quick-spec': { count: 0, costUsd: 0 },
          'explore-spec': { count: 0, costUsd: 0 },
          'ai-edit': { count: 0, costUsd: 0 },
          smash: { count: 0, costUsd: 0 },
          'file-summary': { count: 0, costUsd: 0 },
        },
        isUnattributed: r.ticket_id === null ? true : undefined,
      })
    }
    const entry = ticketMap.get(key)!
    entry.bySurface[r.surface].count += r.cnt
    entry.bySurface[r.surface].costUsd += r.cost ?? 0
    entry.totalRuns += r.cnt
    entry.totalCostUsd += r.cost ?? 0
  }
  const topTickets = Array.from(ticketMap.values())
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd)
    .slice(0, 10)

  // bySurface — derived from ticketRows (same WHERE, grouped by
  // ticket_id+surface): summing across tickets equals a GROUP BY surface
  // (H24: previously a dedicated query re-scanned the same rows).
  const surfaceTotals = new Map<Surface, { cnt: number; cost: number }>()
  for (const r of ticketRows) {
    const agg = surfaceTotals.get(r.surface) ?? { cnt: 0, cost: 0 }
    agg.cnt += r.cnt
    agg.cost += r.cost ?? 0
    surfaceTotals.set(r.surface, agg)
  }
  const bySurface: BySurfaceCount[] = ALL_SURFACES.map((s) => {
    const t = surfaceTotals.get(s)
    return { surface: s, count: t?.cnt ?? 0, costUsd: t?.cost ?? 0 }
  })

  // tracking start (project's first invocation)
  const trackingRow = db.prepare(`
    SELECT MIN(started_at) AS first FROM ai_invocations WHERE project_id = ?
  `).get(projectId) as { first: string | null }

  // byProvider — split authoritative vs estimated cost so the UI can render
  // the `~` tilde + Hero footnote without re-querying. Rows persisted with
  // NULL provider (pre-migration backfill missed somehow) coalesce to
  // `claude` to match the migration default.
  const providerRows = db.prepare(`
    SELECT
      COALESCE(provider, 'claude') AS provider,
      COUNT(*) AS cnt,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 0 THEN total_cost_usd ELSE 0 END), 0) AS authoritativeCost,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS estimatedCost
    FROM ai_invocations WHERE ${where.sql}
    GROUP BY provider
    ORDER BY (authoritativeCost + estimatedCost) DESC
  `).all(...where.params) as Array<{
    provider: string
    cnt: number
    authoritativeCost: number
    estimatedCost: number
  }>
  const byProvider: ByProviderEntry[] = providerRows.map((r) => ({
    provider: r.provider,
    count: r.cnt,
    costUsd: r.authoritativeCost,
    estimatedCostUsd: r.estimatedCost,
  }))

  return {
    summary: {
      totalCostUsd: summaryRow.totalCost,
      totalEstimatedCostUsd: summaryRow.totalEstimatedCost,
      totalTokens: summaryRow.totalTokens,
      totalRuns: summaryRow.totalRuns,
      failureRate: summaryRow.totalRuns > 0 ? (summaryRow.failed ?? 0) / summaryRow.totalRuns : 0,
      prevTotalCostUsd: prevRow.totalCost,
      deltaPct,
      avgCostPerRun: summaryRow.avgCost,
    },
    bySurface,
    byModel,
    byMode,
    byProvider,
    dailyTimeline,
    scatter,
    topTickets,
    trackingStartedAt: trackingRow.first,
    rangeFrom: range.from,
    rangeTo: range.to,
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
  filters: InvocationsFilters = {}
): InvocationsResponse {
  const range = resolveRange(filters)
  const where = buildWhere(projectId, filters, { from: range.from, to: range.to })
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total FROM ai_invocations WHERE ${where.sql}
  `).get(...where.params) as { total: number }
  const cap = filters.cap
  const limit = cap ?? Math.min(filters.limit ?? 50, 200)
  const offset = filters.offset ?? 0
  const rows = db.prepare(`
    SELECT * FROM ai_invocations WHERE ${where.sql}
    ORDER BY started_at DESC LIMIT ? OFFSET ?
  `).all(...where.params, limit, offset) as InvocationRow[]
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
  const enriched: InvocationWithTicket[] = rows.map((r) => ({
    ...r,
    ticket_title: r.conversation_id ? (titleByConv.get(r.conversation_id) ?? null) : null,
  }))
  return {
    rows: enriched,
    total: cap ? Math.min(rows.length, cap) : rows.length,
    truncated: cap !== undefined && totalRow.total > cap,
    totalAvailable: totalRow.total,
  }
}

export function parseSpendingFilters(query: Record<string, unknown>): SpendingFilters {
  const f: SpendingFilters = {}
  if (typeof query.period === 'string') f.period = query.period as Period
  if (typeof query.from === 'string') f.from = query.from
  if (typeof query.to === 'string') f.to = query.to
  if (typeof query.surface === 'string') {
    // M17: validate against the canonical surface list. The old hardcoded subset
    // silently dropped 'smash'/'file-summary' — clicking those chips produced an
    // empty filter array, so buildWhere applied NO surface condition and the UI
    // showed ALL-surface totals while claiming a single-surface filter was active.
    f.surface = query.surface.split(',').filter((s) =>
      (ALL_SURFACES as string[]).includes(s)
    ) as Surface[]
  }
  if (typeof query.model === 'string') {
    f.model = query.model.split(',').filter((s) => s.length > 0)
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
