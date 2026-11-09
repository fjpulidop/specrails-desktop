import path from 'path'
import { resolveSpecrailsHome } from '../util/specrails-home'

/** `<project>/.specrails/plugins/` — base directory for app-managed plugin state. */
export function pluginsDir(projectPath: string): string {
  return path.join(projectPath, '.specrails', 'plugins')
}

/** `<project>/.specrails/plugins/state.json` — per-project plugin registry. */
export function stateFilePath(projectPath: string): string {
  return path.join(pluginsDir(projectPath), 'state.json')
}

/** `<project>/.specrails/plugins/snapshots/` — per-job plugin snapshots (project-local copy). */
export function snapshotsDir(projectPath: string): string {
  return path.join(pluginsDir(projectPath), 'snapshots')
}

/** `<project>/.specrails/plugins/snapshots/<jobId>.json` — per-job project-local snapshot. */
export function projectJobSnapshotPath(projectPath: string, jobId: string): string {
  return path.join(snapshotsDir(projectPath), `${jobId}.json`)
}

/** `~/.specrails/projects/<slug>/jobs/<jobId>/plugins.json` — chmod-400 spawn-time snapshot. */
export function homeJobSnapshotPath(slug: string, jobId: string): string {
  return path.join(resolveSpecrailsHome(), '.specrails', 'projects', slug, 'jobs', jobId, 'plugins.json')
}

/** `<project>/.mcp.json` — Claude CLI MCP config (managed surgically by the app). */
export function mcpJsonPath(projectPath: string): string {
  return path.join(projectPath, '.mcp.json')
}
