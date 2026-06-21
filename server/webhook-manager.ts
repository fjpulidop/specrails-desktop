import { createHmac } from 'crypto'
import type { DbInstance } from './db'
import { listWebhooksForProject } from './desktop-db'
import type { WebhookRow, WebhookEvent } from './desktop-db'
import { isUrlSafeForDelivery } from './ssrf-guard'

const WEBHOOK_TIMEOUT_MS = 10_000
const MAX_ATTEMPTS = 3

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface WebhookPayload {
  event: WebhookEvent
  timestamp: string
  projectId: string
  data: Record<string, unknown>
}

// ─── WebhookManager ───────────────────────────────────────────────────────────

export class WebhookManager {
  private _desktopDb: DbInstance

  constructor(desktopDb: DbInstance) {
    this._desktopDb = desktopDb
  }

  /**
   * Send a test ping to a single webhook (used by the test endpoint).
   */
  deliverTest(webhook: WebhookRow): void {
    const payload: WebhookPayload = {
      event: 'job.completed',
      timestamp: new Date().toISOString(),
      projectId: webhook.project_id ?? '*',
      data: { test: true, message: 'specrails-desktop webhook test ping' },
    }
    setImmediate(() => {
      this._deliverWithRetry(webhook, payload).catch(() => {})
    })
  }

  /**
   * Deliver an event to all matching webhooks for a project.
   * Non-blocking: fires and forgets with retry logic.
   */
  deliver(projectId: string, event: WebhookEvent, data: Record<string, unknown>): void {
    const webhooks = listWebhooksForProject(this._desktopDb, projectId)
    const matching = webhooks.filter((w) => {
      try {
        const events = JSON.parse(w.events) as string[]
        return events.includes(event)
      } catch {
        return false
      }
    })

    for (const webhook of matching) {
      const payload: WebhookPayload = {
        event,
        timestamp: new Date().toISOString(),
        projectId,
        data,
      }
      // Fire-and-forget with retry; errors are swallowed after exhausting attempts
      setImmediate(() => {
        this._deliverWithRetry(webhook, payload).catch(() => {})
      })
    }
  }

  private async _deliverWithRetry(webhook: WebhookRow, payload: WebhookPayload, attempt = 1): Promise<void> {
    // BUG-WEBHOOK-01 (delivery-time half): the URL was validated at registration,
    // but a host can be DNS-rebound to a loopback/private/link-local address
    // before this (long-lived) webhook fires. Re-resolve here and DROP delivery
    // (no retry — re-resolving would only fail again) to an internal target, so
    // an HMAC-signed POST is never sent to an internal service. Honours the
    // SPECRAILS_ALLOW_LOCAL_WEBHOOKS dev opt-in inside isUrlSafeForDelivery.
    if (!(await isUrlSafeForDelivery(webhook.url))) {
      console.warn(`[webhook-manager] blocked delivery to non-public host: ${webhook.url}`)
      return
    }

    const body = JSON.stringify(payload)
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'specrails-desktop',
    }

    if (webhook.secret) {
      const sig = createHmac('sha256', webhook.secret).update(body).digest('hex')
      headers['X-Specrails-Signature'] = `sha256=${sig}`
    }

    try {
      const res = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      })

      if (!res.ok && attempt < MAX_ATTEMPTS) {
        await delay(1000 * attempt)
        return this._deliverWithRetry(webhook, payload, attempt + 1)
      }
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        await delay(1000 * attempt)
        return this._deliverWithRetry(webhook, payload, attempt + 1)
      }
    }
  }
}
