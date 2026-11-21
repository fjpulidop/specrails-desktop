/**
 * Quota escalations → attention events (category `budget`). Pure: given the
 * previous and current views, which providers just crossed into a worse level
 * (≥80 %, ≥90 %, refused). The same window episode is announced once: the key
 * carries the level and the window's reset.
 */
import type { ProviderQuota, QuotaLevel } from './types'

const RANK: Record<QuotaLevel, number> = { unknown: 0, ok: 0, warning: 1, critical: 2, rejected: 3 }

export interface QuotaEscalation { providerId: string; level: Exclude<QuotaLevel, 'unknown' | 'ok'>; key: string; quota: ProviderQuota }

export function quotaEscalations(previous: readonly ProviderQuota[], current: readonly ProviderQuota[]): QuotaEscalation[] {
  return current.flatMap((quota) => {
    if (RANK[quota.level] === 0) return []
    const before = previous.find((item) => item.providerId === quota.providerId)
    if (before && RANK[before.level] >= RANK[quota.level]) return []
    const window = quota.windows.find((item) => item.id === quota.windowId)
    const episode = quota.level === 'rejected' ? quota.rejectedUntil ?? 'open' : window?.resetsAt ?? 'open'
    return [{ providerId: quota.providerId, level: quota.level as QuotaEscalation['level'], key: `quota:${quota.providerId}:${quota.level}:${episode}`, quota }]
  })
}
