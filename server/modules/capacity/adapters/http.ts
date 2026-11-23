/**
 * GET /api/capacity — the machine's run admission: its limits, the runs
 * working now, the runs queued (in launch order, with what each waits for) and
 * the learned per-run share of each provider's usage window. Read-only.
 */
import type { Router } from 'express'
import { runAdmission } from '../runtime/composition'

export function registerCapacityRoutes(router: Router): void {
  router.get('/capacity', (_req, res) => {
    const admission = runAdmission()
    if (!admission) { res.json({ enabled: false }); return }
    res.json({ enabled: true, ...admission.snapshot() })
  })
}
