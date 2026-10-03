import { randomUUID } from 'node:crypto'
import { initialUsage, USAGE_PROVIDERS, type UsageProvider, type UsageSnapshot } from '../domain'
import { backoff, withFreshness } from '../application'
import type { UsageDependencies } from '../ports'
import { UsageError } from '../adapters/errors'
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
      if (!installed) { clear(id); rows.set(id, { ...rows.get(id)!, refreshState: 'idle', retryAt: new Date(now() + 30_000).toISOString(), issue: { code: 'cli-missing', retryable: false } }); return }
      if (deps.eligible && !await deps.eligible(id)) throw new UsageError('unsupported-cli')
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
      if (row.retryAt && Date.parse(row.retryAt) > now()) continue
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
  async function dispose() { disposed = true; controllers.forEach(c => c.abort()); await Promise.allSettled(running.values()) }
  return { snapshot, refresh, dispose, settled: () => Promise.allSettled(running.values()) }
}
export type UsageService = ReturnType<typeof createUsageService>
