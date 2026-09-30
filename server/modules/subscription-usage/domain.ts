export const USAGE_PROVIDERS = ['claude', 'codex'] as const
export type UsageProvider = typeof USAGE_PROVIDERS[number]
export interface UsageWindow {
  id: string
  label: string
  scope: 'account' | 'model'
  model: string | null
  usedPercent: number | null
  durationMinutes: number | null
  resetsAt: string | null
}
export type Availability = 'available' | 'signed-out' | 'unsupported-auth' | 'unsupported-cli' | 'unsupported-platform' | 'unavailable'
export interface ProviderUsage {
  providerId: UsageProvider
  installed: boolean | null
  generation: string
  availability: Availability
  refreshState: 'idle' | 'refreshing' | 'error'
  freshness: 'unknown' | 'fresh' | 'stale'
  plan: string | null
  windows: UsageWindow[]
  source: 'oauth' | 'app-server' | null
  observedAt: string | null
  attemptedAt: string | null
  retryAt: string | null
  issue: { code: string; retryable: boolean } | null
}
export interface UsageSnapshot { scope: 'machine'; instanceId: string; revision: number; providers: ProviderUsage[] }
export const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const percentage = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null
export const duration = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
export function timestamp(value: unknown, seconds = false): string | null {
  const time = typeof value === 'number' && Number.isFinite(value) ? value * (seconds ? 1000 : 1) : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) && time > 0 && time <= 8.64e15 ? new Date(time).toISOString() : null
}
export function windowLabel(minutes: number | null): string {
  return minutes === 300 ? 'session' : minutes === 10080 ? 'weekly' : minutes === 43200 ? 'monthly' : 'window'
}
export function normalizeClaude(payload: unknown): UsageWindow[] {
  const data = record(payload)
  const windows: UsageWindow[] = []
  for (const [key, raw] of Object.entries(data)) {
    if (!/^(five_hour|seven_day(?:_[a-z0-9_]+)?|fable_(weekly|seven_day))$/.test(key) || raw === null) continue
    const value = record(raw)
    if (!['utilization', 'used_percentage', 'resets_at'].some(field => Object.hasOwn(value, field))) continue
    const minutes = key === 'five_hour' ? 300 : 10080
    const model = key.startsWith('seven_day_') ? key.slice(10) : key.startsWith('fable_') ? 'fable' : null
    windows.push({ id: key, label: windowLabel(minutes), scope: model ? 'model' : 'account', model,
      usedPercent: percentage(value.utilization ?? value.used_percentage), durationMinutes: minutes, resetsAt: timestamp(value.resets_at, typeof value.resets_at === 'number') })
  }
  if (Array.isArray(data.limits)) for (const raw of data.limits.slice(0, 32)) {
    const value = record(raw), model = record(record(value.scope).model).display_name
    if (value.kind !== 'weekly_scoped' || typeof model !== 'string' || !model.trim()) continue
    const name = model.trim().slice(0, 80)
    if (windows.some(w => w.model?.toLowerCase() === name.toLowerCase())) continue
    windows.push({ id: `model:${name}`, label: 'weekly', scope: 'model', model: name,
      usedPercent: percentage(value.percent), durationMinutes: 10080, resetsAt: timestamp(value.resets_at, true) })
  }
  return windows
}
export function normalizeCodex(payload: unknown): UsageWindow[] {
  const data = record(payload), groups = record(data.rateLimitsByLimitId)
  const entries = Object.keys(groups).length ? Object.entries(groups) : [['codex', data.rateLimits]] as [string, unknown][]
  const windows: UsageWindow[] = []
  for (const [group, raw] of entries.slice(0, 32)) {
    const bucket = record(raw)
    for (const slot of ['primary', 'secondary']) {
      if (!bucket[slot] || typeof bucket[slot] !== 'object') continue
      const value = record(bucket[slot]), minutes = duration(value.windowDurationMins)
      windows.push({ id: `${group}:${slot}`, label: windowLabel(minutes), scope: group === 'codex' ? 'account' : 'model',
        model: group === 'codex' ? null : (typeof bucket.limitName === 'string' ? bucket.limitName : group).slice(0, 80),
        usedPercent: percentage(value.usedPercent), durationMinutes: minutes, resetsAt: timestamp(value.resetsAt, true) })
    }
  }
  return windows
}
export function initialUsage(providerId: UsageProvider, generation: string): ProviderUsage {
  return { providerId, installed: null, generation, availability: 'unavailable', refreshState: 'idle', freshness: 'unknown', plan: null,
    windows: [], source: null, observedAt: null, attemptedAt: null, retryAt: null, issue: null }
}
