/**
 * The one machine-wide store of each provider account's latest quota.
 *
 * Fed by typed usage-limit reports (Core sessions, Core runtime runs,
 * Desktop's own Claude stream), by prose refusals the provider-limit
 * classifier recognises, and by the subscription-usage reader. Quota is
 * account state, not project data: every project sees the same windows.
 *
 * Persistence: only the refusals (window → reset) are written, as one small
 * `desktop_settings` value and only when that set changes. They are what a
 * restart must not forget (launching N rails into a refusing account), while
 * utilization is re-read by the subscription reader and the next run anyway.
 */
import {
  applyRefusal,
  applyReport,
  applyUsageWindows,
  emptyQuota,
  expireQuota,
  nextExpiry,
  presentQuota,
  type ProviderQuotaState,
  type ProviderQuotaView,
  type QuotaSource,
  type RateLimitReport,
} from '../domain'
import type { QuotaPersistence, QuotaTimers, UsageFeed } from '../ports'

/** The providers the quota surfaces always list (others appear once observed). */
export const LISTED_PROVIDERS = ['claude', 'codex'] as const
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** Coalesce bursts of per-request reports into one broadcast. */
const NOTIFY_DELAY_MS = 250
const MAX_TIMER_MS = 2_147_000_000

interface PersistedQuota { version: 1; providers: Record<string, { rejected: Record<string, string | null>; observedAt: string | null }> }

export interface QuotaStoreDeps {
  timers: QuotaTimers
  persistence?: QuotaPersistence
  usage?: UsageFeed
  /** Called (coalesced) after the views change. */
  onChange?: (views: ProviderQuotaView[]) => void
}

export function createQuotaStore(deps: QuotaStoreDeps) {
  const { timers } = deps
  const states = new Map<string, ProviderQuotaState>()
  let persisted = ''
  let notifyTimer: { cancel(): void } | null = null
  let expiryTimer: { cancel(): void } | null = null
  let disposed = false

  // Restore refusals that outlived the previous process (expired ones fall away on read).
  try {
    const raw = deps.persistence?.load()
    if (raw) {
      const data = JSON.parse(raw) as PersistedQuota
      if (data?.version === 1 && data.providers && typeof data.providers === 'object') {
        for (const [id, entry] of Object.entries(data.providers)) {
          if (!PROVIDER_ID.test(id) || !entry || typeof entry !== 'object') continue
          const rejected: Record<string, string | null> = {}
          for (const [windowId, resetsAt] of Object.entries(entry.rejected ?? {})) {
            if (resetsAt === null || (typeof resetsAt === 'string' && Number.isFinite(Date.parse(resetsAt)))) rejected[windowId] = resetsAt
          }
          states.set(id, expireQuota({ ...emptyQuota(id), rejected, status: Object.keys(rejected).length ? 'rejected' : null, observedAt: typeof entry.observedAt === 'string' ? entry.observedAt : null }, timers.now()))
        }
        persisted = serialize()
      }
    }
  } catch { /* unreadable persisted quota is treated as none */ }
  armExpiry()

  function state(providerId: string): ProviderQuotaState {
    return states.get(providerId) ?? emptyQuota(providerId)
  }

  function serialize(): string {
    const providers: PersistedQuota['providers'] = {}
    for (const [id, value] of states) if (Object.keys(value.rejected).length) providers[id] = { rejected: value.rejected, observedAt: value.observedAt }
    return JSON.stringify({ version: 1, providers } satisfies PersistedQuota)
  }

  function persist(): void {
    if (!deps.persistence) return
    const next = serialize()
    if (next === persisted) return
    persisted = next
    try { deps.persistence.save(next) } catch (error) { console.error('[provider-quota] could not persist refusals:', error) }
  }

  function scheduleNotify(): void {
    if (disposed || !deps.onChange || notifyTimer) return
    notifyTimer = timers.setTimeout(() => {
      notifyTimer = null
      try { deps.onChange?.(views()) } catch { /* listeners are advisory */ }
    }, NOTIFY_DELAY_MS)
  }

  /** Re-evaluate exactly when the next reset passes, so a lifted refusal is announced on time. */
  function armExpiry(): void {
    expiryTimer?.cancel()
    expiryTimer = null
    if (disposed) return
    const now = timers.now()
    const next = [...states.values()].map((value) => nextExpiry(value, now)).filter((time): time is number => time !== null)
    if (!next.length) return
    expiryTimer = timers.setTimeout(() => {
      expiryTimer = null
      const at = timers.now()
      for (const [id, value] of states) states.set(id, expireQuota(value, at))
      persist()
      scheduleNotify()
      armExpiry()
    }, Math.min(MAX_TIMER_MS, Math.max(0, Math.min(...next) - now) + 50))
  }

  function commit(providerId: string, next: ProviderQuotaState, previous: ProviderQuotaState): void {
    if (next === previous) return
    states.set(providerId, next)
    persist()
    scheduleNotify()
    armExpiry()
  }

  /** A typed usage-limit report (Core event or Desktop's stream parser). */
  function observe(providerId: string, report: RateLimitReport, source: QuotaSource, observedAt = new Date(timers.now()).toISOString()): void {
    if (disposed || !PROVIDER_ID.test(providerId)) return
    const previous = state(providerId)
    const next = applyReport(previous, report, observedAt, source)
    commit(providerId, next, previous)
    if (next !== previous && deps.usage) {
      const fresh = Object.values(next.windows).filter((window) => window.observedAt === observedAt && window.source !== 'subscription')
      if (fresh.length) try { deps.usage.observe(providerId, fresh, observedAt) } catch { /* the usage rows are a projection */ }
    }
  }

  /** A refusal known only from the provider's prose; `resetsAt` when the words pin a time. */
  function observeRefusal(providerId: string, resetsAt: string | null, observedAt = new Date(timers.now()).toISOString()): void {
    if (disposed || !PROVIDER_ID.test(providerId)) return
    const previous = state(providerId)
    commit(providerId, applyRefusal(previous, resetsAt, observedAt), previous)
  }

  /** Fold the subscription reader's latest windows in (fresher run reports win). */
  function syncUsage(): void {
    const snapshot = (() => { try { return deps.usage?.snapshot() } catch { return undefined } })()
    if (!snapshot) return
    for (const row of snapshot.providers) {
      if (row.availability !== 'available' || !row.observedAt || !PROVIDER_ID.test(row.providerId)) continue
      const previous = state(row.providerId)
      const next = applyUsageWindows(previous, row.windows, row.observedAt)
      if (next !== previous) states.set(row.providerId, next)
    }
  }

  function view(providerId: string): ProviderQuotaView {
    syncUsage()
    return presentQuota(state(providerId), timers.now())
  }

  function views(): ProviderQuotaView[] {
    syncUsage()
    const ids = new Set<string>([...LISTED_PROVIDERS, ...states.keys()])
    return [...ids].map((id) => presentQuota(state(id), timers.now()))
  }

  /** When a refused provider accepts requests again (null: not refused, or reset unknown). */
  function resumeAt(providerId: string): string | null {
    return view(providerId).rejectedUntil
  }

  function dispose(): void {
    disposed = true
    notifyTimer?.cancel(); notifyTimer = null
    expiryTimer?.cancel(); expiryTimer = null
  }

  return { observe, observeRefusal, view, views, resumeAt, dispose }
}

export type QuotaStore = ReturnType<typeof createQuotaStore>

export const realTimers: QuotaTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return { cancel: () => clearTimeout(handle) } },
}
