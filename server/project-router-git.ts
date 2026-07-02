import type { Request, Response } from 'express'
import type { ProjectRoutesDeps } from './project-router-helpers'
import { getProjectGitInfo, checkoutProjectBranch } from './project-git'

// ─── Git domain routes (/api/projects/:projectId/git) ─────────────────────────
//
// Backs the Agent-Mode git bar: current branch + last commit + local branches,
// and a user-initiated branch switch. Git always runs against project.path (the
// REAL repo — under artifact relocation the workspace never holds the code).

export function registerGitRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx } = deps

  router.get('/:projectId/git', async (req: Request, res: Response) => {
    try {
      res.json(await getProjectGitInfo(ctx(req).project.path))
    } catch (err) {
      console.error('[project-git] info failed:', err)
      res.status(500).json({ error: 'Failed to read git info' })
    }
  })

  router.post('/:projectId/git/checkout', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
    if (!branch) {
      res.status(400).json({ error: 'branch is required' })
      return
    }
    const repoDir = ctx(req).project.path
    try {
      const result = await checkoutProjectBranch(repoDir, branch)
      if (!result.ok) {
        // 409: the working tree state (or an unknown branch) refused the switch.
        res.status(409).json({ error: result.error })
        return
      }
      res.json(await getProjectGitInfo(repoDir))
    } catch (err) {
      console.error('[project-git] checkout failed:', err)
      res.status(500).json({ error: 'Checkout failed' })
    }
  })
}
