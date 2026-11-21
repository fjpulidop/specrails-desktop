/**
 * Background services that need a complete ProjectContext.
 *
 * Owns starting the mission resource recorder, spec triage, the recently
 * deleted specs purge and the PR merge watch, attaching each to `ctx` so the
 * registry's teardown stops them. Called once the context object exists and
 * before Intent wiring, in the order below.
 */
import type { DbInstance } from './db'
import { attachmentManager } from './attachment-manager'
import { startPrMergeWatch } from './modules/delivery/runtime/pr-merge-watch'
import { startProjectTrashPurge } from './modules/specs/runtime/ticket-trash-service'
import { SpecTriageService } from './modules/specs/runtime/triage'
import type { ProjectBroadcastTaps } from './project-context-broadcast'
import type { ProjectContext } from './project-registry'
import { startMissionResourceRecording } from './project-router-mission-resources'

export function attachProjectServices(ctx: ProjectContext, deps: {
  db: DbInstance
  ticketStorePath: () => string
  taps: ProjectBroadcastTaps
}): void {
  const { project, chatManager, ticketWatcher } = ctx
  const { db, ticketStorePath } = deps
  const boundBroadcast = ctx.broadcast
  // Records each working mission's resource totals so the Resources popover keeps its history.
  ctx.missionResourceRecorder = startMissionResourceRecording(ctx)
  // Spec triage (launch-triage): cheap per-spec loop recommendation. Seeded
  // now so the existing backlog is only triaged on edit or on demand.
  const specTriage = new SpecTriageService({
    project, db, ticketsPath: ticketStorePath, broadcast: boundBroadcast,
    notifyDesktopWrite: (revision) => ticketWatcher.notifyDesktopWrite(revision),
  })
  deps.taps.specTriage = specTriage
  specTriage.start()
  ctx.specTriage = specTriage
  // Recently deleted specs: purge past the 30-day window at startup and on a timer.
  ctx.trashPurge = startProjectTrashPurge({
    ticketStorePath,
    db,
    deleteAttachments: (ticketKey) => attachmentManager.deleteAll(project.slug, ticketKey),
    forgetExploreConversation: (conversationId) => {
      chatManager?.forgetSpecDraft(conversationId)
      chatManager?.forgetExploreLifecycle(conversationId)
    },
  })
  // A PR merged (or closed) on GitHub settles on its own, as "Verify PR" would.
  ctx.prMergeWatch = startPrMergeWatch({
    db,
    project: { id: project.id, slug: project.slug, path: project.path },
    broadcast: boundBroadcast,
    jiraSyncManager: ctx.jiraSyncManager,
  })
}
