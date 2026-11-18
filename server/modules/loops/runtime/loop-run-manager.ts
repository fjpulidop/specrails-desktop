/**
 * LoopRunManager — the app-driven engine that executes a published loop graph.
 *
 * The APP owns the iteration loop: it traverses the graph node-by-node,
 * increments the iteration counter at each Loop Decider, and enforces
 * maxIterations + timeout. The stop/continue verdict is produced by the Decider
 * NODE (an AI invocation), never by app heuristics. AI Step / Shell / Decider
 * execution is delegated to injected `executors` so the traversal, counting,
 * persistence, and event logic are unit-testable WITHOUT spawning real
 * processes; the production executors wire `runAiCliInvocation` + a shell spawn.
 *
 * This class owns the resident per-run state (children, interactive sessions,
 * pauses, cancellation, definition claims) and the run lifecycle; one run is
 * executed by focused units over a shared `LoopRunContext`: launch
 * (`loop-run-launch`), events (`loop-run-events`), accounting
 * (`loop-run-ledger`), pauses (`loop-run-pauses`), the legacy traversal and its
 * node executors (`loop-legacy-traversal`, `loop-node-*`), Core delegation
 * (`loop-definition-execution`) and settlement (`loop-run-settlement`).
 *
 * Spec: openspec/changes/loop-builder/specs/loop-execution/spec.md
 */
import type { ChildProcess } from 'node:child_process'
import { treeKillSafe as treeKill } from '../../../util/win-spawn'
import type { DbInstance } from '../../../db'
import type { InteractiveJobSession } from '../../execution/runtime/interactive-job-session'
import type { WsMessage } from '../../../types'
import { getAdapter, requireToolPolicy } from '../../../providers'
import { isRunCapCrossed, runCapRejection } from '../../execution'
import { newId } from '../../../ids'
import { isDefinitionGraph } from './loop-graph'
import {
  readDefinitionRun,
  readDefinitionForkTarget,
  readDefinitionExecutionClaim,
  claimDefinitionExecution,
  definitionRepositoryMounts,
  completeLoopStepRecovery,
  readLoopJobUsage,
  getLoopRun,
  writeLoopRunCap,
} from './loop-runs-store'
import { BUILTIN_CONSTANTS } from './loop-constants'
import type { DefinitionInterrupt, DefinitionResumeControls } from './loop-definition-run'
import { insertLoopInvocation } from './loop-step-accounting'
import { seedChangeId } from './loop-run-vars'
import { runInteractiveAiStep } from './loop-interactive-ai-step'
import { createLoopRunEvents } from './loop-run-events'
import { bindRunCap, initialEventSeq, normalizeLoopRunRequest, persistLoopRunLaunch, resolveRunLimits, writeRunHeader } from './loop-run-launch'
import { runDefinitionEngine } from './loop-definition-execution'
import { runLegacyTraversal } from './loop-legacy-traversal'
import { saveLimitPause } from './loop-limit-pauses'
import { sharesQuota } from '../../provider-quota/domain'
import { settleLoopRun } from './loop-run-settlement'
import type { LoopRunContext, LoopRunHost, LoopRunState } from './loop-run-context'
import type {
  LoopBudgetBreach,
  LoopExecutors,
  LoopRunManagerOptions,
  LoopRunRequest,
  LoopRunResult,
  PausedRun,
  RunCapChoice,
  BudgetResumeResult,
  LoopLimitPause,
} from './loop-run-contract'

export type {
  AiStepResult,
  ShellResult,
  DeciderRunResult,
  LoopLogSink,
  LoopSpawnSink,
  InteractivePlanInput,
  InteractiveAiStepPlan,
  LoopExecutors,
  LoopRunRequest,
  LoopStallReason,
  LoopRunResult,
  LoopStepEventPayload,
  LoopStepEndEventPayload,
  LoopGraphEventPayload,
  LoopBudgetBreach,
  RunCapChoice,
  BudgetResumeResult,
} from './loop-run-contract'
export { BUDGET_PAUSED, LIMIT_PAUSED } from './loop-run-contract'
export { truncate, resolveRunVars, seedChangeId, openspecChangeState, extractChangeId } from './loop-run-vars'
export { DETERMINISTIC_VERIFICATION_MODEL, CORE_V1_ROW_PREFIX, recoverOrphanLoopStepAccounting } from './loop-step-accounting'

export class LoopRunManager {
  private _disposed = false
  private readonly _definitionTasks = new Map<string, Promise<LoopRunResult>>()
  private readonly _cancelled = new Set<string>()
  /** The currently-spawned child per run, so cancel/stop can actually KILL a
   *  blocked spawn (the cooperative `_cancelled` flag can't interrupt an await). */
  private readonly _activeChild = new Map<string, ChildProcess>()
  /** The ACTIVE interactive step session per run (present only while an ai-step
   *  runs as a resident persistent-stdin session — between steps the entry is
   *  gone, so a mid-decider/shell turn correctly routes 409). Keyed by the run
   *  id, which IS the backing job row's id — the manager-agnostic turn routing
   *  (project-router-jobs) addresses sessions by that job id. */
  private readonly _interactiveSteps = new Map<string, InteractiveJobSession>()
  private readonly _activeStepRecovery = new Map<string, string>()
  private readonly _pausedHumanDecisions = new Map<string, PausedRun>()

  constructor(
    private readonly db: DbInstance,
    private readonly broadcast: (msg: WsMessage) => void,
    private readonly executors: LoopExecutors,
    private readonly now: () => number = () => Date.now(),
    /** `idleTimeoutMs`: override the env-resolved loop-step idle watchdog
     *  (tests). Undefined ⇒ resolveLoopStepIdleTimeoutMs() per run.
     *  `dailyBudget`: the project/app-wide daily budget gate (null = within
     *  budget). Consulted between AI steps; absent ⇒ no budget guard. */
    private readonly options: LoopRunManagerOptions = {},
  ) {}

  /** Live per-run soft cap state of the runs this manager is executing. */
  private readonly _runCaps = new Map<string, { capUsd: number | null; cost: () => number }>()

  /** Best-effort budget read: an unreadable budget never stops a run. */
  private _dailyBudgetBreach(): LoopBudgetBreach | null {
    try { return this.options.dailyBudget?.() ?? null } catch { return null }
  }

  /** The per-run soft cap, when this run's provider-reported cost has reached it. */
  private _runCapBreach(runId: string): LoopBudgetBreach | null {
    const state = this._runCaps.get(runId)
    if (!state || !isRunCapCrossed(state.capUsd, state.cost())) return null
    return runCapRejection(state.capUsd as number, state.cost())
  }

  /** Daily/weekly/monthly cap first (refuses outright), then the run's soft cap. */
  private _budgetBreach(runId: string): LoopBudgetBreach | null {
    return this._dailyBudgetBreach() ?? this._runCapBreach(runId)
  }

  /** The budget a run is paused on (`budget_paused`), else null. */
  /** Live loop/rail children per run (a step's spawn, a Core definition runtime process, or a resident
   *  interactive step), labelled with the loop name, rail and ticket. Read-only, for resource metering. */
  listProcessRoots(): Array<{ runId: string; pid: number; label: string }> {
    const roots: Array<{ runId: string; pid: number; label: string }> = []
    const add = (runId: string, pid: number | null | undefined) => {
      if (typeof pid !== 'number' || pid <= 0 || roots.some(r => r.pid === pid)) return
      let label = runId
      try {
        const row = getLoopRun(this.db, runId)
        if (row) label = [row.rail_index != null ? `Rail ${row.rail_index + 1}` : null, row.loop_name ?? row.loop_id, row.ticket_id != null ? `#${row.ticket_id}` : null].filter(Boolean).join(' · ')
      } catch { /* label stays the run id */ }
      roots.push({ runId, pid, label })
    }
    for (const [runId, child] of this._activeChild) add(runId, child.pid)
    for (const [runId, session] of this._interactiveSteps) add(runId, session.processPid())
    return roots
  }

  budgetPause(runId: string): LoopBudgetBreach | null {
    const budget = this._pausedHumanDecisions.get(runId)?.budget
    return budget ? structuredClone(budget) : null
  }

  /** The usage limit a run is paused on (`limit_paused`), else null. */
  limitPause(runId: string): LoopLimitPause | null {
    const limit = this._pausedHumanDecisions.get(runId)?.limit
    return limit ? { ...limit } : null
  }

  /**
   * Answer a `limit_paused` run: resume now (same provider), continue on
   * another provider (legacy engine; never one that shares the quota), or turn
   * its automatic resume on/off. Returns false when the run is not limit-paused
   * or the choice does not apply to it.
   */
  resolveLimitPause(runId: string, choice: { action: 'resume' } | { action: 'switch'; provider: string; model: string } | { action: 'auto'; enabled: boolean }): boolean {
    const paused = this._pausedHumanDecisions.get(runId)
    const limit = paused?.limit
    if (!paused || !limit) return false
    if (choice.action === 'auto') {
      limit.autoResume = choice.enabled
      try { saveLimitPause(this.db, runId, limit) } catch { /* the in-memory choice still applies */ }
      this._emit({ type: 'loop.limit_pause', projectId: this.projectIdOf(runId), loopRunId: runId, limit: { ...limit } } as unknown as WsMessage)
      return true
    }
    if (choice.action === 'switch' && (!limit.switchable || sharesQuota(limit.providerId, choice.provider))) return false
    this._pausedHumanDecisions.delete(runId)
    paused.resolve(choice.action === 'switch' ? { action: 'switch', provider: choice.provider, model: choice.model } : { action: 'resume', text: '' })
    return true
  }

  private projectIdOf(runId: string): string | null {
    try { return getLoopRun(this.db, runId)?.project_id ?? null } catch { return null }
  }

  /** Resume a `budget_paused` run once the budget allows the next step. While
   *  still exhausted the run stays paused and the caller gets the 409 body. */
  resumeBudgetPause(runId: string, choice?: RunCapChoice): BudgetResumeResult {
    const paused = this._pausedHumanDecisions.get(runId)
    if (!paused?.budget) return { status: 'not_budget_paused' }
    // The person's answer to a per-run soft cap: waive it for this run, or move it up.
    const state = this._runCaps.get(runId)
    if (state && choice) {
      state.capUsd = 'ignore' in choice ? null : choice.raiseTo
      try { writeLoopRunCap(this.db, runId, state.capUsd ?? 0) } catch { /* the in-memory choice still applies */ }
    }
    const rejection = this._budgetBreach(runId)
    if (rejection) {
      paused.budget = rejection
      return { status: 'over_budget', rejection: structuredClone(rejection) }
    }
    this._pausedHumanDecisions.delete(runId)
    paused.resolve({ action: 'resume', text: '' })
    return { status: 'resumed' }
  }

  /** WebSocket delivery is advisory. A disconnected/misbehaving listener must
   * never change launch, accounting, traversal, or terminal outcomes. */
  private _emit(msg: WsMessage): void {
    try { this.broadcast(msg) } catch { /* persisted state remains authoritative */ }
  }

  /** Cancel an in-flight run: flag it AND kill the active spawned child so a
   *  blocked AI Step / Shell returns immediately (the engine then settles
   *  'stopped' at the next boundary). An interactive step is torn down through
   *  its session's abort() (fold in-flight turn → settle 'crashed' → the
   *  awaited step resolves) — NOT dispose(), which never settles and would
   *  leave the engine's `await` hanging forever. */
  cancel(runId: string): void {
    // A run waiting on a host task (CI, push) has no Core process: stop the host work too.
    try { this.options.hostTasks?.()?.cancel(runId) } catch { /* advisory */ }
    const frozen = readDefinitionRun(this.db, runId)
    // No traversal of ours will settle it: the composition cancels and settles it.
    if (frozen?.metadata.contextPath && this.options.cancelRetained && !this.isDefinitionRunActive(runId)) {
      this.options.cancelRetained(runId)
      return
    }
    if (this.executors.cancelDefinition && frozen?.metadata.contextPath) {
      void this.cancelDefinition(runId).catch(error => {
        console.error(`[loop-run] durable cancellation failed for ${runId}: ${error instanceof Error ? error.message : String(error)}`)
      })
      return
    }
    this.cancelResident(runId, false)
  }

  private readonly _definitionCancellations = new Map<string, Promise<void>>()
  isDefinitionCancellationPending(runId: string): boolean { return this._definitionCancellations.has(runId) }

  /** Launch-time engine check, callable before a caller allocates worktrees. */
  async assertEngineSupport(graph: LoopRunRequest['graph']): Promise<void> {
    if (isDefinitionGraph(graph)) {
      if (!this.executors.runDefinition) throw new Error('engine_unsupported: Core workflow execution is unavailable')
      await this.executors.assertDefinitionSupport?.(graph)
    } else await this.executors.assertLegacyEngineSupport?.()
  }
  private definitionForkOwnsRun(runId: string): boolean {
    return !!readDefinitionForkTarget(this.db, runId) || readDefinitionExecutionClaim(this.db, runId)?.owner.startsWith('fork:') === true
  }
  /** Persist intent in the retained Core inbox before settling a resident pause.
   * A rejected control leaves the execution available for an explicit retry. */
  cancelDefinition(runId: string, requestId = `desktop-cancel:${runId}`): Promise<void> {
    if (this.definitionForkOwnsRun(runId)) return Promise.reject(new Error('runtime_fork_owns_worktree: Continue the forked run'))
    const pending = this._definitionCancellations.get(runId)
    if (pending) return pending
    const frozen = readDefinitionRun(this.db, runId)
    const contextPath = frozen?.metadata.contextPath
    if (!contextPath || !this.executors.cancelDefinition) return Promise.reject(new Error('runtime_control_unavailable: Frozen workflow cancellation is unavailable'))
    const task = this.executors.cancelDefinition({ runId, contextPath, requestId }).then(() => {
      this.cancelResident(runId, true)
    }).finally(() => { this._definitionCancellations.delete(runId) })
    this._definitionCancellations.set(runId, task)
    return task
  }

  private cancelResident(runId: string, graceful: boolean): void {
    this._cancelled.add(runId)
    try { this.options.hostTasks?.()?.cancel(runId) } catch { /* host work is advisory to cancellation */ }
    const paused = this._pausedHumanDecisions.get(runId)
    if (paused) {
      this._pausedHumanDecisions.delete(runId)
      paused.resolve({ action: 'stop' })
    }
    const session = this._interactiveSteps.get(runId)
    if (session) {
      session.abort('■ Run canceled — tearing down the interactive step session.')
    }
    const child = this._activeChild.get(runId)
    if (child?.pid) {
      try { treeKill(child.pid, graceful ? 'SIGTERM' : 'SIGKILL', () => { /* best-effort */ }) } catch { /* already gone */ }
      if (graceful) {
        const timer = setTimeout(() => {
          if (this._activeChild.get(runId) === child && child.pid) {
            try { treeKill(child.pid, 'SIGKILL', () => {}) } catch { /* already gone */ }
          }
        }, 1500)
        timer.unref?.()
        child.once('close', () => clearTimeout(timer))
      }
    }
  }

  // ─── Interactive step routing (manager-agnostic /jobs/:id/messages) ─────────

  /** True while an interactive step session is resident for this run/job id. */
  isInteractiveJob(jobId: string): boolean {
    return this._interactiveSteps.has(jobId)
  }

  /** True while the loop is paused between engine steps awaiting a human call. */
  isPaused(jobId: string): boolean {
    return this._pausedHumanDecisions.has(jobId)
  }

  pausedReason(jobId: string): string | null {
    return this._pausedHumanDecisions.get(jobId)?.reason ?? null
  }

  /** Feed one more user prompt to the ACTIVE step session owning this job row
   *  (queued behind the active turn — steering; the loop tends to continue its
   *  plan). Returns false when no interactive step is live for the id. */
  pendingInterrupts(jobId: string): DefinitionInterrupt[] {
    return structuredClone(this._pausedHumanDecisions.get(jobId)?.pending ?? [])
  }

  sendInteractiveTurn(jobId: string, text: string, control?: { interruptId?: string; approve?: boolean }): boolean {
    if (this.definitionForkOwnsRun(jobId)) return false
    const paused = this._pausedHumanDecisions.get(jobId)
    if (paused?.budget) return this.resumeBudgetPause(jobId).status === 'resumed'
    if (paused) {
      if (paused.pending?.length) {
        const selected = control?.interruptId ? paused.pending.find(item => item.id === control.interruptId) : paused.pending.length === 1 ? paused.pending[0] : undefined
        if (!selected || (selected.kind !== 'question' && control?.approve !== true)) return false
      }
      this._pausedHumanDecisions.delete(jobId)
      paused.resolve({ action: 'resume', text, ...control })
      return true
    }
    const session = this._interactiveSteps.get(jobId)
    if (!session) return false
    return session.send(text)
  }

  /** Settle-now for THIS step: SIGTERM the resident child; the session settles
   *  'finalized' and the loop advances with what the step produced. Returns
   *  false when no interactive step is live for the id. */
  finalizeInteractive(jobId: string): boolean {
    const session = this._interactiveSteps.get(jobId)
    if (!session) return false
    session.finalize()
    return true
  }

  /** Teardown for project removal / process shutdown: dispose every resident
   *  interactive step session (SIGTERM, NO settle — mirrors QueueManager's
   *  shutdown) and kill any in-flight one-shot children. Does not settle the
   *  runs — the startup orphan sweeps (jobs + loop_runs) reconcile the rows on
   *  the next boot, exactly as they do for a crash today. */
  shutdown(): void {
    try { this.options.hostTasks?.()?.dispose() } catch { /* startup recovery re-dispatches */ }
    if (this._disposed) return
    this._disposed = true
    for (const runId of this._activeChild.keys()) this._cancelled.add(runId)
    for (const runId of this._interactiveSteps.keys()) this._cancelled.add(runId)
    for (const [runId, session] of this._interactiveSteps) {
      try {
        const snapshot = session.snapshotForAbort()
        const stepKey = this._activeStepRecovery.get(runId)
        if (stepKey) {
          let recoveredProjectId: string | null = null
          completeLoopStepRecovery(this.db, runId, stepKey, (payload) => {
            recoveredProjectId = payload.projectId
            insertLoopInvocation(this.db, payload, {
              cost: snapshot.totals.total_cost_usd,
              tokens: snapshot.totals.tokens_in + snapshot.totals.tokens_out,
              tokensIn: snapshot.totals.tokens_in,
              tokensOut: snapshot.totals.tokens_out,
              tokensCacheRead: snapshot.totals.tokens_cache_read,
              tokensCacheCreate: snapshot.totals.tokens_cache_create,
              numTurns: snapshot.totals.num_turns,
              durationMs: snapshot.activeDurationMs,
              sessionId: snapshot.sessionId ?? undefined,
              model: snapshot.model ?? undefined,
              provider: payload.provider,
              estimated: snapshot.estimated,
              failed: true,
            }, new Date(this.now()).toISOString())
            const aggregate = readLoopJobUsage(this.db, runId)
            const recoveredLoopDuration = (payload.loopDurationBaseline ?? 0) + snapshot.activeDurationMs
            this.db.prepare(`
              UPDATE loop_runs
                 SET total_cost_usd = ?, total_tokens = ?, total_duration_ms = ?,
                     iteration_count = MAX(iteration_count, COALESCE(?, iteration_count))
               WHERE id = ?
            `).run(
              aggregate.totalCostUsd,
              aggregate.tokensIn + aggregate.tokensOut,
              recoveredLoopDuration,
              payload.iterationCount ?? null,
              runId,
            )
            this.db.prepare(`UPDATE jobs SET duration_ms = ? WHERE id = ? AND owner = 'loop'`)
              .run(recoveredLoopDuration, runId)
          })
          this._activeStepRecovery.delete(runId)
          if (recoveredProjectId) {
            this._emit({ type: 'spending.invalidated', projectId: recoveredProjectId })
          }
        }
      } catch (err) {
        // Leave the durable step checkpoint for startup raw-event recovery.
        console.error(`[loop] shutdown accounting checkpoint failed for ${runId}:`, err)
      }
      try { session.dispose() } catch { /* ignore */ }
    }
    this._interactiveSteps.clear()
    for (const child of this._activeChild.values()) {
      if (child?.pid) {
        try { treeKill(child.pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
      }
    }
    this._activeChild.clear()
    for (const [runId, paused] of this._pausedHumanDecisions.entries()) {
      this._cancelled.add(runId)
      try { paused.resolve({ action: 'stop' }) } catch { /* ignore */ }
    }
    this._pausedHumanDecisions.clear()
  }

  isDisposed(): boolean { return this._disposed }

  isDefinitionRunActive(runId: string): boolean { return this._definitionTasks.has(runId) }

  private readonly _definitionClaims = new Map<string, () => void>()
  private claimDefinition(req: LoopRunRequest & { runId: string }): void {
    if (this._definitionClaims.has(req.runId)) return
    const claim = claimDefinitionExecution(this.db, req.runId, { owner: newId(), repositoryMounts: definitionRepositoryMounts(req) })
    if (!claim.ok) throw new Error(`runtime_run_active: ${claim.reason} (${claim.conflictingRunId})`)
    this._definitionClaims.set(req.runId, claim.release)
  }
  private releaseDefinition(runId: string): void {
    this._definitionClaims.get(runId)?.()
    this._definitionClaims.delete(runId)
  }

  run(req: LoopRunRequest): Promise<LoopRunResult> {
    if (!isDefinitionGraph(req.graph)) return this._run(req)
    const runId = req.runId ?? newId()
    if (this._definitionTasks.has(runId)) return Promise.reject(new Error('runtime_run_active: Workflow is already running'))
    try { this.claimDefinition({ ...req, runId }) } catch (error) { return Promise.reject(error) }
    const task = this._run({...req,runId}).finally(() => { this.releaseDefinition(runId); this._definitionTasks.delete(runId) })
    this._definitionTasks.set(runId,task)
    return task
  }

  resumeDefinition(runId: string, input: DefinitionResumeControls = {}): Promise<LoopRunResult> {
    try { return this.beginDefinitionResume(runId, input) } catch (error) { return Promise.reject(error) }
  }

  /** Synchronous admission lets HTTP reject competing writers before acknowledging a resume. */
  beginDefinitionResume(runId: string, input: DefinitionResumeControls = {}): Promise<LoopRunResult> {
    if (this._disposed) throw new Error('runtime_shutting_down: LoopRunManager is shut down')
    const active = this._definitionTasks.get(runId)
    if (active) {
      const interruptId = input.interruptId ?? input.approve?.[0]
      if (!this.isPaused(runId)) throw new Error('runtime_run_active: Select a pending question or approval')
      const request = readDefinitionRun(this.db, runId)?.request
      if (!request) throw new Error('runtime_run_not_found: Frozen workflow is unavailable')
      this.claimDefinition({ ...request, runId })
      if (!this.sendInteractiveTurn(runId,input.answer ?? '',{interruptId,approve: Boolean(input.approve?.length)})) {
        this.releaseDefinition(runId)
        throw new Error('runtime_run_active: Select a pending question or approval')
      }
      return active
    }
    const frozen = readDefinitionRun(this.db,runId)
    if (!frozen) throw new Error('runtime_run_not_found: Frozen workflow is unavailable')
    if (frozen.row.status === 'completed') throw new Error('runtime_run_completed: Fork a completed workflow to continue')
    this._cancelled.delete(runId)
    this.claimDefinition({ ...frozen.request, runId })
    // Cards and chips that showed the restart/interruption pause follow the resumed run live.
    const request = frozen.request
    this._emit({ type: 'loop.run_resumed', projectId: request.projectId, loopRunId: runId, railIndex: request.railIndex ?? null,
      ticketIds: request.spec?.ticketIds ?? (request.ticketId == null ? [] : [request.ticketId]) })
    const task = this._run(frozen.request,{resume:true,...input}).finally(() => { this.releaseDefinition(runId); this._definitionTasks.delete(runId) })
    this._definitionTasks.set(runId,task)
    return task
  }

  /** The narrow view of this manager a run executes against. */
  private _runHost(): LoopRunHost {
    return {
      db: this.db,
      executors: this.executors,
      options: this.options,
      now: () => this.now(),
      emit: (msg) => this._emit(msg),
      isDisposed: () => this._disposed,
      isCancelled: (runId) => this._cancelled.has(runId),
      setActiveChild: (runId, child) => { this._activeChild.set(runId, child) },
      clearActiveChild: (runId) => { this._activeChild.delete(runId) },
      activeStepRecovery: (runId) => this._activeStepRecovery.get(runId),
      setActiveStepRecovery: (runId, stepKey) => { this._activeStepRecovery.set(runId, stepKey) },
      clearActiveStepRecovery: (runId) => { this._activeStepRecovery.delete(runId) },
      parkPause: (runId, pause) => { this._pausedHumanDecisions.set(runId, pause) },
      resolvePause: (runId, decision) => {
        const paused = this._pausedHumanDecisions.get(runId)
        if (!paused) return false
        this._pausedHumanDecisions.delete(runId)
        paused.resolve(decision)
        return true
      },
      budgetBreach: (runId) => this._budgetBreach(runId),
      trackRunCap: (runId, cap) => { this._runCaps.set(runId, cap) },
      untrackRunCap: (runId) => { this._runCaps.delete(runId) },
      claimDefinition: (req) => this.claimDefinition(req),
      releaseDefinition: (runId) => this.releaseDefinition(runId),
      cancelResident: (runId, graceful) => this.cancelResident(runId, graceful),
      runInteractiveAiStep: (input) => runInteractiveAiStep({
        db: this.db,
        broadcast: this.broadcast,
        emit: (msg) => this._emit(msg),
        now: () => this.now(),
        agentAudit: this.options.agentAudit,
        sessions: this._interactiveSteps,
      }, input),
    }
  }

  /** Execute one run end to end: admit, launch, execute (Core delegation or
   *  legacy traversal), settle. A manager disposed mid-run never settles —
   *  startup recovery owns those rows. */
  private async _run(input: LoopRunRequest, continuation?: DefinitionResumeControls & {resume:true}): Promise<LoopRunResult> {
    const req = normalizeLoopRunRequest(input)
    const definitionEngine = isDefinitionGraph(req.graph)
    if (definitionEngine && !this.executors.runDefinition) throw new Error('engine_unsupported: Core workflow execution is unavailable')
    // Saved runs resume with their retained package whatever the active Core lists.
    if (!continuation) await this.assertEngineSupport(req.graph)
    if (this._disposed) throw new Error('LoopRunManager is shut down')
    const adapter = getAdapter(req.provider)
    // A Decider is a structured, read-only judgment over repository state.
    // Prompt wording is not a permission boundary: reject before allocating or
    // persisting the run when the CLI cannot enforce read-only natively.
    if (req.graph.nodes.some((node) => node.type === 'decider')) {
      requireToolPolicy(adapter, 'read-only')
    }
    const usageTelemetryAvailable = adapter.capabilities.reportsUsage !== false
    const neverAfterDispose = (): Promise<LoopRunResult> => new Promise(() => { /* startup recovery owns settlement */ })
    const runId = req.runId ?? newId()
    const { deadline, ...limits } = resolveRunLimits(req, usageTelemetryAvailable, this.now(), this.options.idleTimeoutMs)
    const exactTicketIds = req.spec?.ticketIds ?? (req.ticketId == null ? [] : [req.ticketId])
    persistLoopRunLaunch(this.db, {
      req, runId, exactTicketIds, definitionEngine,
      maxIterations: limits.maxIterations,
      startedAt: new Date(this.now()).toISOString(),
      continuation: !!continuation,
    })
    this._emit({
      type: 'loop.run_started',
      projectId: req.projectId,
      loopRunId: runId,
      loopId: req.loopId,
      railIndex: req.railIndex ?? null,
    })

    // Surface the run as a JOB so the full session streams live in the Jobs list
    // + JobDetail. Both identities committed together above, before any spawn.
    const state: LoopRunState = {
      seq: initialEventSeq(this.db, runId, !!continuation),
      stepNum: 0,
      // The last emitted step still awaiting its `loop_step_end` (cleared by
      // emitStepEnd). The settle path closes a step left open by a traversal
      // exception as 'failed', so the persisted stream only ever lacks an end
      // event when the manager was disposed mid-flight (shutdown / project
      // removal — the client reads that as "interrupted").
      openStep: null,
      deadline,
      usageTelemetryAvailable,
      outcome: 'failed',
      stallReason: undefined,
      providerLimitHit: undefined,
      engineOverride: undefined,
      failedStepId: undefined,
      failureText: undefined,
      coreFailure: undefined,
      iteration: 0,
      totalCost: 0,
      totalTokens: 0,
      totalDuration: 0,
      finalJobUsage: {
        tokensIn: usageTelemetryAvailable ? 0 : null,
        tokensOut: usageTelemetryAvailable ? 0 : null,
        tokensCacheRead: usageTelemetryAvailable ? 0 : null,
        tokensCacheCreate: usageTelemetryAvailable ? 0 : null,
        numTurns: usageTelemetryAvailable ? 0 : null,
      },
      aiSessionId: undefined,
      consecutiveAiFailures: 0,
      lastRepoHash: null,
      consecutiveNoProgress: 0,
      justContinued: false,
      passFailed: false,
      costUnknownWarned: false,
      costUncertain: false,
      recoveryCounts: new Map(),
      phaseRecovery: undefined,
      definitionCompletion: undefined,
    }
    const host = this._runHost()
    // Seed `changeId` from the DURABLE sources a launch already knows — the
    // follow-up's declared OpenSpec change name, else the spec's
    // `openspecChangeName` metadata. Capturing it from a step's prose was the
    // only source before, and a step that created, implemented AND archived the
    // change in one go (run 644eb404) never mentioned an active path, so the
    // validate/archive shell steps refused to run and a green implementation
    // settled `failed`. A step's own capture still wins when nothing is seeded.
    const seededChangeId = seedChangeId({ ...req, runId })
    const ctx: LoopRunContext = {
      host, req, runId, continuation, definitionEngine, adapter, exactTicketIds, limits, state, seededChangeId,
      events: createLoopRunEvents(host, runId, state),
      constMap: { ...BUILTIN_CONSTANTS, ...(req.constants ?? {}) },
      history: [],
      runVars: {},
    }
    writeRunHeader(ctx, adapter)
    bindRunCap(ctx)
    if (seededChangeId) {
      ctx.runVars.changeId = seededChangeId.id
      ctx.events.logLine(`↪ OpenSpec change id seeded from ${seededChangeId.source}: ${seededChangeId.id}`)
    }

    try {
      if (definitionEngine) await runDefinitionEngine(ctx)
      else if (await runLegacyTraversal(ctx) === 'disposed') return neverAfterDispose()
    } catch (err) {
      if (this._disposed) return neverAfterDispose()
      state.outcome = 'failed'
      console.error(`[loop] run=${runId} traversal threw:`, err)
      ctx.events.logLine(`error: ${(err as Error)?.message ?? String(err)}`, 'stderr')
    }

    if (this._disposed) return neverAfterDispose()
    return settleLoopRun(ctx)
  }
}
