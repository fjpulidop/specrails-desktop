import type { Request, Router } from 'express'
import { SettingsValidationError, type ProjectSettings, type ProjectSettingsService } from '..'

/** Inbound adapter: translate HTTP into use cases and domain errors into HTTP. */
export function registerProjectSettingsHttp(
  router: Router,
  serviceForRequest: (request: Request) => ProjectSettingsService,
  /** Observer for committed changes (e.g. open agent sessions re-reading policy). */
  onUpdated?: (request: Request, settings: ProjectSettings, previous: ProjectSettings) => void,
): void {
  router.get('/:projectId/settings', (req, res) => {
    res.json(serviceForRequest(req).getSettings())
  })
  router.patch('/:projectId/settings', (req, res) => {
    try {
      const service = serviceForRequest(req)
      const previous = onUpdated ? service.getSettings() : null
      const settings = service.updateSettings(req.body)
      res.json({ ok: true, settings })
      if (onUpdated && previous) {
        try { onUpdated(req, settings, previous) } catch (error) { console.error('[project-router] settings observer error:', error) }
      }
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
