import type { DbInstance } from './db'
import type { NormalisedResult } from './result-event'

export type Surface =
  | 'job'
  | 'quick-spec'
  | 'explore-spec'
  | 'ai-edit'
  | 'smash'
  | 'file-summary'
  | 'loop'
  // Cost-accounting audit additions — previously-unrecorded billable spawners
  // (sidebar chat, /opsx:ff spec launcher, proposal manager, custom-agent
  // studio generate/test, setup-wizard AI turns).
  | 'chat-sidebar'
  | 'spec-launcher'
  | 'proposal'
  | 'agent-studio'
  | 'setup'
export type InvocationStatus = 'success' | 'failed' | 'aborted'

const ALLOWED_SURFACES: ReadonlySet<Surface> = new Set([
  'job',
  'quick-spec',
  'explore-spec',
  'ai-edit',
  'smash',
  'file-summary',
  'loop',
  'chat-sidebar',
  'spec-launcher',
  'proposal',
  'agent-studio',
  'setup',
])

export interface RecordInput extends NormalisedResult {
  id: string
  project_id: string
  /** Provider id from the resolved adapter. Required after migration 18.
   *  Existing pre-migration rows are backfilled to 'claude'. */
  provider: string
  surface: Surface
  surface_ref_id?: string | null
  ticket_id?: number | null
  conversation_id?: string | null
  status: InvocationStatus
  started_at: string
  finished_at?: string | null
  /** True when `total_cost_usd` came from the local pricing table fallback
   *  (vs the provider's terminal event). Writes the `total_cost_usd_estimated`
   *  flag column. Default false. */
  total_cost_usd_estimated?: boolean
  /** Links a loop's per-iteration AI Step / Loop Decider invocation (surface='loop')
   *  to its loop_runs row for run-level rollups. NULL for all non-loop rows. */
  loop_run_id?: string | null
}

export interface InvocationRow {
  id: string
  project_id: string
  provider: string | null
  surface: Surface
  surface_ref_id: string | null
  ticket_id: number | null
  conversation_id: string | null
  model: string | null
  status: InvocationStatus
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

export class InvalidSurfaceError extends Error {
  constructor(public readonly surface: string) {
    super(`Invalid surface: ${surface}`)
    this.name = 'InvalidSurfaceError'
  }
}

export function recordInvocation(db: DbInstance, input: RecordInput): void {
  if (!ALLOWED_SURFACES.has(input.surface)) {
    throw new InvalidSurfaceError(input.surface)
  }
  if (!input.provider) {
    throw new Error('recordInvocation: provider is required')
  }
  db.prepare(`
    INSERT INTO ai_invocations (
      id, project_id, provider, surface, surface_ref_id, ticket_id, conversation_id,
      model, status, started_at, finished_at, duration_ms, duration_api_ms,
      tokens_in, tokens_out, tokens_cache_read, tokens_cache_create,
      total_cost_usd, total_cost_usd_estimated, num_turns, session_id, loop_run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.id,
    input.project_id,
    input.provider,
    input.surface,
    input.surface_ref_id ?? null,
    input.ticket_id ?? null,
    input.conversation_id ?? null,
    input.model ?? null,
    input.status,
    input.started_at,
    input.finished_at ?? null,
    input.duration_ms ?? null,
    input.duration_api_ms ?? null,
    input.tokens_in ?? null,
    input.tokens_out ?? null,
    input.tokens_cache_read ?? null,
    input.tokens_cache_create ?? null,
    input.total_cost_usd ?? null,
    input.total_cost_usd_estimated ? 1 : 0,
    input.num_turns ?? null,
    input.session_id ?? null,
    input.loop_run_id ?? null,
  )
}

export function updateTicketIdForConversation(
  db: DbInstance,
  conversationId: string,
  ticketId: number
): number {
  const result = db.prepare(
    `UPDATE ai_invocations SET ticket_id = ? WHERE conversation_id = ? AND ticket_id IS NULL`
  ).run(ticketId, conversationId)
  return result.changes
}

export function listInvocationsForConversation(
  db: DbInstance,
  conversationId: string
): InvocationRow[] {
  return db.prepare(
    `SELECT * FROM ai_invocations WHERE conversation_id = ? ORDER BY started_at ASC`
  ).all(conversationId) as InvocationRow[]
}

export function getTicketSpendingSummary(
  db: DbInstance,
  ticketId: number
): {
  totalCostUsd: number
  /**
   * Portion of `totalCostUsd` from rows flagged `total_cost_usd_estimated=1`
   * (codex/gemini pricing-table fallback). Lets TicketSpendingLine render a `~`
   * when the ticket's cost is wholly/partly estimated (BUG-ANALYTICS-12).
   * 0 for a ticket implemented entirely via claude.
   */
  estimatedCostUsd: number
  totalTokens: number | null
  totalTurns: number | null
  pricedRuns: number
  unpricedRuns: number
  usageReportedRuns: number
  usageUnavailableRuns: number
  turnsReportedRuns: number
  turnsUnavailableRuns: number
  activeDurationMs: number
  bySurface: Record<Surface, { count: number; costUsd: number; unpricedCount?: number }>
  totalRuns: number
} {
  const rows = db.prepare(
    `SELECT surface, status, total_cost_usd, total_cost_usd_estimated, num_turns, duration_ms,
            tokens_in, tokens_out, tokens_cache_read, tokens_cache_create
     FROM ai_invocations WHERE ticket_id = ?`
  ).all(ticketId) as Array<{
    surface: Surface
    status: InvocationStatus
    total_cost_usd: number | null
    total_cost_usd_estimated: number
    num_turns: number | null
    duration_ms: number | null
    tokens_in: number | null
    tokens_out: number | null
    tokens_cache_read: number | null
    tokens_cache_create: number | null
  }>
  const bySurface: Record<Surface, { count: number; costUsd: number; unpricedCount?: number }> = {
    job: { count: 0, costUsd: 0, unpricedCount: 0 },
    'quick-spec': { count: 0, costUsd: 0, unpricedCount: 0 },
    'explore-spec': { count: 0, costUsd: 0, unpricedCount: 0 },
    'ai-edit': { count: 0, costUsd: 0, unpricedCount: 0 },
    smash: { count: 0, costUsd: 0, unpricedCount: 0 },
    'file-summary': { count: 0, costUsd: 0, unpricedCount: 0 },
    loop: { count: 0, costUsd: 0, unpricedCount: 0 },
    'chat-sidebar': { count: 0, costUsd: 0, unpricedCount: 0 },
    'spec-launcher': { count: 0, costUsd: 0, unpricedCount: 0 },
    proposal: { count: 0, costUsd: 0, unpricedCount: 0 },
    'agent-studio': { count: 0, costUsd: 0, unpricedCount: 0 },
    setup: { count: 0, costUsd: 0, unpricedCount: 0 },
  }
  let totalCostUsd = 0
  let estimatedCostUsd = 0
  let totalTokens = 0
  let totalTurns = 0
  let pricedRuns = 0
  let unpricedRuns = 0
  let usageReportedRuns = 0
  let usageUnavailableRuns = 0
  let turnsReportedRuns = 0
  let turnsUnavailableRuns = 0
  let activeDurationMs = 0
  for (const r of rows) {
    // Defensive: a row written by a newer schema with a surface this build
    // doesn't know must not crash the summary.
    if (!bySurface[r.surface]) bySurface[r.surface] = { count: 0, costUsd: 0, unpricedCount: 0 }
    bySurface[r.surface].count += 1
    bySurface[r.surface].costUsd += r.total_cost_usd ?? 0
    if (r.total_cost_usd == null) {
      unpricedRuns += 1
      bySurface[r.surface].unpricedCount = (bySurface[r.surface].unpricedCount ?? 0) + 1
    } else {
      pricedRuns += 1
    }
    totalCostUsd += r.total_cost_usd ?? 0
    if (r.total_cost_usd_estimated === 1) estimatedCostUsd += r.total_cost_usd ?? 0
    // Real total tokens = fresh input + output + cache-read + cache-create.
    const hasUsage =
      r.tokens_in != null || r.tokens_out != null
      || r.tokens_cache_read != null || r.tokens_cache_create != null
    if (hasUsage) {
      usageReportedRuns += 1
      totalTokens +=
        (r.tokens_in ?? 0) +
        (r.tokens_out ?? 0) +
        (r.tokens_cache_read ?? 0) +
        (r.tokens_cache_create ?? 0)
    } else {
      usageUnavailableRuns += 1
    }
    if (r.num_turns != null) {
      turnsReportedRuns += 1
      totalTurns += r.num_turns
    } else {
      turnsUnavailableRuns += 1
    }
    activeDurationMs += r.duration_ms ?? 0
  }
  for (const bucket of Object.values(bySurface)) {
    if ((bucket.unpricedCount ?? 0) === 0) delete bucket.unpricedCount
  }
  return {
    totalCostUsd,
    estimatedCostUsd,
    totalTokens: usageReportedRuns > 0 ? totalTokens : rows.length > 0 ? null : 0,
    totalTurns: turnsReportedRuns > 0 ? totalTurns : rows.length > 0 ? null : 0,
    pricedRuns,
    unpricedRuns,
    usageReportedRuns,
    usageUnavailableRuns,
    turnsReportedRuns,
    turnsUnavailableRuns,
    activeDurationMs,
    bySurface,
    totalRuns: rows.length,
  }
}

/**
 * Per-provider aggregation for the Analytics dashboard. Returns counts +
 * authoritative cost (rows with total_cost_usd_estimated=0) and estimated
 * cost (rows with total_cost_usd_estimated=1) split, so the UI can render the
 * ~ badge and the "Includes estimated costs" footnote accurately.
 *
 * Spec: openspec/.../specs/project-spending/spec.md ("byProvider analytics breakdown")
 */
export function getInvocationsByProvider(
  db: DbInstance,
  projectId: string,
  opts: { fromIso?: string; toIso?: string } = {},
): Array<{ provider: string; count: number; costUsd: number; estimatedCostUsd: number }> {
  const params: Array<string> = [projectId]
  let dateClause = ''
  if (opts.fromIso) {
    dateClause += ' AND started_at >= ?'
    params.push(opts.fromIso)
  }
  if (opts.toIso) {
    dateClause += ' AND started_at < ?'
    params.push(opts.toIso)
  }
  const rows = db.prepare(`
    SELECT
      COALESCE(provider, 'claude') AS provider,
      COUNT(*)                                                         AS count,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 0 THEN total_cost_usd ELSE 0 END), 0) AS costUsd,
      COALESCE(SUM(CASE WHEN total_cost_usd_estimated = 1 THEN total_cost_usd ELSE 0 END), 0) AS estimatedCostUsd
    FROM ai_invocations
    WHERE project_id = ?${dateClause}
    GROUP BY provider
    ORDER BY (costUsd + estimatedCostUsd) DESC
  `).all(...params) as Array<{
    provider: string
    count: number
    costUsd: number
    estimatedCostUsd: number
  }>
  return rows
}
