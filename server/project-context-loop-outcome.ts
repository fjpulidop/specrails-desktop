/**
 * Terminal loop-run effects and startup orphan reconciliation for one project.
 *
 * Owns releasing a finished loop run's tickets and rail slots through its
 * durable `loop_terminal_recovery` intent (ticket outcome, spec addenda, Jira
 * outbox, Intent/milestone settlement, WS fan-out), and replaying orphaned
 * runs after a restart through that same handler so crash recovery keeps the
 * ticket, rail and Jira invariants instead of bypassing them with raw SQL.
 */
import type { DbInstance } from './db'
import type { ProjectRow } from './desktop-db'
import type { JiraSyncManager } from './jira/jira-sync-manager'
import { isRailPrDeliveryEnabled } from './modules/delivery/runtime/rail-isolation'
import { getRails, releaseRailTicketsOwnedBy, ticketOutcomeOwner } from './modules/delivery/runtime/rails-store'
import { recoverOrphanLoopStepAccounting } from './modules/loops/runtime/loop-run-manager'
import {
  completeLoopTerminalRecovery,
  getLoopRun,
  getLoopTerminalRecovery,
  listPendingLoopTerminalRecoveries,
  readDefinitionRun,
  readDefinitionSuccessor,
  reconcileOrphanLoopRuns,
  type DefinitionCheckpoint,
  type LoopRunRow,
  type LoopTerminalRecoveryPayload,
} from './modules/loops/runtime/loop-runs-store'
import { settleForkAddendaAt, settleSpecAddendaAt } from './modules/specs/runtime/spec-addenda'
import { applyJobOutcomeToTickets, isFlowHeldTicket, mutateStore, readStore, type JobOutcome } from './modules/specs/runtime/ticket-store'
import type { ProjectBroadcastTaps } from './project-context-broadcast'
import type { RunClarificationsPublisher } from './project-context-loops'
import type { ProjectContext } from './project-registry'
import type { RailUpdatedMessage, TicketUpdatedMessage, WsMessage } from './types'

export type LoopRunFinishedHandler = ProjectContext['onLoopRunFinished']

/**
 * Releases a finished loop run's tickets + rail slots. The engine already
 * emitted loop.run_completed; this mirrors onJobFinished's ticket/rail
 * release (kept separate so the critical job path is untouched).
 */
export function createLoopRunFinishedHandler(deps: {
  project: ProjectRow
  db: DbInstance
  railLoopRuns: ProjectContext['railLoopRuns']
  ticketStorePath: () => string
  jiraSyncManager: JiraSyncManager
  publishRunClarifications: RunClarificationsPublisher
  /** Read at call time: Intent and milestone chains are constructed later. */
  taps: ProjectBroadcastTaps
  broadcast: (msg: WsMessage) => void
}): LoopRunFinishedHandler {
  const { project, db, railLoopRuns, ticketStorePath, jiraSyncManager, publishRunClarifications, taps, broadcast: boundBroadcast } = deps
  return (
    runId: string,
    outcome: string,
    opts?: { ticketCompletionStatus?: 'done' | 'on_review'; stallReason?: string },
  ): void => {
    if (readDefinitionSuccessor(db, runId)) return
    const intent = getLoopTerminalRecovery(db, runId)
    let payload: LoopTerminalRecoveryPayload | null = null
    if (intent) {
      try {
        const parsed = JSON.parse(intent.payload) as LoopTerminalRecoveryPayload
        if (parsed?.runId !== runId || !Array.isArray(parsed.ticketIds)) {
          throw new Error('loop terminal payload identity is invalid')
        }
        payload = parsed
      } catch (err) {
        console.error(`[loops] invalid terminal recovery payload for ${runId}:`, err)
        return
      }
    }
    const meta = railLoopRuns.get(runId)
    if (!intent && meta?.requiresTerminalIntent) {
      // Current launches atomically settle their run/job/outbox. If there is
      // no outbox, the launch either never committed or failed before the
      // engine acquired terminal authority. Do not release/revert tickets by
      // falling through to the pre-outbox compatibility path.
      if (!getLoopRun(db, runId)) railLoopRuns.delete(runId)
      return
    }
    if (payload && payload.outcomeFinalized === false) {
      const finalizedOutcome = outcome as LoopTerminalRecoveryPayload['outcome']
      payload = {
        ...payload,
        outcome: finalizedOutcome,
        jobStatus: finalizedOutcome === 'success'
          ? 'completed'
          : finalizedOutcome === 'stopped' || finalizedOutcome === 'blocked' || finalizedOutcome === 'stalled'
            ? 'canceled'
            : 'failed',
        outcomeFinalized: true,
      }
      try {
        // Monotonic decision commit precedes effect delivery. A rail/ticket
        // failure may roll back its own transaction, but can never revert a
        // verified isolated result to the conservative startup fallback.
        db.prepare(`UPDATE loop_terminal_recovery SET payload = ? WHERE run_id = ?`)
          .run(JSON.stringify(payload), runId)
      } catch (err) {
        console.error(`[loops] failed to persist final outcome for ${runId}:`, err)
        return
      }
    }
    const ticketIds = payload?.ticketIds ?? meta?.ticketIds ?? []
    // Idempotent per record: a pause already posted is not posted again.
    publishRunClarifications(runId, ticketIds)
    const railIndex = payload?.railIndex ?? meta?.railIndex ?? null
    const effectiveOutcome = payload?.outcome ?? outcome
    const status: JobOutcome =
      effectiveOutcome === 'success' ? 'completed'
        : effectiveOutcome === 'stopped' || effectiveOutcome === 'blocked' || effectiveOutcome === 'stalled'
          ? 'canceled'
          : 'failed'
    const completedStatus = payload?.ticketCompletionStatus
      ?? opts?.ticketCompletionStatus
      ?? (isRailPrDeliveryEnabled() ? 'on_review' : 'done')

    try {
      const deliver = db.transaction(() => {
        let changedIds: number[] = []
        let effectTicketIds: number[] = []
        let store: ReturnType<typeof readStore> | null = null
        const causallyOwnedTicketIds = ticketIds.filter((ticketId) => {
          const owner = ticketOutcomeOwner(db, ticketId)
          return owner === runId || (payload?.causalOwnership !== true && owner === null)
        })
        if (causallyOwnedTicketIds.length > 0) {
          store = mutateStore(ticketStorePath(), (s) => {
            changedIds = applyJobOutcomeToTickets(s, causallyOwnedTicketIds, status, new Date().toISOString(), {
              completedStatus,
              effectId: runId,
              causalOwnerConfirmed: true,
            })
          })
          effectTicketIds = causallyOwnedTicketIds.filter((ticketId) => {
            const marker = store?.tickets[String(ticketId)]?.metadata.specrails_outcome
            return marker?.owner_id === runId && marker.applied_effect_id === runId
          })
        }

        // Spec addenda settle (spec-addenda): keyed on the run id, so only
        // the addenda THIS run claimed move (applied on success, reopened
        // otherwise). Runs for every ticket of the run, not only the causally
        // owned ones — the run id is already the causal proof.
        if (ticketIds.length > 0) {
          const inherited = readDefinitionRun(db, runId)?.metadata.inheritedAddendaClaims ?? []
          const inheritedResult = settleForkAddendaAt(ticketStorePath(), causallyOwnedTicketIds, runId, inherited, status)
          if (inheritedResult.store) {
            store = inheritedResult.store
            for (const tid of inheritedResult.changedTicketIds) if (!changedIds.includes(tid)) changedIds.push(tid)
          }
          const settledAddenda = settleSpecAddendaAt(ticketStorePath(), ticketIds, runId, status)
          if (settledAddenda.store) {
            store = settledAddenda.store
            for (const tid of settledAddenda.changedTicketIds) if (!changedIds.includes(tid)) changedIds.push(tid)
          }
        }

        const released = releaseRailTicketsOwnedBy(db, runId, causallyOwnedTicketIds, {
          railIndex,
          allowUnowned: payload ? payload.causalOwnership !== true : true,
        })

        // Jira has its own idempotent outbox keyed by runId/ticketId. Only
        // tickets whose causal marker belongs to this run may be enqueued.
        if (store && effectTicketIds.length > 0) {
          try {
            if (status === 'completed' && completedStatus === 'on_review') {
              // Intent specs: the Intent settlement creates the Jira issue first and
              // then transitions it; an early review here would be a no-op at
              // best and a double transition at worst.
              const reviewIds = effectTicketIds.filter(
                (ticketId) => store?.tickets[String(ticketId)]?.status === 'on_review' && !isFlowHeldTicket(store?.tickets[String(ticketId)]),
              )
              jiraSyncManager.onRailReview(reviewIds, runId)
            } else {
              const needsReviewIds = effectTicketIds.filter(
                (ticketId) => store?.tickets[String(ticketId)]?.needs_review === true,
              )
              jiraSyncManager.onJobOutcome({
                ticketIds: effectTicketIds,
                status,
                jobId: runId,
                costUsd: null,
                durationMs: null,
                needsReviewIds,
              })
            }
          } catch (err) {
            console.error('[project-registry] jira loop onJobOutcome failed:', err)
          }
        }
        if (intent) completeLoopTerminalRecovery(db, runId)
        return { changedIds, store, released }
      })
      const delivered = deliver()
      railLoopRuns.delete(runId)
      // Intent hand-off without a PR delivery row: the completed run settles the
      // Intent (with a delivery row, the `rail.pr_state` observer does).
      const flowService = taps.flowService
      if (status === 'completed' && flowService) {
        for (const ticketId of ticketIds) {
          const flowId = delivered.store?.tickets[String(ticketId)]?.metadata?.flow?.flowId
          if (flowId) void flowService.onRailRunCompleted({ flowId, runId }).catch((err) => console.error('[flow] run settlement failed:', err))
        }
      }
      // Milestone chain fallback hook: records the engine outcome (names the
      // pause reason) and settles delivery-less chunks. Isolated chunks
      // advance from the later `rail.pr_state` settle instead.
      try { taps.milestoneChains?.onRunSettled(runId, effectiveOutcome, opts?.stallReason) } catch (err) { console.error('[milestone-chain] onRunSettled failed:', err) }
      for (const ticketId of delivered.changedIds) {
        const ticket = delivered.store?.tickets[String(ticketId)]
        if (!ticket) continue
        try {
          boundBroadcast({
            type: 'ticket_updated',
            ticket: ticket as unknown as TicketUpdatedMessage['ticket'],
            projectId: project.id,
            timestamp: ticket.updated_at,
          } as TicketUpdatedMessage)
        } catch { /* persisted file is authoritative */ }
      }
      for (const released of delivered.released) {
        try {
          boundBroadcast({
            type: 'rail.updated',
            projectId: project.id,
            railIndex: released.rail.railIndex,
            changed: 'tickets',
            ticketIds: released.rail.ticketIds,
            name: released.rail.name ?? null,
            mode: released.rail.mode,
            profileName: released.rail.profileName ?? null,
            aiEngine: released.rail.aiEngine ?? null,
          } as RailUpdatedMessage)
        } catch { /* advisory */ }
      }
    } catch (err) {
      // Durable intents remain pending. Ticket JSON may already contain the
      // effect marker; replay is safe and cannot outrank a later owner.
      console.error(`[loops] terminal effects failed for ${runId}:`, err)
    }
  }
}

/**
 * Startup reconciliation of loop runs a dead process left active. Registers
 * their rail slots, settles them durably, then replays every pending terminal
 * intent through `onLoopRunFinished`. Returns false when reconciliation failed
 * (process admission then stays closed).
 */
export function recoverOrphanLoopRuns(
  project: ProjectRow,
  db: DbInstance,
  railLoopRuns: ProjectContext['railLoopRuns'],
  onLoopRunFinished: (runId: string, outcome: string) => void,
  orphans: LoopRunRow[],
  definitionStates?: ReadonlyMap<string, DefinitionCheckpoint>,
): boolean {
  try {
    const recoveredSteps = recoverOrphanLoopStepAccounting(db)
    if (recoveredSteps > 0) {
      console.log(`[loops] recovered ${recoveredSteps} interrupted step invocation(s) for ${project.slug}`)
    }
    const countByRail = new Map<number, number>()
    for (const run of orphans) {
      if (run.rail_index != null) countByRail.set(run.rail_index, (countByRail.get(run.rail_index) ?? 0) + 1)
    }
    const rails = getRails(db)
    const legacyTicketIds = new Map<string, number[]>()
    for (const run of orphans) {
      if (run.rail_index == null) continue
      let persistedIds: number[] = []
      try {
        const parsed = JSON.parse(run.ticket_ids_json ?? '[]') as unknown
        if (Array.isArray(parsed)) {
          persistedIds = parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0)
        }
      } catch { /* pre-migration malformed value → legacy fallback */ }
      let ticketIds = persistedIds.length > 0
        ? persistedIds
        : (run.ticket_id == null ? [] : [run.ticket_id])
      // Compatibility only for rows launched before migration 45. New rows
      // persist the exact set and never use this ambiguous heuristic.
      if (persistedIds.length === 0 && (countByRail.get(run.rail_index) ?? 0) === 1) {
        const rail = rails.find((candidate) => candidate.railIndex === run.rail_index)
        if (rail && rail.ticketIds.length > 0) ticketIds = [...rail.ticketIds]
      }
      legacyTicketIds.set(run.id, ticketIds)
      railLoopRuns.set(run.id, { railIndex: run.rail_index, ticketIds })
    }
    reconcileOrphanLoopRuns(db, new Date().toISOString(), legacyTicketIds, definitionStates)
    // Includes orphan intents created above AND normally-completed runs whose
    // process died after the atomic settle but before its `.then` callback.
    const pending = listPendingLoopTerminalRecoveries(db)
    for (const row of pending) {
      let terminalOutcome = 'failed'
      try {
        const payload = JSON.parse(row.payload) as LoopTerminalRecoveryPayload
        terminalOutcome = payload.outcome
        if (payload.outcomeFinalized === false) {
          const durableRun = getLoopRun(db, row.run_id)
          if (durableRun?.status === 'completed' && durableRun.final_outcome) {
            terminalOutcome = durableRun.final_outcome
          }
        }
      } catch { /* handler logs and retains malformed intent */ }
      onLoopRunFinished(row.run_id, terminalOutcome)
    }
    if (orphans.length > 0) {
      console.log(`[loops] reconciled ${orphans.length} orphan loop run(s) for ${project.slug}`)
    }
    return true
  } catch (err) {
    console.error(`[loops] orphan reconciliation failed for ${project.slug}:`, err)
    return false
  }
}
