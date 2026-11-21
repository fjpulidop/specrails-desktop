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
import { acceptedRouteOverrides, currentRoleRoutes } from '../../agent-runtime/runtime/agent-runtime-route-overrides'
import type { ChildProcess } from 'node:child_process'
import { treeKillSafe as treeKill } from '../../../util/win-spawn'
import type { DbInstance } from '../../../db'
import type { InteractiveJobSession } from '../../execution/runtime/interactive-job-session'
import type { WsMessage } from '../../../types'
import { getAdapter, requireToolPolicy } from '../../../providers'
import { isRunCapReached, runCapRejection, type RunTurnCosts } from '../../execution'
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
import { runQuestionFrom } from '../../../shared/run-question'
import { insertLoopInvocation } from './loop-step-accounting'
import { seedChangeId } from './loop-run-vars'
import { runInteractiveAiStep } from './loop-interactive-ai-step'
import { createLoopRunEvents } from './loop-run-events'
import { bindRunCap, initialEventSeq, normalizeLoopRunRequest, persistLoopRunLaunch, resolveRunLimits, writeRunHeader } from './loop-run-launch'
import { runDefinitionEngine } from './loop-definition-execution'
import { runLegacyTraversal } from './loop-legacy-traversal'
import { saveLimitPause } from './loop-limit-pauses'
import { clearUserPause, saveUserPause, USER_PAUSE_REASON, userPauseRequestId } from './loop-user-pauses'
import { sharesQuota } from '../../provider-quota/domain'
import { settleLoopRun } from './loop-run-settlement'
import type { LoopRunContext, LoopRunHost, LoopRunState } from './loop-run-context'
import type { LoopRunAdmission } from './loop-run-contract'
import { QUEUED_LOG_PREFIX } from './loop-runs-store'
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
  UserPauseRequestResult,
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
  /** Runs waiting for a machine run slot (capacity admission): aborting stops the wait. */
  private readonly _admissionWaits = new Map<string, AbortController>()
  /** Never-started runs (stopped by a restart while queued) the person stopped: they settle without starting. */
  private readonly _stopBeforeStart = new Set<string>()
  /** The person's pending Pause per run (Core request id): the run is still working toward its next step boundary. */
  private readonly _userPauseRequests = new Map<string, string>()
  /** Whether each resident run's retained Core supports the cooperative pause (probed once it has a Core context). */
  private readonly _pauseSupport = new Map<string, boolean>()
  /** Makes every Pause request id unique in this process (Date.now() in the id keeps it unique across restarts). */
  private _userPauseSequence = 0

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
  private readonly _runCaps = new Map<string, { capUsd: number | null; cost: () => number; turns?: () => RunTurnCosts }>()

  /** Best-effort budget read: an unreadable budget never stops a run. */
  private _dailyBudgetBreach(): LoopBudgetBreach | null {
    try { return this.options.dailyBudget?.() ?? null } catch { return null }
  }

  /** The per-run soft cap, when this run's provider-reported cost has reached it, or its
   *  next turn (at the cost of its largest turn so far) would take it past it. `turnsAhead`
   *  looks further: 2 asks, while a turn runs, whether the turn after it could start. */
  private _runCapBreach(runId: string, turnsAhead = 1): LoopBudgetBreach | null {
    const state = this._runCaps.get(runId)
    if (!state) return null
    let turns: RunTurnCosts = { largestUsd: null, lastUsd: null }
    try { turns = state.turns?.() ?? turns } catch { /* an unreadable history projects nothing */ }
    const cost = state.cost()
    if (!isRunCapReached(state.capUsd, cost, turns.largestUsd, turnsAhead)) return null
    return runCapRejection(state.capUsd as number, cost, turns)
  }

  /** Daily/weekly/monthly cap first (refuses outright), then the run's soft cap. */
  private _budgetBreach(runId: string, turnsAhead = 1): LoopBudgetBreach | null {
    return this._dailyBudgetBreach() ?? this._runCapBreach(runId, turnsAhead)
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
  resolveLimitPause(runId: string, choice: { action: 'resume' } | { action: 'switch'; provider: string; model: string; effort?: string; remember?: boolean } | { action: 'auto'; enabled: boolean }): boolean {
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
    // A Core run continues only on a provider its card offered (installed, not sharing the quota).
    if (choice.action === 'switch' && limit.switchTargets && !limit.switchTargets.some(target => target.provider === choice.provider)) return false
    this._pausedHumanDecisions.delete(runId)
    paused.resolve(choice.action === 'switch' ? { action: 'switch', provider: choice.provider, model: choice.model, ...(choice.effort ? { effort: choice.effort } : {}), ...(choice.remember ? { remember: true } : {}) } : { action: 'resume', text: '' })
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

  /**
   * The person's Pause of a RUNNING Core definition run: Core finishes the step in
   * progress and parks at the next step boundary (no step is interrupted), the run
   * holds as `paused` by you, gives its capacity slot back and waits for Resume.
   * `pausing`: the request is recorded and the run is still finishing its step.
   * The request is durable (a restart meanwhile keeps the run paused).
   */
  async requestUserPause(runId: string): Promise<UserPauseRequestResult> {
    if (!this._definitionTasks.has(runId) || this._cancelled.has(runId) || this._disposed) return { status: 'not_running' }
    if (this._pausedHumanDecisions.get(runId)?.userPause) return { status: 'paused' }
    if (this._pausedHumanDecisions.has(runId) || this._admissionWaits.has(runId)) return { status: 'held' }
    const pending = this._userPauseRequests.get(runId)
    if (pending) return { status: 'pausing', requestId: pending }
    const contextPath = readDefinitionRun(this.db, runId)?.metadata.contextPath
    if (!this.executors.pauseDefinition || this._pauseSupport.get(runId) === false) return { status: 'unsupported' }
    if (!contextPath) return { status: 'not_ready' }
    const requestId = userPauseRequestId(runId, ++this._userPauseSequence, this.now())
    this._userPauseRequests.set(runId, requestId)
    try { saveUserPause(this.db, runId, { requestId, requestedAt: new Date(this.now()).toISOString() }) } catch { /* the in-memory request still applies */ }
    this._emit({ type: 'loop.pause_requested', projectId: this.projectIdOf(runId), loopRunId: runId, requestId } as unknown as WsMessage)
    try {
      const result = await this.executors.pauseDefinition({ runId, contextPath, requestId, reason: USER_PAUSE_REASON })
      // Core has nothing left to run: the run settles on its own, there is nothing to pause.
      if (result.outcome === 'terminal') { this._dropUserPauseRequest(runId); return { status: 'not_running' } }
      // `not-running`/`paused`: Desktop holds the run between Core invocations (a host task): it parks at that boundary.
      return { status: 'pausing', requestId }
    } catch (error) {
      this._dropUserPauseRequest(runId)
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('engine_unsupported')) { this._pauseSupport.set(runId, false); return { status: 'unsupported' } }
      throw error
    }
  }

  private _dropUserPauseRequest(runId: string): void {
    if (!this._userPauseRequests.delete(runId)) return
    try { if (!this._pausedHumanDecisions.get(runId)?.userPause) clearUserPause(this.db, runId) } catch { /* settlement clears it */ }
    this._emit({ type: 'loop.pause_request_ended', projectId: this.projectIdOf(runId), loopRunId: runId } as unknown as WsMessage)
  }

  /** True while the run is parked on the person's Pause. */
  userPause(runId: string): boolean {
    return !!this._pausedHumanDecisions.get(runId)?.userPause
  }

  /** True while the person's Pause is requested and the run still finishes its step. */
  isUserPauseRequested(runId: string): boolean {
    return this._userPauseRequests.has(runId)
  }

  /** Resume a run parked on the person's Pause, in place (the same attempt). False when it is not. */
  resumeUserPause(runId: string): boolean {
    const paused = this._pausedHumanDecisions.get(runId)
    if (!paused?.userPause) return false
    this._pausedHumanDecisions.delete(runId)
    paused.resolve({ action: 'resume', text: '' })
    return true
  }

  /**
   * The pause control a surface offers for a resident run: `pause` while it works and
   * its Core can pause, `pausing` until Core parks it, `resume` while it is paused by
   * the person; null otherwise (legacy engine, held on something else, settling).
   */
  userPauseControl(runId: string): 'pause' | 'pausing' | 'resume' | null {
    if (!this._definitionTasks.has(runId) || this._cancelled.has(runId)) return null
    if (this._pausedHumanDecisions.get(runId)?.userPause) return 'resume'
    if (this._userPauseRequests.has(runId)) return 'pausing'
    if (this._pausedHumanDecisions.has(runId) || this._admissionWaits.has(runId)) return null
    return this.executors.pauseDefinition && this._pauseSupport.get(runId) === true ? 'pause' : null
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
    // Queued for capacity: Core has nothing yet, so stopping it only ends the wait (it settles stopped).
    if (!contextPath && this._admissionWaits.has(runId)) { this.cancelResident(runId, false); return Promise.resolve() }
    if (!contextPath || !this.executors.cancelDefinition) return Promise.reject(new Error('runtime_control_unavailable: Frozen workflow cancellation is unavailable'))
    const task = this.executors.cancelDefinition({ runId, contextPath, requestId }).then(() => {
      this.cancelResident(runId, true)
    }).finally(() => { this._definitionCancellations.delete(runId) })
    this._definitionCancellations.set(runId, task)
    return task
  }

  private cancelResident(runId: string, graceful: boolean): void {
    this._cancelled.add(runId)
    this._userPauseRequests.delete(runId)
    // Queued for capacity: nothing runs yet, so stopping it only ends the wait.
    this._admissionWaits.get(runId)?.abort()
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

  /** Why a launched run has not started yet (waiting for capacity), or null. */
  queuedFor(jobId: string): { waitingFor: string; since: string; position: number } | null {
    if (!this._admissionWaits.has(jobId)) return null
    try {
      const waiting = this.options.admission?.()?.waiting(jobId)
      return waiting ? { waitingFor: waiting.waitingFor, since: new Date(waiting.since).toISOString(), position: waiting.position } : null
    } catch { return null }
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

  sendInteractiveTurn(jobId: string, text: string, control?: { interruptId?: string; approve?: boolean; optionId?: string; reject?: boolean }): boolean {
    if (this.definitionForkOwnsRun(jobId)) return false
    const paused = this._pausedHumanDecisions.get(jobId)
    if (paused?.budget) return this.resumeBudgetPause(jobId).status === 'resumed'
    // A message is not a Resume: the person's own Pause holds until they resume it.
    if (paused?.userPause) return false
    if (paused) {
      if (paused.pending?.length) {
        const selected = control?.interruptId ? paused.pending.find(item => item.id === control.interruptId) : paused.pending.length === 1 ? paused.pending[0] : undefined
        if (!selected || (selected.kind !== 'question' && control?.approve !== true && control?.reject !== true)) return false
        // A choice must be one the question offered; a rejection needs a rejectable approval and a reason.
        const question = runQuestionFrom([selected])
        if (control?.optionId && (selected.kind !== 'question' || !question?.options.some(option => option.id === control.optionId))) return false
        if (control?.reject && (!question?.canReject || control.approve === true || !text.trim())) return false
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
    // A queued run stays queued in its row; startup recovery offers it again.
    for (const wait of this._admissionWaits.values()) wait.abort()
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
    const task = this._run({...req,runId}).finally(() => { this.releaseDefinition(runId); this._definitionTasks.delete(runId); this._endUserPauseState(runId) })
    this._definitionTasks.set(runId,task)
    return task
  }

  resumeDefinition(runId: string, input: DefinitionResumeControls = {}): Promise<LoopRunResult> {
    try { return this.beginDefinitionResume(runId, input) } catch (error) { return Promise.reject(error) }
  }

  /** Synchronous admission lets HTTP reject competing writers before acknowledging a resume. */
  /** Stop a run that never reached Core (a restart stopped it while it was queued):
   *  it settles stopped through the ordinary settlement, having run nothing. */
  stopNeverStarted(runId: string): Promise<LoopRunResult> {
    this._stopBeforeStart.add(runId)
    let task: Promise<LoopRunResult>
    try { task = this.beginDefinitionResume(runId) } catch (error) { this._stopBeforeStart.delete(runId); return Promise.reject(error) }
    return task.finally(() => this._stopBeforeStart.delete(runId))
  }

  beginDefinitionResume(runId: string, input: DefinitionResumeControls = {}): Promise<LoopRunResult> {
    if (this._disposed) throw new Error('runtime_shutting_down: LoopRunManager is shut down')
    const active = this._definitionTasks.get(runId)
    if (active) {
      // An explicit resume of a run the person paused continues it in place.
      if (this.resumeUserPause(runId)) return active
      const interruptId = input.interruptId ?? input.approve?.[0]
      if (!this.isPaused(runId)) throw new Error('runtime_run_active: Select a pending question or approval')
      const request = readDefinitionRun(this.db, runId)?.request
      if (!request) throw new Error('runtime_run_not_found: Frozen workflow is unavailable')
      this.claimDefinition({ ...request, runId })
      const rejected = input.reject ? { interruptId: input.reject, reject: true } : {}
      if (!this.sendInteractiveTurn(runId,input.answer ?? input.reason ?? '',{interruptId,approve: Boolean(input.approve?.length),...(input.optionId ? { optionId: input.optionId } : {}),...rejected})) {
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
    const task = this._run(frozen.request,{resume:true,...input}).finally(() => { this.releaseDefinition(runId); this._definitionTasks.delete(runId); this._endUserPauseState(runId) })
    this._definitionTasks.set(runId,task)
    return task
  }

  /** The run's execution here ended: a settled run drops its Pause record; one left
   *  for startup recovery (shutdown) keeps it, so it stays paused after the restart. */
  private _endUserPauseState(runId: string): void {
    this._userPauseRequests.delete(runId)
    this._pauseSupport.delete(runId)
    if (this._disposed) return
    try { if (getLoopRun(this.db, runId)?.status === 'completed') clearUserPause(this.db, runId) } catch { /* a stale record of a settled run is never read */ }
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
      budgetBreach: (runId, options) => this._budgetBreach(runId, options?.turnsAhead ?? 1),
      trackRunCap: (runId, cap) => { this._runCaps.set(runId, cap) },
      untrackRunCap: (runId) => { this._runCaps.delete(runId) },
      claimDefinition: (req) => this.claimDefinition(req),
      releaseDefinition: (runId) => this.releaseDefinition(runId),
      cancelResident: (runId, graceful) => this.cancelResident(runId, graceful),
      userPauseRequest: (runId) => this._userPauseRequests.get(runId) ?? null,
      endUserPauseRequest: (runId) => { this._userPauseRequests.delete(runId) },
      notePauseSupport: (runId, supported) => { if (this._definitionTasks.has(runId)) this._pauseSupport.set(runId, supported) },
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

    const admitted = definitionEngine ? await this._admit(ctx) : { release: () => {} }
    if (admitted === 'disposed') return neverAfterDispose()
    if (admitted === 'stopped') return settleLoopRun(ctx)
    // The slot held now: a hold gives it back and its end takes one again (see _capacitySlot).
    const slot = { release: admitted.release }
    if (definitionEngine) ctx.capacity = this._capacitySlot(ctx, slot)
    try {
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
      return await settleLoopRun(ctx)
    } finally { slot.release() }
  }

  /**
   * Take a machine run slot before Core works on this run (capacity admission).
   * Over capacity the run waits, queued: its log and card say what it waits for,
   * and it starts by itself. Stopped while queued, it settles as stopped having
   * run nothing. Without an admission queue it starts at once.
   */
  private async _admit(ctx: LoopRunContext, again?: { provider?: string }): Promise<{ release: () => void } | 'stopped' | 'disposed'> {
    const { req, runId, state } = ctx
    if (this._stopBeforeStart.has(runId)) {
      state.outcome = 'stopped'
      ctx.events.logLine('■ Stopped before it started; nothing ran.')
      return 'stopped'
    }
    let admission: LoopRunAdmission | null = null
    try { admission = this.options.admission?.() ?? null } catch { admission = null }
    if (!admission) return { release: () => {} }
    const aborter = new AbortController()
    this._admissionWaits.set(runId, aborter)
    let waitedSince: number | null = null
    try {
      const release = await admission.acquire({ runId, projectId: req.projectId, provider: again?.provider ?? admittedProvider(ctx, this.db) }, {
        signal: aborter.signal,
        onWait: (waitingFor, position) => {
          waitedSince ??= this.now()
          ctx.events.logLine(`${QUEUED_LOG_PREFIX}${position} in line): ${queueReasonLine(waitingFor)} It starts by itself when there is room.`)
          this._emit({ type: 'loop.run_queued', projectId: req.projectId, loopRunId: runId, railIndex: req.railIndex ?? null, waitingFor, position })
        },
      })
      if (waitedSince !== null) {
        ctx.events.logLine(`▶ ${again ? 'Continues' : 'Started'} after waiting ${Math.round((this.now() - waitedSince) / 1000)} s for capacity.`)
        this._emit({ type: 'loop.run_resumed', projectId: req.projectId, loopRunId: runId, railIndex: req.railIndex ?? null, ticketIds: ctx.exactTicketIds })
      }
      return { release }
    } catch {
      if (this._disposed) return 'disposed'
      state.outcome = 'stopped'
      ctx.events.logLine(again ? '■ Stopped while it waited for capacity to continue.' : '■ Stopped while it waited for capacity; nothing ran.')
      return 'stopped'
    } finally { this._admissionWaits.delete(runId) }
  }

  /**
   * A held run gives its capacity slot back. Parked on a person (question, approval),
   * its budget or a provider usage limit, it does no work: Core has returned and
   * nothing runs until the hold ends, which can take hours. Keeping the slot blocked
   * the project's other rails and the machine's queue behind a run waiting for
   * someone. When the hold ends it takes a slot again, queued like a launch (same
   * log line, card and cancel), before Core continues. `slot.release` always
   * releases what is held now, so settlement frees the right one.
   */
  private _capacitySlot(ctx: LoopRunContext, slot: { release: () => void }): NonNullable<LoopRunContext['capacity']> {
    let held = true
    return {
      yieldSlot: () => {
        if (!held) return
        held = false
        const release = slot.release
        slot.release = () => {}
        release()
      },
      reclaim: async (provider?: string) => {
        if (held) return 'admitted'
        const again = await this._admit(ctx, { provider })
        if (again === 'stopped' || again === 'disposed') return again
        held = true
        slot.release = again.release
        return 'admitted'
      },
    }
  }
}

/** One plain sentence per admission wait reason (the run log; the UI has its own 8-locale text). */
export function queueReasonLine(waitingFor: string): string {
  switch (waitingFor) {
    case 'run_slots': return 'every run slot of this machine is working.'
    case 'project_slots': return 'this project already runs as many rails at once as it may.'
    case 'provider_slots': return 'this AI provider already runs as many rails at once as it may.'
    case 'cpu': return 'the machine\'s CPU is saturated.'
    case 'memory': return 'the machine is low on free memory.'
    case 'provider_quota': return 'the provider\'s usage window could not finish another run now.'
    default: return 'the machine is at capacity.'
  }
}

/**
 * The provider a run's capacity slot counts against: the one its roles were moved to
 * (a switch at a usage limit, Core routeOverrides), else the run's own.
 */
function admittedProvider(ctx: LoopRunContext, db: DbInstance): string {
  const moved = ctx.continuation?.routeOverrides
  if (moved) return Object.values(moved.routes)[0]?.provider ?? ctx.req.provider
  try {
    const contextPath = readDefinitionRun(db, ctx.runId)?.metadata.contextPath
    if (!contextPath || !acceptedRouteOverrides(contextPath).length) return ctx.req.provider
    const routes = currentRoleRoutes(contextPath)
    return (routes.developer ?? Object.values(routes)[0])?.provider ?? ctx.req.provider
  } catch { return ctx.req.provider }
}
