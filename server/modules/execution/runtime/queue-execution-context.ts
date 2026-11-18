// Per-project execution context for QueueManager spawns: the relocate-artifacts
// gate (workspace vs legacy repo cwd), the matching ticket store path, and the
// startup sweep of stale per-job openspec PATH shims.
import fsNode from 'fs'
import pathNode from 'path'
import { resolveProjectExecution, type ProjectExecution } from '../../../workspace-resolution'
import { resolveTicketStoragePath } from '../../specs/runtime/ticket-store'
import { openspecShimDir } from '../../../openspec-shim'
import { resolveHome } from '../../../artifact-registry'

/**
 * Resolve the relocate-artifacts execution context for this manager's project.
 * The gate: relocated only when a registry entry exists AND core has populated
 * the workspace; otherwise legacy (cwd = project.path, empty env) — preserving
 * byte-identical behaviour for every existing in-repo project. Falls back to a
 * legacy resolution rooted at `cwd` when slug/cwd are unavailable
 * (non-Super contexts / tests that construct the manager without a slug).
 */
export function resolveQueueExecution(projectSlug: string | null, cwd: string | undefined): ProjectExecution {
  const repoDir = cwd ?? process.cwd()
  if (!projectSlug || !cwd) {
    return {
      relocated: false,
      cwd: repoDir,
      repoDir,
      workspaceDir: null,
      ticketsPath: pathNode.join(repoDir, '.specrails', 'local-tickets.json'),
      backlogConfigPath: pathNode.join(repoDir, '.specrails', 'backlog-config.json'),
      profilesDir: pathNode.join(repoDir, '.specrails', 'profiles'),
      pluginsStateDir: pathNode.join(repoDir, '.specrails', 'plugins'),
      fileSummariesDir: pathNode.join(repoDir, '.specrails', 'file-summaries'),
      specrailsDir: pathNode.join(repoDir, '.specrails'),
      stateDir: pathNode.join(repoDir, '.claude'),
      env: {},
    }
  }
  return resolveProjectExecution({ slug: projectSlug, path: cwd })
}

/**
 * Resolve the local-tickets.json path honouring the relocate-artifacts gate.
 * Relocated ⇒ the registry entry's ticketsPath (workspace). Legacy ⇒
 * `resolveTicketStoragePath(cwd)` which preserves the
 * integration-contract.json custom-storagePath behaviour for existing repos.
 */
export function resolveQueueTicketsPath(projectSlug: string | null, cwd: string | undefined): string {
  const exec = resolveQueueExecution(projectSlug, cwd)
  if (exec.relocated) return exec.ticketsPath
  return resolveTicketStoragePath(cwd ?? process.cwd())
}

/**
 * Startup sweep of stale per-job openspec shim dirs left on disk by rails that
 * crashed/were killed before this code shipped the terminal-path cleanup (or
 * by an ungraceful server exit). Best-effort: removes every `<jobId>` subdir
 * under `~/.specrails/projects/<slug>/openspec-shim/`. The dirs are pure
 * regeneratable PATH shims (no state), so an over-eager sweep is harmless —
 * the next spawn re-materialises its own. No-op when no slug is set.
 */
export function sweepStaleOpenspecShims(projectSlug: string | null): void {
  if (!projectSlug) return
  try {
    const home = resolveHome()
    const shimRoot = pathNode.dirname(openspecShimDir(projectSlug, '_', home))
    if (!fsNode.existsSync(shimRoot)) return
    for (const entry of fsNode.readdirSync(shimRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        fsNode.rmSync(pathNode.join(shimRoot, entry.name), { recursive: true, force: true })
      } catch {
        /* best-effort per-entry */
      }
    }
  } catch {
    /* best-effort: a missing shim root / unreadable dir is fine */
  }
}
