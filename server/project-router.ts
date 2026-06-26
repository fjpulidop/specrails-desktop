import { Router, Request, Response, NextFunction } from 'express'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import { createHooksRouter } from './hooks'
import { createRailsRouter } from './rails-router'
import { createProfilesRouter } from './profiles-router'
import { createPluginsRouter } from './plugins-router'
import { createCodeExplorerRouter } from './code-explorer-router'
import { createJiraRouter } from './jira-router'
import { resolveTicketStoragePath } from './ticket-store'
import { resolveProjectExecution } from './workspace-resolution'
import { registerJobsRoutes } from './project-router-jobs'
import { registerSpendingRoutes } from './project-router-spending'
import { registerChatRoutes } from './project-router-chat'
import { registerSetupRoutes } from './project-router-setup'
import { registerTicketsRoutes } from './project-router-tickets'
import { registerTerminalsRoutes } from './project-router-terminals'
import { registerSettingsRoutes } from './project-router-settings'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import type { ProjectRoutesDeps } from './project-router-helpers'

// Re-export the spec helpers from their new home so existing importers
// (`import { ... } from './project-router'`) keep working unchanged.
export {
  stripSpecMetadataSections,
  extractShortSummary,
  deriveFallbackShortSummary,
  lightlyStructurePrompt,
  formatDescriptionWithCriteria,
  resolveDefaultSpecModel,
} from './project-router-helpers'

export function createProjectRouter(registry: ProjectRegistry): Router {
  const router = Router({ mergeParams: true })

  // Middleware: resolve project from :projectId param
  router.use('/:projectId', (req: Request, res: Response, next: NextFunction) => {
    const projectId = req.params.projectId as string
    const ctx = registry.getContext(projectId)
    if (!ctx) {
      res.status(404).json({ error: 'Project not found' })
      return
    }
    registry.touchProject(projectId)
    req.projectCtx = ctx
    next()
  })

  // Helper to get ctx (always defined after middleware)
  function ctx(req: Request): ProjectContext {
    return req.projectCtx!
  }

  // ─── Hooks ──────────────────────────────────────────────────────────────────

  // Per-ProjectContext sub-router memo. Keyed on the ctx object (WeakMap) so a
  // removed+re-added project gets a fresh router, instead of rebuilding the
  // router on every request (H18).
  function memoizedSubRouter(
    cache: WeakMap<object, Router>,
    projectCtx: ProjectContext,
    factory: () => Router
  ): Router {
    let sub = cache.get(projectCtx)
    if (!sub) {
      sub = factory()
      cache.set(projectCtx, sub)
    }
    return sub
  }

  // Mount hooks router under each project — the hot path while jobs stream.
  const hooksRouterByCtx = new WeakMap<object, Router>()
  router.use('/:projectId/hooks', (req: Request, res: Response, next: NextFunction) => {
    const projectCtx = ctx(req)
    const hooksRouter = memoizedSubRouter(hooksRouterByCtx, projectCtx, () => createHooksRouter(
      projectCtx.project.id,
      projectCtx.broadcast,
      projectCtx.db,
      {
        get current() { return projectCtx.queueManager.getActiveJobId() },
        set current(_: string | null) { /* managed by QueueManager */ },
      }
    ))
    hooksRouter(req, res, next)
  })

  // Mount rails router under each project
  const railsRouter = createRailsRouter()
  router.use('/:projectId/rails', railsRouter)

  // Mount profiles router under each project (agent profiles)
  const profilesRouter = createProfilesRouter()
  router.use('/:projectId/profiles', profilesRouter)

  // Mount plugins router under each project (per-project marketplace)
  const pluginsRouter = createPluginsRouter()
  router.use('/:projectId/plugins', pluginsRouter)

  // Mount Jira router under each project (per-project Jira board sync)
  const jiraRouter = createJiraRouter()
  router.use('/:projectId/jira', jiraRouter)

  // Mount Code-Explorer router. FileSummaryManager comes from ProjectContext.
  const codeRouterByCtx = new WeakMap<object, Router>()
  router.use('/:projectId/code', (req: Request, res: Response, next: NextFunction) => {
    const projectCtx = ctx(req)
    const codeRouter = memoizedSubRouter(codeRouterByCtx, projectCtx, () => createCodeExplorerRouter({
      db: projectCtx.db,
      projectPath: projectCtx.project.path,
      projectId: projectCtx.project.id,
      broadcast: projectCtx.broadcast,
      fileSummaryManager: projectCtx.fileSummaryManager,
      // Relocate-artifacts: summary JSON OUTPUTS live in the workspace when
      // relocated (source tree still read from project.path). Resolved per-call.
      resolveSummaryRoot: () => {
        const exec = resolveProjectExecution({ slug: projectCtx.project.slug, path: projectCtx.project.path })
        return exec.relocated && exec.workspaceDir ? exec.workspaceDir : projectCtx.project.path
      },
    }))
    codeRouter(req, res, next)
  })


  // Relocate-artifacts gate (single chokepoint for ALL project-router ticket
  // I/O): relocated ⇒ the registry entry's ticketsPath (workspace); legacy ⇒
  // resolveTicketStoragePath (preserves integration-contract.json custom
  // storagePath). Existing in-repo projects are byte-identical.
  const ticketPath = (req: Request): string => {
    const project = ctx(req).project
    const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
    return exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(project.path)
  }
  const deps: ProjectRoutesDeps = { router, registry, ctx, ticketPath }
  registerJobsRoutes(deps)
  registerSpendingRoutes(deps)
  registerChatRoutes(deps)
  registerSetupRoutes(deps)
  registerTicketsRoutes(deps)
  registerTerminalsRoutes(deps)
  registerSettingsRoutes(deps)
  registerLoopRunRoutes(deps)

  return router
}
