/**
 * App-level webhook routes (`/webhooks*`): CRUD with registration-time SSRF
 * validation and test pings. Secrets are never returned.
 */
import type { Router } from 'express'
import { randomUUID } from 'crypto'
import type { ProjectRegistry } from './project-registry'
import { listWebhooks, getWebhook, addWebhook, updateWebhook, removeWebhook } from './desktop-db'
import type { WebhookEvent } from './desktop-db'
import { WebhookManager } from './webhook-manager'
import { resolvesToPublicOnly, validateHttpUrl } from './desktop-router-url-validation'

function publicWebhook(row: ReturnType<typeof getWebhook>) {
  if (!row) return row
  const { secret: _secret, ...rest } = row
  return { ...rest, hasSecret: row.secret.length > 0 }
}

export function registerWebhookRoutes(router: Router, deps: { registry: ProjectRegistry }): void {
  const { registry } = deps
  // ─── Webhook routes ──────────────────────────────────────────────────────────

  const webhookManager = new WebhookManager(registry.desktopDb)

  // GET /api/webhooks — list all webhooks
  router.get('/webhooks', (_req, res) => {
    res.json({ webhooks: listWebhooks(registry.desktopDb).map(publicWebhook) })
  })

  // BUG-WEBHOOK-01: webhook destinations must not resolve to internal hosts.
  // `validateHttpUrl` blocks IP literals; this adds the DNS-resolution gate so a
  // public hostname that resolves to a loopback/private/link-local address is
  // rejected too. Skipped when loopback is explicitly allowed (dev opt-in).
  async function webhookHostAllowed(normalizedUrl: string): Promise<boolean> {
    if (process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS === '1') return true
    let hostname: string
    try {
      hostname = new URL(normalizedUrl).hostname
    } catch {
      return false
    }
    return resolvesToPublicOnly(hostname)
  }

  // POST /api/webhooks — create a webhook
  router.post('/webhooks', async (req, res) => {
    const { url, secret, events, projectId } = req.body ?? {}
    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'url is required' })
      return
    }

    const validEvents: WebhookEvent[] = ['job.completed', 'job.failed', 'job.canceled', 'daily_budget_exceeded', 'desktop_daily_budget_exceeded']
    const parsedEvents: WebhookEvent[] = Array.isArray(events)
      ? (events as string[]).filter((e): e is WebhookEvent => validEvents.includes(e as WebhookEvent))
      : ['job.completed', 'job.failed', 'job.canceled']

    if (parsedEvents.length === 0) {
      res.status(400).json({ error: 'at least one valid event is required' })
      return
    }

    if (projectId != null) {
      const ctx = registry.getContext(projectId)
      if (!ctx) {
        res.status(400).json({ error: 'project not found' })
        return
      }
    }

    const normalizedUrl = validateHttpUrl(url.trim(), {
      allowLoopback: process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS === '1',
      requireHttps: true,
    })
    if (!normalizedUrl) {
      res.status(400).json({ error: 'webhook url must be https and must not target localhost/private IPs' })
      return
    }

    if (!(await webhookHostAllowed(normalizedUrl))) {
      res.status(400).json({ error: 'webhook url must be https and must not target localhost/private IPs' })
      return
    }

    const webhook = addWebhook(registry.desktopDb, {
      id: randomUUID(),
      projectId: projectId ?? null,
      url: normalizedUrl,
      secret: typeof secret === 'string' ? secret.trim() : '',
      events: parsedEvents,
    })
    res.status(201).json({ webhook: publicWebhook(webhook) })
  })

  // PATCH /api/webhooks/:id — update a webhook
  router.patch('/webhooks/:id', async (req, res) => {
    const existing = getWebhook(registry.desktopDb, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }

    const { url, secret, events, enabled } = req.body ?? {}
    const validEvents: WebhookEvent[] = ['job.completed', 'job.failed', 'job.canceled', 'daily_budget_exceeded', 'desktop_daily_budget_exceeded']
    const parsedEvents: WebhookEvent[] | undefined = Array.isArray(events)
      ? (events as string[]).filter((e): e is WebhookEvent => validEvents.includes(e as WebhookEvent))
      : undefined

    let normalizedUrl: string | undefined
    if (typeof url === 'string') {
      const candidate = validateHttpUrl(url.trim(), {
        allowLoopback: process.env.SPECRAILS_ALLOW_LOCAL_WEBHOOKS === '1',
        requireHttps: true,
      })
      if (!candidate) {
        res.status(400).json({ error: 'webhook url must be https and must not target localhost/private IPs' })
        return
      }
      if (!(await webhookHostAllowed(candidate))) {
        res.status(400).json({ error: 'webhook url must be https and must not target localhost/private IPs' })
        return
      }
      normalizedUrl = candidate
    }

    const updated = updateWebhook(registry.desktopDb, req.params.id, {
      url: normalizedUrl,
      secret: typeof secret === 'string' ? secret.trim() : undefined,
      events: parsedEvents,
      enabled: typeof enabled === 'boolean' ? enabled : undefined,
    })
    res.json({ webhook: publicWebhook(updated) })
  })

  // DELETE /api/webhooks/:id — delete a webhook
  router.delete('/webhooks/:id', (req, res) => {
    const existing = getWebhook(registry.desktopDb, req.params.id)
    if (!existing) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }
    removeWebhook(registry.desktopDb, req.params.id)
    res.json({ ok: true })
  })

  // POST /api/webhooks/:id/test — send a test ping
  router.post('/webhooks/:id/test', (req, res) => {
    const webhook = getWebhook(registry.desktopDb, req.params.id)
    if (!webhook) {
      res.status(404).json({ error: 'Webhook not found' })
      return
    }
    webhookManager.deliverTest(webhook)
    res.json({ ok: true, message: 'Test ping queued' })
  })
}
