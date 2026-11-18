import type { Router } from 'express'
import type { ProjectRegistry } from '../../../project-registry'
import { localDayWindow } from '../../../util/local-day'
import { getDesktopTodayStats } from '../../accounting/runtime/desktop-analytics'
import { collectInbox } from '../../inbox'
import { createInboxSources } from '../../inbox/adapters/http'
import { collectLiveBoard } from '../application'
import { createMissionDirectory } from './missions'
import { createProjectLiveBoardSource } from './project-source'

/**
 * GET /api/live-board — every run of every project in one read-model. Each
 * project is read through its own context and database; the "Needs you" and
 * review cards are the inbox's own projection (the same sources as
 * GET /api/inbox, so the two always agree); today's spend is the analytics
 * figure. Nothing is cached between calls.
 */
export function registerLiveBoardRoutes(router: Router, registry: ProjectRegistry): void {
  router.get('/live-board', (_req, res) => {
    const now = new Date()
    const inbox = collectInbox(createInboxSources(registry, () => now.getTime()), () => now)
    res.json(collectLiveBoard({
      sources: registry.listContexts().map((ctx) => createProjectLiveBoardSource({
        project: { id: ctx.project.id, name: ctx.project.name },
        db: ctx.db,
        liveRunMissions: () => ctx.railLoopRuns,
      })),
      attention: inbox.items,
      missions: createMissionDirectory(registry.desktopDb),
      todaySpend: { read: () => { const stats = getDesktopTodayStats(registry, now); return { costUsd: stats.costToday, estimated: stats.includesEstimated } } },
      day: localDayWindow(now),
      now: () => now,
    }))
  })
}
