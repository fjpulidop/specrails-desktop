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
import { resumeRetainedDefinitionRun } from './project-router-loop-runs'
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
 * Start the restart replay for a context that is already registered. Returns
 * immediately; admission stays closed when any step fails.
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
}): void {
  const { ctx, project, db, broadcast: boundBroadcast, jiraSyncManager, orphanLoopRuns, isCurrent } = deps
  const recoverAfterProbe = (definitionStates?: ReadonlyMap<string, DefinitionCheckpoint>) => {
    if (!isCurrent()) return
    const loopRecoveryOk = deps.recoverOrphanLoopRuns(definitionStates)
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
      void reconcileRailWorktrees(db, project.path)
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
              void resumeRetainedDefinitionRun(ctx, runId, {}).then(outcome => {
                if (outcome.status >= 400) console.warn(`[host-task] ${project.slug}: run ${runId} was not re-dispatched (${outcome.status})`, outcome.body)
              }).catch(error => console.error(`[host-task] ${project.slug}: re-dispatch of ${runId} failed:`, error))
            }
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
  }
  const definitionIds = orphanLoopRuns.filter(run => run.engine_version === 2).map(run => run.id)
  if (definitionIds.length) {
    void probeDefinitionRuns({ db, cwd: project.path, env: process.env }, definitionIds)
      .then(probes => recoverAfterProbe(toDefinitionStates(probes)))
      .catch(error => { console.error(`[loops] Core recovery inspection failed for ${project.slug}; admission remains closed:`, error) })
  } else recoverAfterProbe()
}
