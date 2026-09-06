import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// We need to re-import auth after each test to reset module-level state.
describe('auth', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })
  afterEach(() => { vi.useRealTimers() })

  describe('initAuth', () => {
    it('fetches /api/token and caches the token', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'test-token-abc' }),
      })

      const { initAuth, getDesktopToken } = await import('../auth')
      await initAuth()

      expect(global.fetch).toHaveBeenCalledWith('/api/token', expect.objectContaining({ signal: expect.any(AbortSignal) }))
      expect(getDesktopToken()).toBe('test-token-abc')
    })

    it('does not crash and leaves token null when fetch fails', async () => {
      vi.useFakeTimers()
      ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'))

      const { initAuth, getDesktopToken } = await import('../auth')
      const p = initAuth()
      await vi.runAllTimersAsync()
      await p
      expect(getDesktopToken()).toBeNull()
      vi.useRealTimers()
    })

    it('does not cache token when response is not ok', async () => {
      vi.useFakeTimers()
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        json: async () => ({}),
      })

      const { initAuth, getDesktopToken } = await import('../auth')
      const p = initAuth()
      await vi.runAllTimersAsync()
      await p
      expect(getDesktopToken()).toBeNull()
      vi.useRealTimers()
    })

    it('retries a malformed token response instead of finishing unauthenticated', async () => {
      vi.useFakeTimers()
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => ({}) })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'ready-token' }) })

      const { initAuth, getDesktopToken } = await import('../auth')
      const pending = initAuth()
      await vi.runAllTimersAsync()
      await pending
      expect(getDesktopToken()).toBe('ready-token')
      vi.useRealTimers()
    })
  })

  describe('getDesktopToken', () => {
    it('returns null before initAuth is called', async () => {
      const { getDesktopToken } = await import('../auth')
      expect(getDesktopToken()).toBeNull()
    })

    it('returns a WebSocket subprotocol when token is initialized', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'abc123' }),
      })
      const { initAuth, getDesktopTokenProtocol } = await import('../auth')
      await initAuth()
      expect(getDesktopTokenProtocol()).toBe('desktop-token.abc123')
    })
  })

  describe('installFetchInterceptor', () => {
    it('uses only the native IPv4 backend for token bootstrap and API auth, without replaying HTML200 or authenticating localhost', async () => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true })
      const rawFetch = vi.fn()
        .mockResolvedValueOnce(new Response('{"token":"fixture-token"}', { headers: { 'Content-Type': 'application/json' } }))
        .mockResolvedValueOnce(new Response('<!DOCTYPE html>', { headers: { 'Content-Type': 'text/html' } }))
        .mockResolvedValueOnce(new Response('<!DOCTYPE html>'))
      window.fetch = rawFetch
      try {
        const { refreshDesktopToken, installFetchInterceptor, getDesktopTokenProtocol } = await import('../auth')
        installFetchInterceptor()
        expect(await refreshDesktopToken()).toBe(true)
        expect(rawFetch.mock.calls[0][0]).toBe('http://127.0.0.1:4200/api/token')
        expect(getDesktopTokenProtocol()).toBe('desktop-token.fixture-token')
        expect((await window.fetch('/api/agent/conversations/c1/send', { method: 'POST', body: '{}' })).status).toBe(200)
        expect(rawFetch).toHaveBeenCalledTimes(2)
        expect(rawFetch.mock.calls[1][0]).toBe('http://127.0.0.1:4200/api/agent/conversations/c1/send')
        expect(new Headers(rawFetch.mock.calls[1][1].headers).get('X-Desktop-Token')).toBe('fixture-token')
        await window.fetch('http://localhost:4200/api/agent/conversations')
        expect(new Headers(rawFetch.mock.calls[2][1]?.headers).has('X-Desktop-Token')).toBe(false)
        expect(rawFetch).toHaveBeenCalledTimes(3)
      } finally {
        delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
      }
    })

    it('retries a temporarily unavailable project read with Retry-After without refreshing auth', async () => {
      vi.useFakeTimers()
      const spyFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'project_unavailable' }), { status: 503, headers: { 'Retry-After': '2' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ tickets: [1] }), { status: 200 }))
      window.fetch = spyFetch
      const { installFetchInterceptor } = await import('../auth')
      installFetchInterceptor()
      const pending = window.fetch(new Request(`${window.location.origin}/api/projects/p1/tickets`, { headers: { Accept: 'application/json' } }))
      await vi.advanceTimersByTimeAsync(1999)
      expect(spyFetch).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(await (await pending).json()).toEqual({ tickets: [1] })
      expect(spyFetch).toHaveBeenCalledTimes(2)
      expect((spyFetch.mock.calls[1][0] as Request).method).toBe('GET')
      expect(new Headers(spyFetch.mock.calls[1][1].headers).get('Accept')).toBe('application/json')
    })

    it('stops project read recovery after ten seconds and preserves the final error response', async () => {
      vi.useFakeTimers()
      const spyFetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'project_unavailable', detail: 'database locked' }), { status: 503, headers: { 'Retry-After': '2' } })))
      window.fetch = spyFetch
      const { installFetchInterceptor } = await import('../auth')
      installFetchInterceptor()
      const pending = window.fetch('/api/projects/p1/tickets')
      await vi.advanceTimersByTimeAsync(10000)
      const response = await pending
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'project_unavailable', detail: 'database locked' })
      expect(spyFetch).toHaveBeenCalledTimes(6)
      await vi.advanceTimersByTimeAsync(30000)
      expect(spyFetch).toHaveBeenCalledTimes(6)
    })

    it('aborts during the project recovery delay without replaying the read', async () => {
      vi.useFakeTimers()
      const spyFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'project_unavailable' }), { status: 503 }))
      window.fetch = spyFetch
      const { installFetchInterceptor } = await import('../auth')
      installFetchInterceptor()
      const controller = new AbortController()
      const pending = window.fetch('/api/projects/p1/tickets', { signal: controller.signal })
      const aborted = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      await vi.advanceTimersByTimeAsync(1000)
      controller.abort()
      await aborted
      await vi.advanceTimersByTimeAsync(10000)
      expect(spyFetch).toHaveBeenCalledTimes(1)
    })

    it('never delays mutations or unrelated 503 failures', async () => {
      vi.useFakeTimers()
      const spyFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'project_unavailable' }), { status: 503 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'maintenance' }), { status: 503 }))
      window.fetch = spyFetch
      const { installFetchInterceptor } = await import('../auth')
      installFetchInterceptor()
      const request = new Request(`${window.location.origin}/api/projects/p1/rails/0/launch`, { method: 'POST', body: '{}' })
      expect((await window.fetch(request)).status).toBe(503)
      expect((await window.fetch('/api/projects/p1/tickets')).status).toBe(503)
      await vi.advanceTimersByTimeAsync(30000)
      expect(spyFetch).toHaveBeenCalledTimes(2)
    })

    it('recovers a late sidecar token and retries the originally unauthorized project read', async () => {
      const spyFetch = vi.fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'late-token' }) })
        .mockResolvedValueOnce({ ok: true, status: 200 })
      window.fetch = spyFetch
      const { installFetchInterceptor, getDesktopToken } = await import('../auth')
      installFetchInterceptor()
      expect((await window.fetch('/api/projects')).status).toBe(200)
      expect(getDesktopToken()).toBe('late-token')
      expect(spyFetch.mock.calls[2][1].headers.get('X-Desktop-Token')).toBe('late-token')
    })

    it('refreshes a stale token only once for simultaneous unauthorized calls', async () => {
      let tokenReads = 0
      const spyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/api/token')) {
          tokenReads++
          return { ok: true, status: 200, json: async () => ({ token: tokenReads === 1 ? 'old' : 'new' }) } as Response
        }
        const authorized = new Headers(init?.headers).get('X-Desktop-Token') === 'new'
        return { ok: authorized, status: authorized ? 200 : 401 } as Response
      })
      window.fetch = spyFetch
      const { initAuth, installFetchInterceptor } = await import('../auth')
      await initAuth()
      installFetchInterceptor()
      const results = await Promise.all([window.fetch('/api/projects'), window.fetch('/api/settings')])
      expect(results.map((response) => response.status)).toEqual([200, 200])
      expect(tokenReads).toBe(2)
    })

    it('preserves Request headers and body when replaying after token refresh', async () => {
      const bodies: string[] = []
      const spyFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/api/token')) return { ok: true, json: async () => ({ token: 'new' }) } as Response
        const request = input as Request
        bodies.push(await request.text())
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json')
        return { ok: bodies.length === 2, status: bodies.length === 2 ? 200 : 401 } as Response
      })
      window.fetch = spyFetch
      const { installFetchInterceptor } = await import('../auth')
      installFetchInterceptor()
      const request = new Request(`${window.location.origin}/api/projects`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '/repo' }),
      })
      expect((await window.fetch(request)).status).toBe(200)
      expect(bodies).toEqual(['{"path":"/repo"}', '{"path":"/repo"}'])
    })

    it('never leaks the desktop token to a protocol-relative external URL', async () => {
      const spyFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ token: 'private-token' }) })
      window.fetch = spyFetch
      const { initAuth, installFetchInterceptor } = await import('../auth')
      await initAuth()
      installFetchInterceptor()
      await window.fetch('//external.example/api/projects')
      expect(spyFetch.mock.calls.at(-1)?.[1]).toEqual({})
    })

    it('does not repeat a failed authentication refresh or a caller-owned credential', async () => {
      const spyFetch = vi.fn().mockResolvedValue({ ok: false, status: 401 })
      window.fetch = spyFetch
      const { installFetchInterceptor } = await import('../auth')
      installFetchInterceptor()
      expect((await window.fetch('/api/projects')).status).toBe(401)
      expect(spyFetch).toHaveBeenCalledTimes(2)
      await window.fetch('/api/projects', { headers: { 'X-Desktop-Token': 'explicit' } })
      expect(spyFetch).toHaveBeenCalledTimes(3)
    })
    it('wraps window.fetch when called', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'interceptor-token' }),
      })

      const { initAuth, installFetchInterceptor } = await import('../auth')
      await initAuth()

      const fetchBefore = window.fetch
      installFetchInterceptor()
      const fetchAfter = window.fetch

      // installFetchInterceptor replaces window.fetch with a wrapper
      expect(fetchAfter).not.toBe(fetchBefore)
    })

    it('attaches X-Desktop-Token header to relative URL requests when token is set', async () => {
      // Use a spy as the original fetch BEFORE installing interceptor
      const spyFetch = vi.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      )
      ;(window as unknown as Record<string, unknown>).fetch = spyFetch

      // Init auth by having spyFetch return the token
      spyFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'interceptor-token' }),
      } as unknown as Response)

      const { initAuth, installFetchInterceptor } = await import('../auth')
      await initAuth()
      installFetchInterceptor()

      // Now window.fetch is the interceptor. spyFetch is the origFetch captured inside.
      await window.fetch('/api/jobs')

      expect(spyFetch).toHaveBeenCalled()
      const lastCall = spyFetch.mock.calls[spyFetch.mock.calls.length - 1]
      const headersArg = lastCall[1]?.headers
      if (headersArg instanceof Headers) {
        expect(headersArg.get('X-Desktop-Token')).toBe('interceptor-token')
      } else {
        expect((headersArg as Record<string, string>)?.['X-Desktop-Token']).toBe('interceptor-token')
      }
    })

    it('does not add header when token is null', async () => {
      const spyFetch = vi.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      )
      ;(window as unknown as Record<string, unknown>).fetch = spyFetch

      // Don't call initAuth — token remains null
      const { installFetchInterceptor } = await import('../auth')
      installFetchInterceptor()

      await window.fetch('/api/jobs')

      expect(spyFetch).toHaveBeenCalled()
      // When token is null, origFetch is called with the original init (no headers modified)
      const lastCall = spyFetch.mock.calls[spyFetch.mock.calls.length - 1]
      const callInit = lastCall[1]
      if (callInit?.headers) {
        const headers = callInit.headers as Headers
        expect(headers.get?.('X-Desktop-Token')).toBeFalsy()
      }
      // If no headers — that's fine too (no token injected)
    })

    it('does not overwrite existing X-Desktop-Token header', async () => {
      const spyFetch = vi.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      )
      ;(window as unknown as Record<string, unknown>).fetch = spyFetch

      spyFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'server-token' }),
      } as unknown as Response)

      const { initAuth, installFetchInterceptor } = await import('../auth')
      await initAuth()
      installFetchInterceptor()

      await window.fetch('/api/jobs', {
        headers: new Headers({ 'X-Desktop-Token': 'caller-provided-token' }),
      })

      expect(spyFetch).toHaveBeenCalled()
      const lastCall = spyFetch.mock.calls[spyFetch.mock.calls.length - 1]
      const headers = lastCall[1]?.headers as Headers
      expect(headers.get('X-Desktop-Token')).toBe('caller-provided-token')
    })

    it('does not add header to external URLs not on localhost', async () => {
      const spyFetch = vi.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      )
      ;(window as unknown as Record<string, unknown>).fetch = spyFetch

      spyFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'my-token' }),
      } as unknown as Response)

      const { initAuth, installFetchInterceptor } = await import('../auth')
      await initAuth()
      installFetchInterceptor()

      await window.fetch('https://external-api.example.com/data')

      expect(spyFetch).toHaveBeenCalled()
      const lastCall = spyFetch.mock.calls[spyFetch.mock.calls.length - 1]
      const callInit = lastCall[1]
      // External URLs pass through unchanged — no X-Desktop-Token header modification
      if (callInit?.headers) {
        const headers = callInit.headers as Headers
        expect(headers.get?.('X-Desktop-Token')).toBeNull()
      }
    })

    it('does not add header to unrelated localhost URLs', async () => {
      const spyFetch = vi.fn(() =>
        Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      )
      ;(window as unknown as Record<string, unknown>).fetch = spyFetch

      spyFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: 'my-token' }),
      } as unknown as Response)

      const { initAuth, installFetchInterceptor } = await import('../auth')
      await initAuth()
      installFetchInterceptor()

      await window.fetch('http://localhost:9999/data')

      const lastCall = spyFetch.mock.calls[spyFetch.mock.calls.length - 1]
      const callInit = lastCall[1]
      if (callInit?.headers) {
        const headers = callInit.headers as Headers
        expect(headers.get?.('X-Desktop-Token')).toBeNull()
      }
    })
  })
})
