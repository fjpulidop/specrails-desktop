import path from 'path'
import { getPluginManager } from './manager'

/** Materialize app-installed plugins in the actual Codex invocation. The
 * legacy per-project CODEX_HOME is an install record, not the provider's
 * runtime home: switching HOME would discard the user's login and settings. */
export function buildCodexPluginArgs(options: {
  providerId: string
  stateRoot: string
  repositoryPath: string
  legacyProviderId?: string
}): string[] {
  if (options.providerId !== 'codex') return []
  const manager = getPluginManager()
  const state = manager.getProjectState(options.stateRoot)
  const args: string[] = []
  for (const [name, installed] of Object.entries(state.plugins ?? {})) {
    if (!installed || typeof installed !== 'object') continue
    const scoped = installed.providers?.codex
    if (installed.providers ? !scoped || scoped.active === false : (options.legacyProviderId ?? 'codex') !== 'codex') continue
    const plugin = manager.registry.byName.get(name)
    const entry = plugin?.manifest.providerSupport?.codex?.mcpEntry
    if (!entry) continue
    const keys = plugin?.manifest.owns.mcpServers ?? []
    // A descriptor describes one server. Never duplicate it under unrelated
    // owned keys or overwrite Specrails' authenticated bridge.
    if (keys.length !== 1 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(keys[0]) || keys[0] === 'specrails') continue
    const server = keys[0]
    const serverArgs = [...entry.args]
    // Serena's '.' must mean this invocation's source/worktree, even when
    // the CLI starts in an app-managed conversation or artifact directory.
    if (name === 'serena') {
      const project = serverArgs.indexOf('--project')
      if (project >= 0) serverArgs[project + 1] = path.resolve(options.repositoryPath)
    }
    const prefix = `mcp_servers.${server}`
    args.push('-c', `${prefix}.command=${JSON.stringify(entry.command)}`,
      '-c', `${prefix}.args=${JSON.stringify(serverArgs)}`,
      '-c', `${prefix}.enabled=true`)
    for (const [key, value] of Object.entries(entry.env ?? {})) {
      args.push('-c', `${prefix}.env.${JSON.stringify(key)}=${JSON.stringify(value)}`)
    }
  }
  return args
}
