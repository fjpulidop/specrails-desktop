import { randomUUID } from 'node:crypto'
import { initialUsage, providerBilling, USAGE_PROVIDERS, windowLabel, type ProviderBilling, type UsageProvider, type UsageSnapshot } from '../domain'
import { backoff, withFreshness } from '../application'
import type { UsageDependencies } from '../ports'
import { UsageError } from '../adapters/errors'
/** How soon a missing CLI is looked for again (detection itself is cached for a minute). */
export const CLI_MISSING_RETRY_MS = 60_000
export function createUsageService(deps: UsageDependencies) {
  const now = deps.now ?? Date.now
  const instanceId = randomUUID()
  const rows = new Map(USAGE_PROVIDERS.map(id => [id, initialUsage(id, randomUUID())]))
  const contexts = new Map<UsageProvider, string>(), identities = new Map<UsageProvider, string>()
  const failures = new Map<UsageProvider, number>(), running = new Map<UsageProvider, Promise<void>>()
  const controllers = new Map<UsageProvider, AbortController>()
  let revision = 0, disposed = false
  function snapshot(): UsageSnapshot { return { scope: 'machine', instanceId, revision, providers: USAGE_PROVIDERS.map(id => withFreshness(rows.get(id)!, now())) } }
  function clear(id: UsageProvider) {
    const previous = rows.get(id)!
    rows.set(id, { ...initialUsage(id, randomUUID()), installed: previous.installed, attemptedAt: previous.attemptedAt, refreshState: previous.refreshState })
    identities.delete(id)
    revision++
  }
  async function collect(id: UsageProvider, signal: AbortSignal) {
    const reader = deps.readers[id]
    try {
      const installed = await deps.installed(id)
      if (signal.aborted) return
      rows.set(id, { ...rows.get(id)!, installed })
      // Retryable: the CLI can appear after launch (installed later, or found on a
      // PATH the first detection missed), so automatic reads keep checking at the
      // detection cache's pace instead of reporting "not detected" for the session.
      if (!installed) { clear(id); rows.set(id, { ...rows.get(id)!, refreshState: 'idle', retryAt: new Date(now() + CLI_MISSING_RETRY_MS).toISOString(), issue: { code: 'cli-missing', retryable: true } }); return }
      // Retryable too: a slow first `--version` (cold start on Windows) can report
      // the CLI as not executable once; the next detection usually succeeds.
      if (deps.eligible && !await deps.eligible(id)) throw new UsageError('unsupported-cli', true, CLI_MISSING_RETRY_MS)
      if (signal.aborted) return
      const before = await reader.context(signal)
      if (signal.aborted) return
      if (contexts.get(id) !== before) { clear(id); contexts.set(id, before) }
      const result = await reader.read(signal)
      const after = await reader.context(signal)
      if (signal.aborted) return
      if (before !== after) { clear(id); contexts.set(id, after); throw new UsageError('account-changed', true) }
      if (result.identity && identities.get(id) && identities.get(id) !== result.identity) clear(id)
      if (result.identity) identities.set(id, result.identity)
      const available = result.availability === 'available'
      if (!available) clear(id)
      rows.set(id, { ...rows.get(id)!, availability: result.availability, plan: result.plan, source: result.source, windows: available ? result.windows : [], spend: available ? result.spend ?? null : null,
        // Identity is internal: explicitly select fields instead of returning adapter metadata.
        providerId: id, installed: true, refreshState: 'idle', freshness: available ? 'fresh' : 'unknown',
        observedAt: available ? new Date(now()).toISOString() : null, retryAt: new Date(now() + 30_000).toISOString(),
        issue: available ? null : { code: result.availability, retryable: false } })
      failures.delete(id)
    } catch (error) {
      if (signal.aborted) return
      const issue = error instanceof UsageError ? error : new UsageError('collection-failed', true)
      const count = (failures.get(id) ?? 0) + 1
      failures.set(id, count)
      if (!issue.retryable) clear(id)
      const row = rows.get(id)!
      rows.set(id, { ...row, refreshState: 'error', availability: row.observedAt ? 'available' : (['signed-out', 'unsupported-cli', 'unsupported-platform', 'unsupported-auth'].includes(issue.code) ? issue.code as 'signed-out' | 'unsupported-cli' | 'unsupported-platform' | 'unsupported-auth' : 'unavailable'),
        issue: { code: issue.code, retryable: issue.retryable }, retryAt: new Date(now() + (issue.retryMs ?? backoff(count))).toISOString() })
    } finally { revision++ }
  }
  function refresh(providerId?: UsageProvider, automatic = false) {
    let scheduled = false
    if (!disposed) for (const id of providerId ? [providerId] : USAGE_PROVIDERS) {
      const row = rows.get(id)!
      if (running.has(id)) { scheduled = true; continue }
      // "Install a CLI, then refresh": a manual refresh looks for a missing CLI at once.
      const lookAgain = !automatic && (row.issue?.code === 'cli-missing' || row.issue?.code === 'unsupported-cli')
      if (!lookAgain && row.retryAt && Date.parse(row.retryAt) > now()) continue
      if (automatic && row.issue && !row.issue.retryable) continue
      const controller = new AbortController()
      controllers.set(id, controller)
      rows.set(id, { ...row, attemptedAt: new Date(now()).toISOString(), refreshState: 'refreshing' })
      revision++; scheduled = true
      const task = collect(id, controller.signal).finally(() => { running.delete(id); controllers.delete(id) })
      running.set(id, task)
    }
    const view = snapshot()
    return { snapshot: view, scheduled, retryAt: view.providers.filter(p => !providerId || p.providerId === providerId).map(p => p.retryAt).filter((s): s is string => !!s).sort()[0] ?? null }
  }
  /**
   * Windows a running turn just reported (provider-quota: typed usage-limit
   * reports). Merged into an AVAILABLE row only — a report never signs an
   * account in — and only when fresher than what the reader saw. No probe:
   * the subscription UI updates without another poll of the provider.
   */
  function observe(providerId: string, windows: Array<{ id: string; usedPercent: number | null; resetsAt: string | null; windowMinutes: number | null }>, observedAt: string) {
    if (disposed || !(USAGE_PROVIDERS as readonly string[]).includes(providerId)) return
    const id = providerId as UsageProvider
    const row = rows.get(id)!
    // A turn of this provider just ran, so its CLI exists: a row that says
    // otherwise (not detected, unavailable) is out of date. Re-read it now
    // rather than merging, so the status bar and Settings never disagree.
    if (row.availability !== 'available' && !row.spend) {
      const attempted = row.attemptedAt ? Date.parse(row.attemptedAt) : 0
      if (!running.has(id) && now() - attempted >= CLI_MISSING_RETRY_MS) { rows.set(id, { ...row, retryAt: null }); refresh(id, true) }
      return
    }
    if (row.spend || !Number.isFinite(Date.parse(observedAt))) return
    if (row.observedAt && Date.parse(row.observedAt) > Date.parse(observedAt)) return
    let changed = false
    const merged = row.windows.map(window => {
      const seen = windows.find(candidate => candidate.id === window.id)
      if (!seen || (seen.usedPercent === null && seen.resetsAt === null)) return window
      const usedPercent = seen.usedPercent === null ? window.usedPercent : Math.min(100, Math.max(0, seen.usedPercent))
      const resetsAt = seen.resetsAt ?? window.resetsAt
      if (usedPercent === window.usedPercent && resetsAt === window.resetsAt) return window
      changed = true
      return { ...window, usedPercent, resetsAt }
    })
    for (const seen of windows) {
      if (merged.some(window => window.id === seen.id) || seen.usedPercent === null || merged.length >= 64) continue
      const minutes = seen.windowMinutes
      const model = seen.id.startsWith('seven_day_') ? seen.id.slice(10) : null
      merged.push({ id: seen.id, label: windowLabel(minutes), scope: model ? 'model' : 'account', model, usedPercent: Math.min(100, Math.max(0, seen.usedPercent)), durationMinutes: minutes, resetsAt: seen.resetsAt })
      changed = true
    }
    if (!changed) return
    rows.set(id, { ...row, windows: merged, observedAt, freshness: 'fresh' })
    revision++
    try { deps.onChange?.() } catch { /* advisory */ }
  }
  async function dispose() { disposed = true; controllers.forEach(c => c.abort()); await Promise.allSettled(running.values()) }
  /** How `providerId`'s turns are paid, from the last observation (never probes). */
  function billing(providerId: string, env: Record<string, string | undefined> = process.env): ProviderBilling {
    const result = providerBilling(snapshot(), providerId, env)
    // Not observed yet: start an automatic read so the next ask knows.
    if (result.billing === 'unknown' && (USAGE_PROVIDERS as readonly string[]).includes(providerId)) refresh(providerId as UsageProvider, true)
    return result
  }
  /** Like `billing`, but when the provider was never observed it waits (bounded)
   * for the read it starts, so a card posted right after startup is not left unknown. */
  async function resolveBilling(providerId: string, timeoutMs = 8_000, env: Record<string, string | undefined> = process.env): Promise<ProviderBilling> {
    const first = billing(providerId, env)
    const task = running.get(providerId as UsageProvider)
    if (first.billing !== 'unknown' || !task) return first
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([task, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })]).catch(() => {})
    if (timer) clearTimeout(timer)
    return providerBilling(snapshot(), providerId, env)
  }
  return { snapshot, refresh, observe, dispose, billing, resolveBilling, settled: () => Promise.allSettled(running.values()) }
}
export type UsageService = ReturnType<typeof createUsageService>
