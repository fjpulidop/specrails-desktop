/**
 * Launch forecast: "Usually 6–9 min · $2–4 for runs like this".
 *
 * The numbers come from `GET /api/projects/:id/launch-forecast`, a measured
 * interquartile band of this project's own settled runs (the same samples as
 * the job story's "Runs like this have taken…"). Honest-metrics rules:
 *
 *  · below the server's sample floor the band is absent and the UI says
 *    "Not enough history yet" — never a default, never an average;
 *  · it is labelled an estimate and is never shown as, or summed with, a
 *    billed figure (the server builds the cost band from provider-reported
 *    costs only);
 *  · on a subscription plan the dollar figure is hidden and only time shows.
 */
import { API_ORIGIN } from './origin'

export interface ForecastTime { p25Ms: number; medianMs: number; p75Ms: number; sampleCount: number }
export interface ForecastCost { lowUsd: number; highUsd: number; sampleCount: number }
export interface ForecastBudget {
  scope: 'project' | 'desktop'
  budgetUsd: number
  spentUsd: number
  exhausted: boolean
  resetsAt: string | null
}
export interface LaunchForecastData {
  time: ForecastTime | null
  cost: ForecastCost | null
  minSamples: number
  budget: ForecastBudget | null
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Tolerant parse of the endpoint body; null when it is not a forecast. */
export function parseLaunchForecast(raw: unknown): LaunchForecastData | null {
  const body = record(raw)
  if (!body || !finite(body.minSamples)) return null
  const t = record(body.time)
  const time: ForecastTime | null = t && finite(t.p25Ms) && finite(t.medianMs) && finite(t.p75Ms) && finite(t.sampleCount) && t.p25Ms > 0
    ? { p25Ms: t.p25Ms, medianMs: t.medianMs, p75Ms: t.p75Ms, sampleCount: t.sampleCount }
    : null
  const c = record(body.cost)
  const cost: ForecastCost | null = c && finite(c.lowUsd) && finite(c.highUsd) && finite(c.sampleCount) && c.highUsd > 0
    ? { lowUsd: c.lowUsd, highUsd: c.highUsd, sampleCount: c.sampleCount }
    : null
  const b = record(body.budget)
  const budget: ForecastBudget | null = b && (b.scope === 'project' || b.scope === 'desktop') && finite(b.budgetUsd) && finite(b.spentUsd) && b.budgetUsd > 0
    ? { scope: b.scope, budgetUsd: b.budgetUsd, spentUsd: b.spentUsd, exhausted: b.exhausted === true, resetsAt: typeof b.resetsAt === 'string' ? b.resetsAt : null }
    : null
  return { time, cost, minSamples: body.minSamples, budget }
}

const toCents = (usd: number): number => Math.round(usd * 100)

/**
 * Would today's spend plus the top of the forecast reach the daily budget?
 * Integer cents on both sides (no float drift at the boundary). Needs a cost
 * band: with none there is nothing honest to add, so no warning is guessed.
 * `exhausted` is its own state — the gate refuses the launch outright.
 */
export function budgetOutlook(data: LaunchForecastData): 'none' | 'may-pause' | 'reached' {
  const budget = data.budget
  if (!budget) return 'none'
  if (budget.exhausted || toCents(budget.spentUsd) >= toCents(budget.budgetUsd)) return 'reached'
  if (!data.cost) return 'none'
  return toCents(budget.spentUsd) + toCents(data.cost.highUsd) >= toCents(budget.budgetUsd) ? 'may-pause' : 'none'
}

/** Whole minutes, never 0: a band is rendered in minutes, like the job story. */
export const forecastMinutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

/** "$2–$4" / "$2.10–$3.80": no ".00" on whole dollars, locale aware. */
export function formatUsdBand(low: number, high: number, lang: string): string {
  const money = (value: number): string => {
    const digits = Math.round(value * 100) % 100 === 0 ? 0 : 2
    try {
      return new Intl.NumberFormat(lang, { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
    } catch {
      return new Intl.NumberFormat('en', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)
    }
  }
  const a = money(low)
  const b = money(high)
  return a === b ? a : `${a}–${b}`
}

// ─── Billing mode ────────────────────────────────────────────────────────────

/**
 * Is `provider` billed through a subscription plan (so a dollar figure would
 * mislead)? Read from the machine's subscription-usage snapshot: the provider
 * must be signed in with a detected plan or usage windows, and must not be an
 * on-demand enterprise account (that one is metered, with its own spend).
 * Anything unknown — other providers, API-key auth, a snapshot that does not
 * say — is NOT a plan: costs then show, flagged as estimates.
 */
export function isPlanBilled(snapshot: unknown, provider: string): boolean {
  const providers = record(snapshot)?.providers
  if (!Array.isArray(providers)) return false
  const row = providers.map(record).find((entry) => entry?.providerId === provider)
  if (!row || row.availability !== 'available' || row.spend) return false
  const hasPlan = typeof row.plan === 'string' && row.plan.length > 0
  const windows = Array.isArray(row.windows) ? row.windows : []
  const hasWindow = windows.some((w) => finite(record(w)?.usedPercent))
  return hasPlan || hasWindow
}

// ─── Fetching (small shared cache, in-flight dedupe) ─────────────────────────

const TTL_MS = 30_000
const BILLING_TTL_MS = 60_000

interface Entry<T> { at: number; value: T | null; pending: Promise<T | null> | null }

function cached<T>(store: Map<string, Entry<T>>, key: string, ttl: number, load: () => Promise<T | null>): { fresh: T | null; load: () => Promise<T | null> } {
  const entry = store.get(key)
  const now = Date.now()
  return {
    fresh: entry && entry.value !== null && now - entry.at < ttl ? entry.value : null,
    load: () => {
      const current = store.get(key)
      if (current?.pending) return current.pending
      const pending = load().then((value) => {
        store.set(key, { at: Date.now(), value, pending: null })
        return value
      }, () => {
        store.set(key, { at: current?.at ?? 0, value: current?.value ?? null, pending: null })
        return null
      })
      store.set(key, { at: current?.at ?? 0, value: current?.value ?? null, pending })
      return pending
    },
  }
}

const forecasts = new Map<string, Entry<LaunchForecastData>>()
const billing = new Map<string, Entry<unknown>>()

export interface ForecastQuery { projectId: string; loopId: string; provider: string }

export const forecastKey = (q: ForecastQuery): string => `${q.projectId}|${q.loopId}|${q.provider}`

/** Last forecast seen for this query (stale allowed), for instant paint while it refreshes. */
export function peekForecast(q: ForecastQuery): LaunchForecastData | null {
  return forecasts.get(forecastKey(q))?.value ?? null
}

export function fetchLaunchForecast(q: ForecastQuery, request: typeof fetch = (...args) => fetch(...args)): { fresh: LaunchForecastData | null; load: () => Promise<LaunchForecastData | null> } {
  const params = new URLSearchParams({ loopId: q.loopId, provider: q.provider })
  return cached(forecasts, forecastKey(q), TTL_MS, async () => {
    const res = await request(`${API_ORIGIN}/api/projects/${encodeURIComponent(q.projectId)}/launch-forecast?${params}`)
    return res.ok ? parseLaunchForecast(await res.json()) : null
  })
}

export function fetchUsageSnapshot(request: typeof fetch = (...args) => fetch(...args)): { fresh: unknown; load: () => Promise<unknown> } {
  return cached(billing, 'usage', BILLING_TTL_MS, async () => {
    const res = await request(`${API_ORIGIN}/api/subscription-usage`)
    return res.ok ? await res.json() : null
  })
}

/** Test seam: forget everything cached. */
export function resetLaunchForecastCache(): void {
  forecasts.clear()
  billing.clear()
}
