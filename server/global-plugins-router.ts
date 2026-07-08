import { Router } from 'express'
import type { HeadroomProvider } from './headroom-routing'
import { HeadroomManager } from './headroom-manager'

function isProvider(value: unknown): value is HeadroomProvider {
  return value === 'codex' || value === 'claude'
}

export function createGlobalPluginsRouter(headroom: HeadroomManager): Router {
  const router = Router()

  router.get('/', async (_req, res) => {
    res.json({
      plugins: [
        {
          id: 'headroom-ai',
          name: 'Headroom AI',
          scope: 'global',
          status: await headroom.getFreshState(),
        },
        { id: 'jira', name: 'Jira', scope: 'project' },
        { id: 'serena', name: 'Serena', scope: 'project' },
      ],
    })
  })

  router.get('/headroom', async (_req, res) => {
    res.json({ state: await headroom.getFreshState() })
  })

  router.get('/headroom/diagnostics', (_req, res) => {
    res.json(headroom.diagnostics())
  })

  router.post('/headroom/install', async (_req, res) => {
    const result = await headroom.install()
    res.status(result.ok ? 200 : 409).json(result)
  })

  router.post('/headroom/activate', async (req, res) => {
    const provider = req.body?.provider
    if (!isProvider(provider)) {
      res.status(400).json({ error: 'provider must be codex or claude' })
      return
    }
    const result = await headroom.activate(provider)
    res.status(result.ok ? 200 : 409).json(result)
  })

  router.post('/headroom/deactivate', async (req, res) => {
    const provider = req.body?.provider
    if (!isProvider(provider)) {
      res.status(400).json({ error: 'provider must be codex or claude' })
      return
    }
    const result = await headroom.deactivate(provider)
    res.status(result.ok ? 200 : 409).json(result)
  })

  router.post('/headroom/uninstall', async (_req, res) => {
    const result = await headroom.uninstall()
    res.status(result.ok ? 200 : 409).json(result)
  })

  router.post('/headroom/port', async (req, res) => {
    const port = Number(req.body?.port)
    const result = await headroom.setPort(port)
    res.status(result.ok ? 200 : 400).json(result)
  })

  return router
}
