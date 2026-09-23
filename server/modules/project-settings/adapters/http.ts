import type { Request, Router } from 'express'
import { SettingsValidationError, type ProjectSettingsService } from '..'

/** Inbound adapter: translate HTTP into use cases and domain errors into HTTP. */
export function registerProjectSettingsHttp(
  router: Router,
  serviceForRequest: (request: Request) => ProjectSettingsService,
): void {
  router.get('/:projectId/settings', (req, res) => {
    res.json(serviceForRequest(req).getSettings())
  })
  router.patch('/:projectId/settings', (req, res) => {
    try {
      const settings = serviceForRequest(req).updateSettings(req.body)
      res.json({ ok: true, settings })
    } catch (error) {
      if (error instanceof SettingsValidationError) {
        res.status(400).json({ error: error.message })
        return
      }
      console.error('[project-router] settings patch error:', error)
      res.status(500).json({ error: 'Failed to update settings' })
    }
  })
}
