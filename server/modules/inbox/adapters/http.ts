import type { Router } from 'express'
import type { ProjectRegistry } from '../../../project-registry'
import { collectInbox } from '../application'
import type { ProjectInboxSource } from '../ports'
import { createProjectInboxSource } from './project-source'
import { mapInSlices, replay, settle } from '../../../util/event-loop-slices'

/**
 * One inbox source per registered project, each read through its own context
 * and database. The live board projects the very same sources, so its "Needs
 * you" column and this inbox always agree.
 */
export function createInboxSources(registry: Pick<ProjectRegistry, 'listContexts'>, now?: () => number): ProjectInboxSource[] {
  // An app-wide cap belongs to no project: the first project speaks for it so it appears once.
  return registry.listContexts().map((ctx, index) => createProjectInboxSource({
    project: { id: ctx.project.id, name: ctx.project.name },
    db: ctx.db,
    caps: () => (ctx.budgetCaps?.() ?? []).filter((cap) => cap.scope === 'project' || index === 0),
  }, now))
}

/**
 * Read every source once, a project at a time, giving the event loop a turn
 * between slices. The returned sources replay what was read (or the failure,
 * which `collectInbox` isolates), so the projection itself stays synchronous.
 */
export async function readInboxSourcesInSlices(sources: readonly ProjectInboxSource[]): Promise<ProjectInboxSource[]> {
  return mapInSlices(sources, (source) => {
    const result = settle(() => source.collect())
    return { projectId: source.projectId, projectName: source.projectName, collect: () => replay(result) }
  })
}

/**
 * GET /api/inbox — the "Needs you" read-model across projects. Nothing is
 * cached or shared between projects, and the response is a pure projection.
 */
export function registerInboxRoutes(router: Router, registry: ProjectRegistry): void {
  router.get('/inbox', (_req, res, next) => {
    registry.withSpendSnapshot(async () => {
      res.json(collectInbox(await readInboxSourcesInSlices(createInboxSources(registry))))
    }).catch(next)
  })
}
