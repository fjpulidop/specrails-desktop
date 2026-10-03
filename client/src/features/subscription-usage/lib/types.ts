export interface UsageWindow {
  id: string; label: string; scope: 'account' | 'model'; model: string | null
  usedPercent: number | null; durationMinutes: number | null; resetsAt: string | null
}
export interface EnterpriseSpend {
  kind: 'enterprise-on-demand'
  usedAmount: number | null; limitAmount: number | null
  limitStatus: 'limited' | 'unlimited' | 'unknown'
  currency: string; usedPercent: number | null; resetsAt: string | null
}
export interface ProviderUsage {
  providerId: 'claude' | 'codex'; installed: boolean | null; generation: string
  availability: 'available' | 'signed-out' | 'unsupported-auth' | 'unsupported-cli' | 'unsupported-platform' | 'unavailable'
  refreshState: 'idle' | 'refreshing' | 'error'; freshness: 'unknown' | 'fresh' | 'stale'
  plan: string | null; windows: UsageWindow[]; source: 'oauth' | 'app-server' | null
  spend?: EnterpriseSpend | null
  observedAt: string | null; attemptedAt: string | null; retryAt: string | null
  issue: { code: string; retryable: boolean } | null
}
export interface UsageSnapshot { scope: 'machine'; instanceId: string; revision: number; providers: ProviderUsage[] }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const date = (value: unknown): boolean => value === null || typeof value === 'string' && Number.isFinite(Date.parse(value))
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string'
export function isUsageSnapshot(value: unknown): value is UsageSnapshot {
  const data = object(value)
  if (data.scope !== 'machine' || typeof data.instanceId !== 'string' || !data.instanceId || !Number.isSafeInteger(data.revision) || (data.revision as number) < 0 || !Array.isArray(data.providers) || data.providers.length !== 2) return false
  const ids = new Set<string>()
  for (const raw of data.providers) {
    const p = object(raw)
    if (!['claude', 'codex'].includes(p.providerId as string) || ids.has(p.providerId as string)) return false
    ids.add(p.providerId as string)
    if (typeof p.generation !== 'string' || !(p.installed === null || typeof p.installed === 'boolean') || !nullableString(p.plan)
      || !['available', 'signed-out', 'unsupported-auth', 'unsupported-cli', 'unsupported-platform', 'unavailable'].includes(p.availability as string)
      || !['idle', 'refreshing', 'error'].includes(p.refreshState as string) || !['unknown', 'fresh', 'stale'].includes(p.freshness as string)
      || !(p.source === null || p.source === 'oauth' || p.source === 'app-server') || !date(p.observedAt) || !date(p.attemptedAt) || !date(p.retryAt)
      || !Array.isArray(p.windows) || p.windows.length > 64) return false
    if (p.issue !== null) { const issue = object(p.issue); if (typeof issue.code !== 'string' || typeof issue.retryable !== 'boolean') return false }
    if (p.spend != null) {
      const spend = object(p.spend)
      const amount = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0
      if (p.providerId !== 'claude' || p.plan !== 'enterprise' || spend.kind !== 'enterprise-on-demand'
        || !amount(spend.usedAmount) || !amount(spend.limitAmount) || !amount(spend.usedPercent)
        || spend.usedAmount === null && spend.limitAmount === null || !date(spend.resetsAt)
        || typeof spend.currency !== 'string' || !/^[A-Z]{3}$/.test(spend.currency)
        || !['limited', 'unlimited', 'unknown'].includes(spend.limitStatus as string)
        || (spend.limitStatus === 'limited') !== (spend.limitAmount !== null)
        || spend.limitStatus !== 'limited' && spend.usedPercent !== null
        || p.windows.some(raw => { const window = object(raw); return window.usedPercent !== null || window.resetsAt !== null })) return false
    }
    for (const rawWindow of p.windows) {
      const w = object(rawWindow)
      if (typeof w.id !== 'string' || typeof w.label !== 'string' || !nullableString(w.model) || !['account', 'model'].includes(w.scope as string)
        || !(w.usedPercent === null || typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100)
        || !(w.durationMinutes === null || typeof w.durationMinutes === 'number' && Number.isFinite(w.durationMinutes) && w.durationMinutes > 0) || !date(w.resetsAt)) return false
    }
  }
  return true
}
