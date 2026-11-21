/**
 * In-process pauses of a running loop: a human decision (LOOP_BLOCKED, a
 * blocked Decider, a Core question/approval), the resumable `budget_paused`
 * pause and the `limit_paused` pause (provider usage limit). Both park the run on the manager's pause registry,
 * persist `paused` with the run's counters and broadcast the paused/resumed
 * transitions; Stop (or cancel) resolves them as `stop`.
 */
import { markJobInteractive } from '../../../db'
import { pauseLoopRun, resumeLoopRun } from './loop-runs-store'
import { truncate } from './loop-run-vars'
import { runCounters, type LoopRunContext } from './loop-run-context'
import { BUDGET_PAUSED, LIMIT_PAUSED, USER_PAUSED, type LoopBudgetBreach, type LoopLimitPause, type PausedHumanDecision } from './loop-run-contract'
import { clearLimitPause, saveLimitPause } from './loop-limit-pauses'
import { clearUserPause, markUserPaused, USER_PAUSE_EVENT, USER_RESUME_LINE } from './loop-user-pauses'
import { scheduleLimitResume } from '../../provider-quota/runtime/quota-reports'
import type { DefinitionInterrupt } from './loop-definition-run'
import { runQuestionFrom } from '../../../shared/run-question'

export async function awaitHumanDecision(ctx: LoopRunContext, reason: string, pending?: DefinitionInterrupt[]): Promise<Exclude<PausedHumanDecision, { action: 'switch' }>> {
  const { host, req, runId, state, exactTicketIds } = ctx
  const { logLine } = ctx.events
  const decisionPromise = new Promise<PausedHumanDecision>((resolve) => {
    host.parkPause(runId, { reason, pending, resolve })
  })
  // The card every surface renders; null for a legacy (non-definition) pause, which keeps its plain reason.
  const question = runQuestionFrom(pending)
  logLine(question ? `\n■ Needs you — ${question.kind === 'approval' ? 'approval' : 'question'}: ${reason}` : `\n■ Loop paused — needs a human decision: ${reason}`, 'stderr')
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
    ...(question ? { question } : {}),
  })
  host.emit({
    type: 'job.interactive',
    projectId: req.projectId,
    jobId: runId,
    acceptingTurns: true,
    ...(question ? { question } : {}),
    // Only human interrupts reach a person; host tasks are resolved by the host.
    pendingInterrupts: pending?.filter((item): item is DefinitionInterrupt & { kind: 'question' | 'approval' | 'gate' } => item.kind !== 'host-task'),
    settleMode: 'auto',
    timestamp: pausedAt,
  })

  ctx.capacity?.yieldSlot()
  const decision = await decisionPromise
  if (host.isDisposed()) return new Promise(() => { /* startup recovery owns settlement */ })
  if (decision.action !== 'resume' || host.isCancelled(runId)) {
    logLine(`\n■ Loop stop requested while paused.`, 'stderr')
    return { action: 'stop' }
  }

  resumeLoopRun(host.db, runId, new Date(host.now()))
  const answer = decision.text.trim()
  const resumedAt = new Date(host.now()).toISOString()
  const chosen = decision.optionId ? question?.options.find(option => option.id === decision.optionId)?.label : undefined
  logLine(!question
    ? `\n▶ Loop resumed — human decision received${answer ? `:\n${answer}` : '.'}`
    : decision.reject
      ? `\n▶ Rejected by you${answer ? `: ${answer}` : '.'}`
      : `\n▶ Answer received — the run continues${chosen ? `: ${chosen}` : answer ? `:\n${answer}` : '.'}`)
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
    // The card every surface shows is answered: they drop it now.
    ...(question ? { question: null } : {}),
    settleMode: 'auto',
    timestamp: resumedAt,
  })
  const slot = await reclaimSlot(ctx)
  if (slot === 'disposed') return new Promise(() => { /* startup recovery owns settlement */ })
  return slot === 'stopped' ? { action: 'stop' } : decision
}

/**
 * The hold ended: take a capacity slot again before Core continues (queued like a
 * launch when the machine, project or provider is full). Stop while queued ends the run.
 */
async function reclaimSlot(ctx: LoopRunContext, provider?: string): Promise<'admitted' | 'stopped' | 'disposed'> {
  if (!ctx.capacity) return 'admitted'
  const slot = await ctx.capacity.reclaim(provider)
  if (slot === 'stopped') ctx.events.logLine(`\n■ Loop stop requested while it waited for capacity.`, 'stderr')
  return slot
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
    ctx.capacity?.yieldSlot()
    const decision = await decisionPromise
    if (host.isDisposed()) return new Promise(() => { /* startup recovery owns settlement */ })
    if (decision.action === 'stop' || host.isCancelled(runId)) {
      logLine(`\n■ Loop stop requested while paused on the daily budget.`, 'stderr')
      return 'stop'
    }
    if (Number.isFinite(state.deadline)) state.deadline += Math.max(0, host.now() - pausedAtMs)
    const still = host.budgetBreach(runId)
    if (still) { current = still; continue }
    resumeLoopRun(host.db, runId, new Date(host.now()))
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
    const slot = await reclaimSlot(ctx)
    if (slot === 'disposed') return new Promise(() => { /* startup recovery owns settlement */ })
    return slot === 'stopped' ? 'stop' : 'continue'
  }
}

/**
 * The person paused the run (Pause): Core finished the step it was on and parked at
 * the next step boundary. The run parks as `paused` (restart_reason `user_paused`) on
 * the same in-process pause as a question or the budget, gives its capacity slot back
 * and waits for the person: it never resumes by itself. Resume continues the same
 * attempt from the next step (a budget spent meanwhile parks it on the budget first);
 * Stop settles it stopped. The pause does not consume the run's wall-clock deadline.
 */
export async function awaitUserPause(ctx: LoopRunContext, requestId: string): Promise<'continue' | 'stop'> {
  const { host, req, runId, state, exactTicketIds } = ctx
  const { logLine } = ctx.events
  const reason = 'Paused by you'
  const decisionPromise = new Promise<PausedHumanDecision>((resolve) => {
    host.parkPause(runId, { reason, userPause: true, resolve })
  })
  host.endUserPauseRequest(runId)
  const pausedAtMs = host.now()
  const pausedAt = new Date(pausedAtMs).toISOString()
  logLine(`\n■ Paused by you (${USER_PAUSED}) — the step in progress finished; nothing runs until you resume. Resume continues this same run from its next step.`, 'stderr')
  // The narrated log says it in the person's language ("Paused by you").
  ctx.events.emitRunEvent(USER_PAUSE_EVENT, { state: 'paused' })
  try { markUserPaused(host.db, runId, requestId, pausedAt) } catch { /* the in-memory pause still holds; a restart keeps the run paused anyway */ }
  pauseLoopRun(host.db, runId, runCounters(state), USER_PAUSED)
  host.emit({ type: 'loop.run_paused', projectId: req.projectId, loopRunId: runId, railIndex: req.railIndex ?? null, reason, ticketIds: exactTicketIds, pauseKind: USER_PAUSED })
  host.emit({ type: 'job.interactive', projectId: req.projectId, jobId: runId, acceptingTurns: false, pendingInterrupts: [], settleMode: 'auto', timestamp: pausedAt })
  ctx.capacity?.yieldSlot()
  const decision = await decisionPromise
  if (host.isDisposed()) return new Promise(() => { /* startup recovery owns settlement; the record keeps it paused */ })
  if (decision.action === 'stop' || host.isCancelled(runId)) {
    logLine(`\n■ Loop stop requested while paused.`, 'stderr')
    return 'stop'
  }
  if (Number.isFinite(state.deadline)) state.deadline += Math.max(0, host.now() - pausedAtMs)
  try { clearUserPause(host.db, runId) } catch { /* a stale record is cleared by the run's settlement */ }
  resumeLoopRun(host.db, runId, new Date(host.now()))
  logLine(USER_RESUME_LINE)
  ctx.events.emitRunEvent(USER_PAUSE_EVENT, { state: 'resumed' })
  host.emit({ type: 'loop.run_resumed', projectId: req.projectId, loopRunId: runId, railIndex: req.railIndex ?? null, ticketIds: exactTicketIds })
  host.emit({ type: 'job.interactive', projectId: req.projectId, jobId: runId, acceptingTurns: false, pendingInterrupts: [], settleMode: 'auto', timestamp: new Date(host.now()).toISOString() })
  // A budget spent while it was paused holds it there before Core continues (awaitBudget takes the slot again).
  const breach = host.budgetBreach(runId)
  if (breach) return awaitBudget(ctx, breach)
  const slot = await reclaimSlot(ctx)
  if (slot === 'disposed') return new Promise(() => { /* startup recovery owns settlement */ })
  return slot === 'stopped' ? 'stop' : 'continue'
}

/** At most this many limit pauses per run: a provider that keeps refusing after its reset is a failure, not a wait. */
export const MAX_LIMIT_PAUSES = 3

export type LimitPauseOutcome = { action: 'resume' } | { action: 'switch'; provider: string; model: string; effort?: string; remember?: boolean } | { action: 'stop' }

/**
 * provider-quota: the provider refused the step on its usage limit. The run
 * parks as `paused` (restart_reason `limit_paused`) on the same in-process
 * pause the budget uses, with its `resumeAt` persisted. It resumes by itself
 * at `resumeAt` when automatic resume is on (default; never during sleep or a
 * dark wake), when the person resumes it now, or continues on another provider
 * (legacy engine). Stop settles it 'stopped'. The pause does not consume the
 * run's wall-clock deadline.
 */
/** Least wait before retrying a refused step on its own. */
export const LIMIT_RESUME_FLOOR_MS = 2 * 60_000

/**
 * When to retry on its own. A provider that refuses again after the reset time it
 * announced (its clock, a rounded "11:10pm") gives a resume time already past: resuming
 * at once would burn every limit pause within milliseconds, so wait at least the floor.
 */
export function limitResumeAt(resumeAt: string | null, nowMs: number): string | null {
  if (!resumeAt) return null
  const at = Date.parse(resumeAt)
  return Number.isFinite(at) && at < nowMs + LIMIT_RESUME_FLOOR_MS ? new Date(nowMs + LIMIT_RESUME_FLOOR_MS).toISOString() : resumeAt
}

export async function awaitProviderLimit(ctx: LoopRunContext, announced: Omit<LoopLimitPause, 'pausedAt' | 'autoResume'>): Promise<LimitPauseOutcome> {
  const { host, req, runId, state, exactTicketIds } = ctx
  const { logLine } = ctx.events
  const pausedAtMs = host.now()
  const limit = { ...announced, resumeAt: limitResumeAt(announced.resumeAt, pausedAtMs) }
  const pause: LoopLimitPause = { ...limit, autoResume: limit.resumeAt !== null && host.options.autoResumeOnLimit?.() !== false, pausedAt: new Date(pausedAtMs).toISOString() }
  const reason = `${limit.message}${limit.resumeAt ? ` (resets ${limit.resumeAt})` : ''}`
  const decisionPromise = new Promise<PausedHumanDecision>((resolve) => {
    host.parkPause(runId, { reason, limit: pause, resolve })
  })
  // Scheduled on the wake-aware clock; whether it still applies is read when it fires.
  const timer = pause.resumeAt ? scheduleLimitResume(pause.resumeAt, () => {
    if (pause.autoResume) host.resolvePause(runId, { action: 'resume', text: '' })
  }) : null
  logLine(`\n■ Loop paused (${LIMIT_PAUSED}) — ${limit.providerId} usage limit reached: ${limit.message}.${pause.resumeAt
    ? pause.autoResume ? ` It resumes automatically at ${pause.resumeAt}.` : ` The limit resets at ${pause.resumeAt}.`
    : ' The provider did not say when it resets; resume it when it does.'}`, 'stderr')
  try { saveLimitPause(host.db, runId, pause) } catch { /* the in-memory pause still holds; a restart then settles it */ }
  try { markJobInteractive(host.db, runId) } catch { /* best-effort */ }
  pauseLoopRun(host.db, runId, runCounters(state), LIMIT_PAUSED)
  host.emit({
    type: 'loop.run_paused',
    projectId: req.projectId,
    loopRunId: runId,
    railIndex: req.railIndex ?? null,
    reason,
    ticketIds: exactTicketIds,
    pauseKind: LIMIT_PAUSED,
    limit: { ...pause },
  })
  host.emit({ type: 'job.interactive', projectId: req.projectId, jobId: runId, acceptingTurns: true, pendingInterrupts: [], settleMode: 'auto', timestamp: pause.pausedAt })
  ctx.capacity?.yieldSlot()
  const decision = await decisionPromise
  timer?.cancel()
  if (host.isDisposed()) return new Promise(() => { /* startup recovery owns settlement */ })
  try { clearLimitPause(host.db, runId) } catch { /* stale rows are ignored once the run moves on */ }
  if (decision.action === 'stop' || host.isCancelled(runId)) {
    logLine(`\n■ Loop stop requested while paused on the usage limit.`, 'stderr')
    return { action: 'stop' }
  }
  if (Number.isFinite(state.deadline)) state.deadline += Math.max(0, host.now() - pausedAtMs)
  resumeLoopRun(host.db, runId, new Date(host.now()))
  // A Core run's switch is logged by its engine, which names the moved roles.
  if (decision.action !== 'switch') logLine(`\n▶ Loop resumed after the ${limit.providerId} usage limit — retrying the step.`)
  else if (!limit.switchTargets) logLine(`\n▶ Loop continues on ${decision.provider} — the earlier steps go along as context.`)
  host.emit({ type: 'loop.run_resumed', projectId: req.projectId, loopRunId: runId, railIndex: req.railIndex ?? null, ticketIds: exactTicketIds })
  host.emit({ type: 'job.interactive', projectId: req.projectId, jobId: runId, acceptingTurns: false, pendingInterrupts: [], settleMode: 'auto', timestamp: new Date(host.now()).toISOString() })
  // A switch takes its slot on the provider it moves to (the refusing one would queue it on its quota).
  const slot = await reclaimSlot(ctx, decision.action === 'switch' ? decision.provider : undefined)
  if (slot === 'disposed') return new Promise(() => { /* startup recovery owns settlement */ })
  if (slot === 'stopped') return { action: 'stop' }
  return decision.action === 'switch' ? { action: 'switch', provider: decision.provider, model: decision.model, ...(decision.effort ? { effort: decision.effort } : {}), ...(decision.remember ? { remember: true } : {}) } : { action: 'resume' }
}
