/** Recoverable authentication for the local desktop API and WebSocket. */
import { API_ORIGIN } from './origin'

let _token: string | null = null
let _rawFetch: typeof fetch | null = null
let _refresh: Promise<boolean> | null = null
let _installed = false

function waitForRetry(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

/** One bounded token read shared by concurrent API failures and reconnects.
 * Uses the original fetch so authentication recovery never intercepts itself. */
export function refreshDesktopToken(): Promise<boolean> {
  if (_refresh) return _refresh
  _refresh = (async () => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const fetchToken = _rawFetch ?? window.fetch.bind(window)
      const res = await fetchToken(`${API_ORIGIN}/api/token`, { signal: controller.signal })
      if (!res.ok) return false
      const data = await res.json() as { token?: unknown }
      if (typeof data.token !== 'string' || !data.token.trim()) return false
      _token = data.token
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  })().finally(() => { _refresh = null })
  return _refresh
}

/** Keep the initial splash brief. A slower sidecar can still recover through
 * API 401 handling and authenticated WebSocket reconnection after mounting. */
export async function initAuth(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (await refreshDesktopToken()) return
    if (i < 19) await new Promise((resolve) => setTimeout(resolve, 300))
  }
}

export function getDesktopToken(): string | null { return _token }
export function getDesktopTokenProtocol(): string | undefined {
  return _token ? `desktop-token.${_token}` : undefined
}

/** Rewrite desktop API paths and authenticate only the exact API origin.
 * A rejected token is refreshed once, then the request is replayed once. The
 * server rejects authentication before executing an API mutation. */
export function installFetchInterceptor(): void {
  if (_installed) return
  _installed = true
  const origFetch = window.fetch.bind(window)
  _rawFetch = origFetch
  const apiOrigin = API_ORIGIN || window.location.origin

  window.fetch = async function (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const source = input instanceof Request ? input : null
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let target: URL
    try { target = new URL(rawUrl, apiOrigin) } catch { return origFetch(input, init) }
    const isApi = target.origin === apiOrigin && (target.pathname === '/api' || target.pathname.startsWith('/api/'))
    if (!isApi) return origFetch(input, init)

    // Keep Request method/body/headers/signal when rewriting its URL in Tauri.
    if (API_ORIGIN && rawUrl.startsWith('/') && !rawUrl.startsWith('//')) {
      input = source ? new Request(target.href, source) : target.href
    }
    const headers = new Headers(init.headers ?? source?.headers)
    const callerToken = headers.has('X-Desktop-Token')
    const sentToken = _token
    if (!callerToken && sentToken) headers.set('X-Desktop-Token', sentToken)
    const retryInput = input instanceof Request ? input.clone() : input
    const replay = () => origFetch(retryInput instanceof Request ? retryInput.clone() : retryInput, { ...init, headers })
    const signal = init.signal ?? source?.signal
    let res = await origFetch(input, { ...init, headers })
    if (res.status === 401 && !callerToken && target.pathname !== '/api/token' && !signal?.aborted) {
      // Another request may already have repaired this generation's token.
      if (_token === sentToken && !(await refreshDesktopToken())) return res
      if (!_token || _token === sentToken) return res
      headers.set('X-Desktop-Token', _token)
      res = await replay()
    }

    // Registry recovery may briefly expose a known project before SQLite is
    // available. Retry only reads, for at most ten seconds of waiting. Never
    // turn an unsuccessful launch/edit click into a delayed mutation.
    const method = (init.method ?? source?.method ?? 'GET').toUpperCase()
    let waited = 0
    for (let attempt = 0; attempt < 5 && res.status === 503 && (method === 'GET' || method === 'HEAD'); attempt++) {
      let unavailable = false
      try { unavailable = (await res.clone().json() as { error?: string }).error === 'project_unavailable' } catch { /* unrelated failure */ }
      if (!unavailable) break
      const retryAfter = Number(res.headers.get('Retry-After') ?? 2)
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000
      if (waited + delay > 10000) break
      await waitForRetry(delay, signal)
      waited += delay
      res = await replay()
    }
    return res
  }
}
