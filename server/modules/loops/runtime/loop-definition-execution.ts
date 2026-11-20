/**
 * Core definition (engine 2) delegation for one loop run: wires
 * `runDefinitionLoop` to the run's events, spawn registry, execution claim,
 * human/budget pauses, Core's cooperative mid-run budget pause and the host
 * task dispatcher, then maps Core's terminal status onto the run outcome.
 */
import { createDefinitionEventProjection } from './loop-definition-events'
import { probeDefinitionRun } from './loop-definition-recovery'
import { runDefinitionLoop } from './loop-definition-run'
import { definitionRunNeverReachedCore, getLoopRun, readDefinitionRun, recordDefinitionRunning, saveDefinitionRun } from './loop-runs-store'
import { awaitBudget, awaitHumanDecision, awaitProviderLimit, MAX_LIMIT_PAUSES } from './loop-run-pauses'
import { parseCoreFailure } from '../../recovery/domain'
import { classifyProviderLimit } from '../../../provider-limit'
import { resolveResetText } from '../../provider-quota/domain'
import { quotaResumeAt, reportProviderRefusal } from '../../provider-quota/runtime/quota-reports'
import type { DefinitionRuntimeResult } from './loop-definition-run'
import type { LoopRunRequest } from './loop-run-contract'

/** The provider whose account refused: the one Core names, else the one the quota store knows is refusing, else the run's own. */
function limitedProvider(req: LoopRunRequest, named?: string): string {
  if (named) return named
  const candidates = [...new Set([req.provider, ...Object.values(req.graph.config.agents ?? {}).map(agent => (agent as { provider?: unknown })?.provider).filter((id): id is string => typeof id === 'string')])]
  return candidates.find(id => quotaResumeAt(id) !== null) ?? req.provider
}
import type { LoopRunContext } from './loop-run-context'
import { acceptedRouteOverrides, currentRoleRoutes, type DefinitionRouteOverride } from '../../agent-runtime/runtime/agent-runtime-route-overrides'
import { rolesOnProvider, routeOverrideRequest, switchedLine } from './loop-provider-switch'
import type { ProviderSwitchTarget } from './loop-run-contract'

/** The run's record for a Core process stopped by a signal Specrails did not send (recovery EXTERNAL_STOP). */
export function unrequestedStopText(errorText: string | undefined, step: string | null): string {
  const signal = /\((SIG[A-Z]+)\)/.exec(errorText ?? '')?.[1] ?? 'a termination signal'
  return `The run's Core process received ${signal}, a stop Specrails did not request: something outside the app (a script, a terminal or the system) ended it${step ? ` during the ${step} step` : ''}. The work so far is kept; Continue resumes from that step.`
}

/** Node kinds whose step is a provider turn (the runtime graph names each node's kind). */
const AI_NODE_KINDS: ReadonlySet<string> = new Set(['role-turn', 'prompt', 'implementation', 'implementation-step', 'derive-change', 'agent'])

export async function runDefinitionEngine(ctx: LoopRunContext): Promise<void> {
  const aiNodes = new Set<string>()
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
  // Core's cooperative pause takes effect at the next node it admits, and a request is a
  // short Core process: after a turn ends, the next turn can be admitted before it lands
  // (one gpt-6-astra run went $4.89 against a $2.00 cap). While a turn runs, a request is
  // armed when this turn and the next one, at the run's largest turn cost, would pass the
  // per-run cap; the pause then stops the run before the next turn, which is checked again.
  const requestBudgetPause = (turnsAhead = 1): void => {
    if (budgetPauseRequested || budgetPauseUnsupported || !executors.pauseDefinition || host.isCancelled(runId) || host.isDisposed()) return
    const breach = host.budgetBreach(runId, { turnsAhead })
    const contextPath = breach ? readDefinitionRun(db, runId)?.metadata.contextPath : undefined
    if (!breach || !contextPath) return
    budgetPauseRequested = true
    // Unique per process too: after a restart the episode counter starts again, and Core ignores a
    // pause whose request id it already consumed (a resumed run then ran past its cap to delivery).
    const requestId = `desktop-budget-pause:${runId}:${++budgetPauseEpisode}:${Date.now().toString(36)}`
    if (turnsAhead > 1 && breach.period === 'run') {
      logLine(`\n■ Per-run cap: this turn and the next could take the run past its $${breach.budgetUsd.toFixed(2)} cap. The workflow pauses after this turn, and the next turn starts only if the cap allows it.`, 'stderr')
    } else {
      logLine(`\n■ ${breach.period === 'run' ? 'Per-run cap reached mid-run' : 'Daily budget reached mid-run'} — ${breach.detail} Pausing the workflow after its current step.`, 'stderr')
    }
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
  // The step Core was running last: an unrequested stop names it.
  let lastStep: string | null = null
  // A provider turn starting is where the next turn's budget is checked ahead.
  const observeTurns = (event: Record<string, unknown>): void => {
    const workflow = event.type === 'workflow-event' ? event.event as { type?: unknown; nodePath?: unknown } | undefined : undefined
    if (workflow?.type === 'step_started' && typeof workflow.nodePath === 'string') lastStep = workflow.nodePath
    if (event.type === 'runtime-graph' && Array.isArray(event.nodes)) {
      for (const node of event.nodes as Array<{ path?: unknown; kind?: unknown }>) if (typeof node?.path === 'string' && AI_NODE_KINDS.has(String(node.kind))) aiNodes.add(node.path)
    } else if (workflow?.type === 'step_started' && typeof workflow.nodePath === 'string' && aiNodes.has(workflow.nodePath)) requestBudgetPause(2)
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
  const awaitLimit = async (result: DefinitionRuntimeResult): Promise<'continue' | 'stop' | 'settle' | { routeOverrides: DefinitionRouteOverride }> => {
    const failure = parseCoreFailure(result.failure)
    const limited = failure?.kind === 'provider_limit' || (!failure && classifyProviderLimit(result.errorText) !== null)
    if (!limited || result.completion || host.isCancelled(runId) || host.isDisposed() || limitPauses >= MAX_LIMIT_PAUSES) return 'settle'
    limitPauses += 1
    // Core names the refusing CLI on its failure record (routeOverrides Cores) and in its typed message, or
    // its execution failure carries the CLI's own limit sentence ("codex execution failed (exit 1). … usage limit").
    const rawProvider = (result.failure as { provider?: unknown } | undefined)?.provider
    const named = typeof rawProvider === 'string' ? rawProvider : /\b(claude|codex|gemini|kimi) (?:usage limit reached|execution failed)\b/i.exec(result.errorText ?? '')?.[1]?.toLowerCase()
    const provider = limitedProvider(req, named)
    const words = failure?.resetAt ?? classifyProviderLimit(result.errorText)?.resetsAt ?? null
    reportProviderRefusal(provider, failure?.resetsAt ?? words)
    const resumeAt = failure?.resetsAt ?? quotaResumeAt(provider) ?? resolveResetText(words, host.now())
    const message = failure?.detail ?? classifyProviderLimit(result.errorText)?.message ?? 'The provider refused the request on its usage limit'
    const switching = await switchOffer(provider)
    const outcome = await awaitProviderLimit(ctx, { providerId: provider, resumeAt, message, switchable: switching !== null,
      ...(switching ? { switchRoles: switching.roles, switchTargets: switching.targets } : {}) })
    if (outcome.action === 'stop') return 'stop'
    if (outcome.action !== 'switch' || !switching) return 'continue'
    // Continue now on another provider (Core routeOverrides): every role that ran on the limited
    // provider moves, for the rest of this run. Switching answered the pause, so the automatic
    // resume scheduled for the old provider is gone with it.
    const choice = { provider: outcome.provider, model: outcome.model, ...(outcome.effort ? { effort: outcome.effort } : {}) }
    const request = routeOverrideRequest({ runId, sequence: acceptedRouteOverrides(switching.contextPath).length + 1, fromProvider: provider, roles: switching.roles, choice })
    const line = switchedLine(provider, choice)
    logLine(`\n▶ ${line}. The ${switching.roles.join(', ')} steps continue there for the rest of this run: the interrupted step starts again with a fresh session and the work already in the worktree is kept.`)
    emitRunEvent('provider_switched', { fromProvider: provider, provider: choice.provider, model: choice.model, effort: choice.effort ?? null, roles: switching.roles, remember: outcome.remember === true, text: line })
    // Capacity: the run's slot now counts against the new provider's slots and quota.
    try { host.options.admission?.()?.reassign?.(runId, choice.provider) } catch { /* advisory accounting */ }
    if (outcome.remember) {
      try {
        host.options.providerSwitch?.()?.remember(Object.fromEntries(switching.roles.map(role => [role, choice as { provider: string; model: string; effort?: string }])))
        logLine(`  The project now routes ${switching.roles.join(', ')} to ${choice.provider}/${choice.model}${choice.effort ? ` (${choice.effort})` : ''}.`)
      } catch (error) { logLine(`  The project routes could not be updated: ${error instanceof Error ? error.message : String(error)}`, 'stderr') }
    }
    return { routeOverrides: request }
  }
  /** The roles a switch moves and where they may go; null when this run cannot switch (older Core, nothing else installed). */
  const switchOffer = async (provider: string): Promise<{ contextPath: string; roles: string[]; targets: ProviderSwitchTarget[] } | null> => {
    const contextPath = readDefinitionRun(db, runId)?.metadata.contextPath
    const port = host.options.providerSwitch?.()
    if (!contextPath || !port || !executors.supportsRouteOverrides) return null
    try {
      if (!await executors.supportsRouteOverrides({ runId, contextPath })) return null
      const roles = rolesOnProvider(currentRoleRoutes(contextPath), provider)
      const targets = roles.length ? port.targets({ fromProvider: provider, roles }) : []
      return targets.length ? { contextPath, roles, targets } : null
    } catch (error) {
      console.error(`[loop-run] provider switch offer for ${runId} failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  // A retained run resumed on another provider (the switch answered after a restart): say so like a live switch.
  if (continuation?.routeOverrides) {
    const moved = continuation.routeOverrides, first = Object.values(moved.routes)[0]
    if (first?.model) {
      const choice = { provider: first.provider, model: first.model, ...(first.effort ? { effort: first.effort } : {}) }
      const line = switchedLine(moved.fromProvider ?? req.provider, choice)
      logLine(`\n▶ ${line}. The ${Object.keys(moved.routes).join(', ')} steps continue there for the rest of this run: the interrupted step starts again with a fresh session and the work already in the worktree is kept.`)
      emitRunEvent('provider_switched', { fromProvider: moved.fromProvider ?? req.provider, provider: choice.provider, model: choice.model, effort: choice.effort ?? null, roles: Object.keys(moved.routes), text: line })
    }
  }
  let activeDurationMs = continuation ? getLoopRun(db, runId)?.total_duration_ms ?? 0 : 0
  // A run that never reached Core (it waited, queued for capacity, when the app
  // stopped) has no Core context to resume: its continuation starts it afresh.
  const coreStarted = !definitionRunNeverReachedCore(db, runId)
  const result = await runDefinitionLoop(req, runId, { continuation: continuation && coreStarted ? continuation : undefined, contextPath: () => readDefinitionRun(db, runId)?.metadata.contextPath,
    onPrepared: metadata => { saveDefinitionRun(db, runId, metadata) },
    invoke: input => {
      host.claimDefinition({ ...req, runId })
      // Resuming answers the stored pause: the API shows the run working from now, not after Core's first event.
      if (input.resume) { try { recordDefinitionRunning(db, runId, getLoopRun(db, runId)?.core_event_cursor ?? 0) } catch { /* the projection settles it on workflow_resumed */ } }
      return executors.runDefinition!(input)
    }, isCancelled: () => host.isCancelled(runId),
    remainingMs: () => req.graph.config.timeoutMinutes > 0 ? Math.max(1, req.graph.config.timeoutMinutes * 60_000 - activeDurationMs) : undefined,
    onLine: logLine, onRuntimeEvent: event => { auditTap?.(event); projectEvent(event); observeTurns(event) }, onSpawn: child => {
      host.setActiveChild(runId, child)
      if (host.isCancelled(runId)) host.cancelResident(runId, false)
    },
    onInvocationEnd: result => {
      host.clearActiveChild(runId); budgetPauseRequested = false; if (result.runtimeStatus === 'paused') host.releaseDefinition(runId); if (result.durationMs !== undefined) { activeDurationMs = result.durationMs; state.totalDuration = result.durationMs }
      try { host.options.onDefinitionInvocationEnd?.(runId, exactTicketIds, result.runtimeStatus) } catch { /* advisory observer */ }
    }, awaitHumanDecision: (reason, pending) => awaitHumanDecision(ctx, reason, pending),
    // Machine-wide installs (Core `machineInstalls`): the host runs an approved install itself,
    // outside the run, with its output in the run log; a remembered approval never asks again.
    ...(host.options.machineInstalls?.() ? { machineInstalls: {
      autoAnswer: interrupt => host.options.machineInstalls!()!.autoAnswer(interrupt, line => logLine(line)),
      answer: (interrupt, text) => host.options.machineInstalls!()!.answer(interrupt, text, line => logLine(line)),
      lookup: async interruptId => (await probeDefinitionRun({ db, cwd: req.cwd, env: process.env }, runId)).pendingInterrupts.find(item => item.id === interruptId) ?? null,
    } } : {}),
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
      logLine(`\n▶ The budget allows the next step — resuming the workflow.`)
      return 'continue'
    },
  })
  state.definitionCompletion = result.completion
  state.coreFailure = result.failure
  if (result.errorText) state.failureText = result.errorText
  if (result.durationMs !== undefined) state.totalDuration = result.durationMs
  if (result.errorText) logLine(result.errorText, 'stderr')
  state.outcome = result.runtimeStatus === 'succeeded' ? 'success' : result.runtimeStatus === 'cancelled' ? 'stopped' : result.runtimeStatus === 'blocked' ? 'blocked' : 'failed'
  // Core cancelled the run on a signal nobody in Specrails sent (no Stop, no shutdown):
  // a script, a terminal or the system stopped its process. That is not the person's
  // stop: the record says what happened and the run stays continuable from its step.
  if (result.runtimeStatus === 'cancelled' && !host.isCancelled(runId) && !host.isDisposed()) {
    const text = unrequestedStopText(result.errorText, lastStep)
    state.outcome = 'failed'
    state.failureText = text
    state.failedStepId = lastStep ?? undefined
    logLine(`\n■ ${text}`, 'stderr')
  }
}
