import type { Router } from 'express'
import type { ProjectRegistry } from '../../../project-registry'
import { collectInbox } from '../application'
import { createProjectInboxSource } from './project-source'

/**
 * GET /api/inbox — the "Needs you" read-model across projects. Each registered
 * project is read through its own context and database; nothing is cached or
 * shared between projects, and the response is a pure projection.
 */
export function registerInboxRoutes(router: Router, registry: ProjectRegistry): void {
  router.get('/inbox', (_req, res) => {
    // An app-wide cap belongs to no project: the first project speaks for it so it appears once.
    const sources = registry.listContexts().map((ctx, index) => createProjectInboxSource({
      project: { id: ctx.project.id, name: ctx.project.name },
      db: ctx.db,
      caps: () => (ctx.budgetCaps?.() ?? []).filter((cap) => cap.scope === 'project' || index === 0),
    }))
    res.json(collectInbox(sources))
  })
}
