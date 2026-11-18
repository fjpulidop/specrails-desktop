/**
 * Core definition (engine 2) delegation for one loop run: wires
 * `runDefinitionLoop` to the run's events, spawn registry, execution claim,
 * human/budget pauses, Core's cooperative mid-run budget pause and the host
 * task dispatcher, then maps Core's terminal status onto the run outcome.
 */
import { createDefinitionEventProjection } from './loop-definition-events'
import { runDefinitionLoop } from './loop-definition-run'
import { getLoopRun, readDefinitionRun, saveDefinitionRun } from './loop-runs-store'
import { awaitBudget, awaitHumanDecision, awaitProviderLimit, MAX_LIMIT_PAUSES } from './loop-run-pauses'
import { parseCoreFailure } from '../../recovery/domain'
import { classifyProviderLimit } from '../../../provider-limit'
import { resolveResetText } from '../../provider-quota/domain'
import { quotaResumeAt, reportProviderRefusal } from '../../provider-quota/runtime/quota-reports'
import type { DefinitionRuntimeResult } from './loop-definition-run'
import type { LoopRunRequest } from './loop-run-contract'

/** The provider whose account refused: the one the quota store knows is refusing, else the run's own. */
function limitedProvider(req: LoopRunRequest): string {
  const candidates = [...new Set([req.provider, ...Object.values(req.graph.config.agents ?? {}).map(agent => (agent as { provider?: unknown })?.provider).filter((id): id is string => typeof id === 'string')])]
  return candidates.find(id => quotaResumeAt(id) !== null) ?? req.provider
}
import type { LoopRunContext } from './loop-run-context'

export async function runDefinitionEngine(ctx: LoopRunContext): Promise<void> {
  const { host, req, runId, state, continuation, exactTicketIds } = ctx
  const { logLine, emitRunEvent, takeSeq, auditTap } = ctx.events
  const { db, executors } = host
  // rail-loop-budget-guard (mid-run): Core schedules every step inside one
  // invocation, so a budget crossed by a role's spend is enforced with
  // Core's cooperative pause (`pauseRuns`): the current step finishes, Core
  // records `paused` (reason `budget`) and exits 2, and the run parks on
  // the same resumable `budget_paused` pause. One request per invocation;
  // a Core without the capability keeps the between-invocation guard.
  let budgetPauseRequested = false, budgetPauseUnsupported = false, budgetPauseEpisode = 0, budgetCheckedCost = state.totalCost
  const requestBudgetPause = (): void => {
    if (budgetPauseRequested || budgetPauseUnsupported || !executors.pauseDefinition || host.isCancelled(runId) || host.isDisposed()) return
    const breach = host.budgetBreach(runId)
    const contextPath = breach ? readDefinitionRun(db, runId)?.metadata.contextPath : undefined
    if (!breach || !contextPath) return
    budgetPauseRequested = true
    const requestId = `desktop-budget-pause:${runId}:${++budgetPauseEpisode}`
    logLine(`\n■ Daily budget reached mid-run — ${breach.detail} Pausing the workflow after its current step.`, 'stderr')
    void executors.pauseDefinition({ runId, contextPath, requestId, reason: 'budget' }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      if (message.startsWith('engine_unsupported')) {
        budgetPauseUnsupported = true
        logLine(`\n■ This run's Core cannot pause mid-run; the daily budget applies before its next continuation.`, 'stderr')
      } else {
        budgetPauseRequested = false
        console.error(`[loop-run] budget pause request failed for ${runId}: ${message}`)
      }
    })
  }
  const projectEvent = createDefinitionEventProjection({ db, runId, projectId: req.projectId, ticketIds: exactTicketIds, nextSequence: takeSeq,
    broadcast: event => host.emit({ type: 'event', jobId: runId, event_type: event.eventType, source: 'stdout', payload: event.payload, seq: event.seq, timestamp: event.timestamp }),
    onProgress: (count, usage) => {
      state.stepNum = count; state.totalCost = usage.cost; state.totalTokens = usage.tokensIn + usage.tokensOut; state.totalDuration = usage.duration; state.costUncertain = usage.costUnknown; state.usageTelemetryAvailable = usage.present
      // Only new recorded spend can cross the budget: check on a cost change.
      if (state.totalCost > budgetCheckedCost) { budgetCheckedCost = state.totalCost; requestBudgetPause() }
    },
  })
  // provider-quota: Core failed on a usage limit. Pause until the reset (or a
  // person's resume) and resume the retained run; Core re-runs the refused step.
  // A run with a durable completion cannot resume, so its failure stands.
  let limitPauses = 0
  const awaitLimit = async (result: DefinitionRuntimeResult): Promise<'continue' | 'stop' | 'settle'> => {
    const failure = parseCoreFailure(result.failure)
    const limited = failure?.kind === 'provider_limit' || (!failure && classifyProviderLimit(result.errorText) !== null)
    if (!limited || result.completion || host.isCancelled(runId) || host.isDisposed() || limitPauses >= MAX_LIMIT_PAUSES) return 'settle'
    limitPauses += 1
    const provider = limitedProvider(req)
    const words = failure?.resetAt ?? classifyProviderLimit(result.errorText)?.resetsAt ?? null
    reportProviderRefusal(provider, failure?.resetsAt ?? words)
    const resumeAt = failure?.resetsAt ?? quotaResumeAt(provider) ?? resolveResetText(words, host.now())
    const message = failure?.detail ?? classifyProviderLimit(result.errorText)?.message ?? 'The provider refused the request on its usage limit'
    const outcome = await awaitProviderLimit(ctx, { providerId: provider, resumeAt, message, switchable: false })
    return outcome.action === 'stop' ? 'stop' : 'continue'
  }
  let activeDurationMs = continuation ? getLoopRun(db, runId)?.total_duration_ms ?? 0 : 0
  const result = await runDefinitionLoop(req, runId, { continuation, contextPath: () => readDefinitionRun(db, runId)?.metadata.contextPath,
    onPrepared: metadata => { saveDefinitionRun(db, runId, metadata) },
    invoke: input => { host.claimDefinition({ ...req, runId }); return executors.runDefinition!(input) }, isCancelled: () => host.isCancelled(runId),
    remainingMs: () => req.graph.config.timeoutMinutes > 0 ? Math.max(1, req.graph.config.timeoutMinutes * 60_000 - activeDurationMs) : undefined,
    onLine: logLine, onRuntimeEvent: auditTap ? event => { auditTap(event); return projectEvent(event) } : projectEvent, onSpawn: child => {
      host.setActiveChild(runId, child)
      if (host.isCancelled(runId)) host.cancelResident(runId, false)
    },
    onInvocationEnd: result => {
      host.clearActiveChild(runId); budgetPauseRequested = false; if (result.runtimeStatus === 'paused') host.releaseDefinition(runId); if (result.durationMs !== undefined) { activeDurationMs = result.durationMs; state.totalDuration = result.durationMs }
      try { host.options.onDefinitionInvocationEnd?.(runId, exactTicketIds, result.runtimeStatus) } catch { /* advisory observer */ }
    }, awaitHumanDecision: (reason, pending) => awaitHumanDecision(ctx, reason, pending),
    // Machine interrupts (Core `hostTasks`): Desktop performs the effect
    // itself and resumes Core with the typed result — never a person.
    resolveHostTask: async interrupt => {
      const dispatcher = host.options.hostTasks?.()
      const task = interrupt.value.task
      emitRunEvent('host_task_started', { interruptId: interrupt.id, nodePath: interrupt.nodePath, task, input: interrupt.value.input })
      if (!dispatcher) {
        logLine(`\n■ Host task ${task} cannot run on this Desktop.`, 'stderr')
        const result = { outcome: 'failed', output: { detail: `This Desktop cannot perform host task ${task}` } }
        emitRunEvent('host_task_finished', { interruptId: interrupt.id, nodePath: interrupt.nodePath, task, outcome: result.outcome })
        return { action: 'resume' as const, result }
      }
      // The worktree stays claimed while the host acts in it (Core holds no lease).
      host.claimDefinition({ ...req, runId })
      logLine(`\n▶ Host task ${task}`)
      try {
        const result = await dispatcher.dispatch({ runId, interruptId: interrupt.id, request: interrupt.value, log: line => logLine(line) })
        emitRunEvent('host_task_finished', { interruptId: interrupt.id, nodePath: interrupt.nodePath, task, outcome: result.outcome })
        logLine(`✓ Host task ${task}: ${result.outcome}`)
        return { action: 'resume' as const, result }
      } catch (error) {
        // Shutdown: startup recovery re-dispatches the persisted host task; never settle here.
        if (host.isDisposed()) return new Promise<never>(() => { /* startup recovery owns settlement */ })
        if (host.isCancelled(runId)) return { action: 'stop' as const }
        throw error
      }
    },
    // Core schedules every step inside one invocation; the only boundary
    // Desktop owns is the re-invocation after a human decision.
    beforeContinuation: async () => {
      const breach = host.budgetBreach(runId)
      return breach ? awaitBudget(ctx, breach) : 'continue'
    },
    // Core exited 2 on the budget pause requested above. A budget raised
    // meanwhile resumes at once; otherwise the run waits like any budget pause.
    awaitProviderLimit: awaitLimit,
    awaitHostPause: async pause => {
      if (pause.reason !== 'budget') throw new Error(`Core paused (${pause.reason}) without an addressable interrupt`)
      const breach = host.budgetBreach(runId)
      if (breach) return awaitBudget(ctx, breach)
      logLine(`\n▶ The daily budget allows the next step — resuming the workflow.`)
      return 'continue'
    },
  })
  state.definitionCompletion = result.completion
  state.coreFailure = result.failure
  if (result.errorText) state.failureText = result.errorText
  if (result.durationMs !== undefined) state.totalDuration = result.durationMs
  if (result.errorText) logLine(result.errorText, 'stderr')
  state.outcome = result.runtimeStatus === 'succeeded' ? 'success' : result.runtimeStatus === 'cancelled' ? 'stopped' : result.runtimeStatus === 'blocked' ? 'blocked' : 'failed'
}
