/**
 * Project-scoped WebSocket broadcast for one ProjectContext.
 *
 * Owns the `projectId` injection on every project message, the late-bound
 * observer taps (milestone chain/progress, spec triage, Intent settlement) and
 * the agent-assignment release on terminal queue snapshots. Wired by
 * `project-registry.ts` (composition root); the taps are assigned after the
 * managers they observe exist.
 */
import type { DbInstance } from './db'
import { clearAgentJob } from './desktop-db'
import type { MilestoneChainManager } from './modules/builder/runtime/milestone-chain'
import type { MilestoneProgressBroadcaster } from './modules/builder/runtime/milestone-progress'
import type { IntentService } from './modules/intent'
import type { SpecTriageService } from './modules/specs/runtime/triage'
import type { JobStatus, WsMessage } from './types'

/** The two live queue states are the only non-terminal members of JobStatus.
 * Deriving terminality from that invariant avoids a second status list that can
 * silently fall behind the queue contract when a new terminal outcome is added. */
export function isTerminalJobStatus(status: JobStatus): boolean {
  return status !== 'queued' && status !== 'running'
}

/** Observers constructed after the broadcast exists. Each is null until its
 *  owner is created; messages emitted before then are simply not observed
 *  (startup messages are few). Also read at call time by loop settlement. */
export interface ProjectBroadcastTaps {
  milestoneChains: MilestoneChainManager | null
  milestoneProgress: MilestoneProgressBroadcaster | null
  specTriage: SpecTriageService | null
  flowService: IntentService | null
  /** Automatic continuation of a failed run (project-context-auto-continue.ts). */
  autoContinue: { observe(msg: WsMessage): void } | null
}

export function createProjectBroadcastTaps(): ProjectBroadcastTaps {
  return { milestoneChains: null, milestoneProgress: null, specTriage: null, flowService: null, autoContinue: null }
}

/**
 * Bind broadcast with projectId so all WS messages carry context.
 * Also wire agent status: when a queued job reaches a terminal state,
 * clear current_job_id on any agent that was assigned to it.
 * Milestone progress tap (premium-milestone-progress): every project-scoped
 * broadcast that can change a milestone's counts/rails/chain schedules ONE
 * debounced `blueprint.milestone_progress` re-derivation. Assigned once the
 * rail maps exist; null until then (startup messages are few).
 */
export function createProjectBroadcast(opts: {
  projectId: string
  broadcast: (msg: WsMessage) => void
  desktopDb: DbInstance
  taps: ProjectBroadcastTaps
}): (msg: WsMessage) => void {
  const { projectId, broadcast, desktopDb, taps } = opts
  return (msg: WsMessage): void => {
    const enriched = { ...msg, projectId }
    broadcast(enriched as WsMessage)
    // Chain first: a delivery settle may launch the next chunk (async) and
    // emit its own `milestone.chain_changed`; the progress tap then coalesces.
    taps.milestoneChains?.observe(msg)
    taps.milestoneProgress?.observe(msg)
    // Spec triage: a created/edited spec schedules a debounced triage scan.
    taps.specTriage?.observe(msg)
    // A failed run whose cause is known and fixable is continued once by itself.
    taps.autoContinue?.observe(msg)
    // Intent settlement: an Intent session delivery that reached review settles its Intent.
    const flowService = taps.flowService
    if (msg.type === 'rail.pr_state' && flowService) {
      const deliveryId = (msg as { prDeliveryId?: unknown }).prDeliveryId
      if (typeof deliveryId === 'string') void flowService.observeDelivery(deliveryId).catch((err) => console.error('[flow] delivery settlement failed:', err))
    }
    if (msg.type === 'queue') {
      for (const job of msg.jobs) {
        if (isTerminalJobStatus(job.status)) {
          clearAgentJob(desktopDb, job.id)
        }
      }
    }
  }
}
