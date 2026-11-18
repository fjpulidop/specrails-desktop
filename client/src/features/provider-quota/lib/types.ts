/** Server `ProviderQuotaView` (server/modules/provider-quota/domain.ts). */
export type QuotaLevel = 'unknown' | 'ok' | 'warning' | 'critical' | 'rejected'

export interface QuotaWindow {
  id: string
  usedPercent: number | null
  resetsAt: string | null
  windowMinutes: number | null
  observedAt: string
  source: 'session' | 'runtime' | 'stream' | 'subscription'
}

export interface ProviderQuota {
  providerId: string
  level: QuotaLevel
  usedPercent: number | null
  windowId: string | null
  rejectedUntil: string | null
  rejectedIndefinitely: boolean
  windows: QuotaWindow[]
  observedAt: string | null
}

export const QUOTA_WARNING_PERCENT = 80
export const QUOTA_CRITICAL_PERCENT = 90

const LEVELS: ReadonlySet<string> = new Set(['unknown', 'ok', 'warning', 'critical', 'rejected'])
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const isoOrNull = (value: unknown): value is string | null => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)))

/** Tolerant parse of the server's list (unknown or malformed rows are dropped). */
export function parseProviderQuotas(raw: unknown): ProviderQuota[] {
  const providers = record(raw)?.providers
  if (!Array.isArray(providers)) return []
  return providers.flatMap((value) => {
    const row = record(value)
    if (!row || typeof row.providerId !== 'string' || !LEVELS.has(row.level as string) || !isoOrNull(row.rejectedUntil) || !isoOrNull(row.observedAt)) return []
    const windows = Array.isArray(row.windows) ? row.windows.flatMap((raw) => {
      const window = record(raw)
      if (!window || typeof window.id !== 'string' || !isoOrNull(window.resetsAt)) return []
      return [{ id: window.id, usedPercent: typeof window.usedPercent === 'number' ? window.usedPercent : null, resetsAt: window.resetsAt as string | null,
        windowMinutes: typeof window.windowMinutes === 'number' ? window.windowMinutes : null, observedAt: typeof window.observedAt === 'string' ? window.observedAt : '', source: (window.source as QuotaWindow['source']) ?? 'subscription' }]
    }) : []
    return [{ providerId: row.providerId, level: row.level as QuotaLevel, usedPercent: typeof row.usedPercent === 'number' ? row.usedPercent : null,
      windowId: typeof row.windowId === 'string' ? row.windowId : null, rejectedUntil: row.rejectedUntil as string | null,
      rejectedIndefinitely: row.rejectedIndefinitely === true, windows, observedAt: row.observedAt as string | null }]
  })
}

/** A level that deserves a warning before launching more work. */
export function quotaNeedsWarning(level: QuotaLevel): boolean {
  return level === 'warning' || level === 'critical' || level === 'rejected'
}

/** Engines billed against the same account share one quota (server `sharesQuota`). */
export function sharesQuota(a: string, b: string): boolean {
  return a === b
}
