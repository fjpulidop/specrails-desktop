import fs from 'fs'
import path from 'path'
import { getPluginManager } from './manager'
import { homeJobSnapshotPath, projectJobSnapshotPath } from './paths'
import { atomicWriteFileSync } from './json-mutation'

export interface ResolvedPlugins {
  active: Array<{ name: string; version: string }>
  degraded: Array<{ name: string; reason: string }>
}

/**
 * Resolves the project's installed plugins for a rail spawn. For each entry
 * in `state.json`, runs `verify` (timeout-bounded) and classifies into
 * `active` (verify ok) or `degraded` (verify failed / timed out / threw).
 *
 * Side effect: `verify` persists a plugin's health to `state.json` only when it
 * actually changed since the last check (no churn on the steady-state path).
 * Otherwise this performs no project-file mutation.
 */
export async function resolvePluginsForSpawn(
  projectPath: string,
  projectId: string,
  _jobId: string,
  providerId: string = 'claude',
  legacyProviderId: string = providerId,
  slug?: string,
): Promise<ResolvedPlugins> {
  const mgr = getPluginManager()
  const state = mgr.getProjectState(projectPath)
  const active: ResolvedPlugins['active'] = []
  const degraded: ResolvedPlugins['degraded'] = []

  // Run verify in parallel for all installed plugins. Each verify is
  // already timeout-wrapped inside PluginManager.
  const checks = await Promise.all(
    Object.entries(state.plugins).map(async ([name, entry]) => {
      const scopedProviderState = entry.providers?.[providerId]
      const providerInstalled = entry.providers
        ? scopedProviderState !== undefined
        : providerId === legacyProviderId
      // A plugin installed only for another provider must not appear in this
      // rail's snapshot. Explicitly deactivated installs are intentionally
      // absent rather than misreported as degraded.
      if (!providerInstalled || scopedProviderState?.active === false) return null
      // Skip orphans — they are not in the registry, so verify cannot run.
      if (!mgr.registry.byName.has(name)) return { name, version: entry.version, result: { ok: false, reason: 'orphan', checkedAt: new Date().toISOString() } }
      const result = await mgr.verify(
        projectPath,
        projectId,
        name,
        undefined,
        providerId,
        legacyProviderId,
        slug,
      )
      return { name, version: entry.version, result }
    }),
  )

  for (const c of checks) {
    if (!c) continue
    if (c.result.ok) active.push({ name: c.name, version: c.version })
    else degraded.push({ name: c.name, reason: c.result.reason ?? 'unknown' })
  }

  return { active, degraded }
}

/**
 * Writes the per-job plugin snapshot to:
 *   - `~/.specrails/projects/<slug>/jobs/<jobId>/plugins.json` (chmod 400)
 *   - `<project>/.specrails/plugins/snapshots/<jobId>.json` (project-local mirror)
 * Returns the absolute path of the home-side snapshot (used for env var).
 */
export function snapshotPluginsForJob(
  slug: string,
  jobId: string,
  projectId: string,
  active: ResolvedPlugins['active'],
  degraded: ResolvedPlugins['degraded'],
): string {
  const body = JSON.stringify(
    {
      jobId,
      projectId,
      capturedAt: new Date().toISOString(),
      active,
      degraded,
    },
    null,
    2,
  ) + '\n'

  // Home-side snapshot — chmod 400, source of truth for diagnostic export.
  const homeSnap = homeJobSnapshotPath(slug, jobId)
  fs.mkdirSync(path.dirname(homeSnap), { recursive: true })
  atomicWriteFileSync(homeSnap, body, 0o400)

  return homeSnap
}

/**
 * Project-local mirror snapshot, kept alongside `state.json`. Best-effort —
 * never fails the rail spawn. Used for in-app inspection.
 */
export function snapshotPluginsForJobProjectLocal(
  projectPath: string,
  jobId: string,
  projectId: string,
  active: ResolvedPlugins['active'],
  degraded: ResolvedPlugins['degraded'],
): void {
  try {
    const body = JSON.stringify({ jobId, projectId, capturedAt: new Date().toISOString(), active, degraded }, null, 2) + '\n'
    const p = projectJobSnapshotPath(projectPath, jobId)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    atomicWriteFileSync(p, body)
  } catch {
    // Non-fatal.
  }
}
