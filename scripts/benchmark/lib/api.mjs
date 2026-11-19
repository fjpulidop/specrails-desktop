// Minimal client for the isolated server's HTTP API (token from /api/token).

import { apiBase } from './isolation.mjs'

export function createApi(port, { timeoutMs = 90_000 } = {}) {
  const base = apiBase(port)
  let token = null
  async function auth() {
    if (!token) token = (await (await fetch(`${base}/api/token`)).json()).token
    return token
  }
  async function call(method, route, body, opts = {}) {
    const t0 = performance.now()
    const r = await fetch(`${base}/api${route}`, {
      method, signal: AbortSignal.timeout(opts.timeoutMs ?? timeoutMs),
      headers: { Authorization: `Bearer ${await auth()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const raw = await r.text()
    let data = raw
    try { data = raw ? JSON.parse(raw) : null } catch { /* text */ }
    return { status: r.status, data, ms: performance.now() - t0 }
  }
  return {
    base, call,
    get: (route, opts) => call('GET', route, undefined, opts),
    post: (route, body, opts) => call('POST', route, body ?? {}, opts),
    put: (route, body, opts) => call('PUT', route, body ?? {}, opts),
    patch: (route, body, opts) => call('PATCH', route, body ?? {}, opts),
    resetToken() { token = null },
  }
}
