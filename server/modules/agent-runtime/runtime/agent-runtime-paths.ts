import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { resolveProjectExecution } from '../../../workspace-resolution'

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Whether a programmatic runtime request exists for this run. The run's own
 * frozen context (`contextPath`, recorded at admission) is authoritative: a run
 * admitted while its project was still assembling (or in the in-repo layout,
 * where an isolated run's context lives in its worktree) keeps its runtime
 * state there even after the project's layout moved. The project's current
 * `.specrails/pipeline` is the fallback for callers without the frozen path.
 */
export function hasAgentRuntimeRequest(project: { path: string; slug?: string }, runId: string, contextPath?: string | null): boolean {
  if (!RUN_ID.test(runId)) return false
  if (contextPath && isAbsolute(contextPath) && existsSync(join(dirname(contextPath), 'agent-runtime-request.json'))) return true
  const file = join(resolveProjectExecution(project).specrailsDir, 'pipeline', runId, 'agent-runtime-request.json')
  return existsSync(file)
}
