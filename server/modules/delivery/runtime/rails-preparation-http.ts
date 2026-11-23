// Prepared run checkouts for Launch all (worktree-preparation-pool.ts): the
// dialog opening asks for up to three checkouts of the primary repository to
// be populated while the person reads it; dismissing it drops them. Both are
// advisory: a failure never blocks a launch, which then creates its worktrees
// the ordinary way.
import type { Router, Request, Response } from 'express'
import { getProjectSettings } from '../../../db'
import { fetchOrigin, resolveIntegrationBranch, resolveWorktreeBaseRef } from '../../../integration-branch'
import { defaultGitRunner } from '../../../worktree-manager'
import { isolatedRepositoryTarget } from './isolated-worktree'
import { MAX_PREPARED, prewarmPreparedCheckouts, releasePreparedCheckouts, isWorktreePreparationEnabled } from './worktree-preparation-pool'
import { projectContextOf } from './rails-http-shared'

export function registerRailPreparationRoutes(router: Router): void {
  // POST /rails/worktree-preparation { count } — start preparing checkouts.
  router.post('/worktree-preparation', async (req: Request, res: Response) => {
    const c = projectContextOf(req)
    const raw = Number((req.body as { count?: unknown } | undefined)?.count ?? 1)
    const count = Number.isFinite(raw) ? Math.max(0, Math.min(MAX_PREPARED, Math.floor(raw))) : 1
    if (!isWorktreePreparationEnabled() || count === 0) { res.json({ preparing: 0 }); return }
    try {
      const target = isolatedRepositoryTarget(c.project, null)
      const projectSetting = target.integrationBranch ?? getProjectSettings(c.db).integrationBranch
      // Warm the launch's fetch too (de-duplicated per repository).
      void fetchOrigin(defaultGitRunner, target.path)
      const integration = await resolveIntegrationBranch(defaultGitRunner, { repoDir: target.path, projectSetting: projectSetting ?? undefined })
      const guess = await resolveWorktreeBaseRef(defaultGitRunner, { repoDir: target.path, integration, fetchOk: true })
      const preparing = prewarmPreparedCheckouts({ git: defaultGitRunner, repoDir: target.path, worktreesRoot: target.worktreesRoot, baseRef: guess.baseRef }, count)
      res.json({ preparing })
    } catch (err) {
      res.json({ preparing: 0, warning: err instanceof Error ? err.message : String(err) })
    }
  })

  // POST /rails/worktree-preparation/release — the dialog was dismissed.
  router.post('/worktree-preparation/release', async (req: Request, res: Response) => {
    const c = projectContextOf(req)
    try {
      const target = isolatedRepositoryTarget(c.project, null)
      const released = await releasePreparedCheckouts(defaultGitRunner, target.path, target.worktreesRoot)
      res.json({ released })
    } catch (err) {
      res.json({ released: 0, warning: err instanceof Error ? err.message : String(err) })
    }
  })
}


