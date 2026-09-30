import type { ProviderUsage } from './domain'
export function withFreshness(row: ProviderUsage, now: number): ProviderUsage {
  if (!row.observedAt) return { ...row, freshness: 'unknown' }
  const expired = now - Date.parse(row.observedAt) >= 300_000 || row.windows.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now)
  return { ...row, freshness: expired || row.refreshState === 'error' ? 'stale' : 'fresh' }
}
export function backoff(failures: number): number { return Math.min(300_000, 30_000 * 2 ** Math.min(4, Math.max(0, failures - 1))) }
