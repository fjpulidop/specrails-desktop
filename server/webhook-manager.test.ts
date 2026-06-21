import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebhookManager } from './webhook-manager'
import { initDesktopDb, addWebhook, addProject } from './desktop-db'
import type { DbInstance } from './db'

// Flush setImmediate and pending microtasks so fire-and-forget callbacks execute
async function flushAsync(passes = 4): Promise<void> {
  for (let i = 0; i < passes; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await Promise.resolve()
  }
}

describe('WebhookManager', () => {
  let desktopDb: DbInstance
  let manager: WebhookManager
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    desktopDb = initDesktopDb(':memory:')
    manager = new WebhookManager(desktopDb)
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // Keep these HMAC/retry tests hermetic: the delivery-time SSRF guard
    // (BUG-WEBHOOK-01) would otherwise DNS-resolve example.com on every send.
    // The guard itself is covered exhaustively in ssrf-guard.test.ts; the
    // wiring (a private host is dropped) has its own test below.
    process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS = '1'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    delete process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS
  })

  // ─── delivery-time SSRF guard (BUG-WEBHOOK-01) ───────────────────────────────

  describe('delivery SSRF guard', () => {
    it('drops a delivery whose URL resolves to a private/loopback host (no POST)', async () => {
      // No env opt-in for this test → the guard is active. A literal private IP
      // resolves synchronously (no DNS), so the HMAC-signed POST is never sent.
      delete process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS
      fetchMock.mockResolvedValue({ ok: true })
      const webhook = addWebhook(desktopDb, {
        id: 'wh-ssrf',
        projectId: null,
        url: 'http://127.0.0.1:9000/hook',
        secret: 'shh',
        events: ['job.completed'],
      })

      manager.deliverTest(webhook)
      await flushAsync()

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  // ─── deliverTest ─────────────────────────────────────────────────────────────

  describe('deliverTest', () => {
    it('sends a test ping payload to the webhook URL', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      const webhook = addWebhook(desktopDb, {
        id: 'wh-1',
        projectId: null,
        url: 'https://example.com/hook',
        secret: '',
        events: ['job.completed'],
      })

      manager.deliverTest(webhook)
      await flushAsync()

      expect(fetchMock).toHaveBeenCalledOnce()
      const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
      expect(url).toBe('https://example.com/hook')
      expect(opts.method).toBe('POST')
      const body = JSON.parse(opts.body as string)
      expect(body.event).toBe('job.completed')
      expect(body.data.test).toBe(true)
      expect(body.data.message).toContain('test ping')
    })

    it('adds HMAC-SHA256 signature header when secret is set', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      const webhook = addWebhook(desktopDb, {
        id: 'wh-2',
        projectId: null,
        url: 'https://example.com/hook',
        secret: 'my-secret',
        events: ['job.completed'],
      })

      manager.deliverTest(webhook)
      await flushAsync()

      expect(fetchMock).toHaveBeenCalledOnce()
      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
      expect(opts.headers['X-Specrails-Signature']).toMatch(/^sha256=[a-f0-9]{64}$/)
    })

    it('does not add signature header when secret is empty', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      const webhook = addWebhook(desktopDb, {
        id: 'wh-3',
        projectId: null,
        url: 'https://example.com/hook',
        secret: '',
        events: ['job.completed'],
      })

      manager.deliverTest(webhook)
      await flushAsync()

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
      expect(opts.headers['X-Specrails-Signature']).toBeUndefined()
    })

    it('uses wildcard projectId when webhook.project_id is null', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      const webhook = addWebhook(desktopDb, {
        id: 'wh-4',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.completed'],
      })

      manager.deliverTest(webhook)
      await flushAsync()

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.projectId).toBe('*')
    })

    it('uses actual projectId when webhook.project_id is set', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      addProject(desktopDb, { id: 'proj-123', slug: 'proj-123', name: 'Test Project', path: '/tmp/test' })
      const webhook = addWebhook(desktopDb, {
        id: 'wh-5',
        projectId: 'proj-123',
        url: 'https://example.com/hook',
        events: ['job.completed'],
      })

      manager.deliverTest(webhook)
      await flushAsync()

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.projectId).toBe('proj-123')
    })

    it('includes Content-Type and User-Agent headers', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      const webhook = addWebhook(desktopDb, {
        id: 'wh-6',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.completed'],
      })

      manager.deliverTest(webhook)
      await flushAsync()

      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }]
      expect(opts.headers['Content-Type']).toBe('application/json')
      expect(opts.headers['User-Agent']).toBe('specrails-desktop')
    })
  })

  // ─── deliver ─────────────────────────────────────────────────────────────────

  describe('deliver', () => {
    it('sends payload to all enabled webhooks matching the event', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      addWebhook(desktopDb, {
        id: 'wh-1',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.completed'],
      })

      manager.deliver('proj-1', 'job.completed', { jobId: 'j1' })
      await flushAsync()

      expect(fetchMock).toHaveBeenCalledOnce()
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.event).toBe('job.completed')
      expect(body.projectId).toBe('proj-1')
      expect(body.data.jobId).toBe('j1')
    })

    it('does not send to webhooks not matching the event', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      addWebhook(desktopDb, {
        id: 'wh-1',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.failed'],
      })

      manager.deliver('proj-1', 'job.completed', {})
      await flushAsync()

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('sends to global webhooks (project_id IS NULL) for any project', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      addWebhook(desktopDb, {
        id: 'wh-global',
        projectId: null,
        url: 'https://example.com/global',
        events: ['job.completed'],
      })

      manager.deliver('any-project', 'job.completed', {})
      await flushAsync()

      expect(fetchMock).toHaveBeenCalledOnce()
    })

    it('handles webhooks with malformed events JSON gracefully', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      // Insert a webhook with invalid JSON events directly
      desktopDb.prepare(
        `INSERT INTO webhooks (id, project_id, url, secret, events, enabled) VALUES (?, NULL, ?, '', ?, 1)`
      ).run('wh-bad', 'https://example.com/hook', 'not-valid-json')

      expect(() => manager.deliver('proj-1', 'job.completed', {})).not.toThrow()
      await flushAsync()
      // Malformed events are treated as non-matching
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('delivers to multiple matching webhooks', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      for (let i = 1; i <= 3; i++) {
        addWebhook(desktopDb, {
          id: `wh-${i}`,
          projectId: null,
          url: `https://example.com/hook${i}`,
          events: ['job.completed'],
        })
      }

      manager.deliver('proj-1', 'job.completed', {})
      await flushAsync()

      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('includes a timestamp in the payload', async () => {
      fetchMock.mockResolvedValue({ ok: true })
      addWebhook(desktopDb, {
        id: 'wh-1',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.completed'],
      })

      manager.deliver('proj-1', 'job.completed', {})
      await flushAsync()

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
      expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  // ─── retry logic ─────────────────────────────────────────────────────────────

  describe('retry logic', () => {
    it('retries up to 3 times on non-ok response', async () => {
      vi.useFakeTimers()
      fetchMock.mockResolvedValue({ ok: false })

      addWebhook(desktopDb, {
        id: 'wh-1',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.completed'],
      })

      manager.deliver('proj-1', 'job.completed', {})
      await vi.runAllTimersAsync()

      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('retries up to 3 times on fetch error', async () => {
      vi.useFakeTimers()
      fetchMock.mockRejectedValue(new Error('Network error'))

      addWebhook(desktopDb, {
        id: 'wh-1',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.completed'],
      })

      manager.deliver('proj-1', 'job.completed', {})
      await vi.runAllTimersAsync()

      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('does not retry after a successful response', async () => {
      fetchMock.mockResolvedValue({ ok: true })

      addWebhook(desktopDb, {
        id: 'wh-1',
        projectId: null,
        url: 'https://example.com/hook',
        events: ['job.completed'],
      })

      manager.deliver('proj-1', 'job.completed', {})
      await flushAsync()

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })
  })
})
