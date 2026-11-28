/**
 * `GET /api/global-plugins/tapflow` (status), `POST …/install` (opens the installer terminal and returns
 * its session id), `POST …/activate`, `POST …/deactivate`, `POST …/uninstall`. Mounted by
 * `server/global-plugins-router.ts`.
 */
import type { Request, Response, Router } from 'express'
import type { TapflowPlugin } from '../application'

export function registerTapflowRoutes(router: Router, tapflow: TapflowPlugin): void {
  router.get('/tapflow', async (_req: Request, res: Response) => { res.json({ status: await tapflow.status() }) })
  const action = (name: 'install' | 'activate' | 'deactivate' | 'uninstall') => async (_req: Request, res: Response) => {
    try {
      const result = await tapflow[name]()
      res.status(result.ok ? 200 : 409).json(result)
    } catch (err) {
      res.status(500).json({ ok: false, error: (err as Error).message, status: await tapflow.status() })
    }
  }
  router.post('/tapflow/install', action('install'))
  router.post('/tapflow/activate', action('activate'))
  router.post('/tapflow/deactivate', action('deactivate'))
  router.post('/tapflow/uninstall', action('uninstall'))
}
