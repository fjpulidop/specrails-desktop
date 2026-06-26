/**
 * Standalone loop runs (rails-as-loops). A ticket-LESS loop (one that references
 * no `{{spec.*}}` token) is launched directly against a project from the Loops
 * page "Run" action — no rail, no ticket. It surfaces as a job in THIS project's
 * Jobs history (railIndex=null), exactly like a rail loop run, with cost recorded
 * via `ai_invocations` (`surface='loop'`).
 */
import type { Request, Response } from 'express'
import type { ProjectRoutesDeps } from './project-router-helpers'
import { isLoopsEnabled } from './feature-flags'
import { getLoop } from './loops-store'
import { getLoopRun } from './loop-runs-store'
import { loadConstantMap } from './loop-constants'
import { getAdapter } from './providers'
import { validateRequestedProvider } from './provider-selection'
import { isValidModelForProvider, getModelsForProvider, type SpecProvider } from './spec-models'
import { resolveProjectExecution } from './workspace-resolution'
import { referencesClaudeOnlyCommand } from './loop-command-catalog'
import { newId } from './ids'
import type { ReasoningEffort } from './providers/types'

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high'])

export function registerLoopRunRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx } = deps

  // GET a single loop run's live/terminal state. Backs the companion's running
  // surface (a loop run has no jobId, so it can't be tailed via /jobs/:id).
  router.get('/:projectId/loop-runs/:id', (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req)
    const run = getLoopRun(c.db, req.params.id as string)
    if (!run || run.project_id !== c.project.id) {
      res.status(404).json({ error: 'Loop run not found' }); return
    }
    res.json({ loopRun: run })
  })

  router.post('/:projectId/loop-runs', (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req)
    const body = req.body ?? {}
    const { loopId, aiEngine, provider: providerAlias, reasoning_effort, model: requestedModel } = body

    if (typeof loopId !== 'string' || !loopId) {
      res.status(400).json({ error: 'loopId is required' }); return
    }
    const loop = getLoop(c.desktopDb, loopId)
    if (!loop) { res.status(404).json({ error: 'Loop not found' }); return }
    if (loop.status !== 'published') {
      res.status(400).json({ error: 'Loop must be published before it can run' }); return
    }

    let effort: ReasoningEffort | undefined
    if (reasoning_effort !== undefined && reasoning_effort !== null) {
      if (typeof reasoning_effort !== 'string' || !VALID_REASONING_EFFORTS.has(reasoning_effort)) {
        res.status(400).json({ error: 'reasoning_effort must be one of: low, medium, high' }); return
      }
      effort = reasoning_effort as ReasoningEffort
    }

    const check = validateRequestedProvider(c.project, aiEngine ?? providerAlias)
    if (!check.ok) { res.status(400).json({ error: check.error }); return }
    const provider = check.provider

    // claude-only guard (e.g. a loop that uses {{cmd:ultracode}}).
    const promptsText = loop.graph.nodes
      .filter((n) => n.type === 'ai-step')
      .map((n) => String(n.data?.prompt ?? ''))
      .join('\n')
    if (referencesClaudeOnlyCommand(promptsText) && provider !== 'claude') {
      res.status(400).json({ error: 'This loop uses a Claude-only command and requires the Claude provider' }); return
    }

    // Optional explicit model — validated against the chosen provider's catalog
    // (mirrors Add Spec). Omitted ⇒ the provider's default.
    let model: string
    if (requestedModel !== undefined && requestedModel !== null) {
      if (!isValidModelForProvider(requestedModel, provider as SpecProvider)) {
        res.status(400).json({ error: `model is not valid for provider "${provider}"`, allowed: getModelsForProvider(provider as SpecProvider) }); return
      }
      model = requestedModel
    } else {
      model = getAdapter(provider).defaultModel()
    }
    const exec = resolveProjectExecution({ slug: c.project.slug, path: c.project.path })
    const runId = newId()
    c.loopRunManager
      .run({
        runId,
        loopId,
        loopName: loop.name,
        graph: loop.graph,
        projectId: c.project.id,
        cwd: exec.cwd,
        repoDir: exec.relocated ? exec.repoDir : undefined,
        railIndex: null,
        ticketId: null,
        spec: undefined,
        constants: loadConstantMap(c.desktopDb),
        provider,
        model,
        effort,
      })
      .then((r) => c.onLoopRunFinished(r.runId, r.outcome))
      .catch((err) => {
        console.error('[loop-runs] standalone run failed:', err)
        c.onLoopRunFinished(runId, 'failed')
      })
    res.status(202).json({ loopRunId: runId })
  })
}
