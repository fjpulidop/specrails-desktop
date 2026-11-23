import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import type { ProjectContext } from '../../project-registry'
import { requireProject, requireRepository, toolTierAllowed } from './types'
import { startBackgroundProcess, getBackgroundProcess, getBackgroundProcessLogs, listBackgroundProcesses } from '../../transient-children'
import { resolveBackgroundCwd, backgroundProcessHooks, backgroundStartBusyReason, stopOwnedBackgroundProcess } from '../../modules/terminals/runtime/background-process-service'
import { withAppUrls } from '../../modules/terminals/runtime/app-urls'
import { getProjectRepositories } from '../../project-repositories'
import { actionEnum, type ActionFields } from './actions'

/**
 * `specrails_background`: long-running application processes (dev servers,
 * watchers) owned by an authenticated in-app agent conversation. Moved out of
 * `specrails_jobs`; `specrails_jobs(background_*)` are hidden aliases.
 */

const APP_URLS_HINT = 'appUrls are the addresses this process announced. Give the user each as a clickable markdown link: local opens on this computer; network opens from a phone or another device on the same Wi-Fi/VPN. No network URL means the server only listens on this computer (it was started without its host/LAN flag).'

const FLOW_APP_HINT = 'Started in the Intent worktree. Read specrails_background(logs) now for the listening URL or a startup failure, then give the user the appUrls as clickable links. The Intent bar shows Preview and Stop while it runs; Specrails stops it when the Intent is paused, discarded or handed off.'

export const BACKGROUND_ACTIONS = ['start', 'list', 'logs', 'kill'] as const

export const BACKGROUND_ACTION_FIELDS: Record<string, ActionFields> = {
  start: { required: ['command', 'confirmed'], optional: ['repositoryId', 'cwd', 'allowWhileBusy'] },
  list: { optional: ['chatId', 'includeFinished', 'limit', 'offset'] },
  logs: { required: ['pid'], optional: ['processId', 'chatId', 'limit'] },
  kill: { required: ['pid'], optional: ['processId'] },
}

/**
 * The ACTIVE Intent of the authenticated conversation in this project, through
 * the project's Intent use cases (bound at composition). A paused or settling
 * Intent, a missing Intent service or a failing lookup all mean "no Intent".
 */
export function activeFlowWorkspace(projectCtx: Pick<ProjectContext, 'flow'>, conversationId: string | null | undefined): { flowId: string; worktreePath: string; repositoryId?: string } | null {
  if (!conversationId) return null
  try {
    const flow = projectCtx.flow?.getByConversation(conversationId)
    if (!flow || flow.state !== 'active' || flow.step !== null || !flow.worktreePath) return null
    // `repositoryId`: the non-primary repository the Intent runs in (absent ⇒ primary).
    return { flowId: flow.id, worktreePath: flow.worktreePath, ...(flow.repositoryId ? { repositoryId: flow.repositoryId } : {}) }
  } catch {
    return null
  }
}

/**
 * Entering Intent already granted write and execution in the Intent worktree, so
 * inside an ACTIVE Intent the in-app agent may start (with the user's explicit
 * confirmation) and stop that Intent's background processes below the
 * Autonomous level. Everything else keeps the ladder.
 */
function flowBackgroundException(ctx: McpToolContext, args: Record<string, unknown>): boolean {
  const action = args.action
  if (action !== 'start' && action !== 'kill') return false
  if (action === 'start' && args.confirmed !== true) return false
  let projectCtx: ProjectContext
  try { projectCtx = requireProject(ctx, args.projectId as string | undefined) } catch { return false }
  const flow = activeFlowWorkspace(projectCtx, ctx.originConversationId)
  if (!flow) return false
  if (action === 'start') return true
  const pid = args.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false
  const process = getBackgroundProcess(pid, typeof args.processId === 'string' ? args.processId : undefined)
  return process?.flowId === flow.flowId && process.projectId === projectCtx.project.id && process.chatId === ctx.originConversationId
}

function requireFirstPartyConversation(ctx: McpToolContext, action: string): string {
  if (!ctx.firstPartyAgent || !ctx.originConversationId) {
    throw new Error(`${action} is available only to an authenticated in-app agent turn.`)
  }
  return ctx.originConversationId
}

export function backgroundTool(): McpToolSpec {
  return {
    name: 'specrails_background',
    title: 'Background processes',
    description:
      'Long-running application processes (dev servers, watchers) of an in-app agent conversation. ' +
      'Actions: start (destructive, in-app agent only; confirmed:true after the person approved this exact command; inside an active Intent it runs in the Intent worktree and is allowed below the Autonomous level), ' +
      'list (read; running first, then recent history), logs (read; bounded stdout/stderr and lifecycle), ' +
      'kill (destructive, in-app agent only; stopping is not yet stopped). Arguments per action: specrails_describe.',
    hintTier: 'read',
    tier: (a) => (a.action === 'start' || a.action === 'kill' ? 'destructive' : 'read'),
    tierException: flowBackgroundException,
    actionFields: BACKGROUND_ACTION_FIELDS,
    inputSchema: {
      action: actionEnum(BACKGROUND_ACTIONS),
      projectId: z.string().optional().describe('Project id (defaults to the active project)'),
      command: z.string().optional().describe('start: shell command'),
      confirmed: z.boolean().optional().describe('start: must be true after explicit user confirmation for this exact command'),
      allowWhileBusy: z.boolean().optional().describe('start: override the active job/loop guard after explicit user confirmation'),
      repositoryId: z.string().min(1).optional().describe('start: repository membership id; required for multi-repository projects (ignored inside an active Intent)'),
      cwd: z.string().optional().describe('start: cwd inside the selected repository (inside the Intent worktree during an Intent); see workspacePaths in specrails_projects(get)'),
      pid: z.number().int().positive().optional().describe('logs/kill: process pid'),
      processId: z.string().min(1).max(200).optional().describe('logs/kill: execution UUID from start/list; pass with pid to avoid a reused PID'),
      chatId: z.string().optional().describe('list/logs from an external client: the owning conversation id (in-app turns use their own)'),
      includeFinished: z.boolean().optional().describe('list: include finished/disconnected executions (default true)'),
      limit: z.number().int().positive().max(200).optional().describe('list: page size (default 50); logs: last N lines (default 100)'),
      offset: z.number().int().nonnegative().optional().describe('list: page offset'),
    },
    async handler(ctx, args) {
      const action = args.action as string
      switch (action) {
        case 'start': {
          const command = args.command as string | undefined
          if (!command || !command.trim()) throw new Error('start requires a "command".')
          if (args.confirmed !== true) throw new Error('start requires confirmed:true after explicit user confirmation for this exact command.')
          const chatId = requireFirstPartyConversation(ctx, 'background start')
          const projectCtx = requireProject(ctx, args.projectId as string | undefined)
          // Inside an active Intent the app runs in the Intent worktree (never the
          // project checkout), tagged with the Intent so it stops with it. The
          // worktree is isolated, so the project's busy guard does not apply.
          const flow = activeFlowWorkspace(projectCtx, chatId)
          if (flow) {
            const cwd = resolveBackgroundCwd(flow.worktreePath, args.cwd as string | undefined, 'the Intent worktree')
            const repository = flow.repositoryId ? getProjectRepositories(projectCtx.project).find((member) => member.id === flow.repositoryId) : undefined
            const process = startBackgroundProcess(command.trim(), cwd, chatId.trim(), projectCtx.project.id,
              backgroundProcessHooks(ctx.broadcast), { flowId: flow.flowId, ...(repository ? { repositoryId: repository.id, repositoryName: repository.name } : {}) })
            return { ok: true, flowId: flow.flowId, cwd, process, hint: FLOW_APP_HINT }
          }
          // The Intent exception admitted this call, but the Intent ended meanwhile.
          if (ctx.agentTierLevel !== undefined && !toolTierAllowed(ctx, 'destructive')) throw new Error('The Intent is no longer active, so background start needs the Autonomous permission level again.')
          const busyReason = backgroundStartBusyReason(projectCtx)
          if (busyReason && args.allowWhileBusy !== true) {
            throw new Error(`background start refused because ${busyReason}. Wait for it to finish, or pass allowWhileBusy:true only after explicit user confirmation.`)
          }
          const repository = requireRepository(ctx, args.projectId as string | undefined, args.repositoryId as string | undefined)
          const cwd = resolveBackgroundCwd(repository.path, args.cwd as string | undefined)
          const process = startBackgroundProcess(command.trim(), cwd, chatId.trim(), projectCtx.project.id,
            backgroundProcessHooks(ctx.broadcast), { repositoryId: repository.id, repositoryName: repository.name })
          return { ok: true, repositoryId: repository.id, process,
            hint: 'Application command accepted, not proof of readiness. Preserve pid and processId; inspect specrails_background(logs) now for the listening URL or startup failure as part of this launch, without asking for another permission to read. The user can inspect persisted logs from its chip or mission process history.' }
        }

        case 'list': {
          const chatId = ctx.firstPartyAgent ? requireFirstPartyConversation(ctx, 'background list') : args.chatId as string | undefined
          if (!chatId?.trim()) throw new Error('list requires a "chatId".')
          const projectCtx = requireProject(ctx, args.projectId as string | undefined)
          const terminal = new Set(['exited', 'killed', 'failed', 'interrupted'])
          const processes = listBackgroundProcesses({ projectId: projectCtx.project.id, chatId: chatId.trim(), includeFinished: args.includeFinished !== false })
            .sort((a, b) => Number(terminal.has(a.status)) - Number(terminal.has(b.status)) || b.startedAt - a.startedAt)
          const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.floor(args.limit))) : 50
          const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0
          return { processes: processes.slice(offset, offset + limit).map(withAppUrls), total: processes.length, offset, limit, hasMore: offset + limit < processes.length,
            ...(Number.isSafeInteger(ctx.desktopPort) && ctx.desktopPort > 0 ? { specrailsApi: { host: '127.0.0.1', port: ctx.desktopPort } } : {}),
            hint: 'History includes persisted executions. interrupted means supervision ended after restart; current OS state is unknown and the historical PID cannot be signalled. Keep application ports separate from the Specrails API. Inspect persisted failure logs before proposing another launch.' }
        }

        case 'kill': {
          const pid = args.pid as number | undefined
          if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('kill requires a positive integer "pid".')
          const chatId = requireFirstPartyConversation(ctx, 'background kill')
          const projectCtx = requireProject(ctx, args.projectId as string | undefined)
          const process = stopOwnedBackgroundProcess(pid, { projectId: projectCtx.project.id, chatId: chatId.trim(),
            ...(typeof args.processId === 'string' ? { processId: args.processId } : {}) })
          if (!process) throw new Error('kill requires a registered execution in the same project/chat.')
          if (process.error && !['stopping', 'exited', 'killed', 'failed'].includes(process.status)) throw new Error(process.error)
          return { ok: true, pid, process, status: process.status,
            hint: process.status === 'stopping' ? 'Stop requested; inspect specrails_background(list) or (logs) until terminal before reporting the application stopped.' : 'Inspect the returned terminal status and retained logs.' }
        }

        case 'logs': {
          const pid = args.pid as number | undefined
          if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('logs requires a positive integer "pid".')
          // A first-party turn is confined to its authenticated conversation
          // for reads as well as start/kill. External read-tier clients still
          // supply chatId explicitly because they have no agent capability.
          const chatId = ctx.firstPartyAgent ? requireFirstPartyConversation(ctx, 'background logs') : (args.chatId as string | undefined)
          if (!chatId || !chatId.trim()) throw new Error('logs requires a "chatId".')
          const projectCtx = requireProject(ctx, args.projectId as string | undefined)
          const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.floor(args.limit))) : 100
          const logs = getBackgroundProcessLogs(pid, {
            projectId: projectCtx.project.id,
            chatId: chatId.trim(),
            ...(typeof args.processId === 'string' ? { processId: args.processId } : {}),
            limit,
          })
          if (!logs) throw new Error('logs requires a registered pid in the same project/chat; logs may have expired.')
          const { appUrls } = withAppUrls(logs.process)
          return {
            ok: true,
            ...logs,
            ...(appUrls ? { appUrls, appUrlsHint: APP_URLS_HINT } : {}),
            hint: logs.lines.length > 0
              ? 'Inspect stdout/stderr to explain why the background process exited or failed.'
              : 'No stdout/stderr output has been captured yet. Check the returned process status; empty logs do not prove application readiness.',
          }
        }

        default:
          throw new Error(`Unknown action "${action}".`)
      }
    },
  }
}
