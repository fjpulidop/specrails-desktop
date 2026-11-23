/**
 * The client's copy of the machine's provider quota: read once, then kept
 * live by the server's `provider_quota.updated` pushes (no polling).
 */
import { API_ORIGIN } from '../../../lib/origin'
import { parseProviderQuotas, type ProviderQuota } from './types'

export interface QuotaState { providers: ProviderQuota[]; loaded: boolean }

export function createQuotaStore(request: typeof fetch = (...args) => fetch(...args)) {
  let state: QuotaState = { providers: [], loaded: false }
  const listeners = new Set<() => void>()
  let loading: Promise<void> | null = null
  const publish = (next: QuotaState) => { state = next; listeners.forEach((listener) => listener()) }

  function load(): Promise<void> {
    loading ??= (async () => {
      try {
        const response = await request(`${API_ORIGIN}/api/provider-quota`, { signal: AbortSignal.timeout(10_000) })
        if (response.ok) publish({ providers: parseProviderQuotas(await response.json()), loaded: true })
      } catch { /* the next push or open retries */ } finally { loading = null }
    })()
    return loading
  }

  /** A server push (`provider_quota.updated`). */
  function accept(raw: unknown): void {
    publish({ providers: parseProviderQuotas(raw), loaded: true })
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (!state.loaded && listeners.size === 1) void load()
    return () => { listeners.delete(listener) }
  }

  return { subscribe, getSnapshot: () => state, accept, load }
}

export const quotaStore = createQuotaStore()
