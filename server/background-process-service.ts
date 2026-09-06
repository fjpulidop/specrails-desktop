import path from 'node:path'
import type { WsMessage } from './types'
import type { ProjectContext } from './project-registry'
import { listActiveLoopRuns } from './loop-runs-store'
import { canonicalRepositoryPath, isRepositoryPathWithin, RepositoryValidationError } from './project-repositories'
import { getBackgroundProcess, killOwnedBackgroundProcess, type BackgroundProcessHooks } from './transient-children'

/** The same scope and lifecycle policy applies to REST and the mission MCP. */
export function resolveBackgroundCwd(repositoryRoot: string, cwd: unknown): string {
  if (cwd !== undefined && typeof cwd !== 'string') throw new RepositoryValidationError('cwd must be a string')
  const resolved = path.resolve(repositoryRoot, typeof cwd === 'string' && cwd.trim() ? cwd : '.')
  if (!isRepositoryPathWithin(canonicalRepositoryPath(repositoryRoot), canonicalRepositoryPath(resolved))) {
    throw new RepositoryValidationError('background_start cwd must stay within the selected repository.')
  }
  return resolved
}

export function backgroundProcessHooks(broadcast: (msg: WsMessage) => void): BackgroundProcessHooks {
  const publish = (type: 'background_process.started' | 'background_process.updated' | 'background_process.exited') =>
    (process: import('./transient-children').BackgroundProcess) => broadcast({ type, process,
      projectId: process.projectId, timestamp: new Date().toISOString() })
  return { onStarted: publish('background_process.started'), onUpdated: publish('background_process.updated'), onExited: publish('background_process.exited') }
}

export function backgroundStartBusyReason(c: ProjectContext): string | null {
  const activeJobId = typeof c.queueManager?.getActiveJobId === 'function' ? c.queueManager.getActiveJobId() : null
  if (activeJobId) return `job ${activeJobId} is still running`
  // Context-only fixtures have no database; a real database error must not
  // silently bypass the concurrent-run guard.
  if (!c.db) return null
  const activeLoops = listActiveLoopRuns(c.db, c.project.id)
  return activeLoops.length ? `loop run ${activeLoops[0].id} is still running` : null
}

export class BackgroundProcessOwnershipLostError extends Error {
  readonly status = 409
  constructor() {
    super('This execution was recovered from history after Specrails restarted. Its current OS state is unknown, so its old PID cannot be used to stop it. Inspect its retained logs and the current application state first.')
    this.name = 'BackgroundProcessOwnershipLostError'
  }
}

export function stopOwnedBackgroundProcess(pid: number, owner: { projectId: string; chatId: string; processId?: string }) {
  const process = getBackgroundProcess(pid, owner.processId)
  if (!process || process.projectId !== owner.projectId || process.chatId !== owner.chatId ||
      (owner.processId !== undefined && process.processId !== owner.processId)) return null
  if (process.status === 'interrupted') throw new BackgroundProcessOwnershipLostError()
  if (['exited', 'killed', 'failed'].includes(process.status)) return process
  if (!killOwnedBackgroundProcess(pid, owner)) return null
  return getBackgroundProcess(pid, owner.processId)
}
