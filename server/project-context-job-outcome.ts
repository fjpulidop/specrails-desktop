/**
 * Terminal-job effects for one project's queue (`QueueManager.onJobFinished`).
 *
 * Owns applying a finished job's outcome to its tickets, settling spec addenda,
 * releasing rail slots, and the advisory Jira/webhook/WS fan-out. Ticket-file
 * and rail mutations are the critical, idempotent invariants: a recovery replay
 * surfaces their failure so the queue's durable outbox retries the callback.
 */
import type { DbInstance } from './db'
import { clearAgentJob, type ProjectRow } from './desktop-db'
import type { JiraSyncManager } from './jira/jira-sync-manager'
import { releaseRailTicketsOwnedBy, ticketOutcomeOwner } from './modules/delivery/runtime/rails-store'
import type { QueueManager } from './modules/execution/runtime/queue-manager'
import { settleSpecAddendaAt } from './modules/specs/runtime/spec-addenda'
import { applyJobOutcomeToTickets, isFlowHeldTicket, mutateStore, readStore, resolveTicketStoragePath, type JobOutcome } from './modules/specs/runtime/ticket-store'
import { isTerminalJobStatus } from './project-context-broadcast'
import type { ProjectContext } from './project-registry'
import type { RailUpdatedMessage, TicketUpdatedMessage, WsMessage } from './types'
import type { WebhookManager } from './webhook-manager'
import { resolveProjectExecution } from './workspace-resolution'

export type JobFinishedHandler = NonNullable<NonNullable<ConstructorParameters<typeof QueueManager>[4]>['onJobFinished']>

export function createJobFinishedHandler(deps: {
  project: ProjectRow
  db: DbInstance
  desktopDb: DbInstance
  railJobs: ProjectContext['railJobs']
  jiraSyncManager: JiraSyncManager
  webhookManager: WebhookManager
  broadcast: (msg: WsMessage) => void
}): JobFinishedHandler {
  const { project, db, desktopDb, railJobs, jiraSyncManager, webhookManager, broadcast: boundBroadcast } = deps
  return (jobId, status, costUsd, opts) => {
    // Recovery can deliver this callback without another queue snapshot.
    // Clear the assignment here as the authoritative terminal effect; the
    // bound queue broadcast (project-context-broadcast.ts) remains an idempotent
    // live-path fallback.
    if (isTerminalJobStatus(status)) {
      clearAgentJob(desktopDb, jobId)
    }
    const jobRow = db.prepare('SELECT command, duration_ms, causal_ownership FROM jobs WHERE id = ?').get(jobId) as
      | { command: string; duration_ms: number | null; causal_ownership: number }
      | undefined
    // Recovery callbacks carry their own immutable inputs. Job history is
    // independently deletable/purgeable once a row is terminal; replaying
    // from that row would otherwise checkpoint an empty callback and strand
    // the ticket/rail state forever.
    const recoveryCommand = opts?.recoveryReplay ? opts.recoveryCommand : undefined
    const effectiveCommand = recoveryCommand ?? jobRow?.command ?? ''
    const effectiveDurationMs = opts?.recoveryReplay
      ? (opts.recoveryDurationMs ?? jobRow?.duration_ms ?? null)
      : (jobRow?.duration_ms ?? null)
    const ticketOutcomeStatus: JobOutcome = status === 'skipped'
      ? 'canceled'
      : status as JobOutcome
    const affectsTickets = status === 'completed' || status === 'failed' ||
      status === 'canceled' || status === 'zombie_terminated' || status === 'skipped'
    const event = status === 'completed' ? 'job.completed' : status === 'canceled' ? 'job.canceled' : 'job.failed'
    const criticalFailures: string[] = []
    let outcomeStore: ReturnType<typeof readStore> | null = null
    let changedTicketIds: number[] = []
    let effectTicketIds: number[] = []
    // Broadcast rail.job_completed if this job was launched by a rail
    const railMeta = railJobs.get(jobId)
    if (railMeta) {
      railJobs.delete(jobId)
    }

    // Determine ticket IDs: from rail metadata, or parse from command as fallback
    // (railJobs Map is in-memory and lost on server restart)
    let completedTicketIds: number[] = railMeta?.ticketIds ?? []
    if (completedTicketIds.length === 0 && opts?.recoveryReplay && opts.recoveryTicketIds) {
      completedTicketIds = [...new Set(opts.recoveryTicketIds)]
    }
    if (completedTicketIds.length === 0 && effectiveCommand) {
      const matches = effectiveCommand.match(/#(\d+)/g)
      if (matches) completedTicketIds = matches.map((m) => parseInt(m.slice(1), 10))
    }
    const ticketOwners = new Map<number, string | null>()
    let ownershipReadable = true
    try {
      for (const ticketId of completedTicketIds) {
        ticketOwners.set(ticketId, ticketOutcomeOwner(db, ticketId))
      }
    } catch (err) {
      ownershipReadable = false
      criticalFailures.push(`ticket ownership: ${err instanceof Error ? err.message : String(err)}`)
    }
    const callbackCausalOwnership = opts?.recoveryReplay
      ? opts.recoveryCausalOwnership === true
      : jobRow?.causal_ownership === 1

    // Apply the job outcome to its tickets. Success promotes todo/in_progress
    // → done (→ Specs Done) — or → on_review under the ask-first PR-delivery
    // methodology (below); failure/cancel/zombie reverts in_progress → todo
    // (→ Specs) or flags an already-done spec for review. zombie_terminated is
    // treated as a failure here (and is included in the _onJobExit callback
    // guard) so a timed-out rail releases its specs instead of stranding them.
    //
    // Ask-first methodology (safe-pr-workflow, universal): QueueManager
    // captures the PR-delivery flag ONCE at this job's spawn and threads it
    // here as `opts.ticketCompletionStatus` — so a mid-flight env flip can't
    // split one job's behavior. Under the flag a COMPLETED job parks its
    // tickets at on_review (the human decides done via PR merge or a manual
    // move), never done. Absent opts (legacy callers / never-spawned failure
    // paths) ⇒ 'done', byte-identical to the pre-change promotion.
    const completedStatus = opts?.ticketCompletionStatus ?? 'done'
    if (
      completedTicketIds.length > 0 &&
      affectsTickets
    ) {
      try {
        // Relocate-artifacts gate: write the job outcome to the workspace
        // ticket store when relocated, else the repo-relative store (legacy).
        const outcomeExec = resolveProjectExecution({ slug: project.slug, path: project.path })
        const ticketFile = outcomeExec.relocated
          ? outcomeExec.ticketsPath
          : resolveTicketStoragePath(project.path)
        const now = new Date().toISOString()
        const causallyOwnedTicketIds = completedTicketIds.filter((ticketId) => {
          if (!ownershipReadable) return false
          const owner = ticketOwners.get(ticketId) ?? null
          return owner === jobId || (!callbackCausalOwnership && owner === null)
        })
        const store = mutateStore(ticketFile, (s) => {
          changedTicketIds = applyJobOutcomeToTickets(s, causallyOwnedTicketIds, ticketOutcomeStatus, now, {
            completedStatus,
            effectId: jobId,
            causalOwnerConfirmed: true,
          })
        })
        outcomeStore = store
        effectTicketIds = causallyOwnedTicketIds.filter((ticketId) => {
          const marker = store.tickets[String(ticketId)]?.metadata.specrails_outcome
          return marker?.owner_id === jobId && marker.applied_effect_id === jobId
        })
        for (const tid of changedTicketIds) {
          const ticket = store.tickets[String(tid)]
          if (!ticket) continue
          try {
            boundBroadcast({
              type: 'ticket_updated',
              ticket: ticket as unknown as import('./types').LocalTicket,
              projectId: project.id,
              timestamp: ticket.updated_at,
            } as TicketUpdatedMessage)
          } catch {
            // The file mutation is authoritative; a startup client reloads it.
          }
        }
      } catch (err) {
        console.error('[project-registry] failed to apply job outcome to tickets:', err)
        criticalFailures.push(`ticket outcome: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // Spec addenda settle (spec-addenda): the addenda this job claimed at
    // spawn move to `applied` on completion or back to `open` otherwise.
    // Keyed on the job id (the causal key), so a replay or a newer owner
    // can never touch another run's addenda. Independent of the ticket
    // status effect above: an already on_review spec still settles them.
    if (completedTicketIds.length > 0 && affectsTickets) {
      try {
        const addendaExec = resolveProjectExecution({ slug: project.slug, path: project.path })
        const addendaFile = addendaExec.relocated ? addendaExec.ticketsPath : resolveTicketStoragePath(project.path)
        const settled = settleSpecAddendaAt(addendaFile, completedTicketIds, jobId, ticketOutcomeStatus)
        for (const tid of settled.changedTicketIds) {
          const ticket = settled.store?.tickets[String(tid)]
          if (!ticket) continue
          try {
            boundBroadcast({
              type: 'ticket_updated',
              ticket: ticket as unknown as import('./types').LocalTicket,
              projectId: project.id,
              timestamp: ticket.updated_at,
            } as TicketUpdatedMessage)
          } catch { /* the file mutation is authoritative */ }
        }
      } catch (err) {
        console.error('[project-registry] failed to settle spec addenda:', err)
      }
    }

    // Release the job's tickets from any rail that still holds them. The
    // server `rails` table is the source of truth for mobile clients (the
    // desktop strips its localStorage copy on rail.job_completed) — without
    // this, a finished spec stays stranded on the rail forever. Runs on
    // every terminal outcome, mirroring the desktop: success → spec is
    // done; failure/cancel/zombie → spec returns to the board. Scans ALL
    // rails (not just railMeta.railIndex) so it also heals after a server
    // restart, when the in-memory railJobs map is lost.
    if (
      completedTicketIds.length > 0 &&
      affectsTickets
    ) {
      try {
        const releasableTicketIds = completedTicketIds.filter((ticketId) => {
          if (!ownershipReadable) return false
          const owner = ticketOwners.get(ticketId) ?? null
          return owner === jobId || (!callbackCausalOwnership && owner === null)
        })
        const releasedRails = releaseRailTicketsOwnedBy(db, jobId, releasableTicketIds, {
          railIndex: railMeta?.railIndex ?? null,
          allowUnowned: !callbackCausalOwnership,
        })
        for (const released of releasedRails) {
          const rail = released.rail
          try {
            boundBroadcast({
              type: 'rail.updated',
              projectId: project.id,
              railIndex: rail.railIndex,
              changed: 'tickets',
              ticketIds: rail.ticketIds,
              name: rail.name ?? null,
              mode: rail.mode,
              profileName: rail.profileName ?? null,
              aiEngine: rail.aiEngine ?? null,
            } as RailUpdatedMessage)
          } catch {
            // Persisted rail state is authoritative; WS delivery is advisory.
          }
        }
      } catch (err) {
        console.error('[project-registry] failed to release rail tickets after job exit:', err)
        criticalFailures.push(`rail release: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    // QueueManager's recovery outbox checkpoints the callback only when it
    // returns normally. Ticket-file and rail mutations are the two critical
    // domain invariants, so surface either failure during a recovery replay.
    // Live exits keep their long-standing best-effort behavior because they
    // have no durable retry owner; they still continue to Jira/webhooks below.
    // Both critical operations are idempotent, so partial replay is safe.
    if (criticalFailures.length > 0 && opts?.recoveryReplay) {
      throw new Error(`critical job outcome effects failed: ${criticalFailures.join('; ')}`)
    }

    // Jira is already backed by its own idempotent durable outbox. Keep it
    // best-effort for this callback: a Jira configuration/network fault must
    // never prevent the local recovery checkpoint.
    if (
      outcomeStore &&
      effectTicketIds.length > 0 &&
      affectsTickets
    ) {
      try {
        if (status === 'completed' && completedStatus === 'on_review') {
          // On a replay after the ticket mutation committed but a later rail
          // mutation failed, changedTicketIds is empty. Derive the intended
          // review set from the converged store so Jira still receives it.
          // An Intent session spec reaches Jira only through its Intent settlement
          // (create, then the review transition), never from here.
          const reviewIds = effectTicketIds.filter(
            (tid) => outcomeStore?.tickets[String(tid)]?.status === 'on_review' && !isFlowHeldTicket(outcomeStore?.tickets[String(tid)])
          )
          jiraSyncManager.onRailReview(reviewIds, jobId)
        } else {
          const needsReviewIds = effectTicketIds.filter(
            (tid) => outcomeStore?.tickets[String(tid)]?.needs_review === true
          )
          jiraSyncManager.onJobOutcome({
            ticketIds: effectTicketIds,
            status: ticketOutcomeStatus,
                jobId,
                costUsd: costUsd ?? null,
                durationMs: effectiveDurationMs,
            needsReviewIds,
          })
        }
      } catch (err) {
        console.error('[project-registry] jira onJobOutcome failed:', err)
      }
    }

    // Webhook delivery is fire-and-forget and non-durable by design. A bad
    // registration/desktop DB must not hold the local recovery outbox open.
    if (status !== 'skipped') {
      try {
        webhookManager.deliver(project.id, event, {
          jobId,
          command: effectiveCommand,
          status,
          costUsd: costUsd ?? null,
          durationMs: effectiveDurationMs,
        })
      } catch (err) {
        console.error('[project-registry] webhook delivery scheduling failed:', err)
      }
    }

    // Broadcast rail.job_completed if we know the rail index
    if (railMeta) {
      try {
        boundBroadcast({
          type: 'rail.job_completed',
          projectId: project.id,
          railIndex: railMeta.railIndex,
          jobId,
          status,
          ticketIds: completedTicketIds,
        })
      } catch {
        // Advisory only; local ticket/rail state already committed.
      }
    }
  }
}
