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

/** Value-free resolution status of the configured environment names. The
 * composition binds it to the project's runtime environment cache. */
export interface EnvPassthroughStatusHttpPort {
  /** Current statuses; probes first only when a name has no valid record. */
  read(request: Request): Promise<unknown>
  /** Probe immediately, then return the updated statuses. */
  recheck(request: Request): Promise<unknown>
}

/** Inbound adapter for `GET /:projectId/env-passthrough/status` and
 * `POST /:projectId/env-passthrough/recheck`. Responses carry names and
 * states only; values never reach this adapter. */
export function registerEnvPassthroughStatusHttp(router: Router, port: EnvPassthroughStatusHttpPort): void {
  router.get('/:projectId/env-passthrough/status', async (req, res) => {
    try {
      res.json(await port.read(req))
    } catch (error) {
      console.error('[project-router] env status error:', error)
      res.status(500).json({ error: 'Failed to read environment status' })
    }
  })
  router.post('/:projectId/env-passthrough/recheck', async (req, res) => {
    try {
      res.json(await port.recheck(req))
    } catch (error) {
      console.error('[project-router] env recheck error:', error)
      res.status(500).json({ error: 'Failed to recheck environment' })
    }
  })
}
