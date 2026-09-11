import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProjectExecution } from './workspace-resolution'

export function hasAgentRuntimeRequest(project: { path: string; slug?: string }, runId: string): boolean {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) return false
  const file = join(resolveProjectExecution(project).specrailsDir, 'pipeline', runId, 'agent-runtime-request.json')
  return existsSync(file)
}
