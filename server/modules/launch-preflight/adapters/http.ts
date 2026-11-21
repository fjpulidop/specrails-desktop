import type { Router } from 'express'
import { batchWorktreeRoot } from '../../delivery/adapters/decisions/metadata'
import type { ProjectRegistry } from '../../../project-registry'
import type { LaunchPreflight } from '../runtime/preflight'
import { validateRequestedProvider } from '../../../provider-selection'

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * `GET /api/launch-preflight?projectId=<id>&providers=claude,codex[&fresh=1]` (an empty entry = the project's primary provider):
 * disk at the project's worktrees, sign-in of the given providers, GitHub
 * sign-in and quota. Read-only; sign-in results are cached for a minute.
 */
export function registerLaunchPreflightRoutes(router: Router, registry: ProjectRegistry, preflight: LaunchPreflight): void {
  router.get('/launch-preflight', async (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : ''
    const context = registry.getContext(projectId)
    if (!context) { res.status(404).json({ error: 'Unknown project' }); return }
    // An empty entry is a rail on the project's primary provider.
    const requested = (typeof req.query.providers === 'string' ? req.query.providers.split(',') : ['']).map((id) => id.trim()).slice(0, 8)
    const providers = requested.map((id) => { const checked = validateRequestedProvider(context.project, id); return checked.ok ? checked.provider : id }).filter((id) => PROVIDER_ID.test(id))
    try {
      res.json(await preflight.run({ worktreesDir: batchWorktreeRoot(context.project.slug), providers, github: true, fresh: req.query.fresh === '1', projectDir: context.project.path }))
    } catch (error) {
      res.status(500).json({ error: 'preflight_failed', detail: error instanceof Error ? error.message : String(error) })
    }
  })
}
