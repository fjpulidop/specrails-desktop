import path from 'node:path'
import type { WsMessage } from '../../../types'
import type { ProjectContext } from '../../../project-registry'
import { listActiveLoopRuns } from '../../loops/runtime/loop-runs-store'
import { canonicalRepositoryPath, isRepositoryPathWithin, RepositoryValidationError } from '../../../project-repositories'
import { getBackgroundProcess, killOwnedBackgroundProcess, type BackgroundProcess, type BackgroundProcessHooks, type BackgroundProcessOutputEvent } from '../../../transient-children'
import { withAppUrls } from './app-urls'

/** The same scope and lifecycle policy applies to REST and the mission MCP. */
export function resolveBackgroundCwd(repositoryRoot: string, cwd: unknown): string {
  if (cwd !== undefined && typeof cwd !== 'string') throw new RepositoryValidationError('cwd must be a string')
  const resolved = path.resolve(repositoryRoot, typeof cwd === 'string' && cwd.trim() ? cwd : '.')
  if (!isRepositoryPathWithin(canonicalRepositoryPath(repositoryRoot), canonicalRepositoryPath(resolved))) {
    throw new RepositoryValidationError('background_start cwd must stay within the selected repository.')
  }
  return resolved
}

export function backgroundProcessHooks(
  broadcast: (msg: WsMessage) => void,
  resolveAppUrls: (process: BackgroundProcess) => BackgroundProcess = withAppUrls,
): BackgroundProcessHooks {
  // Every event carries the current app URLs so clients can replace their
  // snapshot wholesale without losing the links.
  let announced = ''
  const send = (type: 'background_process.started' | 'background_process.updated' | 'background_process.exited', process: BackgroundProcess) => {
    const resolved = resolveAppUrls(process)
    announced = JSON.stringify(resolved.appUrls ?? null)
    broadcast({ type, process: resolved, projectId: process.projectId, timestamp: new Date().toISOString() })
  }
  const publish = (type: 'background_process.started' | 'background_process.updated' | 'background_process.exited') =>
    (process: BackgroundProcess) => send(type, process)
  // A dev server prints its address once it is listening: announce new or
  // changed addresses as an update instead of making clients tail the logs.
  const onOutput = (event: BackgroundProcessOutputEvent) => {
    if (!/https?:\/\//i.test(event.line)) return
    const process = getBackgroundProcess(event.pid, event.processId)
    if (!process || process.projectId !== event.projectId) return
    if (JSON.stringify(resolveAppUrls(process).appUrls ?? null) !== announced) send('background_process.updated', process)
  }
  return { onStarted: publish('background_process.started'), onUpdated: publish('background_process.updated'), onOutput, onExited: publish('background_process.exited') }
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
