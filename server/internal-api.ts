// Loopback client for the app's OWN REST API, authenticated with the master
// token held server-side. Precedent: the MCP domain tools (`apiCall`), which
// reuse every router's validation instead of re-implementing it. The milestone
// launch chain uses it to launch chunks through the ordinary rails launch
// route — the single authority for its ~15 guards — so a chunk launch behaves
// byte-identically to a dashboard launch and every 4xx becomes a typed reason.

import { loadOrGenerateToken } from './auth'

export type InternalApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface InternalApiResponse {
  ok: boolean
  status: number
  /** Parsed JSON body (or the raw text when not JSON; null when empty). */
  body: unknown
}

export interface InternalApi {
  /** `path` is appended after `/api` (e.g. `/projects/<id>/rails`). Never throws on 4xx/5xx. */
  call(method: InternalApiMethod, path: string, body?: unknown): Promise<InternalApiResponse>
}

export interface InternalApiDeps {
  port: number
  fetchImpl?: typeof fetch
  token?: () => string
}

export function createInternalApi(deps: InternalApiDeps): InternalApi {
  const fetchImpl = deps.fetchImpl ?? fetch
  const token = deps.token ?? loadOrGenerateToken
  return {
    async call(method, path, body) {
      const res = await fetchImpl(`http://127.0.0.1:${deps.port}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token()}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const text = await res.text()
      let data: unknown
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = text
      }
      return { ok: res.ok, status: res.status, body: data }
    },
  }
}

/** Extract the router's `{ error, detail }` from a failed response body. */
export function internalApiError(res: InternalApiResponse): { error: string; detail?: string } {
  const body = res.body
  if (body && typeof body === 'object') {
    const obj = body as { error?: unknown; detail?: unknown }
    return {
      error: typeof obj.error === 'string' ? obj.error : `http_${res.status}`,
      ...(typeof obj.detail === 'string' ? { detail: obj.detail } : {}),
    }
  }
  return { error: `http_${res.status}`, ...(typeof body === 'string' && body ? { detail: body.slice(0, 200) } : {}) }
}
