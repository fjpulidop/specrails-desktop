import { z } from 'zod'
import type { McpToolSpec } from './types'
import { apiCall, projectPath } from './types'

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
        'Actions: list, get, queue, spawn (ai-spawn — enqueues an arbitrary slash-command job, returns {jobId,position}, async), ' +
        'cancel (destructive — cancels a running/queued job or deletes a terminal one), ' +
        'purge (destructive — bulk-delete persisted job rows in a date range), ' +
        'pause / resume (queue), reorder (queued-job order), priority (change a queued job\'s priority), ' +
        'compare (two jobs side-by-side), export (up to 10k rows as JSON/CSV), ' +
        'diagnostic (binary ZIP — returns a note, not the bytes), run_state (project run state), ' +
        'activity (recent activity feed), stats, metrics, default_spec_model, ' +
        'interactive_turn (ai-spawn — send one more prompt to a running interactive ultracode job), ' +
        'finalize (finalize a running interactive job).',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (['cancel', 'purge'].includes(action)) return 'destructive'
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
            'activity',
            'stats',
            'metrics',
            'default_spec_model',
            'interactive_turn',
            'finalize',
          ])
          .describe('Operation to perform'),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        // ── job identity ──
        jobId: z
          .string()
          .optional()
          .describe('Job id (for get / cancel / priority / diagnostic / interactive_turn / finalize)'),
        // ── list / export pagination + filters ──
        limit: z.number().optional().describe('Page size for list (1-200, default 50) / activity (1-100, default 50)'),
        offset: z.number().optional().describe('Page offset for list'),
        status: z.string().optional().describe('Filter by job status (list)'),
        from: z.string().optional().describe('ISO date lower bound (list / export / purge)'),
        to: z.string().optional().describe('ISO date upper bound (list / export / purge)'),
        before: z.string().optional().describe('Activity cursor: return rows before this timestamp'),
        // ── spawn (rail-bypass enqueue) ──
        command: z.string().optional().describe('Slash-command to enqueue (spawn), e.g. "/specrails:implement #5 --yes"'),
        priority: z
          .enum(['low', 'normal', 'high', 'critical'])
          .optional()
          .describe('Priority for spawn / priority action'),
        dependsOnJobId: z.string().optional().describe('Make the spawned job depend on this job id'),
        pipelineId: z.string().optional().describe('Group the spawned job into this pipeline'),
        profileName: z
          .string()
          .optional()
          .describe('Agent profile for spawn (omit = default resolution; pass empty/null upstream forces legacy)'),
        aiEngine: z.string().optional().describe('Per-job provider override for spawn (must be installed on the project)'),
        // ── reorder ──
        jobIds: z
          .array(z.string())
          .optional()
          .describe('reorder: exact set of currently-queued job ids in the desired order; compare: exactly 2 job ids'),
        // ── interactive_turn ──
        text: z.string().optional().describe('Prompt text for interactive_turn'),
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
            return apiCall(ctx, 'GET', `${base}/jobs${q ? `?${q}` : ''}`)
          }

          case 'get': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('get requires a "jobId".')
            return apiCall(ctx, 'GET', `${base}/jobs/${encodeURIComponent(id)}`)
          }

          case 'queue':
            return apiCall(ctx, 'GET', `${base}/queue`)

          case 'spawn': {
            const command = args.command as string | undefined
            if (!command || !command.trim()) throw new Error('spawn requires a "command".')
            const r = await apiCall(ctx, 'POST', `${base}/spawn`, {
              command,
              priority: args.priority as string | undefined,
              dependsOnJobId: args.dependsOnJobId as string | undefined,
              pipelineId: args.pipelineId as string | undefined,
              profileName: args.profileName as string | undefined,
              aiEngine: args.aiEngine as string | undefined,
            })
            return {
              ...(r as Record<string, unknown>),
              hint: 'Spawned an AI CLI job (incurs token cost). Use specrails_watch with the returned jobId to await completion.',
            }
          }

          case 'cancel': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('cancel requires a "jobId".')
            return apiCall(ctx, 'DELETE', `${base}/jobs/${encodeURIComponent(id)}`)
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
            return apiCall(ctx, 'GET', `${base}/jobs/export?${qs.toString()}`)
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
              hint: 'Queued an additional interactive turn (incurs token cost). Use specrails_watch with the jobId to follow the job.',
            }
          }

          case 'finalize': {
            const id = args.jobId as string | undefined
            if (!id) throw new Error('finalize requires a "jobId".')
            return apiCall(ctx, 'POST', `${base}/jobs/${encodeURIComponent(id)}/finalize`)
          }

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
  ]
}
