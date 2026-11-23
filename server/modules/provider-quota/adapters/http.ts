import type { Router } from 'express'
import type { QuotaStore } from '../runtime/quota-store'

/** `GET /api/provider-quota`: every listed provider's quota view (read-only, never probes). */
export function registerQuotaRoutes(router: Router, store: QuotaStore): void {
  router.get('/provider-quota', (_req, res) => { res.json({ providers: store.views() }) })
}
