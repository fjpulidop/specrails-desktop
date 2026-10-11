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

interface EnvNameStatus { name?: unknown; status?: unknown; shell?: unknown; checkedAt?: unknown; exitCode?: unknown }

/** Names and states only: rebuild each record field by field so nothing but
 *  the documented, value-free fields can ever reach an MCP client. */
function sanitizeStatus(raw: unknown): { checking: boolean; loginShellRecovery: boolean; timeoutMs: number | null; statuses: Array<{ name: string; status: string; shell: string | null; checkedAt: string | null; exitCode: number | null }> } {
  const report = (raw && typeof raw === 'object' ? raw : {}) as { checking?: unknown; loginShellRecovery?: unknown; timeoutMs?: unknown; names?: unknown }
  const names = Array.isArray(report.names) ? report.names as EnvNameStatus[] : []
  return {
    checking: report.checking === true,
    loginShellRecovery: report.loginShellRecovery !== false,
    timeoutMs: typeof report.timeoutMs === 'number' ? report.timeoutMs : null,
    statuses: names
      .filter((entry) => typeof entry?.name === 'string' && typeof entry?.status === 'string')
      .map((entry) => ({
        name: entry.name as string,
        status: entry.status as string,
        shell: typeof entry.shell === 'string' ? entry.shell : null,
        checkedAt: typeof entry.checkedAt === 'string' ? entry.checkedAt : null,
        exitCode: typeof entry.exitCode === 'number' ? entry.exitCode : null,
      })),
  }
}

export function envTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_env',
      title: 'Project worktree environment',
      description:
        'Read, scan, and configure the per-project environment variable NAME allowlist used for rail jobs and isolated loop worktrees. ' +
        'Values are never read or stored by this tool; runs read them from the server environment and can recover configured names from the login shell when the desktop process is missing them. scan inspects safe repo config files such as package.json, .npmrc, .yarnrc.yml and pnpm-workspace.yaml for ${VAR} / process.env.VAR references and private scoped package auth hints. ' +
        'Each configured name reports a value-free resolution status: inherited, recovered (from the login shell), not-defined, probe-timeout or probe-failed. ' +
        'Actions: get (read current names and their statuses), status (statuses only), recheck (probe the login shell now, then return statuses), scan (discover candidates), set (write names), auto_configure (scan then merge discovered names into settings).',
      hintTier: 'read',
      tier: (args) => (args.action === 'set' || args.action === 'auto_configure' ? 'write' : 'read'),
      inputSchema: {
        action: z.enum(['get', 'status', 'recheck', 'scan', 'set', 'auto_configure']).describe('Operation'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        names: z.array(z.string()).optional().describe('set: env var names to configure'),
        merge: z.boolean().optional().describe('set: merge with existing names instead of replacing them (default true)'),
      },
      async handler(ctx, args) {
        const action = args.action as string
        const base = projectPath(ctx, args.projectId as string | undefined)
        if (action === 'get') {
          const settings = await apiCall(ctx, 'GET', `${base}/settings`) as { worktreeEnvPassthrough?: unknown }
          const names = Array.isArray(settings.worktreeEnvPassthrough) ? settings.worktreeEnvPassthrough : []
          // Statuses are best-effort: an older server without the route still answers names.
          try {
            const { statuses } = sanitizeStatus(await apiCall(ctx, 'GET', `${base}/env-passthrough/status`))
            return { names, statuses }
          } catch {
            return { names }
          }
        }
        if (action === 'status') {
          return sanitizeStatus(await apiCall(ctx, 'GET', `${base}/env-passthrough/status`))
        }
        if (action === 'recheck') {
          return sanitizeStatus(await apiCall(ctx, 'POST', `${base}/env-passthrough/recheck`))
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
