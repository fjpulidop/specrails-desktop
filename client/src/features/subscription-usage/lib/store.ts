import { API_ORIGIN } from '../../../lib/origin'
import { isUsageSnapshot, type UsageSnapshot } from './types'
export interface UsageState { snapshot: UsageSnapshot | null; error: boolean; busy: boolean }
export function createUsageStore(request: typeof fetch = (...args) => fetch(...args)) {
  let state: UsageState = { snapshot: null, error: false, busy: false }
  const listeners = new Set<() => void>()
  const retiredInstances = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined, controller: AbortController | undefined
  let nextRefresh = 0, refreshStarted = 0, epoch = 0
  const publish = (next: UsageState) => { state = next; listeners.forEach(fn => fn()) }
  const accept = (snapshot: unknown) => {
    if (!isUsageSnapshot(snapshot)) throw new Error('Invalid usage snapshot')
    if (retiredInstances.has(snapshot.instanceId)) return
    const replaced = !!state.snapshot && snapshot.instanceId !== state.snapshot.instanceId
    if (replaced) { retiredInstances.add(state.snapshot!.instanceId); nextRefresh = 0 }
    if (!state.snapshot || replaced || snapshot.revision >= state.snapshot.revision) publish({ ...state, snapshot, error: false })
  }
  const visible = () => listeners.size > 0 && document.visibilityState !== 'hidden'
  function schedule(delay: number) {
    clearTimeout(timer)
    if (visible()) timer = setTimeout(() => { void poll() }, delay)
  }
  async function refresh(providerId?: 'claude' | 'codex', automatic = false) {
    if (state.busy || !visible()) return
    publish({ ...state, busy: true })
    const current = epoch
    const local = new AbortController()
    controller?.abort(); controller = local
    try {
      const response = await request(`${API_ORIGIN}/api/subscription-usage/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(providerId ? { providerId } : {}), automatic }), signal: AbortSignal.any([local.signal, AbortSignal.timeout(30_000)]) })
      if (!response.ok) throw new Error('Usage refresh failed')
      const payload = await response.json() as { snapshot?: unknown; scheduled?: unknown }
      if (current !== epoch || local.signal.aborted) return
      accept(payload.snapshot)
      refreshStarted = Date.now()
      nextRefresh = Date.now() + 120_000
      schedule(payload.scheduled ? 1000 : 30_000)
    } catch {
      if (current === epoch && !local.signal.aborted) { publish({ ...state, error: true }); schedule(30_000) }
    } finally { if (current === epoch) publish({ ...state, busy: false }) }
  }
  async function poll() {
    if (!visible() || state.busy) return
    const current = epoch, local = new AbortController()
    controller?.abort(); controller = local
    try {
      const response = await request(`${API_ORIGIN}/api/subscription-usage`, { signal: AbortSignal.any([local.signal, AbortSignal.timeout(10_000)]) })
      if (!response.ok) throw new Error('Usage read failed')
      const data: unknown = await response.json()
      if (current !== epoch || local.signal.aborted) return
      accept(data)
      const refreshing = state.snapshot?.providers.some(p => p.refreshState === 'refreshing')
      if (refreshing) {
        if (!refreshStarted) refreshStarted = Date.now()
        if (Date.now() - refreshStarted < 30_000) { schedule(1000); return }
        publish({ ...state, error: true })
        schedule(30_000); return
      }
      refreshStarted = 0
      if (Date.now() >= nextRefresh) { await refresh(undefined, true); return }
      schedule(30_000)
    } catch {
      if (current === epoch && !local.signal.aborted) { publish({ ...state, error: true }); schedule(30_000) }
    }
  }
  function visibility() {
    epoch++; controller?.abort(); clearTimeout(timer)
    publish({ ...state, busy: false })
    if (visible()) { nextRefresh = 0; void poll() }
  }
  function subscribe(listener: () => void) {
    listeners.add(listener)
    if (listeners.size === 1) { document.addEventListener('visibilitychange', visibility); void poll() }
    return () => {
      listeners.delete(listener)
      if (!listeners.size) {
        epoch++; controller?.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility)
        state = { ...state, busy: false }
      }
    }
  }
  return { subscribe, getSnapshot: () => state, refresh }
}
export const usageStore = createUsageStore()
