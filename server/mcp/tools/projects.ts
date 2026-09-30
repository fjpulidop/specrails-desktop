import { z } from 'zod'
import type { ProjectRow } from '../../desktop-db'
import type { McpToolSpec } from './types'
import { apiCall, projectPath, getActiveProject } from './types'
import { canonicalRepositoryPath, getProjectRepositories, repositoryPathKey } from '../../project-repositories'

export function serializeProject(p: ProjectRow): Record<string, unknown> {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    path: p.path,
    primaryRepositoryId: getProjectRepositories(p).find(repository => repository.isPrimary)?.id,
    repositories: getProjectRepositories(p),
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
        'Actions: list, get, resolve (by project/repository/workspace path), repositories (inventory), repository_add / repository_update (write, configure registered code workspacePaths), repository_remove (destructive), unregister (destructive — removes the project and its workspace).',
      hintTier: 'read',
      tier: (args) => ['unregister', 'repository_remove'].includes(String(args.action)) ? 'destructive' : ['repository_add', 'repository_update'].includes(String(args.action)) ? 'write' : 'read',
      inputSchema: {
        action: z.enum(['list', 'get', 'resolve', 'repositories', 'repository_add', 'repository_update', 'repository_remove', 'unregister']).describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id; defaults to the active project for get and repository operations; required for unregister'),
        path: z.string().optional().describe('Filesystem path for resolve or repository_add/update; repository root retains its Git/delivery identity'),
        repositoryId: z.string().min(1).optional().describe('Required for repository_update/remove; discover from repositories/get'),
        name: z.string().min(1).optional().describe('Repository display name'),
        integrationBranch: z.string().nullable().optional().describe('Repository integration branch; null clears it'),
        workspacePaths: z.array(z.string().min(1)).min(1).max(50).nullable().optional().describe('repository_add/update: code directories inside the repository, absolute or root-relative. null resets to repository root. Independent Git roots need separate memberships. Changes are rejected while active runs depend on this scope.'),
      },
      handler: (ctx, args) => {
        const action = args.action as string
        switch (action) {
          case 'repositories':
            return apiCall(ctx, 'GET', `${projectPath(ctx, args.projectId as string | undefined)}/repositories`)
          case 'repository_add':
          case 'repository_update':
          case 'repository_remove': {
            const base = `${projectPath(ctx, args.projectId as string | undefined)}/repositories`
            const id = args.repositoryId as string | undefined
            if (action !== 'repository_add' && !id) throw new Error(`${action} requires repositoryId.`)
            if (action === 'repository_remove') return apiCall(ctx, 'DELETE', `${base}/${encodeURIComponent(id!)}`)
            if (action === 'repository_add' && !args.path) throw new Error('repository_add requires path.')
            const body: Record<string, unknown> = {}
            for (const key of ['path', 'name', 'integrationBranch', 'workspacePaths']) if (args[key] !== undefined) body[key] = args[key]
            if (!Object.keys(body).length) throw new Error('repository_update requires at least one field to update.')
            return apiCall(ctx, action === 'repository_add' ? 'POST' : 'PATCH', action === 'repository_add' ? base : `${base}/${encodeURIComponent(id!)}`, body)
          }
          case 'list':
            return ctx.registry.listProjects().map((p) => ({ ...serializeProject(p), available: !!ctx.registry.getContext(p.id) }))
          case 'get': {
            const id = (args.projectId as string | undefined) ?? getActiveProject(ctx)
            if (!id) throw new Error('No project selected. Provide projectId or use specrails_select_project.')
            const p = ctx.registry.getProjectRow(id)
            if (!p) throw new Error(`Unknown projectId "${id}".`)
            return { ...serializeProject(p), available: !!ctx.registry.getContext(id) }
          }
          case 'resolve': {
            const p = args.path as string | undefined
            if (!p) throw new Error('resolve requires a "path".')
            const selected = args.projectId as string | undefined
            const key = repositoryPathKey(canonicalRepositoryPath(p))
            const matches = ctx.registry.listProjects().filter(row => !selected || row.id === selected).flatMap(project =>
              getProjectRepositories(project).filter(repository => [repository.path, ...(repository.workspacePaths ?? (repository.workspacePath ? [repository.workspacePath] : []))].some(root => repositoryPathKey(canonicalRepositoryPath(root)) === key))
                .map(repository => ({ project, repository })))
            if (matches.length > 1) return { resolved: false, ambiguous: true, matches: matches.map(({ project, repository }) => ({ projectId: project.id, projectName: project.name, repositoryId: repository.id, repositoryName: repository.name })) }
            const match = matches[0]
            return match ? { ...serializeProject(match.project), repositoryId: match.repository.id, available: !!ctx.registry.getContext(match.project.id) } : { resolved: false }
          }
          case 'unregister': {
            const id = args.projectId as string | undefined
            if (!id) throw new Error('unregister requires a "projectId".')
            if (!ctx.registry.getProjectRow(id)) throw new Error(`Unknown projectId "${id}".`)
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
