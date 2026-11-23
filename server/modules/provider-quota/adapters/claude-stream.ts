/**
 * Claude Code `stream-json` usage-limit frames → Core's `RateLimitInfo` shape,
 * for the turns Desktop spawns itself (legacy chat/job transport). Mirrors
 * Core's normalization (contract 5.14) so every source speaks one shape.
 */
import type { RateLimitReport, RateLimitStatus } from '../domain'

const STATUSES: ReadonlySet<string> = new Set(['allowed', 'allowed_warning', 'rejected'])
const WINDOW_MINUTES: Readonly<Record<string, number>> = { five_hour: 300, seven_day: 10_080 }

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const status = (value: unknown): RateLimitStatus | null => typeof value === 'string' && STATUSES.has(value) ? value as RateLimitStatus : null
const fraction = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
const iso = (value: unknown): string | null => {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? new Date(ms).toISOString() : null
}

/** One stream frame; null unless it is a well-formed `rate_limit_event`. */
export function claudeFrameRateLimit(frame: unknown): RateLimitReport | null {
  const value = record(frame)
  if (value?.type !== 'rate_limit_event') return null
  const info = record(value.rate_limit_info)
  const state = status(info?.status)
  if (!info || !state) return null
  const windows: RateLimitReport['windows'] = {}
  for (const [id, raw] of Object.entries(record(info.unifiedWindows) ?? {}).slice(0, 16)) {
    const window = record(raw)
    if (!window) continue
    windows[id] = { utilization: fraction(window.utilization), resetsAt: iso(window.resetsAt), ...(WINDOW_MINUTES[id] ? { windowMinutes: WINDOW_MINUTES[id] } : {}) }
  }
  const type = typeof info.rateLimitType === 'string' && info.rateLimitType ? info.rateLimitType.slice(0, 64) : null
  const overageStatus = status(info.overageStatus)
  const inUse = info.isUsingOverage === true || info.overageInUse === true
  return {
    status: state,
    rateLimitType: type,
    resetsAt: iso(info.resetsAt) ?? (type ? windows[type]?.resetsAt ?? null : null),
    utilization: fraction(info.utilization) ?? (type ? windows[type]?.utilization ?? null : null),
    windows,
    overage: overageStatus !== null || inUse || info.overageDisabledReason !== undefined
      ? { status: overageStatus, inUse, disabledReason: typeof info.overageDisabledReason === 'string' ? info.overageDisabledReason.slice(0, 64) : null, resetsAt: iso(info.overageResetsAt) }
      : null,
  }
}
