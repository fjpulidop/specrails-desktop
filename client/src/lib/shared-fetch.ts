/**
 * In-flight sharing for idempotent GETs.
 *
 * The Board mounts one rail row per rail, and each row's selectors and runtime
 * card fetch the same project-scoped URLs (`/profiles?provider=…`, `/api/loops`,
 * `/rails`, `/agent-runtime/runs?railIndex=…`). Concurrent identical GETs now
 * share ONE network request; each caller receives its own `Response` clone.
 *
 * Nothing is cached after the request settles, so live refreshes (polling, WS
 * driven refetches) always reach the server. The key is the full URL — which
 * already carries the project id — so callers in different projects never share.
 * A caller's `signal` aborts only that caller's wait, never the shared request.
 */
const pending = new Map<string, Promise<Response>>()

export function sharedFetch(url: string, init: { cache?: RequestCache; signal?: AbortSignal } = {}): Promise<Response> {
  const { signal, cache } = init
  if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
  const key = `${cache ?? ''} ${url}`
  let request = pending.get(key)
  if (!request) {
    request = cache ? fetch(url, { cache }) : fetch(url)
    pending.set(key, request)
    const settled = request
    const clear = () => { if (pending.get(key) === settled) pending.delete(key) }
    settled.then(clear, clear)
  }
  // Hand every caller its own body stream; the shared original is never read.
  const response = request.then((r) => (typeof r.clone === 'function' ? r.clone() : r))
  if (!signal) return response
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    response.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** Test seam. */
export function _pendingSharedFetches(): number { return pending.size }
