/**
 * The reporting door every producer uses (Core session/runtime events, the
 * legacy Claude stream, the provider-limit classifier). Bound once to the
 * machine's quota store at composition; reports before binding, or in tests
 * that never bind, are dropped. Quota is account state, never project data.
 */
import { parseRateLimitReport, resolveResetText, type ProviderQuotaView, type QuotaSource } from '../domain'
import type { QuotaStore } from './quota-store'
import { realTimers } from './quota-store'
import { createResumeClock, type ResumeClock } from './resume-clock'

let store: QuotaStore | null = null
let clock: ResumeClock | null = null

/** The machine's wake-aware clock for limit resumes (created on first use when composition bound none). */
export function bindResumeClock(next: ResumeClock | null): void {
  clock?.dispose()
  clock = next
}

/** Run `fire` at `resumeAt` once the machine is settled awake (never during sleep or a dark wake). */
export function scheduleLimitResume(resumeAt: string, fire: () => void): { cancel(): void } {
  clock ??= createResumeClock(realTimers)
  const at = Date.parse(resumeAt)
  return clock.schedule(Number.isFinite(at) ? at : Date.now(), fire)
}

export function bindQuotaStore(next: QuotaStore | null): void {
  store = next
}

/** A typed report in Core's `RateLimitInfo` shape (validated here). Returns the parsed report. */
export function reportRateLimit(providerId: string, raw: unknown, source: QuotaSource, observedAt?: string): ReturnType<typeof parseRateLimitReport> {
  const report = parseRateLimitReport(raw)
  if (report && store) store.observe(providerId, report, source, observedAt)
  return report
}

/**
 * A refusal the provider stated only in prose. `reset` is an ISO time or the
 * provider's own words ("3am (Europe/Madrid)"); returns the resolved reset.
 */
export function reportProviderRefusal(providerId: string, reset: string | null, now = Date.now()): string | null {
  const resetsAt = resolveResetText(reset, now)
  store?.observeRefusal(providerId, resetsAt)
  return resetsAt
}

/** When a refused provider accepts requests again, from the store (null when unknown or not refused). */
export function quotaResumeAt(providerId: string): string | null {
  return store?.resumeAt(providerId) ?? null
}

export function quotaView(providerId: string): ProviderQuotaView | null {
  return store?.view(providerId) ?? null
}
