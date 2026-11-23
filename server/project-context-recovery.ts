/**
 * Startup recovery for one freshly loaded project.
 *
 * Owns the ordered restart replay that runs while process admission is still
 * closed: Core definition-run probing, orphan loop reconciliation, orphaned
 * decision-lease cleanup, isolated worktree reconciliation, PR-CI admission
 * replay, Intent reconciliation/settlement, rail PR ticket effects, local
 * stash restore and PR-decision reprojection. Only after all of that settles
 * does it open the project's process admission. Every async step re-checks
 * that the context is still the registered one (`isCurrent`).
 */
import path from 'path'
import type { DbInstance } from './db'
import type { ProjectRow } from './desktop-db'
import type { JiraSyncManager } from './jira/jira-sync-manager'
import { healLegacyFlowReviews } from './modules/delivery/runtime/flow-review-legacy'
import { createPrCiAdmissionRuntime } from './modules/delivery/runtime/pr-ci/pr-ci-admission-runtime'
import { refreshPrCiOffer } from './modules/delivery/runtime/pr-ci/pr-ci-projection'
import { defaultExec } from './modules/delivery/runtime/pr-publisher'
import { reconcileRailWorktrees } from './modules/delivery/runtime/rail-isolated-launch'
import { recoverLocalStashes } from './modules/delivery/runtime/rail-pr-decision'
import { clearOrphanedPrDeliveryOperations, getPrDelivery, listOriginLinkedPrDeliveries, toPrDecisionCardEnvelope, toPrDeliverySnapshot, toRailPrStateMessage } from './modules/delivery/runtime/rail-pr-store'
import { replayRailPrTicketEffectsUntilSettled } from './modules/delivery/runtime/rail-pr-ticket-effects'
import { startFlowSettlementScheduler } from './modules/intent/adapters/bindings'
import { probeDefinitionRuns, toDefinitionStates } from './modules/loops/runtime/loop-definition-recovery'
import { getLoopRun, type DefinitionCheckpoint, type LoopRunRow } from './modules/loops/runtime/loop-runs-store'
import { getAgentChatManager } from './modules/missions/runtime/agent-chat-registry'
import { openProjectProcessAdmission } from './process-admission'
import type { ProjectContext } from './project-registry'
import { limitResumeOptions, resumeRetainedDefinitionRun } from './project-router-loop-runs'
import { readUserPause } from './modules/loops/runtime/loop-user-pauses'
import { clearLimitPause, listLimitPauses, readLimitPause } from './modules/loops/runtime/loop-limit-pauses'
import { scheduleLimitResume } from './modules/provider-quota/runtime/quota-reports'
import { clearBudgetHold, listDailyBudgetHolds, readBudgetHold, readRetainedBudgetPause, saveBudgetHold } from './modules/loops/runtime/loop-budget-pauses'
import { planRetainedDailyReset, RETAINED_RESET_RESUME_LINE, writeRetainedResetHistory } from './modules/loops/runtime/loop-budget-reset-resume'
import { retainedRunCapRejection } from './modules/loops/runtime/loop-budget-resume'
import { getResumeOnDailyReset } from './desktop-db'
import type { WsMessage } from './types'
import { logRejection } from './util/log-rejection'
import { resolveProjectExecution } from './workspace-resolution'
import { defaultGitRunner } from './worktree-manager'

/** Rehydrate both authoritative PR-decision surfaces after startup recovery.
 * Recovery has already committed the row; broadcasts/cards are advisory and
 * may be retried by normal hydration if a surface is unavailable. */
export function emitRecoveredPrDelivery(ctx: ProjectContext, deliveryId: string): void {
  const row = getPrDelivery(ctx.db, deliveryId)
  if (!row) return
  const snapshot = toPrDeliverySnapshot(row)
  try { ctx.broadcast(toRailPrStateMessage(ctx.project.id, snapshot)) } catch { /* durable row is authoritative */ }
  if (!row.origin_conversation_id) return
  try {
    getAgentChatManager()?.updatePrDecisionCard(
      row.origin_conversation_id,
      toPrDecisionCardEnvelope(ctx.project.id, snapshot),
    )
  } catch { /* conversation hydration can retry */ }
  // pr-ci-loop: existing draft/ready PRs get the optional CI offer too.
  refreshPrCiOffer(ctx, deliveryId)
}

/** Migration/recovery or a crash after a terminal CAS can repair the ledger
 * without touching system envelopes persisted in agent conversations. Project
 * active AND terminal origin-linked rows so obsolete cards cannot stay pinned. */
export function reprojectActivePrDeliveries(ctx: ProjectContext): number {
  const rows = listOriginLinkedPrDeliveries(ctx.db)
  for (const row of rows) emitRecoveredPrDelivery(ctx, row.id)
  return rows.length
}

/**
 * Start the restart replay for a context that is already registered. The
 * returned promise settles (never rejects) when the replay has finished or
 * stopped; admission stays closed when any step fails.
 */
export function startProjectRecovery(deps: {
  ctx: ProjectContext
  project: ProjectRow
  db: DbInstance
  broadcast: (msg: WsMessage) => void
  jiraSyncManager: JiraSyncManager
  /** Loop runs that were active when the context was loaded (captured before the loop engine existed). */
  orphanLoopRuns: LoopRunRow[]
  /** True while `ctx` is still the registered context for this project. */
  isCurrent: () => boolean
  /** Orphan loop reconciliation (registry-owned, so tests can drive it directly). */
  recoverOrphanLoopRuns: (definitionStates?: ReadonlyMap<string, DefinitionCheckpoint>) => boolean
}): Promise<void> {
  const { ctx, project, db, broadcast: boundBroadcast, jiraSyncManager, orphanLoopRuns, isCurrent } = deps
  const recoverAfterProbe = (definitionStates?: ReadonlyMap<string, DefinitionCheckpoint>): Promise<void> => {
    if (!isCurrent()) return Promise.resolve()
    const loopRecoveryOk = deps.recoverOrphanLoopRuns(definitionStates)
    // Reconciled: the rows now say paused (restart) or settled; they speak for themselves.
    if (loopRecoveryOk) ctx.restartPendingRunIds?.clear()
    if (loopRecoveryOk) {
      // Decision tokens belong to the dead process. Clear them before any
      // recovery projection while admission is still closed; otherwise every
      // action on the card remains disabled and cannot trigger lease reclaim.
      const orphanedDecisionLeases = clearOrphanedPrDeliveryOperations(db)
      if (orphanedDecisionLeases > 0) {
        console.log(`[safe-pr] cleared ${orphanedDecisionLeases} orphaned decision lease(s) for ${project.slug}`)
      }
      // Worktree/delivery recovery owns the same repo mutex as launch
      // allocation. Admission opens only after it settles, so a request cannot
      // reuse a ticket-keyed path while startup still inspects it.
      return reconcileRailWorktrees(db, project.path)
        .then(async (n) => {
          if (n > 0) console.log(`[loops] reconciled ${n} orphan worktree(s) for ${project.slug}`)
          // Mission-origin CI repairs interrupted by the restart settle (or return to their offer) here.
          await createPrCiAdmissionRuntime(ctx).replay().catch((error) => console.error(`[pr-ci] admission replay failed for ${project.slug}:`, error))
          // Intent sessions never survive a restart; unfinished sagas complete
          // or compensate before admission opens (never throws).
          if (isCurrent() && ctx.flow) {
            const flows = await ctx.flow.reconcile()
            if (flows.length > 0) console.log(`[flow] reconciled ${flows.length} Intent session(s) for ${project.slug}`)
            // Settlement effects survive restarts: deliveries that reached
            // review while the app was down settle now; pending effects resume.
            const settled = await ctx.flow.replaySettlement()
            if (settled > 0) console.log(`[flow] resumed settlement of ${settled} Intent(s) for ${project.slug}`)
            if (isCurrent() && !ctx.flowSettlement) ctx.flowSettlement = startFlowSettlementScheduler(ctx.flow)
          }
          if (isCurrent()) {
            const effectDeps = {
              db,
              project: { id: project.id, slug: project.slug, path: project.path },
              broadcast: boundBroadcast,
              jiraSyncManager,
            }
            const ticketEffects = await replayRailPrTicketEffectsUntilSettled(effectDeps, {
              isCurrent: () => isCurrent(),
              onAttempt: (result) => {
                if (result.attempted > 0) {
                  console.log(`[safe-pr] replayed ${result.completed}/${result.attempted} ticket effect(s) for ${project.slug}; ${result.pending} pending`)
                  // A failed attempt persists cleanup_incomplete on the terminal
                  // delivery; project it immediately while admission remains
                  // closed so both cards explain the recovery state.
                  for (const deliveryId of result.attemptedDeliveryIds) {
                    emitRecoveredPrDelivery(ctx, deliveryId)
                  }
                }
              },
            })
            if (!ticketEffects.settled || !isCurrent()) return
            // "Integrate locally" saved the person's uncommitted work as a
            // stash and the app stopped before restoring it: re-apply now,
            // before admission opens (never throws; conflicts keep the stash).
            const restoredLocalChanges = await recoverLocalStashes({ ...effectDeps, git: defaultGitRunner, exec: defaultExec })
            for (const deliveryId of restoredLocalChanges) emitRecoveredPrDelivery(ctx, deliveryId)
            if (!isCurrent()) return
            reprojectActivePrDeliveries(ctx)
            openProjectProcessAdmission(project.id)
            // pr-ci-loop: a run paused on a host task (CI wait, push) is not
            // waiting for a person. Re-dispatch it now; the persisted dispatch
            // replays a known result instead of repeating the effect.
            for (const [runId, state] of definitionStates ?? []) {
              if (state.status !== 'paused' || !state.pendingInterrupts?.some(item => (item as { kind?: unknown } | null)?.kind === 'host-task')) continue
              // The person paused it: nothing resumes it but their Resume.
              if (readUserPause(db, runId)) continue
              void resumeRetainedDefinitionRun(ctx, runId, {}).then(outcome => {
                if (outcome.status >= 400) console.warn(`[host-task] ${project.slug}: run ${runId} was not re-dispatched (${outcome.status})`, outcome.body)
              }).catch(error => console.error(`[host-task] ${project.slug}: re-dispatch of ${runId} failed:`, error))
            }
            // provider-quota: runs that were paused on a usage limit keep their
            // persisted resumeAt; resume them at the reset (wake-aware clock).
            scheduleRetainedLimitResumes(ctx, db, isCurrent, project.slug)
            // Runs held on the daily budget over a restart resume when the day resets (now, when it already has).
            scheduleRetainedDailyBudgetResumes(ctx, db, isCurrent, project.slug)
            // Intent -> Spec deliveries settled as a generic failure before the
            // review outcome existed: persist the reclassification once (the
            // retained ledger is read-only here) and refresh their cards.
            void healLegacyFlowReviews({
              db,
              pipelineDir: path.join(resolveProjectExecution({ slug: project.slug, path: project.path }).specrailsDir, 'pipeline'),
              probe: (runIds) => probeDefinitionRuns({ db, cwd: project.path, env: process.env }, runIds, true),
              isDefinitionRun: (runId) => getLoopRun(db, runId)?.engine_version === 2,
            }).then((ids) => {
              if (!isCurrent()) return
              for (const deliveryId of ids) emitRecoveredPrDelivery(ctx, deliveryId)
            }).catch(logRejection('legacy flow review heal'))
          }
        })
        .catch((err) => {
          console.error(`[loops] isolated recovery failed for ${project.slug}; admission remains closed:`, err)
        })
    }
    return Promise.resolve()
  }
  const definitionIds = orphanLoopRuns.filter(run => run.engine_version === 2).map(run => run.id)
  if (definitionIds.length) {
    return probeDefinitionRuns({ db, cwd: project.path, env: process.env }, definitionIds)
      .then(probes => recoverAfterProbe(toDefinitionStates(probes)))
      .catch(error => { console.error(`[loops] Core recovery inspection failed for ${project.slug}; admission remains closed:`, error) })
  }
  try {
    return recoverAfterProbe()
  } catch (error) {
    console.error(`[loops] startup recovery failed for ${project.slug}; admission remains closed:`, error)
    return Promise.resolve()
  }
}

/**
 * After a restart, a Core workflow run that was paused on a provider usage
 * limit is retained paused (reason `restart`) with its `limit_pause` record.
 * When its automatic resume was on, resume it at `resumeAt` through the same
 * path as the person's Resume; anything else keeps waiting for the person.
 * Records of runs that did not survive (legacy engine) are dropped.
 */
function scheduleRetainedLimitResumes(ctx: ProjectContext, db: DbInstance, isCurrent: () => boolean, slug: string): void {
  for (const { runId, pause } of listLimitPauses(db)) {
    const run = getLoopRun(db, runId)
    if (!run || run.status !== 'paused' || run.engine_version !== 2) { clearLimitPause(db, runId); continue }
    if (!pause.autoResume || !pause.resumeAt || readUserPause(db, runId)) continue
    scheduleLimitResume(pause.resumeAt, () => {
      const current = readLimitPause(db, runId)
      if (!isCurrent() || !current?.autoResume || getLoopRun(db, runId)?.status !== 'paused') return
      clearLimitPause(db, runId)
      // A run retained over a restart may hold a step the restart cut off; the automatic
      // resume the person left on authorizes re-running it, exactly like their Resume.
      void resumeRetainedDefinitionRun(ctx, runId, {}, limitResumeOptions(getLoopRun(db, runId))).then(outcome => {
        if (outcome.status >= 400) console.warn(`[provider-quota] ${slug}: run ${runId} did not resume after the usage limit (${outcome.status})`, outcome.body)
      }).catch(error => console.error(`[provider-quota] ${slug}: resume of ${runId} failed:`, error))
    })
  }
}

/**
 * After a restart, a Core workflow run held on the DAILY budget is retained paused
 * (reason `restart`) with its `budget_pause` record and its `budget_hold` (which cap,
 * when it resets). When the day resets (already, for a run held over midnight while
 * the app was closed) and "Resume runs held by the daily budget when the day resets"
 * is on, it resumes through the person's Resume path: every cap is checked again
 * (its per-run cap first) and capacity admission applies. A run the person paused,
 * or one another cap still holds, keeps waiting for the person.
 */
export function scheduleRetainedDailyBudgetResumes(ctx: ProjectContext, db: DbInstance, isCurrent: () => boolean, slug: string): void {
  for (const { runId, detail } of listDailyBudgetHolds(db)) {
    const run = getLoopRun(db, runId)
    if (!run || run.status !== 'paused' || run.engine_version !== 2) { clearBudgetHold(db, runId); continue }
    scheduleDailyReset(ctx, db, isCurrent, slug, runId, detail.resetsAt)
  }
}

function scheduleDailyReset(ctx: ProjectContext, db: DbInstance, isCurrent: () => boolean, slug: string, runId: string, resetsAt: string): void {
  scheduleLimitResume(resetsAt, () => {
    if (!isCurrent()) return
    const run = getLoopRun(db, runId)
    // A run that became resident again (the person resumed it) owns its own schedule.
    if (ctx.loopRunManager.budgetPause?.(runId)) return
    const hold = readBudgetHold(db, runId)
    const plan = planRetainedDailyReset({
      enabled: getResumeOnDailyReset(ctx.desktopDb),
      runPaused: run?.status === 'paused',
      retainedBudgetHold: readRetainedBudgetPause(db, runId),
      userPaused: !!readUserPause(db, runId),
      hold,
      runCapRejection: (() => { try { return retainedRunCapRejection(db, runId, {}) } catch { return null } })(),
      budgetRejection: ctx.dailyBudgetRejection?.() ?? null,
    })
    if (plan.action === 'skip') {
      if (plan.reason === 'not_held') clearBudgetHold(db, runId)
      return
    }
    if (plan.action === 'hold') {
      // Spent again already (the new day's budget): wait for the next reset. Any other cap
      // (its own per-run cap, a weekly or monthly cap) holds it until the person answers.
      try { saveBudgetHold(db, runId, { scope: plan.rejection.scope, ...(plan.rejection.period ? { period: plan.rejection.period } : {}), resetsAt: plan.rejection.resetsAt }) } catch { /* the schedule below still applies */ }
      writeRetainedResetHistory(db, ctx.broadcast, runId, `\n■ The day reset, but the run stays held: ${plan.rejection.detail}`)
      console.log(`[budget] ${slug}: run ${runId} stays held after the daily reset (${plan.rejection.period ?? 'daily'} cap)`)
      if (plan.nextResetAt) scheduleDailyReset(ctx, db, isCurrent, slug, runId, plan.nextResetAt)
      return
    }
    writeRetainedResetHistory(db, ctx.broadcast, runId, RETAINED_RESET_RESUME_LINE, { scope: hold!.scope, resetsAt: hold!.resetsAt })
    console.log(`[budget] ${slug}: run ${runId} resumes by itself — the day reset and the daily budget allows the next step`)
    void resumeRetainedDefinitionRun(ctx, runId, {}, limitResumeOptions(run)).then(outcome => {
      if (outcome.status >= 400) console.warn(`[budget] ${slug}: run ${runId} did not resume after the daily reset (${outcome.status})`, outcome.body)
      else { try { clearBudgetHold(db, runId) } catch { /* advisory once the run moved on */ } }
    }).catch(error => console.error(`[budget] ${slug}: resume of ${runId} after the daily reset failed:`, error))
  })
}
