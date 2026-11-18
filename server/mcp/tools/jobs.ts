import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import { apiCall, projectPath, originConversationDefaults, requireRepository } from './types'
import { toolResponse, type NextCall } from './envelope'
import { DEFAULT_LOG_LINES, MAX_LOG_LINES, focusedLog } from './job-logs'
import { actionEnum, linkAliases, type ActionAlias, type ActionFields } from './actions'
import { runsTool } from './runs'
import { backgroundTool } from './background'

export { activeFlowWorkspace } from './background'

/** Job-queue actions advertised by `specrails_jobs`. */
export const JOB_ACTIONS = [
  'list', 'get', 'logs', 'diagnose_failure', 'queue', 'cancel', 'stats',
  'spawn', 'interactive_turn', 'finalize', 'pause', 'resume', 'reorder', 'priority', 'purge',
  'compare', 'export', 'diagnostic', 'run_state', 'pipeline', 'activity', 'metrics', 'phase_breakdown', 'default_spec_model', 'audit',
] as const

/**
 * Actions that moved to `specrails_runs` / `specrails_background`. They stay
 * accepted on `specrails_jobs` (hidden from the schema and description) so
 * existing clients and prompts keep working.
 */
export const JOB_ALIASES: Record<string, ActionAlias> = {
  runtime_runs: { tool: 'specrails_runs', action: 'state' },
  runtime_diagnose: { tool: 'specrails_runs', action: 'diagnose' },
  runtime_evidence: { tool: 'specrails_runs', action: 'evidence' },
  runtime_steer: { tool: 'specrails_runs', action: 'steer' },
  runtime_resume: { tool: 'specrails_runs', action: 'resume' },
  runtime_recover: { tool: 'specrails_runs', action: 'resume', args: { mode: 'recover' } },
  runtime_approve: { tool: 'specrails_runs', action: 'resume', args: { mode: 'approve' } },
  runtime_settle: { tool: 'specrails_runs', action: 'settle' },
  runtime_dismiss: { tool: 'specrails_runs', action: 'dismiss' },
  runtime_cancel: { tool: 'specrails_runs', action: 'cancel' },
  background_start: { tool: 'specrails_background', action: 'start' },
  background_list: { tool: 'specrails_background', action: 'list' },
  background_logs: { tool: 'specrails_background', action: 'logs' },
  background_kill: { tool: 'specrails_background', action: 'kill' },
}

export const JOB_ACTION_FIELDS: Record<string, ActionFields> = {
  list: { optional: ['status', 'from', 'to', 'limit', 'offset'] },
  get: { required: ['jobId'], optional: ['eventLimit', 'eventOffset'] },
  logs: { required: ['jobId'], optional: ['limit'] },
  diagnose_failure: { required: ['jobId'], optional: ['generate', 'language'] },
  queue: {},
  cancel: { required: ['jobId'] },
  stats: {},
  spawn: { required: ['command'], optional: ['priority', 'dependsOnJobId', 'pipelineId', 'profileName', 'aiEngine', 'model', 'repositoryId'] },
  interactive_turn: { required: ['jobId', 'text'] },
  finalize: { required: ['jobId'] },
  pause: {},
  resume: {},
  reorder: { required: ['jobIds'] },
  priority: { required: ['jobId', 'priority'] },
  purge: { optional: ['from', 'to'] },
  compare: { required: ['jobIds'] },
  export: { optional: ['format', 'from', 'to'] },
  diagnostic: { required: ['jobId'] },
  run_state: {},
  pipeline: { required: ['pipelineId'] },
  activity: { optional: ['limit', 'before'] },
  metrics: {},
  phase_breakdown: { required: ['jobId'] },
  default_spec_model: { optional: ['provider'] },
  audit: { optional: ['jobId', 'format', 'from', 'to'] },
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
  // The aliases target tools of this group, so they are linked here as well
  // as in the catalog (linkAliases is idempotent).
  return linkAliases([
    {
      name: 'specrails_jobs',
      title: 'Jobs & Queue',
      description:
        'A project\'s AI job queue and individual jobs. ' +
        'Actions: list, get (job + paged events), logs (failure-focused log: the failed step first, then the tail), ' +
        'diagnose_failure (why a failed job stopped: diagnosis + saved AI analysis; generate:true is ai-spawn), queue, cancel (destructive), stats, ' +
        'spawn (ai-spawn — direct slash-command job in the primary repository; prefer specrails_rails(launch) for specs), ' +
        'interactive_turn (ai-spawn — steer a running interactive job), finalize (write — settle an interactive job now), ' +
        'pause / resume (write — the queue), reorder / priority (write — queued jobs), purge (destructive — delete job rows in a date range), ' +
        'compare (two jobs), export (up to 10k rows; prefer list/stats), diagnostic (ZIP path, not inlined), run_state, pipeline, activity, metrics, phase_breakdown, default_spec_model, ' +
        'audit (what the agents of jobId read/wrote/ran, JSONL or CSV). ' +
        'Runtime runs: specrails_runs. Background processes: specrails_background. Arguments per action: specrails_describe.',
      hintTier: 'read',
      tier: (a) => {
        const action = a.action as string
        if (['cancel', 'purge'].includes(action)) return 'destructive'
        if (['spawn', 'interactive_turn'].includes(action)) return 'ai-spawn'
        if (action === 'diagnose_failure' && a.generate === true) return 'ai-spawn'
        if (['pause', 'resume', 'reorder', 'priority', 'finalize'].includes(action)) return 'write'
        return 'read'
      },
      aliases: JOB_ALIASES,
      actionFields: JOB_ACTION_FIELDS,
      inputSchema: {
        action: actionEnum(JOB_ACTIONS, Object.keys(JOB_ALIASES)),
        projectId: z.string().optional().describe('Project id (defaults to the active project)'),
        // ── job identity ──
        jobId: z
          .string()
          .optional()
          .describe('Job id'),
        // ── list / export pagination + filters ──
        limit: z.number().int().positive().max(200).optional().describe('list: page size (default 50); activity: rows (max 100); logs: lines (default 200, max 1000)'),
        offset: z.number().int().nonnegative().optional().describe('list: page offset'),
        eventLimit: z.number().int().positive().max(200).optional().describe('get: maximum persisted events to return (default 50, latest events by default)'),
        eventOffset: z.number().int().nonnegative().optional().describe('get: chronological event offset; omit for the latest eventLimit events'),
        status: z.string().optional().describe('Filter by job status (list)'),
        from: z.string().optional().describe('ISO date lower bound (list / export / purge)'),
        to: z.string().optional().describe('ISO date upper bound (list / export / purge)'),
        before: z.string().optional().describe('Activity cursor: return rows before this timestamp'),
        // ── spawn (rail-bypass enqueue) ──
        command: z.string().optional().describe('spawn: slash-command to enqueue in the primary repository'),
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
        aiEngine: z.string().optional().describe('spawn: provider override (defaults to the in-app conversation provider)'),
        model: z.string().optional().describe('spawn: model override'),
        // ── reorder ──
        jobIds: z
          .array(z.string())
          .optional()
          .describe('reorder: exact set of currently-queued job ids in the desired order; compare: exactly 2 job ids'),
        // ── interactive_turn ──
        text: z.string().optional().describe('Prompt text for interactive_turn'),
        repositoryId: z.string().min(1).optional().describe('spawn: repository membership id (required for multi-repository projects; only the primary is accepted)'),
        // ── export ──
        format: z.enum(['json', 'csv', 'jsonl']).optional().describe('Export format: export json|csv (default json); audit jsonl|csv (default jsonl)'),
        // ── default_spec_model ──
        provider: z.string().optional().describe('Provider to resolve the default spec model for (default_spec_model)'),
        // ── diagnose_failure ──
        generate: z.boolean().optional().describe('diagnose_failure: true asks for a fresh AI analysis when none is current (ai-spawn, small cost)'),
        language: z.string().regex(/^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/).optional().describe('diagnose_failure: language of the AI analysis (en, es, de, fr, it, ja, pt, zh; default en)'),
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

          case 'audit': {
            const format = (args.format as string | undefined) === 'csv' ? 'csv' : 'jsonl'
            const qs = new URLSearchParams({ format })
            const id = args.jobId as string | undefined
            if (!id) {
              if (args.from) qs.set('from', args.from as string)
              if (args.to) qs.set('to', args.to as string)
            }
            const path = id ? `${base}/jobs/${encodeURIComponent(id)}/audit?${qs.toString()}` : `${base}/agent-actions?${qs.toString()}`
            const raw = await apiCall(ctx, 'GET', path)
            // The loopback client parses a single JSONL line as JSON; keep the export textual.
            const data = typeof raw === 'string' ? raw : raw == null ? '' : `${JSON.stringify(raw)}\n`
            const rows = data ? data.split('\n').filter(Boolean).length - (format === 'csv' ? 1 : 0) : 0
            return { format, ...(id ? { jobId: id } : {}), rows, note: 'Reads are only as complete as each provider stream reports them.', data }
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

          case 'diagnose_failure':
            return diagnoseFailure(ctx, base, args)

          case 'logs':
            return jobLogs(ctx, base, args)

          default:
            throw new Error(`Unknown action "${action}".`)
        }
      },
    },
    runsTool(),
    backgroundTool(),
  ])
}

type Row = Record<string, unknown>
const asRecord = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null

async function readJob(ctx: McpToolContext, base: string, jobId: string): Promise<{ job: Row; events: Array<{ event_type: string; payload: string | null }> }> {
  const result = asRecord(await apiCall(ctx, 'GET', `${base}/jobs/${encodeURIComponent(jobId)}`))
  const events = Array.isArray(result.events) ? result.events.map(asRecord).map((event) => ({
    event_type: String(event.event_type ?? ''),
    payload: typeof event.payload === 'string' ? event.payload : event.payload === undefined || event.payload === null ? null : JSON.stringify(event.payload),
  })) : []
  return { job: asRecord(result.job), events }
}

/** The deterministic diagnosis plus the saved (or freshly generated) AI analysis of a failed job. */
async function diagnoseFailure(ctx: McpToolContext, base: string, args: Record<string, unknown>): Promise<unknown> {
  const jobId = args.jobId as string | undefined
  if (!jobId) throw new Error('diagnose_failure requires a "jobId".')
  const projectId = typeof args.projectId === 'string' ? args.projectId : undefined
  const scope = projectId ? { projectId } : {}
  const { job } = await readJob(ctx, base, jobId)
  const status = text(job.status) ?? 'unknown'
  const diagnosis = job.failureDiagnosis ?? null
  const diagnosisRow = asRecord(diagnosis)
  if (status !== 'failed' && status !== 'canceled') {
    return toolResponse({ jobId, status, command: job.command ?? null, diagnosis, analysis: null }, {
      status, ids: { jobId, ...scope },
      summary: `Job ${jobId} is ${status}, not failed, so there is nothing to diagnose.`,
      next: status === 'running' || status === 'queued' ? [{ tool: 'specrails_watch', args: { ref: jobId, ...scope }, why: 'Wait for it to settle.' }] : [],
    })
  }
  const query = typeof args.language === 'string' ? `?language=${encodeURIComponent(args.language)}` : ''
  const path = `${base}/jobs/${encodeURIComponent(jobId)}/failure-analysis${query}`
  let analysis = asRecord(await apiCall(ctx, 'GET', path))
  let generated = false
  if (args.generate === true && (analysis.status !== 'ready' || analysis.stale === true)) {
    analysis = asRecord(await apiCall(ctx, 'POST', path, typeof args.language === 'string' ? { language: args.language } : {}))
    generated = true
  }
  const ready = analysis.status === 'ready'
  const reading = asRecord(analysis.analysis)
  const reason = text(reading.headline) ?? text(diagnosisRow.detail)
    ?? (text(diagnosisRow.kind) && diagnosisRow.kind !== 'unknown' ? String(diagnosisRow.kind).replace(/_/g, ' ') : null)
  const next: NextCall[] = [{ tool: 'specrails_jobs', args: { action: 'logs', jobId, ...scope }, why: 'Read the failed step’s log lines.' }]
  if (!ready || analysis.stale === true) next.unshift({ tool: 'specrails_jobs', args: { action: 'diagnose_failure', jobId, generate: true, ...scope }, why: 'Ask the provider that ran it for an AI reading of the log (ai-spawn, small cost).' })
  next.push({ tool: 'specrails_runs', args: { action: 'diagnose', jobId, ...scope }, why: 'Recovery assessment before recommending a retry.' })
  return toolResponse({
    jobId, status, command: job.command ?? null, provider: job.provider ?? null, model: job.model ?? null,
    diagnosis,
    analysis: ready ? {
      headline: reading.headline ?? null, cause: reading.cause ?? null, category: reading.category ?? null,
      failedStep: reading.failedStep ?? null, evidence: reading.evidence ?? [], nextSteps: reading.nextSteps ?? [],
      provider: analysis.provider ?? null, model: analysis.model ?? null, createdAt: analysis.createdAt ?? null,
      stale: analysis.stale === true, generated, label: 'AI reading of the log; the diagnosis keeps its own kind and remedies.',
    } : null,
  }, {
    status,
    ids: { jobId, ...scope },
    summary: `Job ${jobId} ${status === 'canceled' ? 'was canceled' : 'failed'}${reason ? `: ${reason.replace(/\.$/, '')}.` : ' with no recorded cause yet.'}${ready ? ` AI analysis (${String(reading.category ?? 'other')})${analysis.stale === true ? ' is stale' : ' is available'}.` : ' No AI analysis yet.'}`,
    next,
  })
}

/** Bounded, failure-focused log tail instead of raw paged events. */
async function jobLogs(ctx: McpToolContext, base: string, args: Record<string, unknown>): Promise<unknown> {
  const jobId = args.jobId as string | undefined
  if (!jobId) throw new Error('logs requires a "jobId".')
  const projectId = typeof args.projectId === 'string' ? args.projectId : undefined
  const scope = projectId ? { projectId } : {}
  const limit = typeof args.limit === 'number' ? Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(args.limit))) : DEFAULT_LOG_LINES
  const { job, events } = await readJob(ctx, base, jobId)
  const status = text(job.status) ?? 'unknown'
  const failed = status === 'failed' || status === 'canceled'
  const diagnosis = asRecord(job.failureDiagnosis)
  const log = focusedLog(events, { limit, failed, failedStepHint: text(diagnosis.phase) })
  const where = log.failedStep ? ` The failed step “${log.failedStep.title}” (${log.failedStep.status ?? 'unknown'}) comes first.` : ''
  return toolResponse({ jobId, status, limit, ...log }, {
    status,
    ids: { jobId, ...scope },
    truncated: log.truncated,
    summary: log.totalLines
      ? `Job ${jobId} (${status}): showing ${(log.failedStep?.lines.length ?? 0) + log.tail.length} of ${log.totalLines} log lines.${where}`
      : `Job ${jobId} (${status}) has no log lines recorded yet.`,
    next: [
      ...(failed ? [{ tool: 'specrails_jobs', args: { action: 'diagnose_failure', jobId, ...scope }, why: 'The diagnosis and AI analysis of this failure.' }] : []),
      ...(log.truncated ? [{ tool: 'specrails_jobs', args: { action: 'logs', jobId, limit: Math.min(MAX_LOG_LINES, limit * 2), ...scope }, why: 'Read more of the log.' }] : []),
    ],
  })
}
