import type { Request, Response } from 'express'
import type { ProjectRoutesDeps } from './project-router-helpers'
import { getBackgroundProcessLogs, listBackgroundProcesses, startBackgroundProcess } from './transient-children'
import { getProjectRepositories, resolveProjectRepository, RepositoryValidationError } from './project-repositories'
import { BackgroundProcessOwnershipLostError, backgroundProcessHooks, backgroundStartBusyReason, resolveBackgroundCwd, stopOwnedBackgroundProcess } from './background-process-service'

function processQuery(req: Request, res: Response): { pid: number; chatId: string; processId?: string } | null {
  const pid = Number(req.params.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) { res.status(400).json({ error: 'pid must be a positive integer' }); return null }
  const chatId = typeof req.query.chatId === 'string' ? req.query.chatId.trim() : ''
  if (!chatId) { res.status(400).json({ error: 'chatId is required' }); return null }
  const processId = req.query.processId
  if (processId !== undefined && (typeof processId !== 'string' || !processId.trim() || processId.length > 200)) {
    res.status(400).json({ error: 'processId must be a nonempty execution identity' }); return null
  }
  return { pid, chatId, ...(typeof processId === 'string' ? { processId } : {}) }
}

export function registerBackgroundProcessRoutes({ router, ctx }: ProjectRoutesDeps): void {
  router.get('/:projectId/background-processes', (req, res) => {
    const c = ctx(req)
    const chatId = typeof req.query.chatId === 'string' && req.query.chatId.trim() ? req.query.chatId.trim() : undefined
    res.json({ processes: listBackgroundProcesses({ projectId: c.project.id,
      ...(chatId ? { chatId } : {}), ...(req.query.includeFinished === 'true' ? { includeFinished: true } : {}) }) })
  })

  router.get('/:projectId/background-processes/:pid/logs', (req, res) => {
    const c = ctx(req)
    const query = processQuery(req, res)
    if (!query) return
    const { pid, ...owner } = query
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit)
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) { res.status(400).json({ error: 'limit must be a positive integer' }); return }
    const logs = getBackgroundProcessLogs(pid, { projectId: c.project.id, ...owner, ...(limit !== undefined ? { limit } : {}) })
    if (!logs) { res.status(404).json({ error: 'background process logs not found for project/chat or execution has expired' }); return }
    res.json(logs)
  })

  router.post('/:projectId/background-processes', (req, res) => {
    const { command, cwd, chatId, repositoryId, confirmed, allowWhileBusy } = req.body ?? {}
    const c = ctx(req)
    if (typeof command !== 'string' || !command.trim()) { res.status(400).json({ error: 'command is required' }); return }
    if (typeof chatId !== 'string' || !chatId.trim()) { res.status(400).json({ error: 'chatId is required' }); return }
    if (confirmed !== true) { res.status(400).json({ error: 'confirmed must be true after explicit user confirmation' }); return }
    try {
      const busyReason = backgroundStartBusyReason(c)
      if (busyReason && allowWhileBusy !== true) {
        res.status(409).json({ error: 'project is busy', reason: busyReason, hint: 'Wait for the running job/loop to finish, or pass allowWhileBusy:true only after explicit user confirmation.' }); return
      }
      if (repositoryId !== undefined && (typeof repositoryId !== 'string' || !repositoryId.trim())) throw new RepositoryValidationError('repositoryId must be a nonempty string')
      if (getProjectRepositories(c.project).length > 1 && repositoryId === undefined) throw new RepositoryValidationError('repositoryId is required for multi-repository projects', 'repository_required')
      const repository = resolveProjectRepository(c.project, repositoryId)
      const process = startBackgroundProcess(command.trim(), resolveBackgroundCwd(repository.path, cwd), chatId.trim(), c.project.id,
        backgroundProcessHooks(c.broadcast), { repositoryId: repository.id, repositoryName: repository.name })
      res.status(202).json({ ok: true, repositoryId: repository.id, process })
    } catch (err) {
      res.status(err instanceof RepositoryValidationError ? err.status : 500).json({ error: err instanceof Error ? err.message : 'background process failed to start' })
    }
  })

  router.delete('/:projectId/background-processes/:pid', (req, res) => {
    const c = ctx(req)
    const query = processQuery(req, res)
    if (!query) return
    const { pid, ...owner } = query
    try {
      const process = stopOwnedBackgroundProcess(pid, { projectId: c.project.id, ...owner })
      if (!process) { res.status(404).json({ error: 'background process not found for project/chat or execution identity' }); return }
      if (process.error && !['stopping', 'exited', 'killed', 'failed'].includes(process.status)) { res.status(500).json({ error: process.error, process }); return }
      res.status(process.status === 'stopping' ? 202 : 200).json({ ok: true, pid, status: process.status, process })
    } catch (err) {
      res.status(err instanceof BackgroundProcessOwnershipLostError ? err.status : 500).json({ error: err instanceof Error ? err.message : 'background process could not be stopped' })
    }
  })
}
