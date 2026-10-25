/**
 * What-if pricing (CD5): "price the last N days with this model instead".
 *
 * Re-prices RECORDED token usage with the local rate card (`pricing.ts`). The
 * answer is an estimate on both sides (the current model is re-priced the same
 * way, so the delta compares like with like) and is never shown as billed.
 * A model with no rate-card entry is reported as `noPricing` — never guessed.
 * Recorded usage is per invocation (provider + model), not per profile role, so
 * the source is a `provider:model` bucket.
 */
import type { DbInstance } from '../../../db'
import { PRICING, estimateCostUsd, resolvePriceEntry } from './pricing'

export const WHAT_IF_DEFAULT_DAYS = 30
export const WHAT_IF_MAX_DAYS = 365

export interface ModelRef { provider: string; model: string }

export interface WhatIfSource extends ModelRef {
  invocations: number
  /** Recorded cost (billed + estimated) of those invocations; null when none carries a cost. */
  recordedUsd: number | null
  /** Whether the rate card can price this model (so it can be the "from" side of a delta). */
  priced: boolean
}

export interface WhatIfResult {
  from: ModelRef
  to: ModelRef
  days: number
  invocations: number
  /** Invocations with recorded token usage (the ones that could be re-priced). */
  repriced: number
  /** Invocations without usable usage or price on the current model: left out of both estimates. */
  skipped: number
  tokens: { in: number; out: number; cacheRead: number; cacheCreate: number }
  /** Recorded cost of the same invocations (provider-reported plus estimated). Not an input to the delta. */
  recordedUsd: number | null
  estimateCurrentUsd: number | null
  estimateWhatIfUsd: number | null
  /** estimateWhatIf − estimateCurrent, in cents precision; null when either side is unpriced. */
  deltaUsd: number | null
  /** Which side the rate card cannot price, if any. */
  noPricing: { side: 'from' | 'to'; provider: string; model: string } | null
}

export interface WhatIfOverview {
  days: number
  sources: WhatIfSource[]
  /** Every provider:model the rate card can price (the possible "to" sides). */
  targets: ModelRef[]
  result: WhatIfResult | null
}

/** Round once, at the end: summing per-invocation cents would zero out many small calls. */
const toUsd = (usd: number): number => Math.round(usd * 100) / 100

export function listPricedModels(): ModelRef[] {
  return Object.keys(PRICING).map((key) => {
    const at = key.indexOf(':')
    return { provider: key.slice(0, at), model: key.slice(at + 1) }
  })
}

export function hasPricing(ref: ModelRef): boolean {
  return resolvePriceEntry(ref.provider, ref.model) !== undefined
}

interface Row {
  provider: string; model: string | null; tokens_in: number | null; tokens_out: number | null
  tokens_cache_read: number | null; tokens_cache_create: number | null; total_cost_usd: number | null
}

const SELECT = `SELECT COALESCE(provider, 'claude') AS provider, model, tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, total_cost_usd
  FROM ai_invocations WHERE project_id = ? AND started_at >= ? AND model IS NOT NULL AND model != ''`

export function clampDays(raw: unknown): number {
  const value = typeof raw === 'string' ? parseInt(raw, 10) : typeof raw === 'number' ? Math.trunc(raw) : NaN
  return Number.isFinite(value) && value >= 1 ? Math.min(value, WHAT_IF_MAX_DAYS) : WHAT_IF_DEFAULT_DAYS
}

export function computeWhatIf(db: DbInstance, projectId: string, days: number, pair: { from: ModelRef; to: ModelRef } | null, now: Date = new Date()): WhatIfOverview {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString()
  const rows = db.prepare(SELECT).all(projectId, since) as Row[]

  const buckets = new Map<string, WhatIfSource & { cost: number; anyCost: boolean }>()
  for (const row of rows) {
    const key = `${row.provider}:${row.model}`
    const bucket = buckets.get(key) ?? { provider: row.provider, model: row.model as string, invocations: 0, recordedUsd: null, priced: hasPricing({ provider: row.provider, model: row.model as string }), cost: 0, anyCost: false }
    bucket.invocations++
    if (row.total_cost_usd != null) { bucket.cost += row.total_cost_usd; bucket.anyCost = true }
    buckets.set(key, bucket)
  }
  const sources: WhatIfSource[] = [...buckets.values()]
    .map(({ cost, anyCost, ...rest }) => ({ ...rest, recordedUsd: anyCost ? toUsd(cost) : null }))
    .sort((a, b) => (b.recordedUsd ?? 0) - (a.recordedUsd ?? 0) || b.invocations - a.invocations)

  let result: WhatIfResult | null = null
  if (pair) {
    const { from, to } = pair
    const mine = rows.filter((row) => row.provider === from.provider && row.model === from.model)
    const tokens = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 }
    let current = 0, whatIf = 0, repriced = 0, recorded = 0, anyRecorded = false
    for (const row of mine) {
      if (row.total_cost_usd != null) { recorded += row.total_cost_usd; anyRecorded = true }
      const usage = { tokens_in: row.tokens_in ?? 0, tokens_out: row.tokens_out ?? 0, tokens_cache_read: row.tokens_cache_read ?? 0, tokens_cache_create: row.tokens_cache_create ?? 0 }
      tokens.in += usage.tokens_in; tokens.out += usage.tokens_out; tokens.cacheRead += usage.tokens_cache_read; tokens.cacheCreate += usage.tokens_cache_create
      // Per invocation: a long-context tier depends on THAT request's prompt size.
      const was = estimateCostUsd(from.provider, from.model, usage)
      const would = estimateCostUsd(to.provider, to.model, usage)
      if (was === null || would === null) continue
      current += was; whatIf += would; repriced++
    }
    const fromPriced = hasPricing(from)
    const toPriced = hasPricing(to)
    const noPricing = !toPriced ? { side: 'to' as const, ...to } : !fromPriced ? { side: 'from' as const, ...from } : null
    result = {
      from, to, days,
      invocations: mine.length,
      repriced,
      skipped: mine.length - repriced,
      tokens,
      recordedUsd: anyRecorded ? toUsd(recorded) : null,
      estimateCurrentUsd: noPricing ? null : toUsd(current),
      estimateWhatIfUsd: noPricing ? null : toUsd(whatIf),
      deltaUsd: noPricing ? null : toUsd(whatIf - current),
      noPricing,
    }
  }
  return { days, sources, targets: listPricedModels(), result }
}
