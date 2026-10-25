/**
 * Budget panel model (CD5): caps beyond the daily budget, spend per period, the
 * month-end projection and what-if pricing. Pure parsing and arithmetic; the
 * panel binds the fetches.
 *
 * Honest-metrics rules: spend is what was recorded (its estimated part is kept
 * apart), the projection and every what-if figure are estimates and are never
 * summed with, or shown as, a billed figure; a subscription provider shows
 * turns instead of dollars; a model with no price says so.
 */
import { API_ORIGIN } from '../../../lib/origin'

export type CapPeriod = 'day' | 'week' | 'month'
export const CAP_PERIODS: readonly CapPeriod[] = ['day', 'week', 'month']

export interface CapConfig { day: number | null; week: number | null; month: number | null; run: number | null }
export interface CapStatus { scope: 'project' | 'desktop'; period: CapPeriod; budgetUsd: number; spentUsd: number; exhausted: boolean; resetsAt: string }
export interface ProviderSpend { provider: string; usd: number; estimatedUsd: number; invocations: number; turns: number }
export interface PeriodSpend { startsAt: string; resetsAt: string; usd: number; estimatedUsd: number; byProvider: ProviderSpend[] }
export interface Projection { trailingDays: number; avgDailyUsd: number; monthToDateUsd: number; remainingDays: number; projectedUsd: number }

export interface BudgetOverview {
  spend: Record<CapPeriod, PeriodSpend>
  projection: Projection | null
  config: CapConfig
  /** Present on a project overview: the app-wide config, edited from the same panel. */
  appConfig: CapConfig | null
  caps: CapStatus[]
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const positive = (value: unknown): number | null => { const n = num(value); return n !== null && n > 0 ? n : null }

function parseConfig(raw: unknown): CapConfig | null {
  const body = record(raw)
  if (!body) return null
  return { day: positive(body.day), week: positive(body.week), month: positive(body.month), run: positive(body.run) }
}

function parsePeriodSpend(raw: unknown): PeriodSpend | null {
  const body = record(raw)
  if (!body || num(body.usd) === null || !Array.isArray(body.byProvider)) return null
  const byProvider: ProviderSpend[] = []
  for (const entry of body.byProvider) {
    const row = record(entry)
    if (!row || typeof row.provider !== 'string' || num(row.usd) === null) continue
    byProvider.push({ provider: row.provider, usd: row.usd as number, estimatedUsd: num(row.estimatedUsd) ?? 0, invocations: num(row.invocations) ?? 0, turns: num(row.turns) ?? 0 })
  }
  return { startsAt: String(body.startsAt ?? ''), resetsAt: String(body.resetsAt ?? ''), usd: body.usd as number, estimatedUsd: num(body.estimatedUsd) ?? 0, byProvider }
}

function parseProjection(raw: unknown): Projection | null {
  const body = record(raw)
  if (!body) return null
  const [trailingDays, avgDailyUsd, monthToDateUsd, remainingDays, projectedUsd] = [body.trailingDays, body.avgDailyUsd, body.monthToDateUsd, body.remainingDays, body.projectedUsd].map(num)
  if (trailingDays === null || avgDailyUsd === null || monthToDateUsd === null || remainingDays === null || projectedUsd === null) return null
  return { trailingDays, avgDailyUsd, monthToDateUsd, remainingDays, projectedUsd }
}

/** Tolerant parse of `GET …/budget/caps`; null when it is not an overview. */
export function parseBudgetOverview(raw: unknown): BudgetOverview | null {
  const body = record(raw)
  const spendBody = record(body?.spend)
  const config = parseConfig(body?.config)
  if (!body || !spendBody || !config) return null
  const day = parsePeriodSpend(spendBody.day), week = parsePeriodSpend(spendBody.week), month = parsePeriodSpend(spendBody.month)
  if (!day || !week || !month) return null
  const caps: CapStatus[] = []
  for (const entry of Array.isArray(body.caps) ? body.caps : []) {
    const cap = record(entry)
    if (!cap || (cap.scope !== 'project' && cap.scope !== 'desktop') || !(CAP_PERIODS as readonly unknown[]).includes(cap.period)) continue
    const budgetUsd = positive(cap.budgetUsd), spentUsd = num(cap.spentUsd)
    if (budgetUsd === null || spentUsd === null) continue
    caps.push({ scope: cap.scope, period: cap.period as CapPeriod, budgetUsd, spentUsd, exhausted: cap.exhausted === true, resetsAt: String(cap.resetsAt ?? '') })
  }
  return { spend: { day, week, month }, projection: parseProjection(body.projection), config, appConfig: parseConfig(body.appConfig), caps }
}

export async function fetchBudgetOverview(projectBase: string | null, signal?: AbortSignal): Promise<BudgetOverview | null> {
  const url = projectBase ? `${projectBase}/budget/caps` : `${API_ORIGIN}/api/budget/caps`
  const res = await fetch(url, { signal })
  return res.ok ? parseBudgetOverview(await res.json()) : null
}

// ─── Arithmetic (integer cents) ──────────────────────────────────────────────

export const toCents = (usd: number): number => Math.round(usd * 100)

export type BarLevel = 'ok' | 'caution' | 'reached'

/** Reached at the exact cent; caution from 80 %. Null when there is no cap to compare with. */
export function barLevel(spentUsd: number, capUsd: number | null): BarLevel | null {
  if (capUsd === null || !(capUsd > 0)) return null
  const spent = toCents(spentUsd), cap = toCents(capUsd)
  if (spent >= cap) return 'reached'
  return spent * 10 >= cap * 8 ? 'caution' : 'ok'
}

/** Fill of the bar, 0–100 (whole percent, never above 100). */
export function barPercent(spentUsd: number, capUsd: number | null): number {
  if (capUsd === null || !(capUsd > 0)) return 0
  return Math.min(100, Math.floor((toCents(spentUsd) * 100) / toCents(capUsd)))
}

/** Does the month-end projection pass the monthly cap? (An estimate: only a caution.) */
export function projectionPassesCap(projection: Projection | null, monthlyCapUsd: number | null): boolean {
  return !!projection && monthlyCapUsd !== null && monthlyCapUsd > 0 && toCents(projection.projectedUsd) > toCents(monthlyCapUsd)
}

/** The spend the cap check counts for a period: the gate's own figure when a cap exists, else the recorded sum. */
export function periodSpentUsd(overview: BudgetOverview, period: CapPeriod, scope: 'project' | 'desktop'): number {
  const status = overview.caps.find((cap) => cap.scope === scope && cap.period === period)
  return status ? status.spentUsd : overview.spend[period].usd
}

// ─── What-if ─────────────────────────────────────────────────────────────────

export interface ModelRef { provider: string; model: string }
export interface WhatIfSource extends ModelRef { invocations: number; recordedUsd: number | null; priced: boolean }
export interface WhatIfResult {
  from: ModelRef
  to: ModelRef
  days: number
  invocations: number
  repriced: number
  skipped: number
  tokens: { in: number; out: number; cacheRead: number; cacheCreate: number }
  recordedUsd: number | null
  estimateCurrentUsd: number | null
  estimateWhatIfUsd: number | null
  deltaUsd: number | null
  noPricing: { side: 'from' | 'to'; provider: string; model: string } | null
}
export interface WhatIfOverview { days: number; sources: WhatIfSource[]; targets: ModelRef[]; result: WhatIfResult | null }

const modelRef = (raw: unknown): ModelRef | null => {
  const body = record(raw)
  return body && typeof body.provider === 'string' && typeof body.model === 'string' ? { provider: body.provider, model: body.model } : null
}

export function parseWhatIf(raw: unknown): WhatIfOverview | null {
  const body = record(raw)
  if (!body || num(body.days) === null || !Array.isArray(body.sources) || !Array.isArray(body.targets)) return null
  const sources: WhatIfSource[] = []
  for (const entry of body.sources) {
    const ref = modelRef(entry), row = record(entry)
    if (ref && row) sources.push({ ...ref, invocations: num(row.invocations) ?? 0, recordedUsd: num(row.recordedUsd), priced: row.priced === true })
  }
  const targets = body.targets.map(modelRef).filter((ref): ref is ModelRef => ref !== null)
  let result: WhatIfResult | null = null
  const r = record(body.result)
  const from = modelRef(r?.from), to = modelRef(r?.to)
  if (r && from && to) {
    const tokens = record(r.tokens)
    const np = record(r.noPricing)
    result = {
      from, to, days: num(r.days) ?? (body.days as number), invocations: num(r.invocations) ?? 0, repriced: num(r.repriced) ?? 0, skipped: num(r.skipped) ?? 0,
      tokens: { in: num(tokens?.in) ?? 0, out: num(tokens?.out) ?? 0, cacheRead: num(tokens?.cacheRead) ?? 0, cacheCreate: num(tokens?.cacheCreate) ?? 0 },
      recordedUsd: num(r.recordedUsd), estimateCurrentUsd: num(r.estimateCurrentUsd), estimateWhatIfUsd: num(r.estimateWhatIfUsd), deltaUsd: num(r.deltaUsd),
      noPricing: np && (np.side === 'from' || np.side === 'to') && typeof np.provider === 'string' && typeof np.model === 'string' ? { side: np.side, provider: np.provider, model: np.model } : null,
    }
  }
  return { days: body.days as number, sources, targets, result }
}

export const refKey = (ref: ModelRef): string => `${ref.provider}:${ref.model}`
export function parseRefKey(key: string): ModelRef | null {
  const at = key.indexOf(':')
  return at > 0 && at < key.length - 1 ? { provider: key.slice(0, at), model: key.slice(at + 1) } : null
}

export async function fetchWhatIf(projectBase: string, pair: { from: ModelRef; to: ModelRef } | null, signal?: AbortSignal): Promise<WhatIfOverview | null> {
  const params = new URLSearchParams({ days: '30' })
  if (pair) { params.set('from', refKey(pair.from)); params.set('to', refKey(pair.to)) }
  const res = await fetch(`${projectBase}/budget/what-if?${params}`, { signal })
  return res.ok ? parseWhatIf(await res.json()) : null
}
