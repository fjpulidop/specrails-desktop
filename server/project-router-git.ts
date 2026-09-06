import type { Request, Response } from 'express'
import type { ProjectRoutesDeps } from './project-router-helpers'
import { getProjectGitInfo, checkoutProjectBranch } from './project-git'
import { runGitDiagnostic, isGitDiagnosticAction, GIT_DIAGNOSTIC_ACTIONS } from './git-diagnostics'
import { defaultExec } from './pr-publisher'
import { withRepoLock } from './repo-lock'
import { captureProcessAdmission, ProcessAdmissionClosedError } from './process-admission'
import { getProjectRepositories, resolveProjectRepository, type ProjectRepository } from './project-repositories'
import fs from 'node:fs'

// ─── Git domain routes (/api/projects/:projectId/git) ─────────────────────────
//
// Backs the Agent-Mode git bar: current branch + last commit + local branches,
// and a user-initiated branch switch. Git runs against the selected member's
// checkout; legacy routes default to the primary, never the artifact workspace.

export function registerGitRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx } = deps
  const exec = deps.exec ?? defaultExec

  function selectedRepository(req: Request, res: Response, repositoryId = req.params.repositoryId as string | undefined): ProjectRepository | null {
    let repository: ProjectRepository
    try { repository = resolveProjectRepository(ctx(req).project, repositoryId) }
    catch (err) {
      res.status(404).json({ error: 'repository_not_found', detail: (err as Error).message })
      return null
    }
    try { if (!fs.statSync(repository.path).isDirectory()) throw new Error('not a directory') }
    catch {
      res.status(503).json({ error: 'repository_unavailable', repositoryId: repository.id })
      return null
    }
    return repository
  }

  function requireGit(req: Request, res: Response, repositoryId = req.params.repositoryId as string | undefined): ProjectRepository | null {
    const repository = selectedRepository(req, res, repositoryId)
    if (repository?.kind === 'folder') {
      res.status(409).json({ error: 'repository_is_not_git', repositoryId: repository.id })
      return null
    }
    return repository
  }

  router.get(['/:projectId/repositories/:repositoryId/git', '/:projectId/git'], async (req: Request, res: Response) => {
    const repository = selectedRepository(req, res)
    if (!repository) return
    try {
      res.json({ ...(repository.kind === 'folder' ? { git: false } : await getProjectGitInfo(repository.path)), repositoryId: repository.id })
    } catch (err) {
      console.error('[project-git] info failed:', err)
      res.status(500).json({ error: 'Failed to read git info' })
    }
  })

  router.get(['/:projectId/repositories/:repositoryId/git/pull-requests/:number', '/:projectId/git/pull-requests/:number'], async (req: Request, res: Response) => {
    const repository = requireGit(req, res)
    if (!repository) return
    const prNumber = Number.parseInt(String(req.params.number ?? ''), 10)
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      res.status(400).json({ error: 'invalid_pull_request_number' })
      return
    }

    try {
      const r = await exec.run('gh', ['pr', 'view', String(prNumber), '--json', 'url'], repository.path)
      if (r.code !== 0) {
        res.status(404).json({ error: 'pull_request_not_found' })
        return
      }
      const parsed = JSON.parse(r.stdout) as { url?: unknown }
      if (typeof parsed.url !== 'string' || !parsed.url) {
        res.status(404).json({ error: 'pull_request_not_found' })
        return
      }
      res.json({ prNumber, url: parsed.url, repositoryId: repository.id })
    } catch (err) {
      console.error('[project-git] pull request lookup failed:', err)
      res.status(500).json({ error: 'pull_request_lookup_failed' })
    }
  })

  // READ-ONLY git/gh diagnostics (backs the specrails_git MCP tool). A fixed
  // allowlist of read-only commands — the query only names an action, never
  // arguments. Validate that allowlist before resolving filesystem state.
  router.get(['/:projectId/repositories/:repositoryId/git/diagnostic', '/:projectId/git/diagnostic'], async (req: Request, res: Response) => {
    const action = String(req.query.action ?? '')
    if (!isGitDiagnosticAction(action)) {
      res.status(400).json({ error: 'invalid_action', allowed: GIT_DIAGNOSTIC_ACTIONS })
      return
    }
    // The legacy diagnostic reports Git's own informative nonzero result for a
    // primary folder without Git. Explicit context-only members reject Git.
    const repository = req.params.repositoryId === undefined ? selectedRepository(req, res) : requireGit(req, res)
    if (!repository) return
    try {
      res.json({ ...await runGitDiagnostic(action, repository.path), repositoryId: repository.id })
    } catch (err) {
      console.error('[project-git] diagnostic failed:', err)
      res.status(500).json({ error: 'diagnostic_failed', detail: err instanceof Error ? err.message : String(err) })
    }
  })

  router.post(['/:projectId/repositories/:repositoryId/git/checkout', '/:projectId/git/checkout'], async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const routeRepositoryId = req.params.repositoryId as string | undefined
    if (body.repositoryId !== undefined && (typeof body.repositoryId !== 'string' || !body.repositoryId || (routeRepositoryId && body.repositoryId !== routeRepositoryId))) {
      res.status(400).json({ error: 'invalid_repository_id' }); return
    }
    const repositoryId = routeRepositoryId ?? body.repositoryId as string | undefined
    const project = ctx(req).project
    if (repositoryId === undefined && getProjectRepositories(project).length > 1) {
      res.status(400).json({ error: 'repository_required', repositories: getProjectRepositories(project).map(({ id, name }) => ({ id, name })) }); return
    }
    const repository = requireGit(req, res, repositoryId)
    if (!repository) return
    const branch = typeof body.branch === 'string' ? body.branch.trim() : ''
    if (!branch) {
      res.status(400).json({ error: 'branch is required' })
      return
    }
    const repoDir = repository.path
    try {
      const admission = captureProcessAdmission(project.id)
      const result = await withRepoLock(repoDir, async () => {
        admission.assertCurrent()
        const current = getProjectRepositories(ctx(req).project).find(member => member.id === repository.id)
        if (!current || current.path !== repoDir || current.kind !== 'git') {
          return { ok: false as const, error: 'Repository membership changed; refresh before switching branches.' }
        }
        return checkoutProjectBranch(repoDir, branch)
      })
      if (!result.ok) {
        // 409: the working tree state (or an unknown branch) refused the switch.
        res.status(409).json({ error: result.error })
        return
      }
      res.json({ ...await getProjectGitInfo(repoDir), repositoryId: repository.id })
    } catch (err) {
      if (err instanceof ProcessAdmissionClosedError) {
        res.status(409).json({ error: 'project_recovery_in_progress' })
        return
      }
      console.error('[project-git] checkout failed:', err)
      res.status(500).json({ error: 'Checkout failed' })
    }
  })
}
