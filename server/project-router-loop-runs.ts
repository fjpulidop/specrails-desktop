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
import { getAdapter, hasAdapter, reasoningEffortsForModel, supportsToolPolicy } from './providers'
import { isReasoningEffortValidForModel } from './providers/runtime'
import { resolveAgentDefaults } from './agent-defaults'
import { validateRequestedProvider } from './provider-selection'
import { isValidModelForProvider, getModelsForProvider, type SpecProvider } from './spec-models'
import { resolveProjectExecution } from './workspace-resolution'
import { referencesUnsupportedProviderCommand } from './loop-command-catalog'
import { newId } from './ids'
import type { ReasoningEffort } from './providers/types'

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
    const usageAvailable =
      !run.provider
      || !hasAdapter(run.provider)
      || getAdapter(run.provider).capabilities.reportsUsage !== false
    res.json({
      loopRun: usageAvailable
        ? { ...run, usage_available: true }
        : {
            ...run,
            total_cost_usd: null,
            total_tokens: null,
            usage_available: false,
          },
    })
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

    const check = validateRequestedProvider(c.project, aiEngine ?? providerAlias)
    if (!check.ok) { res.status(400).json({ error: check.error }); return }
    const provider = check.provider
    const adapter = getAdapter(provider)

    if (
      loop.graph.nodes.some((node) => node.type === 'decider')
      && !supportsToolPolicy(adapter, 'read-only')
    ) {
      res.status(409).json({
        code: 'provider_tool_policy_unsupported',
        provider,
        requiredPolicy: 'read-only',
        error:
          `Provider '${provider}' cannot run Loop Deciders because its headless CLI ` +
          'does not enforce a read-only tool policy.',
      })
      return
    }

    // Provider-capability guard (e.g. a loop that uses {{cmd:freestyle}}).
    const promptsText = loop.graph.nodes
      .filter((n) => n.type === 'ai-step')
      .map((n) => String(n.data?.prompt ?? ''))
      .join('\n')
    if (referencesUnsupportedProviderCommand(promptsText, provider)) {
      res.status(400).json({ error: `This loop uses a command unsupported by provider '${provider}'` }); return
    }

    // Optional explicit model — validated against the chosen provider's catalog
    // (mirrors Add Spec). Omitted ⇒ the global Specrails Agents default when
    // set (read at launch time — no restart), else the provider's default.
    const globalAgentDefaults = resolveAgentDefaults(c.desktopDb, provider)
    let model: string
    if (requestedModel !== undefined && requestedModel !== null) {
      if (!isValidModelForProvider(requestedModel, provider as SpecProvider)) {
        res.status(400).json({ error: `model is not valid for provider "${provider}"`, allowed: getModelsForProvider(provider as SpecProvider) }); return
      }
      model = requestedModel
    } else {
      model = globalAgentDefaults?.pipelineModel ?? adapter.defaultModel()
    }
    let effort: ReasoningEffort | undefined
    if (reasoning_effort !== undefined && reasoning_effort !== null) {
      const allowed = reasoningEffortsForModel(adapter, model)
      if (
        typeof reasoning_effort !== 'string' ||
        !(allowed as readonly string[]).includes(reasoning_effort)
      ) {
        res.status(400).json({
          error: `reasoning_effort is not valid for provider "${provider}" and model "${model}"`,
          allowed,
        }); return
      }
      effort = reasoning_effort as ReasoningEffort
    } else if (
      globalAgentDefaults?.pipelineEffort
      && isReasoningEffortValidForModel(adapter, model, globalAgentDefaults.pipelineEffort)
    ) {
      effort = globalAgentDefaults.pipelineEffort as ReasoningEffort
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
