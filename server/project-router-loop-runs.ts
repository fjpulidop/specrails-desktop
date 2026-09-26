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
import { isLoopsEnabled } from './feature-flags'
import { getLoop } from './modules/loops/runtime/loops-store'
import { getLoopRun, readDefinitionLineage, readDefinitionExecutionClaim, readDefinitionRun, readDefinitionSuccessor } from './modules/loops/runtime/loop-runs-store'
import { forkDefinitionRun, validateDefinitionForkRequest } from './modules/delivery/runtime/definition-fork'
import { reattachIsolatedSettlement } from './modules/delivery/runtime/rail-isolated-launch'
import { finishDefinitionCancellation } from './modules/loops/runtime/definition-cancellation'
import { appendEvent } from './db'
import { validateDefinitionResumeControls } from './modules/loops/runtime/loop-definition-controls'
import { probeDefinitionRun } from './modules/loops/runtime/loop-definition-recovery'
import { MIN_DURATION_SAMPLES, getJobCommandDurationRange, getLoopDurationRange, jobCommandShape } from './modules/execution/runtime/run-duration-stats'
import { loadConstantMap } from './modules/loops/runtime/loop-constants'
import { getAdapter, hasAdapter, reasoningEffortsForModel, supportsToolPolicy } from './providers'
import { isReasoningEffortValidForModel } from './providers/runtime'
import { resolveAgentDefaults } from './modules/agents/runtime/agent-defaults'
import { validateRequestedProvider } from './provider-selection'
import { isValidModelForProvider, getModelsForProvider, type SpecProvider } from './modules/specs/runtime/spec-models'
import { resolveProjectExecution } from './workspace-resolution'
import { referencesUnsupportedProviderCommand } from './modules/loops/runtime/loop-command-catalog'
import { newId } from './ids'
import type { ReasoningEffort } from './providers/types'
import { getProjectRepositories, validateTicketRepositoryIds, RepositoryValidationError } from './project-repositories'
import { launchMultiRepositoryRail } from './modules/delivery/runtime/multi-repo-execution'
import { getRails, getRail, createRail, deleteRail, MAX_RAILS } from './modules/delivery/runtime/rails-store'
import { getActivePrDeliveryByRail } from './modules/delivery/runtime/rail-pr-store'
import { isolationApplies } from './modules/delivery/runtime/rail-isolation'
import { assertProcessAdmission, ProcessAdmissionClosedError } from './process-admission'

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
    if (!run || run.project_id !== c.project.id || run.engine_version !== 2) { res.status(404).json({ error: 'Definition run not found' }); return }
    try {
      assertProcessAdmission(c.project.id)
      const successor = readDefinitionSuccessor(c.db, runId)
      if (successor) { res.status(409).json({ error: 'runtime_fork_owns_worktree', loopRunId: successor }); return }
      const observedClaim = readDefinitionExecutionClaim(c.db, runId)
      const probe = await probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, runId)
      if (probe.status === 'unavailable') { res.status(503).json({ error: 'runtime_status_unavailable', detail: probe.error?.message }); return }
      if (probe.lease?.active) { res.status(409).json({ error: 'runtime_run_active' }); return }
      let controls
      try { controls = validateDefinitionResumeControls(req.body ?? {}, probe) }
      catch (error) { res.status(400).json({ error: 'invalid_resume_controls', detail: error instanceof Error ? error.message : String(error) }); return }
      // A retained claim can outlive its Core lease. Only release the exact
      // owner observed before inspection, while this remains a restart pause.
      const resident = c.loopRunManager.isDefinitionRunActive(runId)
      if (resident && ((controls.recover?.length ?? 0) > 0 || (controls.approve?.length ?? 0) > 1)) {
        res.status(409).json({ error: 'runtime_control_conflict', detail: 'A resident workflow accepts one pending interrupt at a time' }); return
      }
      if (!resident && observedClaim) {
        c.db.prepare(`DELETE FROM definition_execution_claims WHERE run_id = ? AND owner = ?
          AND EXISTS (SELECT 1 FROM loop_runs WHERE id = ? AND project_id = ? AND status = 'paused' AND restart_reason = 'restart')`)
          .run(runId, observedClaim.owner, runId, c.project.id)
      }
      const snapshot = c.db.prepare('SELECT delivery_id FROM definition_delivery_settlements WHERE project_id = ? AND run_id = ? LIMIT 1')
        .get(c.project.id, runId) as { delivery_id: string } | undefined
      if (!snapshot && readDefinitionRun(c.db, runId)?.request.deferTerminalOutcome) throw new Error('Original isolated settlement snapshot is unavailable')
      if (run.status === 'completed') {
        if (!snapshot) { res.status(409).json({ error: 'runtime_run_completed' }); return }
        await reattachIsolatedSettlement(c, snapshot.delivery_id, runId)
        res.json({ loopRunId: runId, settled: true }); return
      }
      const completion = c.loopRunManager.beginDefinitionResume(runId, controls)
      // Resident executions already own their original settlement callback.
      if (!resident) void completion.then(async result => {
        if (snapshot) await reattachIsolatedSettlement(c, snapshot.delivery_id, runId)
        else c.onLoopRunFinished(runId, result.outcome, result.stallReason ? { stallReason: result.stallReason } : undefined)
      }).catch(error => {
        // Preserve the durable terminal intent and worktree for another attempt.
        console.error('[loop-runs] recovered settlement failed:', runId, error)
      })
      res.status(202).json({ loopRunId: runId })
    } catch (error) {
      res.status(409).json({ error: 'runtime_resume_rejected', detail: error instanceof Error ? error.message : String(error) })
    }
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
      const resident = c.loopRunManager.isDefinitionRunActive(runId)
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
            const snapshot = c.db.prepare('SELECT delivery_id FROM definition_delivery_settlements WHERE project_id=? AND run_id=? LIMIT 1')
              .get(c.project.id, runId) as { delivery_id: string } | undefined
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
      res.status(201).json(result)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      res.status(detail === 'runtime_status_unavailable' ? 503 : 409).json({ error: 'runtime_fork_rejected', detail })
    }
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

  router.post('/:projectId/loop-runs', async (req: Request, res: Response) => {
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
    const primary = getProjectRepositories(c.project).find((repository) => repository.isPrimary)!
    try {
      repositoryIds = validateTicketRepositoryIds(c.project, body.repositoryIds) ?? [primary.id]
      assertLoopShellRepositoryScope(loop.graph, repositoryIds)
      assertProcessAdmission(c.project.id)
    } catch (error) {
      res.status(error instanceof RepositoryValidationError ? error.status : error instanceof ProcessAdmissionClosedError ? 409 : 400).json({ error: error instanceof Error ? error.message : 'Invalid repository scope' }); return
    }
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
          ctx: c, railIndex: rail.railIndex, ticketIds: [], repositoryIds, scope: 'all',
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
      .then((r) => c.onLoopRunFinished(r.runId, r.outcome, r.stallReason ? { stallReason: r.stallReason } : undefined))
      .catch((err) => {
        console.error('[loop-runs] standalone run failed:', err)
        c.onLoopRunFinished(runId, 'failed')
      })
    res.status(202).json({ loopRunId: runId })
  })
}
