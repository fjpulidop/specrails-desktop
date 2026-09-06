import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath, originConversationDefaults, requireProject, requireRepository } from './types'
import { startBackgroundProcess, getBackgroundProcessLogs, listBackgroundProcesses } from '../../transient-children'
import { resolveBackgroundCwd, backgroundProcessHooks, backgroundStartBusyReason, stopOwnedBackgroundProcess } from '../../background-process-service'

function requireFirstPartyConversation(ctx: Parameters<McpToolSpec['handler']>[0], action: string): string {
  if (!ctx.firstPartyAgent || !ctx.originConversationId) {
    throw new Error(`${action} is available only to an authenticated in-app agent turn.`)
  }
  return ctx.originConversationId
}

/**
 * Jobs domain facade. Maps every in-scope jobs/queue action to its REST
 * endpoint on the loopback API (server/project-router-jobs.ts, plus the
 * diagnostic export in server/project-router-settings.ts).
 *
 * Rail-specific operations (launch/stop/set_* on /rails) live in a separate
 * rails tool; this facade covers the project-level job queue and individual
 * job lifecycle. Note: `spawn` here is the rail-bypass `/spawn` endpoint that
 * enqueues an arbitrary slash-command job (incurs token cost, async 202).
 */
export function jobsTools(): McpToolSpec[] {
  return [
    {
      name: 'specrails_jobs',
      title: 'Jobs & Queue',
      description:
        'Manage a project\'s AI-pipeline job queue and individual jobs. ' +
        'Actions: list, get, queue, spawn (ai-spawn — enqueues a direct slash-command job in the primary repository only, returns {jobId,position}, async; repositoryId is required for multi-repository projects; use specrails_rails launch for spec implementations or specrails_loops run for coordinated secondary/multi-repository work; from the in-app agent chat the engine defaults to your conversation\'s provider — pass aiEngine to override), ' +
        'background_start (in-app-agent-only destructive shell command tied to the authenticated chat; requires confirmed:true after explicit user confirmation), background_list (read scoped running/recent applications), background_logs (read bounded stdout/stderr and actual lifecycle), background_kill (in-app-agent-only destructive; stopping is not yet stopped), ' +
        'cancel (destructive — requests cancellation of a running/queued job; it does not delete terminal history), ' +
        'purge (destructive — bulk-delete persisted job rows in a date range), ' +
        'pause / resume (queue), reorder (queued-job order), priority (change a queued job\'s priority), ' +
        'compare (two jobs side-by-side), export (up to 10k rows as JSON/CSV — inlines everything; prefer list/stats for token economy), ' +
        'diagnostic (binary ZIP — returns a note, not the bytes), run_state (project run state), ' +
        'pipeline (read a pipeline\'s jobs + statuses — use after composing dependent spawns), ' +
        'activity (recent activity feed), stats, metrics, phase_breakdown (per-phase timing and token use for jobId), default_spec_model, ' +
        'interactive_turn (ai-spawn — send a steering prompt to any running interactive job; claude jobs are interactive by default), ' +
        'finalize (settle a running interactive job now — Freestyle jobs otherwise wait for it, others auto-settle).',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (['cancel', 'purge', 'background_start', 'background_kill'].includes(action)) return 'destructive'
        if (['spawn', 'interactive_turn'].includes(action)) return 'ai-spawn'
        if (['pause', 'resume', 'reorder', 'priority', 'finalize'].includes(action)) return 'write'
        return 'read'
      },
      inputSchema: {
        action: z
          .enum([
            'list',
            'get',
            'queue',
            'spawn',
            'cancel',
            'purge',
            'pause',
            'resume',
            'reorder',
            'priority',
            'compare',
            'export',
            'diagnostic',
            'run_state',
            'pipeline',
            'activity',
            'stats',
            'metrics',
            'phase_breakdown',
            'default_spec_model',
            'interactive_turn',
            'finalize',
            'background_start',
            'background_list',
            'background_logs',
            'background_kill',
          ])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        // ── job identity ──
        jobId: z
          .string()
          .optional()
          .describe('Job id (for get / cancel / priority / diagnostic / interactive_turn / finalize)'),
        // ── list / export pagination + filters ──
        limit: z.number().int().positive().max(200).optional().describe('Page size for list (1-200, default 50) / activity (1-100, default 50); background_logs returns the last N buffered log lines'),
        offset: z.number().int().nonnegative().optional().describe('Page offset for list/background_list'),
        eventLimit: z.number().int().positive().max(200).optional().describe('get: maximum persisted events to return (default 50, latest events by default)'),
        eventOffset: z.number().int().nonnegative().optional().describe('get: chronological event offset; omit for the latest eventLimit events'),
        status: z.string().optional().describe('Filter by job status (list)'),
        from: z.string().optional().describe('ISO date lower bound (list / export / purge)'),
        to: z.string().optional().describe('ISO date upper bound (list / export / purge)'),
        before: z.string().optional().describe('Activity cursor: return rows before this timestamp'),
        // ── spawn (rail-bypass enqueue) ──
        command: z.string().optional().describe('Direct slash-command to enqueue in the primary repository (spawn), or shell command (background_start). Implement backlog specs through specrails_rails launch to retain isolation and delivery tracking.'),
        priority: z
          .enum(['low', 'normal', 'high', 'critical'])
          .optional()
          .describe('Priority for spawn / priority action'),
        dependsOnJobId: z.string().optional().describe('Make the spawned job depend on this job id'),
        pipelineId: z.string().optional().describe('Pipeline id: group the spawned job into this pipeline (spawn) / pipeline to read (pipeline)'),
        profileName: z
          .string()
          .nullable()
          .optional()
          .describe('Agent profile for spawn (omit = default resolution; null forces legacy)'),
        aiEngine: z.string().optional().describe('Per-job provider override for spawn (must be installed on the project). From the in-app agent chat, omitting it defaults to the launching conversation\'s provider.'),
        model: z.string().optional().describe('Model for spawn; defaults to the launching conversation model when the provider matches. Explicit override is validated by the server.'),
        // ── reorder ──
        jobIds: z
          .array(z.string())
          .optional()
          .describe('reorder: exact set of currently-queued job ids in the desired order; compare: exactly 2 job ids'),
        // ── interactive_turn ──
        text: z.string().optional().describe('Prompt text for interactive_turn'),
        chatId: z.string().optional().describe('Conversation id for background_logs ownership. background_start/background_kill ignore this field and use the authenticated in-app capability.'),
        repositoryId: z.string().min(1).optional().describe('spawn/background_start: repository membership ID; required when the project has several repositories. spawn accepts only the primary repository; use specrails_rails launch or specrails_loops run for other repositories.'),
        cwd: z.string().optional().describe('Optional cwd for background_start; resolved inside the selected repository root'),
        pid: z.number().int().positive().optional().describe('Background process pid for background_logs/background_kill'),
        processId: z.string().min(1).max(200).optional().describe('Background execution UUID returned by background_start/list. Pass with pid on logs/kill to avoid targeting a reused PID.'),
        includeFinished: z.boolean().optional().describe('background_list: include persisted completed/disconnected executions (default true). Active applications are listed first; use limit/offset for older history.'),
        confirmed: z.boolean().optional().describe('background_start only: must be true after explicit user confirmation for this exact command'),
        allowWhileBusy: z.boolean().optional().describe('background_start only: override active job/loop guard after explicit user confirmation'),
        // ── export ──
        format: z.enum(['json', 'csv']).optional().describe('Export format (default json)'),
        // ── default_spec_model ──
        provider: z.string().optional().describe('Provider to resolve the default spec model for (default_spec_model)'),
      },
      async handler(ctx, args) {
        const base = projectPath(ctx, args.projectId as string | undefined)
        const action = args.action as string

        switch (action) {
          case 'list': {
            const qs = new URLSearchParams()
            if (args.limit !== undefined) qs.set('limit', String(args.limit as number))
            if (args.offset !== undefined) qs.set('offset', String(args.offset as number))
            if (args.status) qs.set('status', args.status as string)
            if (args.from) qs.set('from', args.from as string)
            if (args.to) qs.set('to', args.to as string)
            const q = qs.toString()
            const result = await apiCall(ctx, 'GET', `${base}/jobs${q ? `?${q}` : ''}`) as { jobs?: unknown[]; total?: number }
            const offset = (args.offset as number | undefined) ?? 0
            const count = result.jobs?.length ?? 0
            return { ...result, offset, nextOffset: typeof result.total === 'number' && offset + count < result.total && count > 0 ? offset + count : null }
          }

          case 'get': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('get requires a "jobId".')
            const result = await apiCall(ctx, 'GET', `${base}/jobs/${encodeURIComponent(id)}`) as Record<string, unknown>
            const events = Array.isArray(result.events) ? result.events : []
            const limit = (args.eventLimit as number | undefined) ?? 50
            const offset = (args.eventOffset as number | undefined) ?? Math.max(0, events.length - limit)
            const page = events.slice(offset, offset + limit)
            return {
              ...result,
              events: page,
              eventPage: { offset, limit, total: events.length, hasEarlier: offset > 0, nextOffset: offset + page.length < events.length ? offset + page.length : null },
            }
          }

          case 'queue':
            return apiCall(ctx, 'GET', `${base}/queue`)

          case 'spawn': {
            const command = args.command as string | undefined
            if (!command || !command.trim()) throw new Error('spawn requires a "command".')
            const repository = requireRepository(ctx, args.projectId as string | undefined, args.repositoryId as string | undefined)
            if (!repository.isPrimary) {
              throw new Error('spawn supports only the primary repository. Use specrails_rails(action:"launch", repositoryIds:[...]) for spec implementations or specrails_loops(action:"run", repositoryIds:[...]) for coordinated secondary/multi-repository work.')
            }
            // Engine default (STRUCTURAL, never prompt-dependent): a spawn
            // driven by the in-app agent without an explicit aiEngine runs on
            // the LAUNCHING CONVERSATION's provider — not silently on the
            // project primary. Explicit aiEngine always wins; the router still
            // validates installed-ness (its clear 400 surfaces as the tool
            // error). No origin conversation (dashboard / external MCP client)
            // or an unknown id → no default, byte-identical to before.
            // /spawn accepts model but has no reasoning_effort field.
            const defaults = originConversationDefaults(ctx)
            const aiEngine = (args.aiEngine as string | undefined) ?? defaults.provider
            const model = (args.model as string | undefined) ?? (aiEngine === defaults.provider ? defaults.model : undefined)
            const r = await apiCall(ctx, 'POST', `${base}/spawn`, {
              command,
              priority: args.priority as string | undefined,
              dependsOnJobId: args.dependsOnJobId as string | undefined,
              pipelineId: args.pipelineId as string | undefined,
              profileName: args.profileName as string | null | undefined,
              aiEngine,
              model,
            })
            return {
              ...(r as Record<string, unknown>),
              hint: 'Spawned a direct AI CLI job in the primary repository (incurs token cost; bypasses rail isolation and delivery cards). Use specrails_watch(ref:jobId, kind:"job") or specrails_jobs(get, jobId) to read completion. For spec implementations and delivery revisions, use specrails_rails(launch); for coordinated secondary/multi-repository loops, use specrails_loops(run).',
            }
          }

          case 'cancel': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('cancel requires a "jobId".')
            return apiCall(ctx, 'POST', `${base}/jobs/${encodeURIComponent(id)}/cancel`)
          }

          case 'purge':
            return apiCall(ctx, 'DELETE', `${base}/jobs`, {
              from: args.from as string | undefined,
              to: args.to as string | undefined,
            })

          case 'pause':
            return apiCall(ctx, 'POST', `${base}/queue/pause`)

          case 'resume':
            return apiCall(ctx, 'POST', `${base}/queue/resume`)

          case 'reorder': {
            const jobIds = args.jobIds as string[] | undefined
            if (!Array.isArray(jobIds)) throw new Error('reorder requires "jobIds" (array of queued job ids).')
            return apiCall(ctx, 'PUT', `${base}/queue/reorder`, { jobIds })
          }

          case 'priority': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('priority requires a "jobId".')
            const priority = args.priority as string | undefined
            if (!priority) throw new Error('priority requires a "priority" (low|normal|high|critical).')
            return apiCall(ctx, 'PATCH', `${base}/jobs/${encodeURIComponent(id)}/priority`, { priority })
          }

          case 'compare': {
            const jobIds = args.jobIds as string[] | undefined
            if (!Array.isArray(jobIds) || jobIds.length !== 2) {
              throw new Error('compare requires exactly 2 ids in "jobIds".')
            }
            const qs = new URLSearchParams({ jobIds: jobIds.join(',') })
            return apiCall(ctx, 'GET', `${base}/jobs/compare?${qs.toString()}`)
          }

          case 'export': {
            const qs = new URLSearchParams()
            qs.set('format', (args.format as string | undefined) ?? 'json')
            if (args.from) qs.set('from', args.from as string)
            if (args.to) qs.set('to', args.to as string)
            const data = await apiCall(ctx, 'GET', `${base}/jobs/export?${qs.toString()}`)
            return {
              note: 'Inlines up to 10k rows — prefer list/stats for token economy.',
              data,
            }
          }

          case 'diagnostic': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('diagnostic requires a "jobId".')
            // The diagnostic endpoint streams an application/zip (job-metadata.json,
            // telemetry.ndjson, logs.txt, summary.md, profile + plugin snapshot).
            // We do NOT inline binary bytes through the MCP text channel — return a
            // pointer the caller can fetch over the loopback REST API directly.
            return {
              note: 'Binary export (application/zip) — not inlined.',
              jobId: id,
              path: `${base}/jobs/${encodeURIComponent(id)}/diagnostic`,
              hint: 'Requires a telemetry blob to exist for the job (else 404). Fetch the ZIP via the REST endpoint at the given path.',
            }
          }

          case 'run_state':
            return apiCall(ctx, 'GET', `${base}/state`)

          case 'pipeline': {
            const id = args.pipelineId as string | undefined
            if (!id) throw new Error('pipeline requires a "pipelineId".')
            return apiCall(ctx, 'GET', `${base}/pipelines/${encodeURIComponent(id)}`)
          }

          case 'activity': {
            const qs = new URLSearchParams()
            if (args.limit !== undefined) qs.set('limit', String(args.limit as number))
            if (args.before) qs.set('before', args.before as string)
            const q = qs.toString()
            return apiCall(ctx, 'GET', `${base}/activity${q ? `?${q}` : ''}`)
          }

          case 'stats':
            return apiCall(ctx, 'GET', `${base}/stats`)

          case 'metrics':
            return apiCall(ctx, 'GET', `${base}/metrics`)

          case 'phase_breakdown': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('phase_breakdown requires a "jobId".')
            return apiCall(ctx, 'GET', `${base}/jobs/${encodeURIComponent(id)}/phase-breakdown`)
          }

          case 'default_spec_model': {
            const qs = new URLSearchParams()
            if (args.provider) qs.set('provider', args.provider as string)
            const q = qs.toString()
            return apiCall(ctx, 'GET', `${base}/default-spec-model${q ? `?${q}` : ''}`)
          }

          case 'interactive_turn': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('interactive_turn requires a "jobId".')
            const text = args.text as string | undefined
            if (!text || !text.trim()) throw new Error('interactive_turn requires "text".')
            const r = await apiCall(ctx, 'POST', `${base}/jobs/${encodeURIComponent(id)}/messages`, { text })
            return {
              ...(r as Record<string, unknown>),
              hint: 'Queued an additional interactive turn (incurs token cost). specrails_watch settles when the whole job finalizes; a single turn\'s completion arrives as job.turn_done in the events array.',
            }
          }

          case 'finalize': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('finalize requires a "jobId".')
            return apiCall(ctx, 'POST', `${base}/jobs/${encodeURIComponent(id)}/finalize`)
          }

          case 'background_start': {
            const command = args.command as string | undefined
            if (!command || !command.trim()) throw new Error('background_start requires a "command".')
            if (args.confirmed !== true) throw new Error('background_start requires confirmed:true after explicit user confirmation for this exact command.')
            const chatId = requireFirstPartyConversation(ctx, 'background_start')
            const projectCtx = requireProject(ctx, args.projectId as string | undefined)
            const busyReason = backgroundStartBusyReason(projectCtx)
            if (busyReason && args.allowWhileBusy !== true) {
              throw new Error(`background_start refused because ${busyReason}. Wait for it to finish, or pass allowWhileBusy:true only after explicit user confirmation.`)
            }
            const repository = requireRepository(ctx, args.projectId as string | undefined, args.repositoryId as string | undefined)
            const cwd = resolveBackgroundCwd(repository.path, args.cwd as string | undefined)
            const process = startBackgroundProcess(
              command.trim(),
              cwd,
              chatId.trim(),
              projectCtx.project.id,
              backgroundProcessHooks(ctx.broadcast),
              { repositoryId: repository.id, repositoryName: repository.name },
            )
            return { ok: true, repositoryId: repository.id, process,
              hint: 'Application command accepted, not proof of readiness. Preserve pid and processId; inspect background_logs now for the listening URL or startup failure as part of this launch, without asking for another permission to read. The user can inspect persisted logs from its chip or mission process history.' }
          }

          case 'background_list': {
            const chatId = ctx.firstPartyAgent ? requireFirstPartyConversation(ctx, 'background_list') : args.chatId as string | undefined
            if (!chatId?.trim()) throw new Error('background_list requires a "chatId".')
            const projectCtx = requireProject(ctx, args.projectId as string | undefined)
            const terminal = new Set(['exited', 'killed', 'failed', 'interrupted'])
            const processes = listBackgroundProcesses({ projectId: projectCtx.project.id, chatId: chatId.trim(), includeFinished: args.includeFinished !== false })
              .sort((a, b) => Number(terminal.has(a.status)) - Number(terminal.has(b.status)) || b.startedAt - a.startedAt)
            const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.floor(args.limit))) : 50
            const offset = typeof args.offset === 'number' && Number.isFinite(args.offset) ? Math.max(0, Math.floor(args.offset)) : 0
            return { processes: processes.slice(offset, offset + limit), total: processes.length, offset, limit, hasMore: offset + limit < processes.length,
              ...(Number.isSafeInteger(ctx.desktopPort) && ctx.desktopPort > 0 ? { specrailsApi: { host: '127.0.0.1', port: ctx.desktopPort } } : {}),
              hint: 'History includes persisted executions. interrupted means supervision ended after restart; current OS state is unknown and the historical PID cannot be signalled. Keep application ports separate from the Specrails API. Inspect persisted failure logs before proposing another launch.' }
          }

          case 'background_kill': {
            const pid = args.pid as number | undefined
            if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('background_kill requires a positive integer "pid".')
            const chatId = requireFirstPartyConversation(ctx, 'background_kill')
            const projectCtx = requireProject(ctx, args.projectId as string | undefined)
            const process = stopOwnedBackgroundProcess(pid, { projectId: projectCtx.project.id, chatId: chatId.trim(),
              ...(typeof args.processId === 'string' ? { processId: args.processId } : {}) })
            if (!process) throw new Error('background_kill requires a registered execution in the same project/chat.')
            if (process.error && !['stopping', 'exited', 'killed', 'failed'].includes(process.status)) throw new Error(process.error)
            return { ok: true, pid, process, status: process.status,
              hint: process.status === 'stopping' ? 'Stop requested; inspect background_list or background_logs until terminal before reporting the application stopped.' : 'Inspect the returned terminal status and retained logs.' }
          }

          case 'background_logs': {
            const pid = args.pid as number | undefined
            if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('background_logs requires a positive integer "pid".')
            // A first-party turn is confined to its authenticated conversation
            // for reads as well as start/kill. External read-tier clients still
            // supply chatId explicitly because they have no agent capability.
            const chatId = ctx.firstPartyAgent
              ? requireFirstPartyConversation(ctx, 'background_logs')
              : (args.chatId as string | undefined)
            if (!chatId || !chatId.trim()) throw new Error('background_logs requires a "chatId".')
            const projectCtx = requireProject(ctx, args.projectId as string | undefined)
            const limit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? Math.min(200, Math.max(1, Math.floor(args.limit))) : 100
            const logs = getBackgroundProcessLogs(pid, {
              projectId: projectCtx.project.id,
              chatId: chatId.trim(),
              ...(typeof args.processId === 'string' ? { processId: args.processId } : {}),
              ...(limit !== undefined ? { limit } : {}),
            })
            if (!logs) throw new Error('background_logs requires a registered pid in the same project/chat; logs may have expired.')
            return {
              ok: true,
              ...logs,
              hint: logs.lines.length > 0
                ? 'Inspect stdout/stderr to explain why the background process exited or failed.'
                : 'No stdout/stderr output has been captured yet. Check the returned process status; empty logs do not prove application readiness.',
            }
          }

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
