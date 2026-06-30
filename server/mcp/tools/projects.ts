import { z } from 'zod'
import type { ProjectRow } from '../../desktop-db'
import type { McpToolSpec } from './types'
import { requireProject } from './types'

export function serializeProject(p: ProjectRow): Record<string, unknown> {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    path: p.path,
    provider: p.provider,
    providers: p.providers,
    addedAt: p.added_at,
    lastSeenAt: p.last_seen_at,
  }
}

export function projectsTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_projects',
      title: 'Projects',
      description:
        'List and inspect registered Specrails projects, resolve a project by filesystem path, or unregister one. ' +
        'Actions: list, get, resolve (by path), unregister (destructive — removes the project and its workspace).',
      hintTier: 'read',
      tier: (args) => (args.action === 'unregister' ? 'destructive' : 'read'),
      inputSchema: {
        action: z.enum(['list', 'get', 'resolve', 'unregister']).describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (for get / unregister)'),
        path: z.string().optional().describe('Filesystem path (for resolve)'),
      },
      handler: (ctx, args) => {
        const action = args.action as string
        switch (action) {
          case 'list':
            return ctx.registry.listContexts().map((c) => serializeProject(c.project))
          case 'get':
            return serializeProject(requireProject(ctx, args.projectId as string | undefined).project)
          case 'resolve': {
            const p = args.path as string | undefined
            if (!p) throw new Error('resolve requires a "path".')
            const pc = ctx.registry.getContextByPath(p)
            return pc ? serializeProject(pc.project) : { resolved: false }
          }
          case 'unregister': {
            const id = args.projectId as string | undefined
            if (!id) throw new Error('unregister requires a "projectId".')
            if (!ctx.registry.getContext(id)) throw new Error(`Unknown projectId "${id}".`)
            ctx.registry.removeProject(id)
            return { ok: true, unregistered: id }
          }
          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
