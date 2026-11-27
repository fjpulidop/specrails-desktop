/**
 * Cost forecasts for confirmable spending actions, from the app's own data:
 *
 * - `launchForecast` / `scaledCost`: one launch's band from the project's
 *   `launch-forecast` route (the launch dialog's numbers), times the runs it
 *   starts. Shared by runs, rails and blueprint chain launches.
 * - `turnCostBand`: one conversational turn's band from that surface's own
 *   provider-billed history (missions, Builder, milestone generation, Intent).
 *
 * Null means unknown, which the confirmation protocol treats as above the
 * "Ask before spending" threshold.
 */
import type { DbInstance } from '../../../db'
import type { ProjectRow } from '../../../desktop-db'
import type { McpToolContext } from '../../tools/types'
import { maybe } from './loopback'
import { asRecord, type Row } from './text'

const cents = (usd: number) => Math.round(usd * 100) / 100
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

export interface LaunchForecastQuery { loopId?: string | null; command?: string | null; provider?: string | null }

function forecastRow(ctx: McpToolContext, project: Pick<ProjectRow, 'id'>, query: LaunchForecastQuery): Promise<Row | null> {
  const params = new URLSearchParams()
  if (query.loopId) params.set('loopId', query.loopId)
  if (query.command) params.set('command', query.command)
  if (query.provider) params.set('provider', query.provider)
  return maybe(ctx, `/projects/${encodeURIComponent(project.id)}/launch-forecast?${params}`)
}

const IMPLEMENT_LOOP = 'factory:implement'
const hasCost = (row: Row | null): boolean => scaledCost(row, 1) !== null

/**
 * The project's `launch-forecast` row (cost + time), or null when the route has none.
 * A kind of run the project has too few measured runs of (a first Intent hand-off, a new
 * loop) falls back to the closest measured kind: the same loop on any provider, then the
 * project's Implement runs (with that provider, then any). A fallback row carries
 * `basis: 'similar'` so the confirmation says the figure comes from similar runs; with no
 * measured runs at all it stays unknown.
 */
export async function launchForecast(ctx: McpToolContext, project: Pick<ProjectRow, 'id'>, query: LaunchForecastQuery): Promise<Row | null> {
  const exact = await forecastRow(ctx, project, query)
  if (hasCost(exact)) return exact
  const tries: LaunchForecastQuery[] = [
    ...(query.provider ? [{ ...query, provider: null }] : []),
    ...(query.loopId !== IMPLEMENT_LOOP || query.command ? [{ loopId: IMPLEMENT_LOOP, provider: query.provider ?? null }, { loopId: IMPLEMENT_LOOP }] : []),
  ]
  for (const attempt of tries) {
    const row = await forecastRow(ctx, project, attempt)
    if (hasCost(row)) return { ...row, basis: 'similar' }
  }
  return exact
}

/** A forecast's per-run `[lowUsd, highUsd]` times `runs`, in cents; null when unknown. */
export function scaledCost(forecast: Row | null | undefined, runs: number): [number, number] | null {
  if (runs <= 0) return [0, 0]
  const cost = asRecord(forecast?.cost)
  const low = num(cost.lowUsd)
  const high = num(cost.highUsd)
  return low !== null && high !== null ? [cents(low * runs), cents(high * runs)] : null
}

export interface TurnCostOptions {
  /** Fewer billed turns than this: unknown (default 2). */
  minSamples?: number
  /** Lower bound: the cheapest turn (default) or the median one. */
  low?: 'min' | 'median'
}

/** `[low, max]` of a turn's past provider-billed costs (non-negative numbers only). */
export function turnCostBand(costs: ReadonlyArray<number | null | undefined>, options: TurnCostOptions = {}): [number, number] | null {
  const sorted = costs.filter((cost): cost is number => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0).sort((a, b) => a - b)
  if (sorted.length < (options.minSamples ?? 2)) return null
  const low = options.low === 'median' ? sorted[Math.floor(sorted.length / 2)] : sorted[0]
  return [cents(low), cents(sorted[sorted.length - 1])]
}

/** Runs a `SELECT … AS cost` over a ledger and bands it; any read failure is unknown. */
export function turnCostFromLedger(db: DbInstance | null | undefined, sql: string, params: readonly unknown[] = [], options: TurnCostOptions = {}): [number, number] | null {
  if (!db) return null
  try {
    return turnCostBand((db.prepare(sql).all(...params) as Array<{ cost: number | null }>).map((row) => row.cost), options)
  } catch { return null }
}
