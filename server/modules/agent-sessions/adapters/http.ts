import { Router, type Request, type Response } from 'express'

import type { HostStatusView } from '../runtime/session-host-registry'

/** What the HTTP adapter needs from the host registry. */
export interface SessionHostsControl {
  hosts(): HostStatusView[]
  retry(scope: string): Promise<void>
}

const SCOPE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Inbound adapter: Core session host status per scope and manual retry of a
 * degraded scope (after the cause, e.g. another Desktop instance, is gone).
 */
export function createSessionHostsRouter(control: SessionHostsControl): Router {
  const router = Router()
  router.get('/', (_req: Request, res: Response) => {
    res.json({ hosts: control.hosts() })
  })
  router.post('/:scope/retry', async (req: Request, res: Response) => {
    const scope = String(req.params.scope)
    if (!SCOPE_RE.test(scope)) { res.status(400).json({ error: 'Invalid scope' }); return }
    try {
      await control.retry(scope)
      res.json({ host: control.hosts().find((host) => host.scope === scope) ?? { scope, status: 'absent', detail: null, code: null } })
    } catch (error) {
      // The retry ran; the scope reports why it is still unavailable.
      res.status(502).json({ error: error instanceof Error ? error.message : 'Retry failed', host: control.hosts().find((host) => host.scope === scope) ?? null })
    }
  })
  return router
}
