/**
 * Composition of the app-wide worktree process reaper.
 *
 * The reaper (terminals capability) needs every live owner across projects to
 * know what must survive a run's settlement: agent sessions, loop runs, queue
 * jobs, registered background processes and terminal shells — the same roots
 * the app Resources view attributes (`listAppResourceRoots`). This file binds
 * that view and the registered project checkouts at startup, and runs the
 * startup sweep for rail worktrees whose run had already settled.
 */
import os from 'os'
import path from 'path'
import type { DbInstance } from './db'
import type { ProjectRegistry } from './project-registry'
import { listAppResourceRoots } from './app-resources-router'
import { getProjectRepositories } from './project-repositories'
import { resolveSpecrailsHome } from './util/specrails-home'
import { createProcessTableReader } from './modules/terminals/runtime/resource-sampler'
import {
  createWorktreeProcessReaper, installWorktreeProcessReaper, reapWorktreeLeftovers,
  type WorktreeProcessReaper, type WorktreeProcessReaperDeps,
} from './modules/terminals/runtime/worktree-process-reaper'
import { reapWorktreeContainers } from './modules/terminals/runtime/worktree-container-reaper'

type Registry = Pick<ProjectRegistry, 'listContexts' | 'getProjectRow' | 'desktopDb' | 'listProjects'>

/** Paths whose ancestors (and themselves) are never reaped: homes, the server cwd, every project checkout. */
export function forbiddenReapPaths(registry: Pick<Registry, 'listProjects'>): string[] {
  const specrailsHome = resolveSpecrailsHome()
  const userHome = os.homedir()
  const out = [userHome, specrailsHome, path.join(specrailsHome, '.specrails'), process.cwd()]
  try {
    for (const project of registry.listProjects()) {
      out.push(project.path)
      try {
        for (const repo of getProjectRepositories(project)) out.push(repo.path)
      } catch { /* a malformed repository list still protects the project path */ }
    }
  } catch { /* the registry is unavailable: the static paths still apply */ }
  return out
}

export function installAppWorktreeProcessReaper(
  registry: Registry,
  overrides: Partial<WorktreeProcessReaperDeps> = {},
): WorktreeProcessReaper {
  const reaper = createWorktreeProcessReaper({
    readProcessTable: createProcessTableReader(),
    listProtectedRootPids: (table) => listAppResourceRoots(registry, table).map((root) => root.pid),
    listForbiddenPaths: () => forbiddenReapPaths(registry),
    reapContainers: (paths, context) => reapWorktreeContainers(paths, { windows: process.platform === 'win32', context }),
    ...overrides,
  })
  installWorktreeProcessReaper(reaper)
  return reaper
}

/** Newest rail worktree paths whose loop run has settled and that no unsettled run still uses. */
export const SETTLED_WORKTREE_SWEEP_LIMIT = 200

export function listSettledRailWorktreePaths(db: DbInstance): string[] {
  try {
    const rows = db.prepare(`
      SELECT rw.worktree_path AS worktree_path, MAX(rw.updated_at) AS updated_at
        FROM rail_worktrees rw
        JOIN loop_runs lr ON lr.id = rw.run_id
       WHERE lr.finished_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM rail_worktrees other
             JOIN loop_runs active ON active.id = other.run_id
            WHERE other.worktree_path = rw.worktree_path AND active.finished_at IS NULL)
       GROUP BY rw.worktree_path
       ORDER BY updated_at DESC
       LIMIT ?
    `).all(SETTLED_WORKTREE_SWEEP_LIMIT) as Array<{ worktree_path: string }>
    return rows.map((row) => row.worktree_path).filter(Boolean)
  } catch {
    return []
  }
}

/** Startup recovery: one pass over every project's settled rail worktrees (one process-table read each). */
export async function sweepSettledRunWorktrees(registry: Pick<Registry, 'listContexts'>): Promise<number> {
  let reaped = 0
  for (const ctx of registry.listContexts()) {
    const worktreePaths = listSettledRailWorktreePaths(ctx.db)
    if (worktreePaths.length === 0) continue
    const result = await reapWorktreeLeftovers({ worktreePaths, reason: 'startup-recovery', projectId: ctx.project.id })
    reaped += result?.reaped.length ?? 0
  }
  return reaped
}
