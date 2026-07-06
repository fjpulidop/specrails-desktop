import type { Request, Response } from 'express'
import type { ProjectRoutesDeps } from './project-router-helpers'
import { getProjectGitInfo, checkoutProjectBranch } from './project-git'
import { runGitDiagnostic, isGitDiagnosticAction, GIT_DIAGNOSTIC_ACTIONS } from './git-diagnostics'
import { defaultExec } from './pr-publisher'

// ─── Git domain routes (/api/projects/:projectId/git) ─────────────────────────
//
// Backs the Agent-Mode git bar: current branch + last commit + local branches,
// and a user-initiated branch switch. Git always runs against project.path (the
// REAL repo — under artifact relocation the workspace never holds the code).

export function registerGitRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx } = deps
  const exec = deps.exec ?? defaultExec

  router.get('/:projectId/git', async (req: Request, res: Response) => {
    try {
      res.json(await getProjectGitInfo(ctx(req).project.path))
    } catch (err) {
      console.error('[project-git] info failed:', err)
      res.status(500).json({ error: 'Failed to read git info' })
    }
  })

  router.get('/:projectId/git/pull-requests/:number', async (req: Request, res: Response) => {
    const prNumber = Number.parseInt(String(req.params.number ?? ''), 10)
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      res.status(400).json({ error: 'invalid_pull_request_number' })
      return
    }

    try {
      const r = await exec.run('gh', ['pr', 'view', String(prNumber), '--json', 'url'], ctx(req).project.path)
      if (r.code !== 0) {
        res.status(404).json({ error: 'pull_request_not_found' })
        return
      }
      const parsed = JSON.parse(r.stdout) as { url?: unknown }
      if (typeof parsed.url !== 'string' || !parsed.url) {
        res.status(404).json({ error: 'pull_request_not_found' })
        return
      }
      res.json({ prNumber, url: parsed.url })
    } catch (err) {
      console.error('[project-git] pull request lookup failed:', err)
      res.status(500).json({ error: 'pull_request_lookup_failed' })
    }
  })

  // READ-ONLY git/gh diagnostics (backs the specrails_git MCP tool). A fixed
  // allowlist of read-only commands — the query only names an action, never
  // arguments. Git runs against project.path (the real repo; the workspace never
  // holds code under relocation).
  router.get('/:projectId/git/diagnostic', async (req: Request, res: Response) => {
    const action = String(req.query.action ?? '')
    if (!isGitDiagnosticAction(action)) {
      res.status(400).json({ error: 'invalid_action', allowed: GIT_DIAGNOSTIC_ACTIONS })
      return
    }
    try {
      res.json(await runGitDiagnostic(action, ctx(req).project.path))
    } catch (err) {
      console.error('[project-git] diagnostic failed:', err)
      res.status(500).json({ error: 'diagnostic_failed', detail: err instanceof Error ? err.message : String(err) })
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
