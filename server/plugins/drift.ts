import fs from 'fs'
import { getBlockContent } from './claude-md-mutation'
import type { Plugin } from '../types'
import { getAdapter, hasAdapter } from '../providers'

/**
 * Returns true when the project's `.mcp.json` entry for any of the plugin's
 * owned mcpServers no longer matches the bundled manifest. Used to surface
 * an "Update available" affordance when upstream changes args (e.g.,
 * Serena's `serena-mcp-server` → `serena start-mcp-server`).
 *
 * Only inspects entries the plugin owns; user-authored entries are ignored.
 */
export function detectMcpDrift(
  projectPath: string,
  plugin: Plugin,
  providerId: string = 'claude',
): boolean {
  const ownedKeys = plugin.manifest.owns.mcpServers ?? []
  const adapter = hasAdapter(providerId) ? getAdapter(providerId) : getAdapter('claude')

  // The plugin tells us what its current canonical entry should look like
  // via `previewInstall` is too heavy; we instead introspect via a marker:
  // plugins that ship their canonical entry expose it via `expectedMcpEntry`.
  // We accept Plugins without it (drift detection silently disabled).
  const expected = plugin.expectedMcpEntry?.()

  // CLI-managed registries (Codex) have no project JSON to compare. Their
  // registration is checked by the plugin's verify hook instead.
  if (
    expected &&
    ownedKeys.length > 0 &&
    adapter.mcpRegistration === 'project-json' &&
    adapter.projectMcpPath
  ) {
    const file = adapter.projectMcpPath(projectPath)
    if (fs.existsSync(file)) {
      let parsed: { mcpServers?: Record<string, unknown> }
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        return false
      }
      const servers = parsed.mcpServers ?? {}

      for (const key of ownedKeys) {
        const current = servers[key]
        if (current === undefined) continue
        if (JSON.stringify(current) !== JSON.stringify(expected)) return true
      }
    }
  }

  // Provider-instructions contributor drift. The adapter path may be nested
  // (for example Kimi's `.kimi-code/AGENTS.md`). If/when more shared-file
  // contributors land we move this to a `compareDrift` hook.
  if (plugin.manifest.claudeMdInstructions) {
    const expectedMd = plugin.manifest.claudeMdInstructions.trim()
    const actualMd = (
      getBlockContent(projectPath, plugin.manifest.name, adapter.instructionsFilename) ?? ''
    ).trim()
    if (actualMd !== expectedMd) return true
  }

  return false
}
