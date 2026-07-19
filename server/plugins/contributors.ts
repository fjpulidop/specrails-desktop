import type { Plugin } from '../types'
import { upsertBlock, removeBlock } from './claude-md-mutation'
import { getAdapter } from '../providers'

/**
 * "Contributors" abstract per-plugin contributions to **shared project
 * files** that several plugins might co-write — files where each plugin
 * owns a named region rather than the whole file.
 *
 * Each contributor exposes three lifecycle hooks:
 *   - apply(plugin, projectPath)    — write/refresh this plugin's region
 *   - revert(plugin, projectPath)   — remove this plugin's region
 *   - relativePaths(plugin)         — files this contributor will touch
 *                                     (drives preview-install + installedFiles)
 *
 * Adding a new shared-file contribution in the future means:
 *   1. Add an optional manifest field (e.g., `gitignoreEntries`).
 *   2. Implement a contributor module.
 *   3. Append it to `SHARED_FILE_CONTRIBUTORS`.
 *
 * No other code in PluginManager needs to change — install / uninstall /
 * setActive iterate this array.
 */
export interface SharedFileContributor {
  /** Stable id, used in logs and tests. */
  id: string
  /** True when this plugin actually contributes via this contributor. */
  appliesTo(plugin: Plugin): boolean
  /** Project-relative paths this contributor will create/modify. The
   *  optional `providerId` lets the contributor pick a per-provider file
 *  (for example CLAUDE.md, AGENTS.md, or .kimi-code/AGENTS.md). */
  relativePaths(plugin: Plugin, providerId?: string): string[]
  /** Write/refresh the plugin's region. Idempotent. */
  apply(plugin: Plugin, projectPath: string, providerId?: string): Promise<void>
  /** Remove the plugin's region. No-op when already absent. */
  revert(plugin: Plugin, projectPath: string, providerId?: string): Promise<void>
}

/** Resolve the instructions filename for a provider id, defaulting to
 *  `CLAUDE.md` when the id is unknown or absent. */
function instructionsFilenameFor(providerId?: string): string {
  if (!providerId) return 'CLAUDE.md'
  try {
    return getAdapter(providerId).instructionsFilename
  } catch {
    return 'CLAUDE.md'
  }
}

/** Provider-aware instructions-file contributor. Same block format
 *  (`<!-- specrails-desktop-managed:<plugin>:start/end -->`); destination
 *  filename is the adapter's `instructionsFilename`. */
const instructionsMdContributor: SharedFileContributor = {
  id: 'instructions-md',
  appliesTo: (p) => typeof p.manifest.claudeMdInstructions === 'string' && p.manifest.claudeMdInstructions.trim().length > 0,
  relativePaths: (_p, providerId) => [instructionsFilenameFor(providerId)],
  apply: async (p, projectPath, providerId) => {
    await upsertBlock(projectPath, p.manifest.name, p.manifest.claudeMdInstructions!, instructionsFilenameFor(providerId))
  },
  revert: async (p, projectPath, providerId) => {
    await removeBlock(projectPath, p.manifest.name, instructionsFilenameFor(providerId))
  },
}

export const SHARED_FILE_CONTRIBUTORS: SharedFileContributor[] = [
  instructionsMdContributor,
]

/** Run `apply` for every contributor that applies to this plugin. */
export async function applyContributors(plugin: Plugin, projectPath: string, providerId?: string): Promise<string[]> {
  const touchedPaths: string[] = []
  for (const c of SHARED_FILE_CONTRIBUTORS) {
    if (!c.appliesTo(plugin)) continue
    await c.apply(plugin, projectPath, providerId)
    for (const rel of c.relativePaths(plugin, providerId)) {
      if (!touchedPaths.includes(rel)) touchedPaths.push(rel)
    }
  }
  return touchedPaths
}

/** Run `revert` for every contributor that applies to this plugin. */
export async function revertContributors(plugin: Plugin, projectPath: string, providerId?: string): Promise<void> {
  for (const c of SHARED_FILE_CONTRIBUTORS) {
    if (!c.appliesTo(plugin)) continue
    await c.revert(plugin, projectPath, providerId)
  }
}

/** Project-relative paths every applicable contributor will touch. */
export function contributorPaths(plugin: Plugin, providerId?: string): string[] {
  const out: string[] = []
  for (const c of SHARED_FILE_CONTRIBUTORS) {
    if (!c.appliesTo(plugin)) continue
    for (const rel of c.relativePaths(plugin, providerId)) {
      if (!out.includes(rel)) out.push(rel)
    }
  }
  return out
}
