import type { Router } from 'express'
import { USAGE_PROVIDERS, type UsageProvider } from '../domain'
import type { UsageService } from '../runtime/usage-service'
export function registerUsageRoutes(router: Router, service: UsageService) {
  router.get('/subscription-usage', (_req, res) => res.json(service.snapshot()))
  router.post('/subscription-usage/refresh', (req, res) => {
    const body: unknown = req.body ?? {}
    if (typeof body !== 'object' || body === null || Array.isArray(body) || Object.keys(body).some(key => key !== 'providerId' && key !== 'automatic')) {
      res.status(400).json({ error: 'Invalid usage refresh request' }); return
    }
    const { providerId, automatic } = body as { providerId?: unknown; automatic?: unknown }
    if ((providerId !== undefined && !USAGE_PROVIDERS.includes(providerId as UsageProvider)) || (automatic !== undefined && typeof automatic !== 'boolean')) {
      res.status(400).json({ error: 'Invalid usage refresh request' }); return
    }
    res.status(202).json(service.refresh(providerId as UsageProvider | undefined, automatic === true))
  })
}
