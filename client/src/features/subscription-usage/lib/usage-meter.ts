/**
 * One reading of "how much of my plan is used" per provider, shared by the
 * status bar and Settings ▸ Subscription usage so the two never disagree.
 *
 * The source is the machine usage snapshot (which already merges what running
 * turns report) plus the provider-quota refusal: a provider that refused a
 * turn reads as `rejected` until its limit lifts. No reading → no meter.
 */
import type { ProviderQuota } from '../../provider-quota/lib/types'
import { QUOTA_CRITICAL_PERCENT, QUOTA_WARNING_PERCENT } from '../../provider-quota/lib/types'
import type { ProviderUsage, UsageSnapshot } from './types'

export type MeterLevel = 'ok' | 'warning' | 'critical' | 'rejected'

export interface UsageMeter {
  providerId: ProviderUsage['providerId']
  /** Fullest account window (or enterprise spend), 0–100; null only when `rejected` without a figure. */
  percent: number | null
  /** The figure is enterprise on-demand spend, not a plan window. */
  spend: boolean
  level: MeterLevel
  rejectedUntil: string | null
}

export const providerName = (providerId: string): string => providerId === 'claude' ? 'Claude' : providerId === 'codex' ? 'Codex' : providerId

function fullestPercent(provider: ProviderUsage): number | null {
  if (provider.spend) return provider.spend.usedPercent
  const values = provider.windows
    .filter((window) => window.scope === 'account')
    .map((window) => window.usedPercent)
    .filter((value): value is number => value !== null)
  // Model-scoped windows count only when the account has none.
  const pool = values.length ? values : provider.windows.map((window) => window.usedPercent).filter((value): value is number => value !== null)
  return pool.length ? Math.max(...pool) : null
}

export function levelOf(percent: number): Exclude<MeterLevel, 'rejected'> {
  return percent >= QUOTA_CRITICAL_PERCENT ? 'critical' : percent >= QUOTA_WARNING_PERCENT ? 'warning' : 'ok'
}

/** Every provider with something to show, in snapshot order. */
export function usageMeters(snapshot: UsageSnapshot | null, quotas: readonly ProviderQuota[]): UsageMeter[] {
  if (!snapshot) return []
  return snapshot.providers.flatMap((provider): UsageMeter[] => {
    const quota = quotas.find((entry) => entry.providerId === provider.providerId)
    const percent = fullestPercent(provider)
    if (quota?.level === 'rejected') {
      return [{ providerId: provider.providerId, percent, spend: !!provider.spend, level: 'rejected', rejectedUntil: quota.rejectedUntil }]
    }
    if (percent === null) return []
    return [{ providerId: provider.providerId, percent, spend: !!provider.spend, level: levelOf(percent), rejectedUntil: null }]
  })
}

const RANK: Record<MeterLevel, number> = { ok: 0, warning: 1, critical: 2, rejected: 3 }

/** The most-loaded provider: a refusal first, then the highest figure. */
export function busiestMeter(meters: readonly UsageMeter[]): UsageMeter | null {
  let best: UsageMeter | null = null
  for (const meter of meters) {
    if (!best || RANK[meter.level] > RANK[best.level] || (RANK[meter.level] === RANK[best.level] && (meter.percent ?? -1) > (best.percent ?? -1))) best = meter
  }
  return best
}
