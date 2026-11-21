import type { QuotaWindow } from './domain'

/** Where the store keeps the refusals that must survive a restart (one small JSON value). */
export interface QuotaPersistence {
  load(): string | undefined
  save(value: string): void
}

/** The subscription-usage reader, seen through what the quota store needs from it. */
export interface UsageFeed {
  /** Latest machine snapshot (cached; never probes). */
  snapshot(): { providers: Array<{ providerId: string; availability: string; observedAt: string | null; windows: Array<{ id: string; usedPercent: number | null; resetsAt: string | null; durationMinutes: number | null }> }> }
  /** Hand fresher run-observed windows to the usage rows (feeds the subscription-usage UI live). */
  observe(providerId: string, windows: QuotaWindow[], observedAt: string): void
}

export interface QuotaTimers {
  now(): number
  setTimeout(callback: () => void, ms: number): { cancel(): void }
}
