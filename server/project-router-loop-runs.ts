import { ensureIsolatedSettlementSnapshot } from './modules/delivery/runtime/isolated-settlement-reconstruction'
/**
 * Standalone loop runs (rails-as-loops). A ticket-LESS loop (one that references
 * no `{{spec.*}}` token) is launched directly against a project from the Loops
 * page "Run" action — no rail, no ticket. It surfaces as a job in THIS project's
 * Jobs history (railIndex=null), exactly like a rail loop run, with cost recorded
 * via `ai_invocations` (`surface='loop'`).
 */
import type { Request, Response } from 'express'
import { validateLoopGraph, assertLoopShellRepositoryScope } from './modules/loops/runtime/loop-graph'
import type { ProjectRoutesDeps } from './project-router-helpers'
import type { ProjectContext } from './project-registry'
import { isLoopsEnabled } from './feature-flags'
import { getLoop } from './modules/loops/runtime/loops-store'
import { definitionRunNeverReachedCore, getLoopRun, readDefinitionLineage, readDefinitionExecutionClaim, readDefinitionRun, readDefinitionSuccessor } from './modules/loops/runtime/loop-runs-store'
import { forkDefinitionRun, validateDefinitionForkRequest } from './modules/delivery/runtime/definition-fork'
import { IncompleteTasksRemedyError } from './modules/delivery/runtime/incomplete-tasks-remedy'
import { normalizeContinueRemedy, planContinuation, type ContinueRemedy } from './modules/delivery/runtime/run-continuation'
import { EnvFilesUnavailableError, enableEnvFilesForRun } from './modules/delivery/runtime/run-env-files'
import { readAttemptChain, recordRunContinuation } from './modules/loops/runtime/run-attempts'
import { signalDefinitionRun } from './modules/agent-runtime/runtime/agent-runtime-controls-router'
import { continuationGuidance, parseStoredDiagnosis, readStoredOptions, resolutionGuidance, type ResolutionChoice } from './modules/recovery'
import { reattachIsolatedSettlement } from './modules/delivery/runtime/rail-isolated-launch'
import { finishDefinitionCancellation } from './modules/loops/runtime/definition-cancellation'
import { appendEvent, updateProjectSettings } from './db'
import { clearLimitPause, readLimitPause, saveLimitPause } from './modules/loops/runtime/loop-limit-pauses'
import { sharesQuota } from './modules/provider-quota/domain'
import { validateDefinitionResumeControls } from './modules/loops/runtime/loop-definition-controls'
import { createLoopProviderSwitch, routeOverrideRequest, validateSwitchChoice } from './modules/loops/runtime/loop-provider-switch'
import { acceptedRouteOverrides } from './modules/agent-runtime/runtime/agent-runtime-route-overrides'
import { probeDefinitionRun } from './modules/loops/runtime/loop-definition-recovery'
import { MIN_DURATION_SAMPLES, getJobCommandDurationRange, getLoopDurationRange, jobCommandShape } from './modules/execution/runtime/run-duration-stats'
import { getLaunchForecast } from './modules/execution/runtime/launch-forecast'
import { loadConstantMap } from './modules/loops/runtime/loop-constants'
import { getAdapter, hasAdapter, reasoningEffortsForModel, supportsToolPolicy } from './providers'
import { isReasoningEffortValidForModel } from './providers/runtime'
import { resolveAgentDefaults } from './modules/agents/runtime/agent-defaults'
import { validateRequestedProvider } from './provider-selection'
import { isValidModelForProvider, getModelsForProvider, type SpecProvider } from './modules/specs/runtime/spec-models'
import { resolveProjectExecution } from './workspace-resolution'
import { referencesUnsupportedProviderCommand } from './modules/loops/runtime/loop-command-catalog'
import { newId } from './ids'
import { readChainResolution, readFailureAnalysis, readRunDiagnosis, readVerificationTests } from './modules/recovery/adapters/sqlite'
import type { ReasoningEffort } from './providers/types'
import { getProjectRepositories, validateTicketRepositoryIds, validateWorkspaceSelection, RepositoryValidationError } from './project-repositories'
import { launchMultiRepositoryRail } from './modules/delivery/runtime/multi-repo-execution'
import { getRails, getRail, createRail, deleteRail, MAX_RAILS } from './modules/delivery/runtime/rails-store'
import { getActivePrDeliveryByRail } from './modules/delivery/runtime/rail-pr-store'
import { isolationApplies } from './modules/delivery/runtime/rail-isolation'
import { assertProcessAdmission, awaitProcessAdmission, ProcessAdmissionClosedError } from './process-admission'

const pendingCancellations = new WeakMap<object, Map<string, Promise<void>>>()

export function registerLoopRunRoutes(deps: ProjectRoutesDeps): void {
  const { router, ctx } = deps

  router.get('/:projectId/loop-runs/:id/recovery', async (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req), runId = String(req.params.id), run = getLoopRun(c.db, runId)
    if (!run || run.project_id !== c.project.id || run.engine_version !== 2) { res.status(404).json({ error: 'Definition run not found' }); return }
    const probe = await probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, runId)
    const forkOperation = c.db.prepare('SELECT request_json,child_run_id,adopted FROM definition_fork_operations WHERE project_id=? AND source_run_id=? ORDER BY adopted DESC,created_at LIMIT 1').get(c.project.id, runId) as { request_json: string; child_run_id: string; adopted: number } | undefined
    res.json({ ...probe, lineage: readDefinitionLineage(c.db, runId), ...(forkOperation ? { forkRequest: JSON.parse(forkOperation.request_json), forkRunId: forkOperation.child_run_id, forkAdopted: !!forkOperation.adopted } : {}) })
  })

  router.post('/:projectId/loop-runs/:id/resume', async (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req), runId = String(req.params.id), run = getLoopRun(c.db, runId)
    // rail-loop-budget-guard: a resident run paused on the daily budget (either
    // engine) resumes in place once the budget allows the next step.
    if (run && run.project_id === c.project.id && c.loopRunManager.budgetPause?.(runId)) {
      // A per-run soft cap is answered explicitly: `{ runCap: 'ignore' }` continues
      // without it, `{ runCapUsd: n }` raises it. Anything else leaves it standing.
      const body = (req.body ?? {}) as { runCap?: unknown; runCapUsd?: unknown }
      const choice = body.runCap === 'ignore' ? { ignore: true as const }
        : typeof body.runCapUsd === 'number' && Number.isFinite(body.runCapUsd) && body.runCapUsd > 0 ? { raiseTo: body.runCapUsd } : undefined
      const resumed = c.loopRunManager.resumeBudgetPause(runId, choice)
      if (resumed.status === 'over_budget') { res.status(409).json(resumed.rejection); return }
      if (resumed.status === 'resumed') { res.status(202).json({ loopRunId: runId, resumed: true }); return }
    }
    // provider-quota: a resident run waiting for a usage-limit reset resumes now (the provider may still refuse).
    if (run && run.project_id === c.project.id && c.loopRunManager.limitPause?.(runId)) {
      c.loopRunManager.resolveLimitPause(runId, { action: 'resume' })
      res.status(202).json({ loopRunId: runId, resumed: true }); return
    }
    // A run a Desktop restart interrupted is resumed from the inbox or the restart dialog
    // with an empty body. That click is the person's explicit recovery (see resumeRetainedDefinitionRun).
    const controls: unknown = req.body ?? {}
    const restartResume = !!run && isRestartResume(run, controls)
    // Any Continue of a run the restart paused (also one naming the attempts to recover)
    // waits out the dead Core child's lease instead of answering runtime_run_active.
    const outcome = await resumeRetainedDefinitionRun(c, runId, controls, { restartResume, waitForStaleLease: !!run && run.status === 'paused' && run.restart_reason === 'restart' })
    res.status(outcome.status).json(outcome.body)
  })

  // provider-quota: answer a run paused on a provider usage limit — resume now,
  // continue on another provider (never one sharing the quota), or turn its
  // automatic resume at the reset on/off. A run retained over a restart
  // resumes through the regular retained-run path.
  router.post('/:projectId/loop-runs/:id/limit', async (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req), runId = String(req.params.id), run = getLoopRun(c.db, runId)
    if (!run || run.project_id !== c.project.id) { res.status(404).json({ error: 'Loop run not found' }); return }
    const body = (req.body ?? {}) as { action?: unknown; provider?: unknown; enabled?: unknown; model?: unknown; effort?: unknown; remember?: unknown }
    const live = c.loopRunManager.limitPause?.(runId) ?? null
    const retained = live ? null : run.status === 'paused' ? readLimitPause(c.db, runId) : null
    if (!live && !retained) { res.status(409).json({ error: 'not_limit_paused' }); return }
    if (body.action === 'auto' && typeof body.enabled === 'boolean') {
      if (live) c.loopRunManager.resolveLimitPause(runId, { action: 'auto', enabled: body.enabled })
      else saveLimitPause(c.db, runId, { ...retained!, autoResume: body.enabled })
      res.json({ limit: live ? c.loopRunManager.limitPause(runId) : readLimitPause(c.db, runId) }); return
    }
    if (body.action === 'resume') {
      if (live) { c.loopRunManager.resolveLimitPause(runId, { action: 'resume' }); res.status(202).json({ loopRunId: runId, resumed: true }); return }
      const outcome = await resumeRetainedDefinitionRun(c, runId, {}, limitResumeOptions(run))
      res.status(outcome.status).json(outcome.body); return
    }
    // A Core definition run (Core routeOverrides): the roles on the limited provider continue on the
    // chosen provider/model/effort for the rest of the run. Validated here against the offer and the
    // provider catalogs; Core validates the effective configuration again before it runs a step.
    if (body.action === 'switch' && (live ?? retained!).switchTargets) {
      const limit = live ?? retained!
      const checked = validateSwitchChoice(limit, body)
      if (!checked.ok) { res.status(checked.status).json({ error: checked.error, detail: checked.detail }); return }
      const installed = validateRequestedProvider(c.project, checked.choice.provider)
      if (!installed.ok) { res.status(400).json({ error: 'invalid_provider', detail: installed.error }); return }
      const { choice } = checked
      if (live) {
        if (!c.loopRunManager.resolveLimitPause(runId, { action: 'switch', ...choice })) { res.status(409).json({ error: 'switch_unavailable' }); return }
        res.status(202).json({ loopRunId: runId, provider: choice.provider, model: choice.model, effort: choice.effort ?? null }); return
      }
      // Retained over a restart: resume it through the regular retained-run path with the override.
      const contextPath = readDefinitionRun(c.db, runId)?.metadata.contextPath
      if (!contextPath || !limit.switchRoles?.length) { res.status(409).json({ error: 'switch_unavailable', detail: 'This run cannot change provider mid-run' }); return }
      const routeOverrides = routeOverrideRequest({ runId, sequence: acceptedRouteOverrides(contextPath).length + 1, fromProvider: limit.providerId, roles: limit.switchRoles, choice })
      if (choice.remember) {
        try { createLoopProviderSwitch(c.project).remember(Object.fromEntries(limit.switchRoles.map(role => [role, choice]))) }
        catch (error) { res.status(409).json({ error: 'remember_failed', detail: error instanceof Error ? error.message : String(error) }); return }
      }
      const outcome = await resumeRetainedDefinitionRun(c, runId, { routeOverrides }, limitResumeOptions(run))
      res.status(outcome.status).json(outcome.status < 300 ? { ...outcome.body, provider: choice.provider, model: choice.model, effort: choice.effort ?? null } : outcome.body); return
    }
    if (body.action === 'switch' && typeof body.provider === 'string') {
      const limit = live ?? retained!
      if (!live || !limit.switchable) { res.status(409).json({ error: 'switch_unavailable', detail: 'This run cannot change provider mid-run' }); return }
      if (sharesQuota(limit.providerId, body.provider)) { res.status(409).json({ error: 'shares_quota', detail: `${body.provider} uses the same usage limit` }); return }
      const checked = validateRequestedProvider(c.project, body.provider)
      if (!checked.ok || !hasAdapter(body.provider)) { res.status(400).json({ error: 'invalid_provider', detail: checked.ok ? 'Unknown provider' : checked.error }); return }
      const model = getAdapter(body.provider).defaultModel()
      if (!c.loopRunManager.resolveLimitPause(runId, { action: 'switch', provider: body.provider, model })) { res.status(409).json({ error: 'switch_unavailable' }); return }
      res.status(202).json({ loopRunId: runId, provider: body.provider, model }); return
    }
    res.status(400).json({ error: 'invalid_limit_action' })
  })

  router.post('/:projectId/loop-runs/:id/cancel', async (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req), runId = String(req.params.id), run = getLoopRun(c.db, runId)
    if (!run || run.project_id !== c.project.id || run.engine_version !== 2) { res.status(404).json({ error: 'Definition run not found' }); return }
    const body = req.body ?? {}
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'requestId') ||
      body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.requestId))) {
      res.status(400).json({ error: 'invalid_cancellation' }); return
    }
    const requestId = body.requestId ?? `desktop-cancel:${runId}`
    try {
      await cancelDefinitionRun(c, runId, requestId)
      res.status(202).json({ loopRunId: runId, cancellationRequested: true })
    } catch (error) {
      res.status(409).json({ error: 'runtime_cancel_rejected', detail: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post('/:projectId/loop-runs/:id/fork', async (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req), runId = String(req.params.id), run = getLoopRun(c.db, runId)
    if (!run || run.project_id !== c.project.id || run.engine_version !== 2) { res.status(404).json({ error: 'Definition run not found' }); return }
    let input
    try { input = validateDefinitionForkRequest(req.body) }
    catch (error) { res.status(400).json({ error: 'invalid_fork_request', detail: error instanceof Error ? error.message : String(error) }); return }
    try {
      assertProcessAdmission(c.project.id)
      const result = await forkDefinitionRun(c, runId, input)
      // The linked run continues on its own from the selected step: a fork
      // nobody resumes is a paused job the user must find and restart.
      const resumed = await resumeDefinitionRunFromStop(c, result.loopRunId)
      res.status(201).json({ ...result, resumed: resumed.ok, ...(resumed.ok ? {} : { resumeError: resumed.error, ...(resumed.detail ? { resumeDetail: resumed.detail } : {}) }) })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      res.status(detail === 'runtime_status_unavailable' ? 503 : 409).json({ error: 'runtime_fork_rejected', detail })
    }
  })

  // Continue a failed or stopped run, keeping its work: in place when the runtime can resume it,
  // otherwise as the next attempt from the step that failed or stopped, with the cause's guidance.
  // `continue-to-review` hands the remaining checks to a person. `retry-with-browser` is the older id of `continue`.
  router.post('/:projectId/loop-runs/:id/remedy', async (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req), runId = String(req.params.id), run = getLoopRun(c.db, runId)
    if (!run || run.project_id !== c.project.id || run.engine_version !== 2) { res.status(404).json({ error: 'Definition run not found' }); return }
    // "Copy this project's .env into runs": turn the project setting on, copy the env files into
    // this run's worktree(s), then the regular Continue (its guidance names the copies).
    if ((req.body ?? {}).remedy === 'copy-env-files') {
      let envFilesCopied: string[]
      try {
        const copy = await enableEnvFilesForRun(c, runId, { enable: () => updateProjectSettings(c.db, { worktreeEnvFiles: true }) })
        envFilesCopied = copy.copied
        if (copy.warnings.length) console.warn(`[continue] env files for ${runId}: ${copy.warnings.join('; ')}`)
      } catch (error) {
        if (error instanceof EnvFilesUnavailableError) { res.status(409).json({ error: error.code, detail: error.message }); return }
        res.status(500).json({ error: 'env_files_failed', detail: error instanceof Error ? error.message : String(error) }); return
      }
      const outcome = await continueDefinitionRun(c, runId, 'continue', { envFilesCopied })
      res.status(outcome.status).json({ ...outcome.body, envFilesEnabled: true, envFilesCopied })
      return
    }
    // A resolution the person picked from the AI analysis (by id: its guidance is read from the stored
    // analysis, never from the request), or their own instruction.
    const choice = resolutionRequest(c.db, runId, req.body ?? {})
    if ('error' in choice) { res.status(choice.status).json({ error: choice.error, ...(choice.detail ? { detail: choice.detail } : {}) }); return }
    const remedy = choice.remedy ?? normalizeContinueRemedy((req.body ?? {}).remedy)
    if (!remedy) { res.status(400).json({ error: 'invalid_remedy' }); return }
    const outcome = await continueDefinitionRun(c, runId, remedy, choice.resolution ? { resolution: choice.resolution } : {})
    res.status(outcome.status).json({ ...outcome.body, ...(choice.label ? { option: choice.label } : {}) })
  })

  // The attempt chain a run belongs to (oldest first), for the run window's lineage (null without
  // lineage), and whether Continue applies: a settled or paused definition run no later attempt took over.
  router.get('/:projectId/loop-runs/:id/attempts', (req: Request, res: Response) => {
    const c = ctx(req), runId = String(req.params.id), run = getLoopRun(c.db, runId)
    if (!run || run.project_id !== c.project.id) { res.status(404).json({ error: 'Loop run not found' }); return }
    const continuable = run.engine_version === 2 && (run.status === 'completed' ? run.final_outcome !== 'success' : run.status === 'paused' && run.restart_reason !== 'fork')
      && !readDefinitionSuccessor(c.db, runId)
    let chain: ReturnType<typeof readAttemptChain> = null
    try { chain = readAttemptChain(c.db, runId) } catch { chain = null }
    // The chain's spend and whether it keeps stopping for the same cause (the card then leads with the options).
    let resolution: ReturnType<typeof readChainResolution> = null
    try { resolution = chain ? readChainResolution(c.db, runId) : null } catch { resolution = null }
    res.json({ chain, continuable, resolution })
  })

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
    const { failure_diagnosis: _stored, ...publicRun } = run
    const limitPause = c.loopRunManager.limitPause?.(run.id) ?? (run.status === 'paused' ? readLimitPause(c.db, run.id) : null)
    const failureDiagnosis = (() => { try { return readRunDiagnosis(c.db, run.id) } catch { return null } })()
    res.json({
      loopRun: usageAvailable
        ? { ...publicRun, failureDiagnosis, limitPause, usage_available: true }
        : {
            ...publicRun,
            failureDiagnosis,
            limitPause,
            total_cost_usd: null,
            total_tokens: null,
            usage_available: false,
          },
    })
  })

  // Measured duration band for "runs like this have taken X–Y". Returns
  // `range: null` below the sample floor — the caller MUST render nothing
  // rather than a guess (honest-metrics contract; see run-duration-stats).
  router.get('/:projectId/run-duration-range', (req: Request, res: Response) => {
    const c = ctx(req)
    const loopId = typeof req.query.loopId === 'string' ? req.query.loopId : null
    const command = typeof req.query.command === 'string' ? req.query.command : null
    if (!loopId && !command) {
      res.status(400).json({ error: 'loopId or command is required' }); return
    }
    const range = loopId
      ? getLoopDurationRange(c.db, c.project.id, loopId)
      : getJobCommandDurationRange(c.db, jobCommandShape(command as string))
    res.json({ range, minSamples: MIN_DURATION_SAMPLES })
  })

  // Launch forecast ("Usually 6-9 min · $2-4 for runs like this"): the same
  // measured samples as run-duration-range, narrowed to the provider about to
  // run, plus a provider-reported cost band and the tightest daily budget's
  // headroom. Read-only. `time`/`cost` are null below the sample floor — the
  // caller MUST say "Not enough history yet", never guess. Costs here are an
  // estimate from past runs, never a billed figure.
  router.get('/:projectId/launch-forecast', (req: Request, res: Response) => {
    const c = ctx(req)
    const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null)
    const loopId = text(req.query.loopId)
    const command = text(req.query.command)
    const provider = text(req.query.provider)
    if (!loopId && !command) {
      res.status(400).json({ error: 'loopId or command is required' }); return
    }
    if (provider && !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(provider)) {
      res.status(400).json({ error: 'provider is invalid' }); return
    }
    const forecast = getLaunchForecast(c.db, c.project.id, {
      loopId,
      commandShape: command ? jobCommandShape(command) : null,
      provider,
    })
    res.json({ ...forecast, budget: c.dailyBudgetHeadroom?.() ?? null })
  })

  router.post('/:projectId/loop-runs', async (req: Request, res: Response) => {
    if (!isLoopsEnabled()) { res.status(404).json({ error: 'Not Found' }); return }
    const c = ctx(req)
    const body = req.body ?? {}
    const { loopId, aiEngine, provider: providerAlias, reasoning_effort, model: requestedModel } = body
    // Per-launch override of the per-run soft cap: a number > 0 caps this run, 0 waives the default.
    const runCapUsd = typeof body.runCapUsd === 'number' && Number.isFinite(body.runCapUsd) && body.runCapUsd >= 0 ? body.runCapUsd : undefined

    if (typeof loopId !== 'string' || !loopId) {
      res.status(400).json({ error: 'loopId is required' }); return
    }
    const loop = getLoop(c.desktopDb, loopId)
    if (!loop) { res.status(404).json({ error: 'Loop not found' }); return }
    if (loop.status !== 'published') {
      res.status(400).json({ error: 'Loop must be published before it can run' }); return
    }
    const validation = validateLoopGraph(loop.graph)
    if (!validation.valid) {
      res.status(422).json({ error: 'Loop graph is invalid', errors: validation.errors }); return
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
    let repositoryIds: string[]
    let workspaceSelection: Record<string, string[]> | undefined
    const primary = getProjectRepositories(c.project).find((repository) => repository.isPrimary)!
    try {
      repositoryIds = validateTicketRepositoryIds(c.project, body.repositoryIds) ?? [primary.id]
      workspaceSelection = validateWorkspaceSelection(c.project, body.workspaceSelection, repositoryIds)
      assertLoopShellRepositoryScope(loop.graph, repositoryIds)
      assertProcessAdmission(c.project.id)
    } catch (error) {
      res.status(error instanceof RepositoryValidationError ? error.status : error instanceof ProcessAdmissionClosedError ? 409 : 400).json({ error: error instanceof Error ? error.message : 'Invalid repository scope' }); return
    }
    // Standalone loop runs are cost-incurring launches too (rail-loop-budget-guard).
    const budgetRejection = c.dailyBudgetRejection?.() ?? null
    if (budgetRejection) { res.status(409).json(budgetRejection); return }
    if (repositoryIds.length !== 1 || repositoryIds[0] !== primary.id) {
      if (!isolationApplies({ loopsEnabled: true, scope: 'all', ticketCount: 1, readOnly: false })) {
        res.status(409).json({ error: 'repository_isolation_required' }); return
      }
      // A real empty rail makes the grouped delivery reviewable from the board
      // without manufacturing a spec for a ticket-less loop.
      const rails = getRails(c.db)
      const used = new Set([...c.railJobs.values(), ...c.railLoopRuns.values()].map((run) => run.railIndex))
      let rail = rails.find((candidate) => candidate.ticketIds.length === 0 && !used.has(candidate.railIndex) && !getActivePrDeliveryByRail(c.db, candidate.railIndex))
      let created = false
      if (!rail) {
        if (rails.length >= MAX_RAILS) { res.status(409).json({ error: 'no_available_rail', detail: 'Finish a pending rail delivery before launching another isolated loop.' }); return }
        rail = createRail(c.db, loop.name)
        created = true
      }
      const reservationId = `preparing-${newId()}`
      c.railLoopRuns.set(reservationId, { railIndex: rail.railIndex, ticketIds: [], requiresTerminalIntent: true })
      try {
        let prDeliveryId: string | undefined
        const ids = await launchMultiRepositoryRail({
          ctx: c, railIndex: rail.railIndex, ticketIds: [], repositoryIds, workspaceSelection, scope: 'all',
          loopId, loopName: loop.name, loopGraph: loop.graph, provider, model, effort,
          onPrDeliveryCreated: (id) => { prDeliveryId = id },
        })
        res.status(202).json({ loopRunId: ids[0], railIndex: rail.railIndex, prDeliveryId, isolated: true })
      } catch (error) {
        if (created && !getActivePrDeliveryByRail(c.db, rail.railIndex)) deleteRail(c.db, rail.railIndex)
        res.status(409).json({ error: 'repository_launch_failed', detail: error instanceof Error ? error.message : String(error) })
      } finally {
        c.railLoopRuns.delete(reservationId)
        if (created && getRails(c.db).some((candidate) => candidate.railIndex === rail.railIndex)) {
          const current = getRail(c.db, rail.railIndex)
          c.broadcast({ type: 'rail.updated', projectId: c.project.id, railIndex: current.railIndex,
            changed: 'name', ticketIds: current.ticketIds, name: current.name ?? null,
            mode: current.mode, profileName: current.profileName ?? null, aiEngine: current.aiEngine ?? null })
        }
      }
      return
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
        repositoryId: primary.id,
        workspacePaths: workspaceSelection?.[primary.id],
        cwd: exec.cwd,
        repoDir: exec.relocated ? exec.repoDir : undefined,
        railIndex: null,
        ticketId: null,
        spec: undefined,
        constants: loadConstantMap(c.desktopDb),
        provider,
        model,
        effort,
        ...(runCapUsd !== undefined ? { runCapUsd } : {}),
      })
      .then((r) => c.onLoopRunFinished(r.runId, r.outcome, r.stallReason ? { stallReason: r.stallReason } : undefined))
      .catch((err) => {
        console.error('[loop-runs] standalone run failed:', err)
        c.onLoopRunFinished(runId, 'failed')
      })
    res.status(202).json({ loopRunId: runId })
  })
}

/**
 * Continue a retained definition run (the HTTP resume, also used by startup
 * recovery to re-dispatch pending host tasks). Returns the HTTP outcome.
 */
/**
 * Cancel a Core (engine v2) run through every door that stops one (this route,
 * `POST /jobs/:id/cancel`, the rail's Stop). A resident run settles through its
 * own traversal; a run this process does not drive (paused, recovered after a
 * restart) is settled here once Core confirms the cancellation, so it never
 * stays "paused" over a run Core already cancelled.
 */
export async function cancelDefinitionRun(c: ProjectContext, runId: string, requestId = `desktop-cancel:${runId}`): Promise<void> {
  const resident = c.loopRunManager.isDefinitionRunActive(runId)
  // A restart stopped it while it waited for capacity: Core never saw it, so it settles stopped here.
  const never = getLoopRun(c.db, runId)
  if (!resident && never?.status === 'paused' && never.restart_reason === 'restart' && definitionRunNeverReachedCore(c.db, runId)) {
    assertProcessAdmission(c.project.id)
    const claim = readDefinitionExecutionClaim(c.db, runId)
    if (claim) c.db.prepare(`DELETE FROM definition_execution_claims WHERE run_id = ? AND owner = ?
      AND EXISTS (SELECT 1 FROM loop_runs WHERE id = ? AND project_id = ? AND status = 'paused' AND restart_reason = 'restart')`)
      .run(runId, claim.owner, runId, c.project.id)
    const snapshot = ensureIsolatedSettlementSnapshot(c.db, c.project.id, runId)
    const result = await c.loopRunManager.stopNeverStarted(runId)
    if (snapshot) await reattachIsolatedSettlement(c, snapshot.delivery_id, runId)
    else c.onLoopRunFinished(runId, result.outcome)
    return
  }
  await c.loopRunManager.cancelDefinition(runId, requestId)
  let pending = pendingCancellations.get(c)
  if (!pending) { pending = new Map(); pendingCancellations.set(c, pending) }
  if (!resident && !c.loopRunManager.isDefinitionRunActive(runId) && !pending.has(runId)) {
    let observedClaim: ReturnType<typeof readDefinitionExecutionClaim>
    const task = finishDefinitionCancellation({
      inspect: () => {
        observedClaim = readDefinitionExecutionClaim(c.db, runId)
        return probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, runId)
      },
      cancel: () => c.loopRunManager.cancelDefinition(runId, requestId),
      stopped: () => c.loopRunManager.isDisposed(), now: Date.now,
      wait: milliseconds => new Promise(resolve => { const timer = setTimeout(resolve, milliseconds); timer.unref() }),
      settle: async () => {
        assertProcessAdmission(c.project.id)
        if (observedClaim) c.db.prepare(`DELETE FROM definition_execution_claims WHERE run_id=? AND owner=?
          AND EXISTS (SELECT 1 FROM loop_runs WHERE id=? AND project_id=? AND status='paused' AND restart_reason='restart')`)
          .run(runId, observedClaim.owner, runId, c.project.id)
        const snapshot = ensureIsolatedSettlementSnapshot(c.db, c.project.id, runId)
        if (!snapshot && readDefinitionRun(c.db, runId)?.request.deferTerminalOutcome) throw new Error('Original isolated settlement snapshot is unavailable')
        const current = getLoopRun(c.db, runId)!
        const result = current.status === 'completed' ? { outcome: current.final_outcome ?? 'stopped' } : await c.loopRunManager.beginDefinitionResume(runId)
        if (snapshot) await reattachIsolatedSettlement(c, snapshot.delivery_id, runId)
        else c.onLoopRunFinished(runId, result.outcome)
      },
    }).catch(error => {
      // Keep an actionable durable diagnostic; never replace Core's result
      // or turn a failed observation into a successful cancellation.
      try { if (!c.loopRunManager.isDisposed()) c.db.transaction(() => {
        const sequence = (c.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM events WHERE job_id=?').get(runId) as { seq: number }).seq
        appendEvent(c.db, runId, sequence, { event_type: 'definition-control-error', source: 'stderr', payload: JSON.stringify({ action: 'cancel', requestId, message: error instanceof Error ? error.message : String(error) }) })
      })() } catch (diagnosticError) { console.error('[loop-runs] cancellation diagnostic unavailable:', runId, diagnosticError) }
    }).finally(() => pending!.delete(runId))
    pending.set(runId, task)
  }
}

/** Prepare delivery for a definition run Core already finished. Spends no
 * tokens and never resumes the workflow, so no budget gate applies; it reuses
 * the original isolated settlement exactly like a completed resume. */
export async function settleCompletedDefinitionRun(c: ProjectContext, runId: string): Promise<void> {
  const run = getLoopRun(c.db, runId)
  if (!run || run.project_id !== c.project.id || run.engine_version !== 2) throw new Error('Definition run not found')
  if (run.status !== 'completed') throw new Error('Wait for the workflow to finish before preparing delivery')
  if (readDefinitionSuccessor(c.db, runId)) throw new Error('A fork owns this worktree; settle the fork instead')
  assertProcessAdmission(c.project.id)
  const snapshot = ensureIsolatedSettlementSnapshot(c.db, c.project.id, runId)
  if (!snapshot) throw new Error('Original isolated settlement snapshot is unavailable')
  await reattachIsolatedSettlement(c, snapshot.delivery_id, runId)
}

export interface ContinueOptions {
  /** Specrails continued on its own (recorded, and bounded to one per chain by the caller). */
  automatic?: boolean
  /** Env files the person's remedy just copied into the run's worktree (named in the guidance). */
  envFilesCopied?: string[]
  /** The resolution the person picked (an AI option or their own instruction): its guidance goes with Continue. */
  resolution?: ResolutionChoice
}

/** Longest instruction a person can continue a run with. */
export const MAX_INSTRUCTION_CHARS = 4_000

type ResolutionRequest =
  | { remedy?: ContinueRemedy; resolution?: ResolutionChoice; label?: string }
  | { error: string; status: number; detail?: string }

/**
 * Validate a remedy request's resolution: `{ optionId }` picks an option of this run's stored AI
 * analysis (the server reads its kind and guidance), `{ instruction }` continues with the person's
 * own words. Options that are not a Continue (edit the spec, change a model, start over) run on the client.
 */
export function resolutionRequest(db: ProjectContext['db'], runId: string, body: Record<string, unknown>): ResolutionRequest {
  const { optionId, instruction } = body
  if (optionId === undefined && instruction === undefined) return {}
  if (optionId !== undefined && instruction !== undefined) return { error: 'invalid_resolution', status: 400, detail: 'Send an option or an instruction, not both' }
  if (body.remedy !== undefined && body.remedy !== 'continue') return { error: 'invalid_resolution', status: 400, detail: 'A resolution continues the run' }
  if (instruction !== undefined) {
    const text = typeof instruction === 'string' ? instruction.trim() : ''
    if (!text || text.length > MAX_INSTRUCTION_CHARS) return { error: 'invalid_instruction', status: 400, detail: `An instruction is 1-${MAX_INSTRUCTION_CHARS} characters` }
    return { remedy: 'continue', resolution: { kind: 'instruction', text } }
  }
  if (typeof optionId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(optionId)) return { error: 'invalid_option', status: 400 }
  let options: ReturnType<typeof readStoredOptions> = []
  try { options = readStoredOptions(readFailureAnalysis(db, runId)?.analysis) } catch { options = [] }
  const option = options.find((candidate) => candidate.id === optionId)
  if (!option) return { error: 'option_not_found', status: 404, detail: 'The analysis has no such option (it may have been regenerated)' }
  if (option.kind === 'continue-to-review') return { remedy: 'continue-to-review', label: option.label }
  if (option.kind === 'continue-with-guidance' || option.kind === 'mark-human-check') {
    return { remedy: 'continue', label: option.label, resolution: { kind: option.kind, label: option.label, does: option.does, guidance: option.guidance } }
  }
  return { error: 'option_runs_on_client', status: 400, detail: `${option.kind} is not a continuation` }
}

/**
 * Continue a failed or stopped definition run (the person's Continue and the
 * automatic continuation). Keeps every piece of work: resumes in place when the
 * runtime can, otherwise forks the next attempt from the step that failed or
 * stopped. The cause's guidance is queued as an operator instruction before the
 * run goes on, so its next agent turn reads it. Returns the HTTP outcome.
 */
function completionReasonsOf(completion: unknown): unknown[] | null {
  return completion && typeof completion === 'object' && Array.isArray((completion as { reasons?: unknown }).reasons) ? (completion as { reasons: unknown[] }).reasons : null
}

export async function continueDefinitionRun(c: ProjectContext, runId: string, remedy: ContinueRemedy, options: ContinueOptions = {}): Promise<{ status: number; body: object }> {
  try {
    assertProcessAdmission(c.project.id)
    const budgetRejection = c.dailyBudgetRejection?.() ?? null
    if (budgetRejection) return { status: 409, body: budgetRejection }
    const successor = readDefinitionSuccessor(c.db, runId)
    if (successor) return { status: 409, body: { error: 'runtime_fork_owns_worktree', detail: 'This attempt was already continued', loopRunId: successor } }
    const probe = await probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, runId, true)
    if (probe.status === 'unavailable') return { status: 503, body: { error: 'runtime_status_unavailable', detail: probe.error?.message } }
    const stored = c.db.prepare('SELECT failure_diagnosis FROM loop_runs WHERE id = ?').get(runId) as { failure_diagnosis: string | null } | undefined
    const diagnosis = parseStoredDiagnosis(stored?.failure_diagnosis ?? null)
    const plan = planContinuation(c.db, runId, remedy, probe, diagnosis)
    const target = plan.mode === 'fork' ? (await forkDefinitionRun(c, runId, plan.request)).loopRunId : runId
    // Checks handed to a person need no guidance; Continue carries the cause's (and the flaky tests' rule).
    let flakyTests: string[] = []
    try { flakyTests = remedy === 'continue' ? readVerificationTests(c.db, runId).flakyTests : [] } catch { flakyTests = [] }
    const cause = remedy === 'continue' ? continuationGuidance(diagnosis, { completionReasons: completionReasonsOf(probe.completion), envFilesCopied: options.envFilesCopied ?? null, flakyTests }) : null
    // A picked resolution is what the person chose Continue to do; otherwise the person read the AI
    // analysis' steps as what Continue does (older analyses, with no options): hand them to the agent too.
    const chosen = resolutionGuidance(options.resolution)
    const guidance = remedy !== 'continue' ? cause
      : chosen ? [cause, chosen].filter(Boolean).join('\n\n')
        : withAnalysisSteps(cause, analysisStepsOf(c.db, runId))
    let guided: boolean | undefined
    if (guidance) {
      try {
        await signalDefinitionRun(c, target, guidance, `continue-${target}-${Date.now().toString(36)}`.slice(0, 128))
        guided = true
      } catch (error) {
        guided = false
        console.warn(`[continue] could not queue the guidance for ${target}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      recordRunContinuation(c.db, { runId: target, sourceRunId: runId, remedy, mode: plan.mode, fromStep: plan.fromStep, cause: diagnosis?.kind ?? null, guidance: guided ? guidance : null, automatic: !!options.automatic })
    } catch (error) { console.warn(`[continue] could not record the continuation of ${runId}:`, error instanceof Error ? error.message : error) }
    const resumed = plan.mode === 'fork' ? await resumeDefinitionRunFromStop(c, target) : await resumeDefinitionRunFromStop(c, runId)
    return { status: plan.mode === 'fork' ? 201 : 202, body: { loopRunId: target, remedy, mode: plan.mode, fromStep: plan.fromStep, resumed: resumed.ok, ...(guided === undefined ? {} : { guided }),
      ...(resumed.ok ? {} : { resumeError: resumed.error, ...(resumed.detail ? { resumeDetail: resumed.detail } : {}) }) } }
  } catch (error) {
    if (error instanceof IncompleteTasksRemedyError) return { status: 409, body: { error: error.code, detail: error.message } }
    if (error instanceof ProcessAdmissionClosedError) return { status: 409, body: { error: 'process_admission_closed', detail: error.message } }
    const detail = error instanceof Error ? error.message : String(error)
    return { status: detail === 'runtime_status_unavailable' ? 503 : 409, body: { error: 'runtime_fork_rejected', detail } }
  }
}

/**
 * Continue a stopped definition run from where it stopped, authorizing a re-run
 * of every interrupted step (what the job's Recover/Resume button does). An
 * already running run counts as resumed.
 */
export async function resumeDefinitionRunFromStop(c: ProjectContext, runId: string): Promise<{ ok: true } | { ok: false; error: string; detail?: string }> {
  if (c.loopRunManager.isDefinitionRunActive(runId)) return { ok: true }
  const probe = await probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, runId)
  if (probe.lease?.active) return { ok: true }
  if (!probe.resumable) return { ok: false, error: 'run_not_resumable', ...(probe.error?.message ? { detail: probe.error.message } : {}) }
  const recover = probe.recoverableSteps.map(step => step.attemptId)
  const outcome = await resumeRetainedDefinitionRun(c, runId, recover.length ? { recover } : {})
  if (outcome.status < 300) return { ok: true }
  const body = outcome.body as { error?: unknown; detail?: unknown }
  return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${outcome.status}`, ...(typeof body.detail === 'string' ? { detail: body.detail } : {}) }
}

export async function resumeRetainedDefinitionRun(c: ProjectContext, runId: string, rawControls: unknown, options: { restartResume?: boolean; waitForStaleLease?: boolean } = {}): Promise<{ status: number; body: object }> {
  const run = getLoopRun(c.db, runId)
  if (!run || run.project_id !== c.project.id || run.engine_version !== 2) return { status: 404, body: { error: 'Definition run not found' } }
  try {
    await awaitProcessAdmission(c.project.id)
    // Continuing a workflow is cost-incurring: same gate as a rail launch.
    const budgetRejection = c.dailyBudgetRejection?.() ?? null
    if (budgetRejection) { return { status: 409, body: budgetRejection } }
    const successor = readDefinitionSuccessor(c.db, runId)
    if (successor) { return { status: 409, body: { error: 'runtime_fork_owns_worktree', loopRunId: successor } } }
    const observedClaim = readDefinitionExecutionClaim(c.db, runId)
    // A run the app stopped before it reached Core (it waited, queued for
    // capacity) has no Core context to inspect or resume: it starts afresh.
    if (run.status === 'paused' && run.restart_reason === 'restart' && definitionRunNeverReachedCore(c.db, runId)) {
      return startNeverStartedRun(c, runId, observedClaim)
    }
    let probe = await probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, runId)
    const residentHere = c.loopRunManager.isDefinitionRunActive?.(runId) ?? false
    // Restart resume: the Core child the restart killed still holds its lease (up to a
    // minute) and the restart dialog offers Resume at boot, so wait it out (bounded)
    // instead of answering runtime_run_active. Nothing in this process runs it.
    const staleWait = options.restartResume || options.waitForStaleLease ? staleLeaseWaitMs(probe.lease, Date.now(), residentHere) : 0
    if (staleWait > 0) {
      await new Promise((resolve) => setTimeout(resolve, staleWait))
      probe = await probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, runId)
    }
    if (probe.status === 'unavailable') { return { status: 503, body: { error: 'runtime_status_unavailable', detail: probe.error?.message } } }
    if (probe.lease?.active) { return { status: 409, body: { error: 'runtime_run_active' } } }
    // The person's Resume of a run the restart cut off authorizes re-running the
    // interrupted steps, instead of failing on "An interrupted write requires explicit recovery".
    const requested = options.restartResume && !residentHere ? restartRecoveryControls(rawControls, probe.recoverableSteps ?? []) : rawControls
    let controls
    try { controls = validateDefinitionResumeControls(requested, probe) }
    catch (error) { return { status: 400, body: { error: 'invalid_resume_controls', detail: error instanceof Error ? error.message : String(error) } } }
    // A retained claim can outlive its Core lease. Only release the exact
    // owner observed before inspection, while this remains a restart pause.
    const resident = c.loopRunManager.isDefinitionRunActive(runId)
    if (resident && ((controls.recover?.length ?? 0) > 0 || (controls.approve?.length ?? 0) > 1)) {
      return { status: 409, body: { error: 'runtime_control_conflict', detail: 'A resident workflow accepts one pending interrupt at a time' } }
    }
    if (!resident && observedClaim) {
      c.db.prepare(`DELETE FROM definition_execution_claims WHERE run_id = ? AND owner = ?
        AND EXISTS (SELECT 1 FROM loop_runs WHERE id = ? AND project_id = ? AND status = 'paused' AND restart_reason = 'restart')`)
        .run(runId, observedClaim.owner, runId, c.project.id)
    }
    const snapshot = ensureIsolatedSettlementSnapshot(c.db, c.project.id, runId)
    if (!snapshot && readDefinitionRun(c.db, runId)?.request.deferTerminalOutcome) throw new Error('Original isolated settlement snapshot is unavailable')
    if (run.status === 'completed') {
      if (!snapshot) { return { status: 409, body: { error: 'runtime_run_completed' } } }
      await reattachIsolatedSettlement(c, snapshot.delivery_id, runId)
      return { status: 200, body: { loopRunId: runId, settled: true } }
    }
    const completion = c.loopRunManager.beginDefinitionResume(runId, controls)
    // A resume answers any usage-limit pause the run carried over a restart.
    try { clearLimitPause(c.db, runId) } catch { /* the record is advisory once the run moves on */ }
    // Resident executions already own their original settlement callback.
    if (!resident) void completion.then(async result => {
      if (snapshot) await reattachIsolatedSettlement(c, snapshot.delivery_id, runId)
      else c.onLoopRunFinished(runId, result.outcome, result.stallReason ? { stallReason: result.stallReason } : undefined)
    }).catch(error => {
      // Preserve the durable terminal intent and worktree for another attempt.
      console.error('[loop-runs] recovered settlement failed:', runId, error)
    })
    return { status: 202, body: { loopRunId: runId } }
  } catch (error) {
    return { status: 409, body: { error: 'runtime_resume_rejected', detail: error instanceof Error ? error.message : String(error) } }
  }
}

/** Continue a run the restart stopped while it waited for capacity: nothing ran, so it starts
 *  from the beginning (through admission again) and settles like any recovered run. */
function startNeverStartedRun(c: ProjectContext, runId: string, observedClaim: ReturnType<typeof readDefinitionExecutionClaim>): { status: number; body: object } {
  if (c.loopRunManager.isDefinitionRunActive(runId)) return { status: 409, body: { error: 'runtime_run_active' } }
  if (observedClaim) c.db.prepare(`DELETE FROM definition_execution_claims WHERE run_id = ? AND owner = ?
    AND EXISTS (SELECT 1 FROM loop_runs WHERE id = ? AND project_id = ? AND status = 'paused' AND restart_reason = 'restart')`)
    .run(runId, observedClaim.owner, runId, c.project.id)
  const snapshot = ensureIsolatedSettlementSnapshot(c.db, c.project.id, runId)
  const completion = c.loopRunManager.beginDefinitionResume(runId)
  void completion.then(async result => {
    if (snapshot) await reattachIsolatedSettlement(c, snapshot.delivery_id, runId)
    else c.onLoopRunFinished(runId, result.outcome, result.stallReason ? { stallReason: result.stallReason } : undefined)
  }).catch(error => console.error('[loop-runs] restarted queued run failed:', runId, error))
  return { status: 202, body: { loopRunId: runId, startedAfresh: true } }
}

/** An empty-handed resume of a run paused by a Desktop restart (no answer, no explicit recovery). */
/**
 * A usage-limit resume (the person's click or the automatic one at the reset) of a
 * run retained over a Desktop restart authorizes re-running the step the restart cut
 * off, as the restart dialog's Resume does; without it Core refuses with "An
 * interrupted write requires explicit recovery" and the run fails.
 */
export function limitResumeOptions(run: { status: string; restart_reason?: string | null } | undefined): { restartResume: boolean } {
  return { restartResume: !!run && isRestartResume(run, {}) }
}

export function isRestartResume(run: { status: string; restart_reason?: string | null }, controls: unknown): boolean {
  if (run.status !== 'paused' || run.restart_reason !== 'restart') return false
  const body = (controls && typeof controls === 'object' ? controls : {}) as Record<string, unknown>
  return body.recover === undefined && body.answer === undefined && body.interruptId === undefined
}

/** The resume controls that authorize re-running every step the restart interrupted. */
export function restartRecoveryControls(controls: unknown, recoverable: ReadonlyArray<{ attemptId: string }>): unknown {
  if (recoverable.length === 0) return controls
  const body = (controls && typeof controls === 'object' ? controls : {}) as Record<string, unknown>
  return { ...body, recover: recoverable.map((step) => step.attemptId) }
}

/** Longest wait for the lease of a Core child that died with the previous Desktop process. */
export const STALE_LEASE_MAX_WAIT_MS = 75_000

/** How long to wait before a restart resume: until the dead owner's lease expires (bounded), never for a run alive here. */
export function staleLeaseWaitMs(lease: { active: boolean; expiresAt?: number | null } | null, nowMs: number, runningHere: boolean): number {
  if (runningHere || !lease?.active || typeof lease.expiresAt !== 'number') return 0
  const remaining = lease.expiresAt - nowMs + 250
  return remaining > 0 && remaining <= STALE_LEASE_MAX_WAIT_MS ? remaining : 0
}

/** The stored AI analysis' next steps for this run, as plain lines (empty when there is none, or when
 *  the analysis offers options: the person then picks one, and a plain Continue is "keep going"). */
function analysisStepsOf(db: ProjectContext['db'], runId: string): string[] {
  try {
    const analysis = readFailureAnalysis(db, runId)?.analysis
    if (readStoredOptions(analysis).length) return []
    const steps = analysis?.nextSteps
    return Array.isArray(steps) ? steps.filter((step): step is string => typeof step === 'string' && !!step.trim()).slice(0, 8) : []
  } catch { return [] }
}

/** Continue's guidance plus the analysis' steps, which the person sees as the plan Continue carries out. */
export function withAnalysisSteps(guidance: string | null, steps: readonly string[]): string | null {
  if (steps.length === 0) return guidance
  const plan = ['The person continued this run after reading this analysis of the failure. Carry out these steps (verify each against the code; the reviewer\'s findings stay authoritative):', ...steps.map((step, index) => `${index + 1}. ${step.slice(0, 600)}`)].join('\n')
  return guidance ? `${guidance}\n\n${plan}` : plan
}
