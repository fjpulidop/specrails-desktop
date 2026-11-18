/**
 * In-process pauses of a running loop: a human decision (LOOP_BLOCKED, a
 * blocked Decider, a Core question/approval) and the resumable
 * `budget_paused` pause. Both park the run on the manager's pause registry,
 * persist `paused` with the run's counters and broadcast the paused/resumed
 * transitions; Stop (or cancel) resolves them as `stop`.
 */
import { markJobInteractive } from '../../../db'
import { pauseLoopRun, resumeLoopRun } from './loop-runs-store'
import { truncate } from './loop-run-vars'
import { runCounters, type LoopRunContext } from './loop-run-context'
import { BUDGET_PAUSED, type LoopBudgetBreach, type PausedHumanDecision } from './loop-run-contract'
import type { DefinitionInterrupt } from './loop-definition-run'

export async function awaitHumanDecision(ctx: LoopRunContext, reason: string, pending?: DefinitionInterrupt[]): Promise<PausedHumanDecision> {
  const { host, req, runId, state, exactTicketIds } = ctx
  const { logLine } = ctx.events
  const decisionPromise = new Promise<PausedHumanDecision>((resolve) => {
    host.parkPause(runId, { reason, pending, resolve })
  })
  logLine(`\n■ Loop paused — needs a human decision: ${reason}`, 'stderr')
  try { markJobInteractive(host.db, runId) } catch { /* best-effort */ }
  pauseLoopRun(host.db, runId, runCounters(state))
  const pausedAt = new Date(host.now()).toISOString()
  host.emit({
    type: 'loop.run_paused',
    projectId: req.projectId,
    loopRunId: runId,
    railIndex: req.railIndex ?? null,
    reason,
    ticketIds: exactTicketIds,
  })
  host.emit({
    type: 'job.interactive',
    projectId: req.projectId,
    jobId: runId,
    acceptingTurns: true,
    // Only human interrupts reach a person; host tasks are resolved by the host.
    pendingInterrupts: pending?.filter((item): item is DefinitionInterrupt & { kind: 'question' | 'approval' | 'gate' } => item.kind !== 'host-task'),
    settleMode: 'auto',
    timestamp: pausedAt,
  })

  const decision = await decisionPromise
  if (host.isDisposed()) return new Promise(() => { /* startup recovery owns settlement */ })
  if (decision.action === 'stop' || host.isCancelled(runId)) {
    logLine(`\n■ Loop stop requested while paused.`, 'stderr')
    return { action: 'stop' }
  }

  resumeLoopRun(host.db, runId)
  const answer = decision.text.trim()
  const resumedAt = new Date(host.now()).toISOString()
  logLine(`\n▶ Loop resumed — human decision received${answer ? `:\n${answer}` : '.'}`)
  ctx.history.push(`Human decision: ${truncate(answer)}`)
  host.emit({
    type: 'loop.run_resumed',
    projectId: req.projectId,
    loopRunId: runId,
    railIndex: req.railIndex ?? null,
    ticketIds: exactTicketIds,
  })
  host.emit({
    type: 'job.interactive',
    projectId: req.projectId,
    jobId: runId,
    acceptingTurns: false,
    pendingInterrupts: [],
    settleMode: 'auto',
    timestamp: resumedAt,
  })
  return decision
}

// rail-loop-budget-guard: the daily budget ran out between AI steps. The run
// parks as `paused` (restart_reason `budget_paused`) on the same in-process
// pause the human-decision path uses — no new lifecycle. Resume re-checks the
// budget and continues from the next step; Stop settles 'stopped'. The pause
// does not consume the run's wall-clock deadline.
export async function awaitBudget(ctx: LoopRunContext, breach: LoopBudgetBreach): Promise<'continue' | 'stop'> {
  const { host, req, runId, state, exactTicketIds } = ctx
  const { logLine } = ctx.events
  let current = breach
  for (;;) {
    const reason = `${current.detail} ${current.action}`
    const decisionPromise = new Promise<PausedHumanDecision>((resolve) => {
      host.parkPause(runId, { reason, budget: current, resolve })
    })
    logLine(`\n■ Loop paused (${BUDGET_PAUSED}) — ${current.detail} Raise the budget, then resume: the run continues from the next step.`, 'stderr')
    const pausedAtMs = host.now()
    pauseLoopRun(host.db, runId, runCounters(state), BUDGET_PAUSED)
    host.emit({
      type: 'loop.run_paused',
      projectId: req.projectId,
      loopRunId: runId,
      railIndex: req.railIndex ?? null,
      reason,
      ticketIds: exactTicketIds,
      pauseKind: BUDGET_PAUSED,
      budget: { scope: current.scope, ...(current.period ? { period: current.period } : {}), budgetUsd: current.budgetUsd, spentUsd: current.spentUsd, resetsAt: current.resetsAt },
    })
    host.emit({
      type: 'job.interactive',
      projectId: req.projectId,
      jobId: runId,
      acceptingTurns: true,
      pendingInterrupts: [],
      settleMode: 'auto',
      timestamp: new Date(pausedAtMs).toISOString(),
    })
    const decision = await decisionPromise
    if (host.isDisposed()) return new Promise(() => { /* startup recovery owns settlement */ })
    if (decision.action === 'stop' || host.isCancelled(runId)) {
      logLine(`\n■ Loop stop requested while paused on the daily budget.`, 'stderr')
      return 'stop'
    }
    if (Number.isFinite(state.deadline)) state.deadline += Math.max(0, host.now() - pausedAtMs)
    const still = host.budgetBreach(runId)
    if (still) { current = still; continue }
    resumeLoopRun(host.db, runId)
    const resumedAt = new Date(host.now()).toISOString()
    logLine(`\n▶ Loop resumed — the daily budget allows the next step.`)
    host.emit({
      type: 'loop.run_resumed',
      projectId: req.projectId,
      loopRunId: runId,
      railIndex: req.railIndex ?? null,
      ticketIds: exactTicketIds,
    })
    host.emit({
      type: 'job.interactive',
      projectId: req.projectId,
      jobId: runId,
      acceptingTurns: false,
      pendingInterrupts: [],
      settleMode: 'auto',
      timestamp: resumedAt,
    })
    return 'continue'
  }
}
