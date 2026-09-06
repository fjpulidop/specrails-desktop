// Post-swap workspace re-seed (global-core-zero-friction / framework-auto-update).
//
// A `current` swap updates every SYMLINKED workspace surface for free, but the
// COPIED files (instruction files with the project name, Windows copy-fallback
// subtrees, Kimi per-child skill links) stay frozen at the old version. This
// pass re-runs the offline assemble for every relocated workspace whose
// recorded framework version differs from `current` — which also repairs
// machines that were off during a swap (missed-swap scenario).
//
// `.mcp.json` guarantee: the framework owns NO mcp keys today, so the surgical
// "update only framework-owned keys" contract degenerates to full preservation
// — the file is snapshotted before the assemble and restored byte-identically
// if the assemble touched it (plugin/user keys can never be clobbered).

import * as fs from 'fs'
import * as path from 'path'
import { listAdapters } from './providers'
import { workspacePathFor } from './workspace-manager'
import { isWorkspacePopulated } from './workspace-resolution'
import { assembleProjectOffline } from './offline-assemble'
import { resolveCoreRuntime } from './core-runtime'
import { coreUpdatePendingPath } from './core-update-state'
export { assertWorkspaceCoreReady } from './core-update-state'

export function isFrameworkAutoswapEnabled(): boolean {
  const v = (process.env.SPECRAILS_FRAMEWORK_AUTOSWAP ?? '').toLowerCase()
  return v !== 'false' && v !== '0' && v !== 'off'
}

export interface ReseedProject {
  id: string
  slug: string
  path: string
}

export interface ReseedResult {
  projectId: string
  reseeded: boolean
  skippedReason?: 'not-relocated' | 'up-to-date'
  error?: string
}

export interface ReseedIO {
  assemble?: (project: ReseedProject, providers: string[]) => Promise<void>
}

/** The framework version this workspace was last assembled against. */
export function readWorkspaceFrameworkVersion(slug: string): string | null {
  try {
    const v = fs.readFileSync(
      path.join(workspacePathFor(slug), '.specrails', 'specrails-version'),
      'utf-8',
    ).trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}

/** Providers whose surface exists in this workspace (assembled at some point). */
function workspaceProviders(workspace: string): string[] {
  return listAdapters()
    .filter((a) => fs.existsSync(path.join(workspace, a.projectDirName)))
    .map((a) => a.id)
}

/**
 * Re-seed every relocated workspace whose recorded framework version differs
 * from `currentVersion`. Idempotent (an up-to-date workspace is skipped);
 * serialized; never throws — per-project failures are reported and logged.
 */
export async function reseedStaleWorkspaces(
  projects: ReseedProject[],
  currentVersion: string | null,
  io?: ReseedIO,
): Promise<ReseedResult[]> {
  const results: ReseedResult[] = []
  if (!currentVersion) return results
  // Mark every affected workspace before yielding for the first install. A
  // later project must not launch against mixed templates while earlier ones
  // are still being refreshed.
  const pendingErrors = new Map<string, string>()
  for (const project of projects) {
    const workspace = workspacePathFor(project.slug)
    if (!isWorkspacePopulated(workspace)) continue
    if (readWorkspaceFrameworkVersion(project.slug) === currentVersion && !fs.existsSync(coreUpdatePendingPath(workspace))) continue
    try {
      fs.mkdirSync(path.dirname(coreUpdatePendingPath(workspace)), { recursive: true })
      fs.writeFileSync(coreUpdatePendingPath(workspace), JSON.stringify({ version: currentVersion, projectId: project.id }), { mode: 0o600 })
    } catch (error) { pendingErrors.set(project.id, `Could not mark the workspace for Core refresh: ${String(error)}`) }
  }

  const assemble = io?.assemble
    ?? (async (p: ReseedProject, providers: string[]) => {
      const results = await assembleProjectOffline({
        projectPath: p.path,
        slug: p.slug,
        desktopProjectId: p.id,
        providers,
        continueOnError: true,
        preserveExistingConfig: true,
      })
      const failed = results.filter(result => !result.ok)
      if (failed.length) throw new Error(failed.map(result => `${result.provider}: ${result.error}`).join('; '))
    })

  for (const project of projects) {
    const workspace = workspacePathFor(project.slug)
    if (!isWorkspacePopulated(workspace)) {
      results.push({ projectId: project.id, reseeded: false, skippedReason: 'not-relocated' })
      continue
    }
    const recorded = readWorkspaceFrameworkVersion(project.slug)
    if (recorded === currentVersion && !fs.existsSync(coreUpdatePendingPath(workspace))) {
      results.push({ projectId: project.id, reseeded: false, skippedReason: 'up-to-date' })
      continue
    }
    const providers = workspaceProviders(workspace)
    if (providers.length === 0) {
      results.push({ projectId: project.id, reseeded: false, skippedReason: 'not-relocated' })
      continue
    }

    // `.mcp.json` preservation snapshot (see module header).
    const mcpPath = path.join(workspace, '.mcp.json')
    let mcpBefore: string | null = null
    try {
      mcpBefore = fs.readFileSync(mcpPath, 'utf-8')
    } catch { /* absent */ }

    try {
      if (pendingErrors.has(project.id)) throw new Error(pendingErrors.get(project.id))
      await assemble(project, providers)
      if (readWorkspaceFrameworkVersion(project.slug) !== currentVersion) throw new Error('Core assembly did not publish the expected workspace version.')
      // Published Core 5 installations before the execution contract remain
      // valid. Require the helper only when the selected package declares it.
      if (!io?.assemble) {
        const runtime = resolveCoreRuntime()
        if (runtime) {
          const contractPath = path.join(runtime.root, 'integration-contract.json')
          let required: unknown
          try { required = JSON.parse(fs.readFileSync(contractPath, 'utf8')).execution?.runtime } catch { /* legacy contract */ }
          if (typeof required === 'string' && required && !fs.existsSync(path.join(workspace, required))) throw new Error('Core assembly did not install its declared execution runtime.')
        }
      }
      results.push({ projectId: project.id, reseeded: true })
    } catch (err) {
      results.push({
        projectId: project.id,
        reseeded: false,
        error: err instanceof Error ? err.message : String(err),
      })
      console.warn(`[framework-reseed] ${project.slug} failed (non-fatal):`, err)
    } finally {
      if (mcpBefore !== null) {
        let mcpAfter: string | null = null
        try {
          mcpAfter = fs.readFileSync(mcpPath, 'utf-8')
        } catch { /* deleted by assemble */ }
        if (mcpAfter !== mcpBefore) {
          try { fs.writeFileSync(mcpPath, mcpBefore, 'utf-8') }
          catch (error) {
            const result = results[results.length - 1]!
            result.reseeded = false
            result.error = `Could not restore the project's MCP configuration: ${String(error)}`
          }
        }
      }
      const result = results[results.length - 1]!
      if (result.reseeded) {
        try {
          fs.rmSync(coreUpdatePendingPath(workspace), { force: true })
          console.log(`[framework-reseed] ${project.slug}: ${recorded ?? '(none)'} → ${currentVersion}`)
        } catch (error) {
          result.reseeded = false
          result.error = `Could not finalize the Core refresh: ${String(error)}`
        }
      }
    }
  }
  return results
}
