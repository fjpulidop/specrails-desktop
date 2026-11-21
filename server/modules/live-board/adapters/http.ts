import type { Router } from 'express'
import type { ProjectRegistry } from '../../../project-registry'
import { localDayWindow } from '../../../util/local-day'
import { getDesktopTodayStats } from '../../accounting/runtime/desktop-analytics'
import { collectInbox } from '../../inbox'
import { createInboxSources, readInboxSourcesInSlices } from '../../inbox/adapters/http'
import { mapInSlices, replay, settle } from '../../../util/event-loop-slices'
import type { ProjectLiveBoardSource } from '../ports'
import { readSettledOrFresh } from './settled-project-cache'
import { collectLiveBoard } from '../application'
import { createMissionDirectory } from './missions'
import { createProjectLiveBoardSource } from './project-source'
import { peekMergePreview, warmMergePreviews } from '../../delivery/runtime/merge-preview'

/**
 * GET /api/live-board — every run of every project in one read-model. Each
 * project is read through its own context and database; the "Needs you" and
 * review cards are the inbox's own projection (the same sources as
 * GET /api/inbox, so the two always agree); today's spend is the analytics
 * figure. Nothing is cached between calls, except that delivery cards carry
 * the delivery capability's last merge preview (see below), and a project with
 * nothing live reuses its previous read until its database changes
 * (settled-project-cache.ts). Projects are read in short event-loop slices, so
 * a board of many projects never blocks the app.
 */
export function registerLiveBoardRoutes(router: Router, registry: ProjectRegistry): void {
  router.get('/live-board', (_req, res, next) => {
    // One app-wide spend figure per request; every project's caps share it.
    registry.withSpendSnapshot(async () => {
      const now = new Date()
      const day = localDayWindow(now)
      // Each project is read synchronously on its own connection; the event
      // loop gets a turn between slices so one board read never stalls the app.
      const inbox = collectInbox(await readInboxSourcesInSlices(createInboxSources(registry, () => now.getTime())), () => now)
      const contexts = registry.listContexts()
      const sources = await mapInSlices(contexts, (ctx): ProjectLiveBoardSource => {
        const source = createProjectLiveBoardSource({
          project: { id: ctx.project.id, name: ctx.project.name },
          db: ctx.db,
          liveRunMissions: () => ctx.railLoopRuns,
          restartPending: ctx.restartPendingRunIds,
          queuedFor: (runId) => ctx.loopRunManager?.queuedFor?.(runId) ?? null,
        })
        // A project with nothing live is reused until its database changes (exact stamp).
        const hasLiveMemory = (ctx.railLoopRuns?.size ?? 0) > 0 || (ctx.restartPendingRunIds?.size ?? 0) > 0
        const runs = settle(() => readSettledOrFresh({ db: ctx.db, hasLiveMemory }, day, () => source.collect(day)))
        return { projectId: source.projectId, projectName: source.projectName, collect: () => replay(runs) }
      })
      const snapshot = collectLiveBoard({
        sources,
        attention: inbox.items,
        missions: createMissionDirectory(registry.desktopDb),
        todaySpend: { read: () => { const stats = getDesktopTodayStats(registry, now); return { costUsd: stats.costToday, estimated: stats.includesEstimated } } },
        day,
        now: () => now,
      })
      // Delivery cards carry their last merge preview (never computed on this
      // request); a throttled background refresh announces changes with
      // `rail.merge_preview`, which makes the board refetch.
      for (const card of snapshot.cards) {
        if (card.deliveryId) card.mergePreview = peekMergePreview(card.projectId, card.deliveryId)
      }
      for (const ctx of contexts) {
        warmMergePreviews({ project: ctx.project, db: ctx.db }, () => {
          try { ctx.broadcast({ type: 'rail.merge_preview', projectId: ctx.project.id }) } catch { /* best-effort */ }
        })
      }
      res.json(snapshot)
    }).catch(next)
  })
}
