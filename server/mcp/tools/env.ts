import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath, requireProject } from './types'
import { scanWorktreeEnvRequirements } from '../../worktree-env-discovery'

function uniq(names: unknown[]): string[] {
  const out: string[] = []
  for (const v of names) {
    if (typeof v !== 'string') continue
    const name = v.trim()
    if (name && !out.includes(name)) out.push(name)
  }
  return out
}

export function envTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_env',
      title: 'Project worktree environment',
      description:
        'Read, scan, and configure the per-project environment variable NAME allowlist used for rail jobs and isolated loop worktrees. ' +
        'Values are never read or stored by this tool; runs read them from the server environment and can recover configured names from the login shell when the desktop process is missing them. scan inspects safe repo config files such as package.json, .npmrc, .yarnrc.yml and pnpm-workspace.yaml for ${VAR} / process.env.VAR references and private @busuu/* package hints. ' +
        'Actions: get (read current names), scan (discover candidates), set (write names), auto_configure (scan then merge discovered names into settings).',
      hintTier: 'read',
      tier: (args) => (args.action === 'set' || args.action === 'auto_configure' ? 'write' : 'read'),
      inputSchema: {
        action: z.enum(['get', 'scan', 'set', 'auto_configure']).describe('Operation'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        names: z.array(z.string()).optional().describe('set: env var names to configure'),
        merge: z.boolean().optional().describe('set: merge with existing names instead of replacing them (default true)'),
      },
      async handler(ctx, args) {
        const action = args.action as string
        const base = projectPath(ctx, args.projectId as string | undefined)
        if (action === 'get') {
          const settings = await apiCall(ctx, 'GET', `${base}/settings`) as { worktreeEnvPassthrough?: unknown }
          return { names: Array.isArray(settings.worktreeEnvPassthrough) ? settings.worktreeEnvPassthrough : [] }
        }
        if (action === 'scan') {
          const project = requireProject(ctx, args.projectId as string | undefined).project
          return scanWorktreeEnvRequirements(project.path)
        }
        if (action === 'set') {
          const incoming = uniq(Array.isArray(args.names) ? args.names : [])
          if (incoming.length === 0) throw new Error('set requires at least one env var name in "names".')
          const merge = args.merge !== false
          const current = await apiCall(ctx, 'GET', `${base}/settings`) as { worktreeEnvPassthrough?: unknown }
          const existing = Array.isArray(current.worktreeEnvPassthrough) ? uniq(current.worktreeEnvPassthrough) : []
          const next = merge ? uniq([...existing, ...incoming]) : incoming
          const res = await apiCall(ctx, 'PATCH', `${base}/settings`, { worktreeEnvPassthrough: next }) as { settings?: { worktreeEnvPassthrough?: string[] } }
          return { ok: true, names: res.settings?.worktreeEnvPassthrough ?? next, changed: next.filter((n) => !existing.includes(n)) }
        }
        if (action === 'auto_configure') {
          const project = requireProject(ctx, args.projectId as string | undefined).project
          const scan = scanWorktreeEnvRequirements(project.path)
          const discovered = scan.candidates.map((c) => c.name)
          const current = await apiCall(ctx, 'GET', `${base}/settings`) as { worktreeEnvPassthrough?: unknown }
          const existing = Array.isArray(current.worktreeEnvPassthrough) ? uniq(current.worktreeEnvPassthrough) : []
          if (discovered.length === 0) return { ok: true, names: existing, changed: [], scan }
          const next = uniq([...existing, ...discovered])
          const res = await apiCall(ctx, 'PATCH', `${base}/settings`, { worktreeEnvPassthrough: next }) as { settings?: { worktreeEnvPassthrough?: string[] } }
          return { ok: true, names: res.settings?.worktreeEnvPassthrough ?? next, changed: next.filter((n) => !existing.includes(n)), scan }
        }
        throw new Error(`Unknown action "${action}".`)
      },
    },
  ]
}
