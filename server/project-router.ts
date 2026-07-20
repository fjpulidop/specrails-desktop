import { Router, Request, Response, NextFunction } from 'express'
import type { ProjectRegistry, ProjectContext } from './project-registry'
import { createHooksRouter } from './hooks'
import { createRailsRouter } from './rails-router'
import { createProfilesRouter } from './profiles-router'
import { createPluginsRouter } from './plugins-router'
import { createCodeExplorerRouter } from './code-explorer-router'
import { createJiraRouter } from './jira-router'
import { resolveTicketStoragePath, mutateStore, type Ticket } from './ticket-store'
import type { LocalTicket } from './types'
import { resolveProjectExecution } from './workspace-resolution'
import { workspacePathFor } from './workspace-manager'
import { readBlueprint, writeBlueprintPair } from './blueprint-render'
import { coerceBlueprint } from './blueprint-draft-parser'
import { analyzeBuilderSpecBatch, firstBuilderSpecQualityDetail } from './blueprint-spec-quality'
import { FileStoryManager, buildStorySystemPrompt } from './file-story-manager'
import { createFileSummaryGenerator } from './file-summary-generator'
import { getAdapter } from './providers'
import { getDesktopSetting } from './desktop-db'
import { registerJobsRoutes } from './project-router-jobs'
import { registerSpendingRoutes } from './project-router-spending'
import { registerChatRoutes } from './project-router-chat'
import { registerSetupRoutes } from './project-router-setup'
import { registerTicketsRoutes } from './project-router-tickets'
import { registerTerminalsRoutes } from './project-router-terminals'
import { registerSettingsRoutes } from './project-router-settings'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import { registerGitRoutes } from './project-router-git'
import { formatDescriptionWithCriteria, type ProjectRoutesDeps } from './project-router-helpers'

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
    const codeRouter = memoizedSubRouter(codeRouterByCtx, projectCtx, () => {
      // Construction-story contribution generator — per-ctx (memoized with the
      // router). Reuses the file-summary spawn skeleton with the story prompt,
      // and the SAME monthly budget setting + ai_invocations surface, so the
      // whole Code-section AI spend rides one budget (see file-story-manager).
      const storyAdapter = getAdapter(projectCtx.project.provider ?? 'claude')
      const fileStoryManager = new FileStoryManager({
        db: projectCtx.db,
        broadcast: projectCtx.broadcast,
        generate: createFileSummaryGenerator({
          adapter: storyAdapter,
          cwd: projectCtx.project.path,
          systemPrompt: buildStorySystemPrompt,
        }),
        monthToDateSpend: (projectId: string) => {
          const row = projectCtx.db.prepare(
            `SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM ai_invocations
             WHERE project_id = ? AND surface = 'file-summary'
               AND started_at >= strftime('%Y-%m-01', 'now')`,
          ).get(projectId) as { total: number } | undefined
          return row?.total ?? 0
        },
        monthlyBudgetUsd: () => {
          const raw = getDesktopSetting(projectCtx.desktopDb, 'summary_monthly_budget_usd')
          const n = parseFloat(raw ?? '5.00')
          return isNaN(n) ? 5.0 : n
        },
        language: () => {
          const raw = getDesktopSetting(projectCtx.desktopDb, 'summary_language')
          return raw === 'es' ? 'es' : 'en'
        },
        providerId: () => storyAdapter.id,
        getTicketSpec: projectCtx.getTicketSpec,
      })
      return createCodeExplorerRouter({
        db: projectCtx.db,
        projectPath: projectCtx.project.path,
        projectId: projectCtx.project.id,
        broadcast: projectCtx.broadcast,
        fileSummaryManager: projectCtx.fileSummaryManager,
        getTicketSpec: projectCtx.getTicketSpec,
        fileStoryManager,
        aiTransformProvider: storyAdapter.id,
        // Relocate-artifacts: summary JSON OUTPUTS live in the workspace when
        // relocated (source tree still read from project.path). Resolved per-call.
        resolveSummaryRoot: () => {
          const exec = resolveProjectExecution({ slug: projectCtx.project.slug, path: projectCtx.project.path })
          return exec.relocated && exec.workspaceDir ? exec.workspaceDir : projectCtx.project.path
        },
      })
    })
    codeRouter(req, res, next)
  })


  // Project Builder sidebar re-entry (add-project-builder D5): read the
  // workspace-resident blueprint pair's source of truth. 404 when the project
  // has no blueprint (every non-Builder project) — the sidebar entry hides.
  router.get('/:projectId/blueprint', (req: Request, res: Response) => {
    const project = ctx(req).project
    const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
    const workspace = exec.relocated && exec.workspaceDir
      ? exec.workspaceDir
      : (project.slug ? workspacePathFor(project.slug) : null)
    const blueprint = workspace ? readBlueprint(workspace) : null
    if (!blueprint) {
      res.status(404).json({ error: 'no blueprint for this project' })
      return
    }
    res.json({ blueprint })
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
  // Milestone batch commit (add-project-builder D7): insert one blueprint
  // milestone's generated specs as `M<n>`-labeled todo tickets, flip that
  // milestone to `committed`, and re-render the blueprint pair. Jira-connected
  // projects ride the existing materializer on the store mutation unchanged.
  router.post('/:projectId/blueprint/commit-milestone', (req: Request, res: Response) => {
    const projectCtx = ctx(req)
    const project = projectCtx.project
    const body = (req.body ?? {}) as { milestoneId?: unknown; specsComplete?: unknown; specs?: unknown }
    const milestoneId = typeof body.milestoneId === 'string' && /^m[0-9]{1,3}$/i.test(body.milestoneId)
      ? body.milestoneId.toLowerCase()
      : null
    if (!milestoneId) {
      res.status(400).json({ error: 'milestoneId (e.g. "m2") is required' })
      return
    }
    const rawSpecs = Array.isArray(body.specs) ? body.specs : []
    if (rawSpecs.length === 0) {
      res.status(400).json({ error: 'specs must contain at least one titled spec' })
      return
    }
    const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
    const workspace = exec.relocated && exec.workspaceDir
      ? exec.workspaceDir
      : (project.slug ? workspacePathFor(project.slug) : null)
    const blueprint = workspace ? readBlueprint(workspace) : null
    if (!workspace || !blueprint) {
      res.status(404).json({ error: 'no blueprint for this project' })
      return
    }
    const milestone = blueprint.milestones.find((m) => m.id === milestoneId)
    if (!milestone) {
      res.status(404).json({ error: `milestone ${milestoneId} not found in the blueprint` })
      return
    }
    if (milestone.status !== 'planned') {
      res.status(409).json({ error: `milestone ${milestoneId} is already ${milestone.status}` })
      return
    }
    const label = milestoneId.toUpperCase()
    const quality = analyzeBuilderSpecBatch(
      { specsComplete: body.specsComplete, specs: rawSpecs },
      { milestoneLabel: label, minSpecs: 1, maxSpecs: 10, requireScaffold: false },
    )
    if (!quality.valid) {
      res.status(400).json({ error: 'milestone_spec_quality_invalid', detail: firstBuilderSpecQualityDetail(quality) })
      return
    }
    const coerced = coerceBlueprint({ blueprintVersion: 1, specsComplete: true, m1Specs: rawSpecs })
    const specs = coerced?.m1Specs ?? []
    try {
      const created: Ticket[] = []
      mutateStore(ticketPath(req), (store) => {
        const indexToId = new Map<number, number>()
        specs.forEach((spec, index) => {
          const id = store.next_id
          store.next_id += 1
          const now = new Date().toISOString()
          const labels = spec.labels.includes(label) ? spec.labels : [...spec.labels, label]
          const prerequisite = spec.dependsOnIndex
          const prerequisites = prerequisite !== undefined && indexToId.has(prerequisite)
            ? [indexToId.get(prerequisite)!]
            : []
          const ticket: Ticket = {
            id,
            title: spec.title,
            description: formatDescriptionWithCriteria(spec.description, spec.acceptanceCriteria),
            status: 'todo',
            priority: spec.priority,
            labels,
            assignee: null,
            prerequisites,
            metadata: {},
            origin_conversation_id: null,
            is_epic: false,
            parent_epic_id: null,
            execution_order: null,
            short_summary: spec.shortSummary,
            created_at: now,
            updated_at: now,
            created_by: 'project-builder',
            source: 'project-builder',
          }
          store.tickets[String(id)] = ticket
          created.push(ticket)
          indexToId.set(index, id)
        })
      })
      milestone.status = 'committed'
      milestone.ticketIds = created.map((t) => t.id)
      writeBlueprintPair(workspace, blueprint)
      for (const ticket of created) {
        projectCtx.broadcast({
          type: 'ticket_created',
          ticket: ticket as unknown as LocalTicket,
          projectId: project.id,
          timestamp: new Date().toISOString(),
        })
      }
      res.status(201).json({ insertedIds: created.map((t) => t.id), milestone: milestone.id })
    } catch (err) {
      console.error('[project-router] commit-milestone error:', err)
      res.status(500).json({ error: 'Failed to commit the milestone' })
    }
  })

  const deps: ProjectRoutesDeps = { router, registry, ctx, ticketPath }
  registerJobsRoutes(deps)
  registerSpendingRoutes(deps)
  registerChatRoutes(deps)
  registerSetupRoutes(deps)
  registerTicketsRoutes(deps)
  registerTerminalsRoutes(deps)
  registerSettingsRoutes(deps)
  registerLoopRunRoutes(deps)
  registerGitRoutes(deps)

  return router
}
