import type { EnvelopeMeta, NextCall } from './envelope'

/**
 * Hand-written envelope summaries for the read actions not covered in
 * summaries.ts. Each entry reads that action's own payload (never mutating it)
 * and returns envelope metadata, or `undefined` when the payload does not have
 * the expected shape, so the generic summary applies. Pure: no I/O.
 *
 * Keys are `<tool>:<action>` with canonical (post-split) tool names; a tool
 * without an action enum uses `<tool>:`.
 */

export type ReadSummarizer = (args: Record<string, unknown>, data: unknown) => EnvelopeMeta | undefined
type Row = Record<string, unknown>

const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const plural = (count: number, noun: string, many = `${noun}s`) => `${count} ${count === 1 ? noun : many}`
const usd = (value: number) => `$${value < 10 ? value.toFixed(2) : value.toFixed(0)}`
const clip = (text: string, max = 80) => text.length > max ? `${text.slice(0, max - 1)}…` : text

function names(items: Row[], pick: (item: Row) => string | null, max = 4): string {
  const list = items.map(pick).filter((name): name is string => !!name).map((name) => clip(name, 48))
  if (!list.length) return ''
  const shown = list.slice(0, max).join(', ')
  return list.length > max ? `${shown} (+${list.length - max} more)` : shown
}

function countBy(items: Row[], key: string): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    const value = str(item[key]) ?? 'unknown'
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].map(([value, count]) => `${value} ${count}`).join(', ')
}

function duration(ms: number | null): string {
  if (ms === null) return 'unknown'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`
  return `${(ms / 86_400_000).toFixed(1)}d`
}

const scope = (args: Record<string, unknown>): Row => str(args.projectId) ? { projectId: str(args.projectId) } : {}
const call = (tool: string, args: Row, why: string): NextCall => ({ tool, args, why })
/** The array under `key`, or the payload itself when it is an array. */
const listAt = (data: unknown, key: string): Row[] | null => Array.isArray(data) ? rows(data) : Array.isArray(record(data)[key]) ? rows(record(data)[key]) : null
const label = (item: Row): string | null => str(item.name) ?? str(item.title) ?? str(item.label) ?? str(item.id)

/** Paging metadata from the common `nextOffset` / `nextCursor` / `hasMore` fields. */
function paging(data: Row): Pick<EnvelopeMeta, 'truncated' | 'cursor'> {
  const cursor = num(data.nextOffset) ?? str(data.nextCursor)
  if (cursor !== null) return { truncated: true, cursor }
  if (data.hasMore === true) return { truncated: true }
  if (data.truncated === true) return { truncated: true }
  return {}
}

/** A list summary: `<count> <noun>: a, b, c.` plus an optional detail line and follow-up. */
function listSummary(noun: string, key: string, opts: { many?: string; pick?: (item: Row) => string | null; detail?: (items: Row[], data: Row) => string | null; next?: (items: Row[], args: Record<string, unknown>) => NextCall[]; empty?: string } = {}): ReadSummarizer {
  return (args, data) => {
    const items = listAt(data, key)
    if (!items) return undefined
    const total = num(record(data).total)
    const detail = opts.detail?.(items, record(data))
    const shown = names(items, opts.pick ?? label)
    const count = total !== null && total !== items.length ? `${items.length} of ${total}` : String(items.length)
    return {
      summary: items.length
        ? `${count} ${items.length === 1 && total === null ? noun : opts.many ?? `${noun}s`}${shown ? `: ${shown}` : ''}.${detail ? ` ${detail}` : ''}`
        : opts.empty ?? `No ${opts.many ?? `${noun}s`} found.`,
      ...paging(record(data)),
      ...(opts.next ? { next: opts.next(items, args).slice(0, 2) } : {}),
    }
  }
}

// ── projects / settings / mission ───────────────────────────────────────────

const projectsResolve: ReadSummarizer = (args, data) => {
  const result = record(data)
  if (result.ambiguous === true) {
    const matches = rows(result.matches)
    return { summary: `The path matches ${plural(matches.length, 'repository', 'repositories')} in several projects: ${names(matches, (m) => `${str(m.projectName) ?? m.projectId}/${str(m.repositoryName) ?? m.repositoryId}`)}. Pass projectId to choose.`, status: 'ambiguous' }
  }
  if (result.resolved === false) return { summary: `No registered project contains ${str(args.path) ?? 'that path'}.`, status: 'not_found', next: [call('specrails_projects', { action: 'list' }, 'See the registered projects.')] }
  const id = str(result.id)
  if (!id) return undefined
  return {
    summary: `${str(args.path) ?? 'The path'} belongs to project ${str(result.name) ?? id} (${id})${str(result.repositoryId) ? `, repository ${result.repositoryId}` : ''}.${result.available === false ? ' Its database is unavailable right now.' : ''}`,
    ids: { projectId: id, ...(str(result.repositoryId) ? { repositoryId: result.repositoryId } : {}) },
    next: [call('specrails_context', { projectId: id }, 'Brief yourself on this project.')],
  }
}

const projectsRepositories = listSummary('repository', 'repositories', {
  many: 'repositories',
  pick: (r) => `${str(r.name) ?? r.id}${r.isPrimary === true ? ' (primary)' : ''}`,
  detail: (items) => items.length > 1 ? 'File and Git operations need an explicit repositoryId.' : null,
})

const settingsGet: ReadSummarizer = (_args, data) => {
  const s = record(data)
  if (!('theme' in s) && !('dailyBudgetUsd' in s)) return undefined
  const caps = [['daily', s.dailyBudgetUsd], ['weekly', s.weeklyBudgetUsd], ['monthly', s.monthlyBudgetUsd], ['per-run', s.runCapUsd]]
    .filter(([, value]) => num(value) !== null).map(([name, value]) => `${name} ${usd(value as number)}`)
  const mcp = record(s.mcp)
  return { summary: `Theme ${str(s.theme) ?? 'default'}, language ${str(s.language) ?? 'auto'}; app-wide caps: ${caps.length ? caps.join(', ') : 'none'}.${typeof mcp.enabled === 'boolean' ? ` MCP ${mcp.enabled ? 'enabled' : 'disabled'}.` : ''}` }
}

const runtimeProvidersList = listSummary('provider connection', 'providers', {
  pick: (p) => `${str(p.name) ?? str(p.id) ?? 'unnamed'}${str(p.baseUrl) ? ` (${p.baseUrl})` : ''}`,
  empty: 'No local provider connections are configured.',
})

const runtimeProvidersTest: ReadSummarizer = (args, data) => {
  const r = record(data)
  if (typeof r.ok !== 'boolean') return undefined
  const models = Array.isArray(r.models) ? r.models.length : null
  return {
    status: r.ok ? 'reachable' : 'unreachable',
    summary: r.ok
      ? `${str(args.baseUrl) ?? 'The endpoint'} answered${models !== null ? ` with ${plural(models, 'model')}` : ''}.`
      : `${str(args.baseUrl) ?? 'The endpoint'} is not reachable: ${clip(str(r.error) ?? str(r.message) ?? 'no detail', 160)}.`,
  }
}

const subagentsSummary = (items: Row[]): string => names(items, (s) => `${clip(str(s.description) ?? String(s.subagentId ?? 'subagent'), 40)} (${str(s.phase) ?? str(s.status) ?? 'unknown'})`)

const subagentWait: ReadSummarizer = (_args, data) => {
  const result = record(data)
  const items = listAt(data, 'subagents') ?? listAt(data, 'results')
  if (!items) return undefined
  const pending = items.filter((s) => !['done', 'completed', 'failed', 'stopped', 'canceled'].includes(str(s.phase) ?? str(s.status) ?? '')).length
  return {
    status: result.timedOut === true || pending ? 'waiting' : 'settled',
    summary: `${plural(items.length, 'sub-agent')}${items.length ? `: ${subagentsSummary(items)}` : ''}.${pending ? ` ${pending} still running; wait again.` : ''}`,
  }
}

const subagentList = listSummary('sub-agent', 'subagents', { pick: (s) => `${clip(str(s.description) ?? String(s.subagentId ?? ''), 40)} (${str(s.phase) ?? 'unknown'})`, empty: 'No sub-agents were delegated in this mission.' })

// ── specs / rails ───────────────────────────────────────────────────────────

const specsSpending: ReadSummarizer = (args, data) => {
  const s = record(data)
  const total = num(s.totalCostUsd)
  if (total === null) return undefined
  const estimated = num(s.estimatedCostUsd) ?? 0
  const unpriced = num(s.unpricedRuns) ?? 0
  const surfaces = Object.entries(record(s.bySurface)).map(([name, v]) => [name, num(record(v).costUsd) ?? 0] as const).filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1])
  return {
    summary: `Spec #${String(args.id ?? '?')}${str(s.ticketTitle) ? ` “${clip(str(s.ticketTitle)!, 60)}”` : ''} cost ${usd(total)} over ${plural(num(s.totalRuns) ?? 0, 'run')}${surfaces[0] ? `, mostly ${surfaces[0][0]} (${usd(surfaces[0][1])})` : ''}.${estimated > 0 ? ` ${usd(estimated)} is estimated.` : ''}${unpriced ? ` ${unpriced} unpriced.` : ''}`,
  }
}

const specsFilesTouched: ReadSummarizer = (args, data) => {
  const files = listAt(data, 'files') ?? listAt(data, 'entries')
  if (!files) return undefined
  return {
    summary: files.length ? `AI jobs for spec #${String(args.id ?? '?')} touched ${plural(files.length, 'file')}: ${names(files, (f) => str(f.path))}.` : `No AI-touched files are recorded for spec #${String(args.id ?? '?')}.`,
    ...paging(record(data)),
    ...(files[0] && str(files[0].path) ? { next: [call('specrails_code', { action: 'read_file', path: files[0].path, ...scope(args) }, 'Read the first touched file.')] } : {}),
  }
}

const specsAttachments = listSummary('attachment', 'attachments', {
  pick: (a) => str(a.filename) ?? str(a.name) ?? str(a.id),
  next: (items, args) => items[0] && str(items[0].id) ? [call('specrails_specs', { action: 'get_attachment', ticketId: args.ticketId, attachmentId: items[0].id, ...scope(args) }, 'Metadata and download path of the first attachment.')] : [],
  empty: 'This spec has no attachments.',
})

const specsGetAttachment: ReadSummarizer = (_args, data) => {
  const a = record(record(data).attachment)
  if (!str(a.id)) return undefined
  const size = num(a.size) ?? num(a.sizeBytes)
  return { summary: `Attachment ${str(a.filename) ?? str(a.name) ?? a.id}${str(a.mimeType) ?? str(a.mime_type) ? ` (${str(a.mimeType) ?? str(a.mime_type)})` : ''}${size !== null ? `, ${Math.ceil(size / 1024)} KB` : ''}; content is not inlined, fetch it from ${str(record(data).path) ?? 'its REST path'}.`, ids: { attachmentId: a.id } }
}

const specsAddenda: ReadSummarizer = (args, data) => {
  const addenda = listAt(data, 'addenda')
  if (!addenda) return undefined
  const open = addenda.filter((a) => a.status === 'open').length
  return {
    summary: addenda.length ? `Spec #${String(args.id ?? '?')} has ${plural(addenda.length, 'addendum', 'addenda')}: ${countBy(addenda, 'status')}.${open ? ` ${open} open will ride into the next launch.` : ''}` : `Spec #${String(args.id ?? '?')} has no addenda.`,
  }
}

const railsPrCandidates = listSummary('PR candidate', 'candidates', {
  pick: (c) => str(c.title) ?? str(c.branch) ?? (c.number !== undefined ? `#${String(c.number)}` : null),
  empty: 'No pull requests can be adopted by this rail.',
})

const railsReviewPacket: ReadSummarizer = (args, data) => {
  const result = record(data)
  const packet = record(result.packet)
  const snapshot = record(result.snapshot)
  if (!Object.keys(packet).length) return undefined
  const checks = rows(packet.checks ?? packet.verification)
  const failing = checks.filter((check) => check.status === 'failed' || check.ok === false || check.passed === false).length
  const decision = str(snapshot.decision)
  const deliveryId = str(snapshot.id) ?? str(args.prDeliveryId)
  return {
    summary: `Review packet for delivery ${deliveryId ?? '?'}${str(snapshot.prUrl) ? ` (${snapshot.prUrl})` : ''}: decision ${decision ?? 'pending'}${checks.length ? `, ${plural(checks.length, 'check')} (${failing} failing)` : ''}.${result.acceptCapability === false ? ' Accept is not available from here; the person decides in the app.' : ''}`,
    status: decision ?? undefined,
    ids: deliveryId ? { prDeliveryId: deliveryId, ...scope(args) } : undefined,
  }
}

// ── jobs ────────────────────────────────────────────────────────────────────


const jobsList: ReadSummarizer = (args, data) => {
  const result = record(data)
  if (!Array.isArray(result.jobs)) return undefined
  const jobs = rows(result.jobs)
  const total = num(result.total)
  const failed = jobs.find((job) => job.status === 'failed')
  const next: NextCall[] = []
  if (failed && str(failed.id)) next.push(call('specrails_jobs', { action: 'diagnose_failure', jobId: failed.id, ...scope(args) }, 'Why the most recent listed failure stopped.'))
  if (num(result.nextOffset) !== null) next.push(call('specrails_jobs', { ...args, offset: result.nextOffset }, 'Fetch the next page.'))
  return {
    summary: jobs.length ? `${jobs.length}${total !== null && total !== jobs.length ? ` of ${total}` : ''} jobs: ${countBy(jobs, 'status')}.` : 'No jobs match.',
    ...paging(result),
    next,
  }
}

const jobsQueue: ReadSummarizer = (args, data) => {
  const q = record(data)
  if (!Array.isArray(q.jobs)) return undefined
  const jobs = rows(q.jobs)
  const queued = jobs.filter((job) => job.status === 'queued').length
  const active = str(q.activeJobId)
  return {
    status: q.paused === true ? 'paused' : active ? 'running' : 'idle',
    summary: `Queue ${q.paused === true ? 'is paused' : 'is running'}: ${active ? `job ${active} active, ` : 'nothing active, '}${plural(queued, 'job')} waiting.`,
    ...(active ? { next: [call('specrails_watch', { ref: active, ...scope(args) }, 'Wait for the active job to settle.')] } : {}),
  }
}

const jobsCompare: ReadSummarizer = (_args, data) => {
  const jobs = listAt(data, 'jobs')
  if (!jobs || !jobs.length) return undefined
  return { summary: `Compared ${plural(jobs.length, 'job')}: ${jobs.map((job) => `${String(job.id ?? '?')} ${str(job.status) ?? '?'}${num(job.total_cost_usd) !== null ? ` ${usd(job.total_cost_usd as number)}` : ''}${num(job.duration_ms) !== null ? ` ${duration(job.duration_ms as number)}` : ''}`).join(' vs ')}.` }
}

const jobsExport: ReadSummarizer = (_args, data) => {
  const result = record(data)
  if (!('data' in result)) return undefined
  const inner = result.data
  const count = Array.isArray(record(inner).jobs) ? rows(record(inner).jobs).length : typeof inner === 'string' ? Math.max(0, inner.split('\n').filter(Boolean).length - 1) : null
  return { summary: `Exported ${count !== null ? plural(count, 'job') : 'the job history'} inline${typeof inner === 'string' ? ' as CSV' : ' as JSON'}; prefer list or stats for routine questions.` }
}

const jobsDiagnostic: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!str(r.path)) return undefined
  return { summary: `The diagnostic bundle of job ${String(r.jobId ?? '?')} is a ZIP and is not inlined; download it from ${r.path} with the app token.`, ids: str(r.jobId) ? { jobId: r.jobId } : undefined }
}

const jobsRunState: ReadSummarizer = (args, data) => {
  const s = record(data)
  if (typeof s.busy !== 'boolean') return undefined
  const current = str(s.currentJobId)
  return {
    status: s.busy ? 'busy' : 'idle',
    summary: `${str(s.projectName) ?? 'The project'} is ${s.busy ? `busy with job ${current ?? 'unknown'}` : 'idle'}.`,
    ...(current ? { next: [call('specrails_jobs', { action: 'get', jobId: current, ...scope(args) }, 'Inspect the running job.')] } : {}),
  }
}

const jobsPipeline: ReadSummarizer = (_args, data) => {
  const p = record(data)
  if (!Array.isArray(p.jobs)) return undefined
  const jobs = rows(p.jobs)
  return { status: str(p.status) ?? undefined, summary: `Pipeline ${String(p.pipelineId ?? '?')} is ${str(p.status) ?? 'unknown'} with ${plural(jobs.length, 'job')}${jobs.length ? `: ${countBy(jobs, 'status')}` : ''}.` }
}

const jobsActivity = listSummary('activity entry', 'items', {
  many: 'activity entries',
  pick: (item) => str(item.summary) ?? str(item.type),
  detail: (items) => {
    const last = items[items.length - 1]
    return last && str(last.timestamp) ? `Older entries: pass before=${last.timestamp}.` : null
  },
  empty: 'No recent activity.',
})

const jobsStats: ReadSummarizer = (_args, data) => {
  const s = record(data)
  const total = num(s.totalJobs)
  if (total === null) return undefined
  const estimated = (num(s.estimatedCostUsd) ?? 0) > 0
  return { summary: `${plural(total, 'job')} in total (${num(s.failedJobs) ?? 0} failed), ${num(s.jobsToday) ?? 0} today; spend ${usd(num(s.totalCostUsd) ?? 0)} overall, ${usd(num(s.costToday) ?? 0)} today${estimated ? ' (partly estimated)' : ''}.` }
}

const jobsMetrics: ReadSummarizer = (_args, data) => {
  const m = record(data)
  const health = num(m.healthScore)
  if (health === null) return undefined
  const coverage = num(record(m.coverage).pct)
  const pipeline = record(m.pipeline)
  const patterns = rows(m.failurePatterns)
  return { summary: `Health score ${Math.round(health)}; coverage ${coverage !== null ? `${Math.round(coverage)}%` : 'unknown'}; last job ${str(pipeline.lastJobStatus) ?? 'none'}${str(pipeline.lastJobCommand) ? ` (${clip(str(pipeline.lastJobCommand)!, 40)})` : ''}.${patterns.length ? ` ${plural(patterns.length, 'recurring failure pattern')}.` : ''}` }
}

const jobsPhaseBreakdown: ReadSummarizer = (_args, data) => {
  const r = record(data)
  const phases = Array.isArray(r.breakdown) ? rows(r.breakdown) : rows(record(r.breakdown).phases)
  if (!Array.isArray(r.breakdown) && !Array.isArray(record(r.breakdown).phases)) return undefined
  const longest = [...phases].sort((a, b) => (num(b.durationMs) ?? num(b.duration_ms) ?? 0) - (num(a.durationMs) ?? num(a.duration_ms) ?? 0))[0]
  return { summary: `Job ${String(r.jobId ?? '?')} ran ${plural(phases.length, 'phase')}${longest ? `; the longest was ${str(longest.phase) ?? str(longest.name) ?? '?'} (${duration(num(longest.durationMs) ?? num(longest.duration_ms))})` : ''}.` }
}

const jobsDefaultSpecModel: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!str(r.provider)) return undefined
  const allowed = Array.isArray(r.allowed) ? r.allowed.length : 0
  return { summary: `New specs on ${r.provider} default to ${str(r.model) ?? 'the provider default'} (${plural(allowed, 'allowed model')}); installed providers: ${Array.isArray(r.providers) ? (r.providers as unknown[]).join(', ') : r.provider}.` }
}

const jobsAudit: ReadSummarizer = (_args, data) => {
  const r = record(data)
  const count = num(r.rows)
  if (count === null) return undefined
  return { summary: `${plural(count, 'agent action')} ${str(r.jobId) ? `for job ${r.jobId}` : 'project-wide'} as ${str(r.format) ?? 'jsonl'}. Reads are only as complete as each provider reports them.` }
}

// ── runs (Core runtime) / background ────────────────────────────────────────

const runsState: ReadSummarizer = (args, data) => {
  const runs = listAt(data, 'runs')
  if (!runs) return undefined
  if (!runs.length) return { summary: 'No runtime runs are recorded for this selection.' }
  const first = runs[0]
  const runId = str(first.runId)
  const pending = first.pendingQuestion ? 'a pending question' : first.pendingApproval ? 'a pending approval' : null
  const next: NextCall[] = runId && (first.status === 'failed' || first.status === 'blocked' || first.status === 'interrupted' || first.canResume === true)
    ? [call('specrails_runs', { action: 'diagnose', jobId: runId, ...scope(args) }, 'Recovery assessment before recommending a resume or relaunch.')]
    : runId && first.active === true ? [call('specrails_watch', { ref: runId, ...scope(args) }, 'Wait for the run to settle.')] : []
  return {
    status: str(first.status) ?? undefined,
    summary: runs.length === 1
      ? `Run ${runId ?? '?'} is ${str(first.status) ?? 'unknown'}${str(first.nextStep) ? ` at ${first.nextStep}` : ''}${pending ? ` with ${pending}` : ''}.${first.canResume === true ? ' It can be resumed.' : ''}`
      : `${plural(runs.length, 'runtime run')}: ${countBy(runs, 'status')}.`,
    ...(runId ? { ids: { jobId: runId, ...scope(args) } } : {}),
    next,
  }
}

const runsDiagnose: ReadSummarizer = (args, data) => {
  const d = record(data)
  const recommendation = str(d.recommendation)
  if (!recommendation) return undefined
  const runId = str(d.runId) ?? str(args.jobId)
  const reviewer = record(d.reviewer)
  const failures = rows(d.recentFailures)
  return {
    status: recommendation,
    summary: `Run ${runId ?? '?'}: recommendation ${recommendation.replace(/_/g, ' ')}.${str(d.reason) ? ` ${clip(str(d.reason)!, 140)}` : ''}${failures.length ? ` ${plural(failures.length, 'recent failure')}.` : ''}${typeof reviewer.approved === 'boolean' ? ` Reviewer ${reviewer.approved ? 'approved' : 'rejected'}.` : ''}`,
    ...(runId ? { ids: { jobId: runId, ...scope(args) } } : {}),
    next: runId ? [call('specrails_runs', { action: 'evidence', jobId: runId, ...scope(args) }, 'Read the saved runtime evidence behind this assessment.')] : [],
  }
}

const runsEvidence: ReadSummarizer = (args, data) => {
  const e = record(data)
  const items = rows(e.items ?? e.entries ?? e.evidence ?? e.sources ?? e.lines)
  const keys = Object.keys(e)
  if (!keys.length) return undefined
  const cursor = str(e.nextCursor) ?? str(e.cursor)
  return {
    summary: `Runtime evidence of run ${str(args.jobId) ?? '?'}${str(args.section) ? ` (${args.section})` : ''}: ${items.length ? plural(items.length, 'entry', 'entries') : `fields ${keys.slice(0, 5).join(', ')}`}.${cursor ? ' More is available with cursor.' : ''}`,
    ...(cursor ? { truncated: true, cursor, next: [call('specrails_runs', { ...args, cursor }, 'Read the next page.')] } : {}),
  }
}

const backgroundList: ReadSummarizer = (args, data) => {
  const r = record(data)
  if (!Array.isArray(r.processes)) return undefined
  const processes = rows(r.processes)
  const live = processes.filter((p) => ['starting', 'running', 'stopping'].includes(str(p.status) ?? ''))
  const first = live[0] ?? processes[0]
  return {
    summary: processes.length ? `${processes.length}${num(r.total) !== null && r.total !== processes.length ? ` of ${r.total}` : ''} background processes, ${live.length} live: ${names(processes, (p) => `${clip(str(p.command) ?? String(p.pid), 36)} (${str(p.status) ?? '?'})`, 3)}.` : 'No background processes for this conversation.',
    ...(r.hasMore === true ? { truncated: true, cursor: (num(r.offset) ?? 0) + processes.length } : {}),
    next: first && num(first.pid) !== null ? [call('specrails_background', { action: 'logs', pid: first.pid, ...(str(first.processId) ? { processId: first.processId } : {}), ...(str(args.chatId) ? { chatId: args.chatId } : {}), ...scope(args) }, 'Read its stdout/stderr.')] : [],
  }
}

const backgroundLogs: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!Array.isArray(r.lines)) return undefined
  const process = record(r.process)
  const urls = record(r.appUrls)
  const links = [...(Array.isArray(urls.local) ? urls.local : []), ...(Array.isArray(urls.network) ? urls.network : [])].filter((u): u is string => typeof u === 'string')
  return {
    status: str(process.status) ?? undefined,
    summary: `Process ${String(process.pid ?? '?')} is ${str(process.status) ?? 'unknown'}${num(process.exitCode) !== null ? ` (exit ${process.exitCode})` : ''}; ${plural(r.lines.length, 'log line')} returned.${links.length ? ` Listening at ${links.slice(0, 2).join(', ')}.` : ''}`,
  }
}

// ── recovery ────────────────────────────────────────────────────────────────

const recoveryInspect: ReadSummarizer = (args, data) => {
  const r = record(data)
  const repos = rows(r.repositories)
  const checks = rows(r.checks ?? r.registeredChecks)
  if (!Array.isArray(r.repositories) && !Array.isArray(r.checks)) return undefined
  const repairs = rows(r.recentRepairs ?? r.repairs ?? r.history)
  return {
    summary: `Run ${str(args.jobId) ?? '?'} worktree: ${plural(repos.length, 'repository', 'repositories')}${repos.length ? ` (${names(repos, (x) => str(x.repositoryId) ?? str(x.id) ?? str(x.name))})` : ''}, ${plural(checks.length, 'registered check')}, ${plural(repairs.length, 'recent repair')}.`,
    next: repos[0] ? [call('specrails_recovery', { action: 'list_files', jobId: args.jobId, repositoryId: repos[0].repositoryId ?? repos[0].id, path: '.', ...scope(args) }, 'Browse the saved worktree.')] : [],
  }
}

const recoveryListFiles = listSummary('entry', 'entries', { many: 'entries', pick: (e) => str(e.path) ?? str(e.name), empty: 'The directory is empty.' })

const recoveryReadFile: ReadSummarizer = (args, data) => {
  const r = record(data)
  const lines = Array.isArray(r.lines) ? r.lines.length : typeof r.content === 'string' ? r.content.split('\n').length : null
  if (lines === null) return undefined
  const hash = str(r.hash) ?? str(r.sha256)
  return { summary: `${str(r.path) ?? str(args.path) ?? 'File'}: ${plural(lines, 'line')}${num(r.startLine) !== null ? ` from line ${r.startLine}` : ''}${num(r.totalLines) !== null ? ` of ${r.totalLines}` : ''}.${hash ? ` Pass expectedHash ${hash.slice(0, 12)}… to patch.` : ''}`, ...(hash ? { ids: { expectedHash: hash } } : {}) }
}

const recoveryDiff: ReadSummarizer = (args, data) => {
  const r = record(data)
  const diff = typeof data === 'string' ? data : str(r.diff) ?? str(r.patch)
  if (diff === null && !('diff' in r)) return undefined
  const changed = (diff ?? '').split('\n').filter((line) => /^[+-](?![+-])/.test(line)).length
  return { summary: diff ? `${str(args.path) ?? 'The file'} differs from the checkpoint by ${plural(changed, 'changed line')}.` : `${str(args.path) ?? 'The file'} is unchanged in the saved worktree.` }
}

const recoveryHistory = listSummary('recovery attempt', 'attempts', { pick: (a) => `${str(a.action) ?? '?'} ${str(a.status) ?? str(a.outcome) ?? ''}`.trim(), empty: 'No repairs or checks have been recorded for this run.' })

// ── chat ────────────────────────────────────────────────────────────────────

const chatList = listSummary('conversation', 'conversations', {
  pick: (c) => str(c.title) ?? str(c.id),
  next: (items, args) => items[0] && str(items[0].id) ? [call('specrails_chat', { action: 'messages', conversationId: items[0].id, ...scope(args) }, 'Read the most recent conversation.')] : [],
  empty: 'No chat conversations in this project.',
})

const chatGet: ReadSummarizer = (args, data) => {
  const c = record(record(data).conversation ?? data)
  const id = str(c.id)
  if (!id) return undefined
  return { summary: `Conversation “${clip(str(c.title) ?? 'Untitled', 60)}” (${str(c.kind) ?? str(c.mode) ?? 'chat'}${str(c.model) ? `, ${c.model}` : ''}).`, ids: { conversationId: id }, next: [call('specrails_chat', { action: 'messages', conversationId: id, ...scope(args) }, 'Read its messages.')] }
}

const chatSpecDraft: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!('ready' in r)) return undefined
  const draft = record(r.draft)
  return { status: r.ready === true ? 'ready' : 'drafting', summary: r.draft ? `Spec draft “${clip(str(draft.title) ?? 'untitled', 60)}” is ${r.ready === true ? 'ready to commit' : 'still being refined'}.` : 'No spec draft has been produced in this conversation yet.' }
}

const chatMessages: ReadSummarizer = (_args, data) => {
  const messages = listAt(data, 'messages')
  if (!messages) return undefined
  const last = messages[messages.length - 1]
  return { summary: messages.length ? `${plural(messages.length, 'message')}; the last is from ${str(last.role) ?? 'unknown'}: “${clip((str(last.content) ?? '').replace(/\s+/g, ' '), 100)}”.` : 'The conversation has no messages yet.' }
}

// ── agents ──────────────────────────────────────────────────────────────────

const agentsList = listSummary('profile', 'profiles', { pick: (p) => `${str(p.name) ?? '?'}${p.isDefault === true || p.default === true ? ' (default)' : ''}`, empty: 'No agent profiles for this provider.' })

const agentsGet: ReadSummarizer = (args, data) => {
  const r = record(data)
  const profile = record(r.profile ?? data)
  const name = str(r.name) ?? str(profile.name) ?? str(args.profileName)
  if (!name || !Object.keys(profile).length) return undefined
  const agents = rows(profile.agents)
  return { summary: `Profile ${name}${str(profile.provider) ? ` (${profile.provider})` : ''}${agents.length ? ` with ${plural(agents.length, 'agent')}: ${names(agents, (a) => str(a.id) ?? str(a.name))}` : ''}.` }
}

const agentsResolve: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!('resolved' in r)) return undefined
  const resolved = record(r.resolved)
  return { summary: r.resolved ? `Jobs resolve to profile ${str(resolved.name) ?? '?'}.` : 'No profile resolves; jobs use the legacy default.' }
}

const agentsAnalytics = listSummary('profile', 'rows', {
  pick: (r) => `${str(r.profileName) ?? '?'} ${num(r.jobs) ?? 0} jobs${num(r.successRate) !== null ? ` ${Math.round((r.successRate as number) * 100)}%` : ''}`,
  detail: (_items, data) => num(data.windowDays) !== null ? `Window: last ${data.windowDays} days.` : null,
  empty: 'No profile usage in this window.',
})

const agentsCoreVersion: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!('version' in r)) return undefined
  return { summary: `specrails-core ${str(r.version) ?? 'not installed'}${str(r.required) ? ` (requires ${r.required})` : ''}; profiles ${r.profileAware === true ? 'supported' : 'not supported'}.` }
}

const agentsCatalogList = listSummary('catalog agent', 'agents', { pick: (a) => str(a.id) ?? str(a.name), empty: 'The agent catalog is empty.' })

const agentsCatalogGet: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!str(r.id) || typeof r.body !== 'string') return undefined
  return { summary: `Agent ${r.id}: ${plural(r.body.split('\n').length, 'line')}${r.runtimeDefined === true ? ', defined by the runtime (read-only)' : ''}${num(r.version) !== null ? `, version ${r.version}` : ''}.` }
}

const agentsVersions = listSummary('version', 'versions', { pick: (v) => num(v.version) !== null ? `v${v.version}` : str(v.created_at) ?? str(v.createdAt), empty: 'No saved versions for this agent.' })

const agentsRefineList = listSummary('refine session', 'sessions', { pick: (s) => `${str(s.refineId) ?? str(s.id) ?? '?'} (${str(s.status) ?? '?'})`, empty: 'No refine sessions for this agent.' })

const agentsRefineGet: ReadSummarizer = (_args, data) => {
  const r = record(data)
  const id = str(r.refineId) ?? str(r.id)
  if (!id || !str(r.status)) return undefined
  return { status: str(r.status) ?? undefined, summary: `Refine session ${id} is ${r.status}${typeof r.draft === 'string' ? '; a draft is ready to apply' : ''}.` }
}

// ── plugins / jira ──────────────────────────────────────────────────────────

const pluginsList = listSummary('plugin', 'plugins', {
  pick: (p) => `${str(p.name) ?? '?'}${p.installed === true ? (p.active === false ? ' (inactive)' : ' (installed)') : ''}`,
  detail: (items) => `${items.filter((p) => p.installed === true).length} installed.`,
  empty: 'No plugins are available.',
})

const pluginsPreview: ReadSummarizer = (args, data) => {
  const r = record(data)
  if (!Object.keys(r).length || Array.isArray(data)) return undefined
  const changes = rows(r.changes ?? r.files ?? r.actions)
  const blockers = rows(r.blockers ?? r.missingPrerequisites ?? r.prerequisites).filter((p) => p.ok !== true && p.installed !== true)
  return { summary: `Installing ${str(args.name) ?? 'the plugin'} would make ${plural(changes.length, 'change')}${blockers.length ? `; ${plural(blockers.length, 'prerequisite')} missing` : ''}. Installing is a write action.` }
}

const pluginsHealth: ReadSummarizer = (args, data) => {
  const r = record(data)
  const ok = typeof r.ok === 'boolean' ? r.ok : typeof r.healthy === 'boolean' ? r.healthy : null
  if (ok === null) return undefined
  const issues = rows(r.issues ?? r.checks).filter((c) => c.ok === false)
  return { status: ok ? 'healthy' : 'unhealthy', summary: `${str(args.name) ?? 'The plugin'} is ${ok ? 'healthy' : 'unhealthy'}${issues.length ? ` (${plural(issues.length, 'issue')}: ${names(issues, (i) => str(i.message) ?? str(i.name))})` : ''}.` }
}

const jiraConnection: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (typeof r.connected !== 'boolean') return undefined
  if (!r.connected) return { status: 'disconnected', summary: 'Jira is not connected for this project.' }
  const conn = record(r.connection)
  const outbox = record(r.outbox)
  const failed = num(outbox.failed) ?? 0
  return { status: 'connected', summary: `Connected to Jira ${str(conn.baseUrl) ?? str(conn.siteUrl) ?? ''} project ${str(conn.projectKey) ?? '?'}.${failed ? ` ${plural(failed, 'outbox operation')} failed.` : ''}`.replace('Jira  project', 'Jira project') }
}

const jiraTest: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (typeof r.ok !== 'boolean') return undefined
  return { status: r.ok ? 'ok' : 'failed', summary: r.ok ? `Jira credentials work${str(r.user) ?? str(record(r.user).displayName) ? ` as ${str(r.user) ?? str(record(r.user).displayName)}` : ''}.` : `Jira rejected the credentials: ${clip(str(r.error) ?? str(r.message) ?? 'no detail', 160)}.` }
}

const jiraProjects = listSummary('Jira project', 'projects', { pick: (p) => str(p.key) ?? str(p.name) })
const jiraStatuses = listSummary('Jira status', 'statuses', { many: 'Jira statuses', pick: (s) => str(s.name) ?? str(s.id) })

const jiraOutbox: ReadSummarizer = (args, data) => {
  const r = record(data)
  if (!Array.isArray(r.ops)) return undefined
  const ops = rows(r.ops)
  const failed = ops.find((op) => op.status === 'failed')
  return {
    summary: `${plural(ops.length, 'outbox operation')}${ops.length ? `: ${countBy(ops, 'status')}` : ''}.`,
    ...(failed && failed.id !== undefined ? { next: [call('specrails_jira', { action: 'outbox_retry', opId: failed.id, ...scope(args) }, 'Retry the failed operation (write).')] } : {}),
  }
}

const jiraSpecDetails: ReadSummarizer = (_args, data) => {
  const r = record(data)
  const key = str(r.key) ?? str(r.issueKey)
  if (!key) return undefined
  return { summary: `Jira issue ${key}${str(r.status) ? ` is ${r.status}` : ''}${str(r.summary) ? `: ${clip(str(r.summary)!, 80)}` : ''}.` }
}

const jiraLinks = listSummary('Jira link', 'links', { pick: (l) => `#${String(l.localId ?? l.ticketId ?? '?')}→${str(l.issueKey) ?? str(l.key) ?? '?'}`, empty: 'No specs are linked to Jira issues.' })

// ── loops ───────────────────────────────────────────────────────────────────

const loopsList = listSummary('loop', 'loops', {
  pick: (l) => `${str(l.name) ?? str(l.id)}${l.published === true || l.status === 'published' ? '' : l.published === false ? ' (draft)' : ''}`,
  next: (items) => items[0] && str(items[0].id) ? [call('specrails_loops', { action: 'get', loopId: items[0].id }, 'Read the first loop graph.')] : [],
  empty: 'No loops are defined.',
})

const loopsGet: ReadSummarizer = (_args, data) => {
  const loop = record(record(data).loop)
  if (!str(loop.id)) return undefined
  const graph = record(loop.graph)
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : null
  return { summary: `Loop ${str(loop.name) ?? loop.id} (${str(loop.status) ?? (loop.published === true ? 'published' : 'draft')})${nodes !== null ? ` with ${plural(nodes, 'step')}` : ''}.`, ids: { loopId: loop.id } }
}

const loopsTemplates = listSummary('loop template', 'templates', { pick: (t) => str(t.name) ?? str(t.id) })
const loopsFactory = listSummary('factory loop', 'factoryLoops', { pick: (f) => str(f.name) ?? str(f.id) })
const loopsCommands: ReadSummarizer = (args, data) => listSummary('command', 'commands', { pick: (c) => str(c.name) })(args, data) ?? listSummary('workflow', 'workflows', { pick: (w) => str(w.name) ?? str(w.id) })(args, data)
const loopsConstants = listSummary('loop constant', 'constants', { pick: (c) => str(c.name) ?? str(c.key) ?? str(c.id), empty: 'No loop constants are defined.' })

const loopsPreview: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!Object.keys(r).length) return undefined
  const errors = rows(r.errors ?? r.issues)
  const steps = rows(r.steps ?? r.nodes ?? record(r.graph).nodes)
  if (!steps.length && !Array.isArray(r.errors) && typeof r.valid !== 'boolean') return undefined
  const valid = typeof r.valid === 'boolean' ? r.valid : errors.length === 0
  return { status: valid ? 'valid' : 'invalid', summary: `The loop preview is ${valid ? 'valid' : 'invalid'}${steps.length ? ` with ${plural(steps.length, 'step')}` : ''}${errors.length ? `; ${plural(errors.length, 'issue')}: ${names(errors, (e) => str(e.message) ?? str(e.code))}` : ''}.` }
}

const loopsRunGet: ReadSummarizer = (args, data) => {
  const run = record(record(data).loopRun)
  const id = str(run.id)
  if (!id) return undefined
  const status = str(run.status) ?? 'unknown'
  const cost = num(run.total_cost_usd)
  const diagnosis = record(run.failureDiagnosis)
  const reason = str(diagnosis.detail) ?? (str(diagnosis.kind) && diagnosis.kind !== 'unknown' ? String(diagnosis.kind).replace(/_/g, ' ') : null)
  return {
    status,
    summary: `Loop run ${id} (${str(run.loop_name) ?? str(run.loop_id) ?? 'loop'}) is ${status}${num(run.iteration_count) !== null ? ` after ${plural(run.iteration_count as number, 'iteration')}` : ''}.${reason && status === 'failed' ? ` Reason: ${clip(reason, 120)}.` : ''}${cost !== null ? ` Cost ${usd(cost)}.` : ''}`,
    ids: { loopRunId: id, ...scope(args) },
    ...(status === 'running' ? { next: [call('specrails_watch', { ref: id, kind: 'loop_run', ...scope(args) }, 'Wait for the run to settle.')] } : {}),
  }
}

// ── code ────────────────────────────────────────────────────────────────────

const codeTree: ReadSummarizer = (args, data) => {
  const r = record(data)
  if (!Array.isArray(r.entries)) return undefined
  const entries = rows(r.entries)
  const files = entries.filter((e) => e.kind === 'file').length
  return {
    summary: `${plural(entries.length, 'tree entry', 'tree entries')} (${plural(files, 'file')})${str(r.nextCursor) ? '; more with nextCursor' : ''}.`,
    ...paging(r),
    ...(str(r.nextCursor) ? { next: [call('specrails_code', { ...args, cursor: r.nextCursor }, 'Fetch the next page of the tree.')] } : {}),
  }
}

const codeFind: ReadSummarizer = (args, data) => {
  const r = record(data)
  if (!Array.isArray(r.matches)) return undefined
  const matches = rows(r.matches)
  const first = matches[0]
  return {
    summary: matches.length ? `${plural(matches.length, 'file')} match “${clip(str(args.query) ?? str(args.path) ?? '', 40)}”: ${names(matches, (m) => str(m.path))}.` : `No file matches “${clip(str(args.query) ?? str(args.path) ?? '', 40)}”${r.truncated === true ? ' in the partial scan' : ''}.`,
    ...(r.truncated === true ? { truncated: true } : {}),
    ...(first && str(first.path) ? { next: [call('specrails_code', { action: 'read_file', path: first.path, ...(str(first.repositoryId) ? { repositoryId: first.repositoryId } : {}), ...scope(args) }, 'Read the best match.')] } : {}),
  }
}

const codeSearch: ReadSummarizer = (args, data) => {
  const hits = listAt(data, 'results') ?? listAt(data, 'matches') ?? listAt(data, 'hits')
  if (!hits) return undefined
  const files = new Set(hits.map((h) => str(h.path) ?? str(h.file)).filter(Boolean))
  return {
    summary: hits.length ? `${plural(hits.length, 'hit')} for “${clip(str(args.query) ?? '', 40)}” in ${plural(files.size, 'file')}: ${[...files].slice(0, 4).join(', ')}.` : `No code matches “${clip(str(args.query) ?? '', 40)}”.`,
    ...paging(record(data)),
  }
}

const codeReadFile: ReadSummarizer = (args, data) => {
  const r = record(data)
  const content = typeof r.content === 'string' ? r.content : null
  if (content === null) return undefined
  const lines = content.split('\n').length
  return { summary: `${str(r.path) ?? str(args.path) ?? 'File'}: ${plural(lines, 'line')}${r.truncated === true ? ' (truncated)' : ''}${str(r.language) ? `, ${r.language}` : ''}.`, ...(r.truncated === true ? { truncated: true } : {}) }
}

const codeSummary: ReadSummarizer = (args, data) => {
  const r = record(data)
  const text = str(r.summary) ?? str(record(r.summary).text) ?? str(r.text)
  if (!text && !('summary' in r)) return undefined
  return { summary: text ? `${str(r.path) ?? str(args.path) ?? 'File'}: ${clip(text.replace(/\s+/g, ' '), 180)}` : `${str(args.path) ?? 'This file'} has no AI summary yet; regenerating one is an ai-spawn action.` }
}

const codeProvenance: ReadSummarizer = (args, data) => {
  const r = record(data)
  const items = rows(r.rows ?? r.provenance ?? r.entries ?? r.files)
  if (!Array.isArray(r.rows ?? r.provenance ?? r.entries ?? r.files)) return undefined
  return { summary: items.length ? `${plural(items.length, 'provenance record')} for ${str(args.path) ?? 'this selection'}: ${names(items, (i) => str(i.jobId) ?? str(i.job_id) ?? str(i.path))}.` : `No AI provenance is recorded for ${str(args.path) ?? 'this selection'}.` }
}

const codeDiff: ReadSummarizer = (args, data) => {
  const r = record(data)
  const diff = typeof data === 'string' ? data : str(r.diff) ?? str(r.patch)
  if (diff === null && !('diff' in r) && !Array.isArray(r.files)) return undefined
  const files = rows(r.files)
  const changed = (diff ?? '').split('\n').filter((line) => /^[+-](?![+-])/.test(line)).length
  return { summary: files.length ? `${plural(files.length, 'changed file')}: ${names(files, (f) => str(f.path))}.` : diff ? `${str(args.path) ?? 'The selection'} has ${plural(changed, 'changed line')}.` : `No changes for ${str(args.path) ?? 'the selection'}.` }
}

// ── setup / analytics ───────────────────────────────────────────────────────

const setupPrerequisites: ReadSummarizer = (_args, data) => {
  const checks = listAt(data, 'prerequisites') ?? listAt(data, 'checks') ?? listAt(data, 'items')
  if (!checks) return undefined
  const missing = checks.filter((c) => c.ok === false || c.installed === false || c.status === 'missing')
  return { status: missing.length ? 'missing' : 'ok', summary: missing.length ? `${plural(missing.length, 'prerequisite')} missing: ${names(missing, (c) => str(c.name) ?? str(c.id))}.` : `All ${plural(checks.length, 'prerequisite')} are satisfied.` }
}

const setupProviders = listSummary('provider', 'providers', {
  pick: (p) => `${str(p.id) ?? str(p.name) ?? '?'}${p.installed === false || p.available === false ? ' (missing)' : ''}`,
})

const setupCheckpoints = listSummary('setup checkpoint', 'checkpoints', {
  pick: (c) => `${str(c.name) ?? str(c.id) ?? '?'} ${str(c.status) ?? ''}`.trim(),
  detail: (items) => `${items.filter((c) => c.status === 'done' || c.status === 'completed' || c.done === true).length} done.`,
})

const setupIntegrationContract: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!Object.keys(r).length || Array.isArray(data)) return undefined
  const missing = rows(r.missing ?? r.gaps)
  return { summary: `Integration contract${str(r.version) ? ` v${r.version}` : ''}${typeof r.ok === 'boolean' ? (r.ok ? ' is satisfied' : ' is not satisfied') : ' read'}${missing.length ? ` (${plural(missing.length, 'gap')})` : ''}.` }
}

const analyticsInvocations: ReadSummarizer = (args, data) => {
  const r = record(data)
  if (!Array.isArray(r.rows)) return undefined
  const list = rows(r.rows)
  const cost = list.reduce((sum, row) => sum + (num(row.total_cost_usd) ?? 0), 0)
  const available = num(r.totalAvailable)
  return {
    summary: `${list.length}${available !== null && available !== list.length ? ` of ${available}` : ''} invocations (${countBy(list, 'surface') || 'none'}) costing ${usd(cost)} on this page.`,
    ...(r.truncated === true ? { truncated: true, cursor: (num(args.offset) ?? 0) + list.length } : {}),
  }
}

const analyticsTicketSummary: ReadSummarizer = (args, data) => specsSpending(args, data)

const analyticsExport: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!('data' in r) || !str(r.mode)) return undefined
  return { summary: `Analytics export (${r.mode}, ${str(r.format) ?? 'json'}) returned inline; the spending action is cheaper for routine questions.` }
}

const analyticsBudget: ReadSummarizer = (args, data) => {
  const b = record(data)
  if (!('dailyBudgetUsd' in b) && !('costToday' in b)) return undefined
  const caps = [['daily', b.dailyBudgetUsd], ['weekly', b.weeklyBudgetUsd], ['monthly', b.monthlyBudgetUsd], ['per-run', b.runCapUsd]]
    .filter(([, value]) => num(value) !== null).map(([name, value]) => `${name} ${usd(value as number)}`)
  const pct = num(b.budgetUtilizationPct)
  return {
    summary: `Spent ${usd(num(b.costToday) ?? 0)} today${pct !== null ? ` (${Math.round(pct)}% of the daily cap)` : ''}; caps: ${caps.length ? caps.join(', ') : 'none'}.${(num(b.unpricedRuns) ?? 0) > 0 ? ` ${b.unpricedRuns} unpriced runs today.` : ''}`,
    next: [call('specrails_spend', { ...scope(args) }, 'Spend by category and the cap state across the app.')],
  }
}

const analyticsDecisionTimes: ReadSummarizer = (_args, data) => {
  const r = record(data)
  const project = record(r.project)
  if (num(project.deliveries) === null) return undefined
  const decision = record(project.toDecision)
  const merge = record(project.toMerge)
  return { summary: `${plural(project.deliveries as number, 'delivery', 'deliveries')} in ${str(r.period) ?? 'the window'}: median time to decision ${duration(num(decision.medianMs))} (p90 ${duration(num(decision.p90Ms))}), to merge ${duration(num(merge.medianMs))}; ${num(decision.pending) ?? 0} awaiting a decision.` }
}

const analyticsLoopEconomics: ReadSummarizer = (_args, data) => {
  const r = record(data)
  const project = record(r.project)
  if (typeof project.hasData !== 'boolean') return undefined
  if (!project.hasData) return { summary: `No loop deliveries in ${str(r.period) ?? 'the window'}.` }
  const rate = num(project.discardRate)
  return { summary: `${num(project.delivered) ?? 0} delivered, ${num(project.merged) ?? 0} merged, ${num(project.discarded) ?? 0} discarded${rate !== null ? ` (${Math.round(rate * 100)}% discard rate)` : ''} across ${plural(rows(r.byLoop).length, 'loop')} in ${str(r.period) ?? 'the window'}.` }
}

// ── git / env / support ─────────────────────────────────────────────────────

const gitInfo: ReadSummarizer = (_args, data) => {
  const g = record(data)
  if (typeof g.git !== 'boolean') return undefined
  if (!g.git) return { summary: 'This repository is not a Git repository.' }
  return { summary: `On ${g.detached === true ? 'a detached HEAD' : `branch ${str(g.branch) ?? '?'}`}, ${g.dirty === true ? 'with uncommitted changes' : 'clean'}${rows(g.worktrees).length ? `; ${plural(rows(g.worktrees).length, 'worktree')}` : ''}.` }
}

const gitPullRequest: ReadSummarizer = (_args, data) => {
  const pr = record(record(data).pullRequest ?? record(data).pr ?? data)
  const number = num(pr.number)
  if (number === null) return undefined
  return { status: str(pr.state) ?? undefined, summary: `PR #${number} “${clip(str(pr.title) ?? '', 60)}” is ${str(pr.state) ?? 'unknown'}${str(pr.mergeable) ? `, mergeable ${pr.mergeable}` : ''}.` }
}

/** The git diagnostic commands share one payload: `{ action, command, ok, exitCode, stdout, stderr }`. */
const gitDiagnostic = (what: string): ReadSummarizer => (_args, data) => {
  const r = record(data)
  if (typeof r.ok !== 'boolean') return undefined
  const out = (str(r.stdout) ?? '').split('\n').filter(Boolean)
  if (!r.ok) return { status: 'nonzero_exit', summary: `${str(r.command) ?? what} exited ${String(r.exitCode ?? 'non-zero')}: ${clip(str(r.stderr) ?? 'no output', 160)}. This is often meaningful state, not a tool failure.` }
  return { summary: out.length ? `${what}: ${plural(out.length, 'line')}; first: ${clip(out[0], 120)}` : `${what}: no output.` }
}

const envGet: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!Array.isArray(r.names)) return undefined
  const statuses = rows(r.statuses)
  const missing = statuses.filter((s) => s.status !== 'present' && s.status !== 'ok' && s.status !== 'found')
  return { summary: `${plural(r.names.length, 'variable name')} pass through to agents${r.names.length ? ` (${(r.names as unknown[]).slice(0, 5).join(', ')})` : ''}; mode ${str(r.agentEnvMode) ?? 'default'}.${statuses.length && missing.length ? ` ${missing.length} not found in the login shell.` : ''}` }
}

const envStatus: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!Array.isArray(r.statuses)) return undefined
  const statuses = rows(r.statuses)
  return { status: r.checking === true ? 'checking' : undefined, summary: statuses.length ? `${r.checking === true ? 'Still checking; ' : ''}${plural(statuses.length, 'variable')}: ${countBy(statuses, 'status')}.` : `${r.checking === true ? 'Still checking; ' : ''}no pass-through variables are configured.` }
}

const envScan: ReadSummarizer = (_args, data) => {
  const found = listAt(data, 'discovered') ?? listAt(data, 'candidates') ?? listAt(data, 'names')
  const raw = Array.isArray(record(data).discovered) ? record(data).discovered : Array.isArray(record(data).names) ? record(data).names : null
  if (!found || !Array.isArray(raw)) return undefined
  const list = (raw as unknown[]).map((value) => typeof value === 'string' ? value : str(record(value).name)).filter(Boolean) as string[]
  return { summary: list.length ? `Found ${plural(list.length, 'variable name')} the project uses: ${list.slice(0, 6).join(', ')}${list.length > 6 ? '…' : ''}. Adding them is a write action.` : 'The scan found no environment variable names to pass through.' }
}

const supportTriage: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (r.mode !== 'support-triage') return undefined
  const steps = Array.isArray(r.recommendedNextSteps) ? r.recommendedNextSteps.length : 0
  const diagnostics = record(r.localDiagnostics)
  const failing = Object.entries(diagnostics).filter(([, value]) => record(value).ok === false).map(([key]) => key)
  return { summary: `Support triage for topic ${str(r.topic) ?? 'general'}: ${plural(steps, 'recommended step')}${failing.length ? `; diagnostics failed for ${failing.join(', ')}` : ''}. Treat it as support, not backlog.` }
}

const coreUpdateStatus: ReadSummarizer = (_args, data) => {
  const r = record(data)
  const current = str(r.currentVersion) ?? str(r.installedVersion) ?? str(r.version)
  if (!current && !('updateAvailable' in r) && !str(r.state)) return undefined
  const latest = str(r.latestVersion) ?? str(r.availableVersion)
  return { status: str(r.state) ?? (r.updateAvailable === true ? 'update_available' : 'current'), summary: `specrails-core ${current ?? 'unknown'}${r.updateAvailable === true ? `; ${latest ?? 'a newer version'} is available (applying it is ai-spawn)` : latest ? `; latest ${latest}` : ''}.` }
}

const apiMeta: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!str(r.version) && !str(r.apiVersion)) return undefined
  return { summary: `Specrails API ${str(r.apiVersion) ?? str(r.version)}${str(r.version) && str(r.apiVersion) ? `, app ${r.version}` : ''}.` }
}

// ── tools without actions ───────────────────────────────────────────────────

const contextSummary: ReadSummarizer = (_args, data) => {
  const r = record(data)
  const sections = record(r.sections)
  if (!str(r.projectId) || !Object.keys(sections).length) return undefined
  const unavailable = Object.entries(sections).filter(([, value]) => record(value).status === 'unavailable').map(([key]) => key)
  const backlog = record(record(sections.backlog).data)
  const counts = Object.entries(record(backlog.statusCounts)).map(([status, count]) => `${status} ${String(count)}`).join(', ')
  const project = record(record(sections.overview).data)
  return {
    summary: `${str(project.name) ?? r.projectId}: ${Object.keys(sections).join(', ')} refreshed${counts ? `; backlog ${counts}` : ''}.${unavailable.length ? ` Unavailable: ${unavailable.join(', ')} (unknown, not empty).` : ''}`,
    ids: { projectId: r.projectId },
    ...(unavailable.length ? { partial: true } : {}),
    ...(num(backlog.nextOffset) ?? str(backlog.nextCursor) ? { truncated: true, cursor: num(backlog.nextOffset) ?? str(backlog.nextCursor) } : {}),
    next: [call('specrails_board', { projectId: r.projectId }, 'The board: columns, rails and what is running.')],
  }
}

const watchSummary: ReadSummarizer = (args, data) => {
  const r = record(data)
  if (typeof r.settled !== 'boolean') return undefined
  const terminal = record(r.terminalEvent)
  const outcome = str(terminal.status) ?? str(terminal.outcome) ?? str(terminal.type)
  if (r.settled) return { status: 'settled', summary: `${String(r.ref ?? 'The operation')} settled${outcome ? ` with ${outcome}` : ''} after ${plural(num(r.eventCount) ?? 0, 'event')}. Settled is not necessarily success.` }
  return {
    status: str(r.reason) ?? 'pending',
    summary: r.reason === 'user_update'
      ? 'Waiting ended because the person sent a new message; the operation is still running.'
      : `${String(r.ref ?? 'The operation')} has not settled yet (${str(r.reason) ?? 'timeout'}); it may still be running.`,
    next: r.reason === 'timeout' ? [call('specrails_watch', { ...args }, 'Keep waiting.')] : [],
  }
}

const describeSummary: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!str(r.name)) return undefined
  const actions = rows(r.actions)
  const validation = record(r.validation)
  return { summary: `${r.name}: ${actions.length ? `${plural(actions.length, 'action')}, ` : ''}${plural(rows(r.inputFields).length, 'input field')}.${'valid' in validation ? (validation.valid === true ? ` The arguments are valid (tier ${str(validation.tier) ?? '?'}).` : ` The arguments are invalid (${plural(rows(validation.issues).length, 'issue')}).`) : ''}` }
}

const searchSummary: ReadSummarizer = (_args, data) => {
  if (!Array.isArray(data)) return record(data).hint ? { summary: 'No tool matched; read specrails_guide for an overview.' } : undefined
  const hits = rows(data)
  const top = hits[0]
  return {
    summary: hits.length ? `Best matches: ${names(hits, (h) => str(h.name), 3)}.` : 'No tool matched.',
    ...(top && str(top.name) ? { next: [call('specrails_describe', { name: top.name }, 'Exact arguments and permissions of the best match.')] } : {}),
  }
}

const selectProjectSummary: ReadSummarizer = (_args, data) => {
  const r = record(data)
  if (!('active' in r)) return undefined
  if (r.active === null) return { summary: 'No active project now; per-project tools need projectId.' }
  return { summary: `Active project is ${str(r.name) ?? r.active}${r.available === false ? ' (database unavailable)' : ''}; per-project tools may omit projectId.`, ids: { projectId: r.active } }
}

export const READ_SUMMARIZERS: Record<string, ReadSummarizer> = {
  'specrails_projects:resolve': projectsResolve,
  'specrails_projects:repositories': projectsRepositories,
  'specrails_settings:get': settingsGet,
  'specrails_settings:runtime_providers.list': runtimeProvidersList,
  'specrails_settings:runtime_providers.test': runtimeProvidersTest,
  'specrails_mission:subagent_wait': subagentWait,
  'specrails_mission:subagent_list': subagentList,
  'specrails_specs:spending_summary': specsSpending,
  'specrails_specs:files_touched': specsFilesTouched,
  'specrails_specs:list_attachments': specsAttachments,
  'specrails_specs:get_attachment': specsGetAttachment,
  'specrails_specs:list_addenda': specsAddenda,
  'specrails_rails:pr_candidates': railsPrCandidates,
  'specrails_rails:review_packet': railsReviewPacket,
  'specrails_jobs:list': jobsList,
  'specrails_jobs:queue': jobsQueue,
  'specrails_jobs:compare': jobsCompare,
  'specrails_jobs:export': jobsExport,
  'specrails_jobs:diagnostic': jobsDiagnostic,
  'specrails_jobs:run_state': jobsRunState,
  'specrails_jobs:pipeline': jobsPipeline,
  'specrails_jobs:activity': jobsActivity,
  'specrails_jobs:stats': jobsStats,
  'specrails_jobs:metrics': jobsMetrics,
  'specrails_jobs:phase_breakdown': jobsPhaseBreakdown,
  'specrails_jobs:default_spec_model': jobsDefaultSpecModel,
  'specrails_jobs:audit': jobsAudit,
  'specrails_runs:state': runsState,
  'specrails_runs:diagnose': runsDiagnose,
  'specrails_runs:evidence': runsEvidence,
  'specrails_background:list': backgroundList,
  'specrails_background:logs': backgroundLogs,
  'specrails_recovery:inspect': recoveryInspect,
  'specrails_recovery:list_files': recoveryListFiles,
  'specrails_recovery:read_file': recoveryReadFile,
  'specrails_recovery:diff': recoveryDiff,
  'specrails_recovery:history': recoveryHistory,
  'specrails_chat:list_conversations': chatList,
  'specrails_chat:get': chatGet,
  'specrails_chat:spec_draft': chatSpecDraft,
  'specrails_chat:messages': chatMessages,
  'specrails_agents:list': agentsList,
  'specrails_agents:get': agentsGet,
  'specrails_agents:resolve': agentsResolve,
  'specrails_agents:analytics': agentsAnalytics,
  'specrails_agents:core_version': agentsCoreVersion,
  'specrails_agents:catalog_list': agentsCatalogList,
  'specrails_agents:catalog_get': agentsCatalogGet,
  'specrails_agents:versions': agentsVersions,
  'specrails_agents:refine_list': agentsRefineList,
  'specrails_agents:refine_get': agentsRefineGet,
  'specrails_plugins:list': pluginsList,
  'specrails_plugins:preview': pluginsPreview,
  'specrails_plugins:health': pluginsHealth,
  'specrails_jira:connection': jiraConnection,
  'specrails_jira:test': jiraTest,
  'specrails_jira:discover_projects': jiraProjects,
  'specrails_jira:discover_statuses': jiraStatuses,
  'specrails_jira:statuses': jiraStatuses,
  'specrails_jira:outbox': jiraOutbox,
  'specrails_jira:spec_details': jiraSpecDetails,
  'specrails_jira:links': jiraLinks,
  'specrails_loops:list': loopsList,
  'specrails_loops:get': loopsGet,
  'specrails_loops:templates': loopsTemplates,
  'specrails_loops:factory': loopsFactory,
  'specrails_loops:commands': loopsCommands,
  'specrails_loops:constants_list': loopsConstants,
  'specrails_loops:preview': loopsPreview,
  'specrails_loops:run_get': loopsRunGet,
  'specrails_code:tree': codeTree,
  'specrails_code:find': codeFind,
  'specrails_code:search': codeSearch,
  'specrails_code:read_file': codeReadFile,
  'specrails_code:summary': codeSummary,
  'specrails_code:provenance': codeProvenance,
  'specrails_code:diff': codeDiff,
  'specrails_setup:prerequisites': setupPrerequisites,
  'specrails_setup:available_providers': setupProviders,
  'specrails_setup:checkpoints': setupCheckpoints,
  'specrails_setup:integration_contract': setupIntegrationContract,
  'specrails_analytics:invocations': analyticsInvocations,
  'specrails_analytics:ticket_summary': analyticsTicketSummary,
  'specrails_analytics:export': analyticsExport,
  'specrails_analytics:budget_get': analyticsBudget,
  'specrails_analytics:decision_times': analyticsDecisionTimes,
  'specrails_analytics:loop_economics': analyticsLoopEconomics,
  'specrails_git:info': gitInfo,
  'specrails_git:pull_request': gitPullRequest,
  'specrails_git:remote': gitDiagnostic('git remote'),
  'specrails_git:status': gitDiagnostic('git status'),
  'specrails_git:log': gitDiagnostic('git log'),
  'specrails_git:diff': gitDiagnostic('git diff'),
  'specrails_git:branch': gitDiagnostic('git branch'),
  'specrails_git:gh_repo': gitDiagnostic('gh repo view'),
  'specrails_git:gh_auth': gitDiagnostic('gh auth status'),
  'specrails_git:gh_pr_list': gitDiagnostic('gh pr list'),
  'specrails_git:gh_pr_view': gitDiagnostic('gh pr view'),
  'specrails_env:get': envGet,
  'specrails_env:status': envStatus,
  'specrails_env:recheck': envStatus,
  'specrails_env:scan': envScan,
  'specrails_support:triage': supportTriage,
  'specrails_support:core_update_status': coreUpdateStatus,
  'specrails_support:core_update_check': coreUpdateStatus,
  'specrails_support:api_meta': apiMeta,
  'specrails_context:': contextSummary,
  'specrails_watch:': watchSummary,
  'specrails_describe:': describeSummary,
  'specrails_search:': searchSummary,
  'specrails_select_project:': selectProjectSummary,
}
