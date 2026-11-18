import type { EnvelopeMeta, NextCall } from './envelope'
import { READ_SUMMARIZERS } from './summaries-catalog'

/**
 * Hand-written envelope summaries and follow-up calls for the most used
 * actions. Each summarizer reads the tool's existing payload (never mutates
 * it) and returns only envelope metadata. Pure and defensive: a payload of an
 * unexpected shape yields `undefined` and the generic summary applies.
 */

type Summarizer = (args: Record<string, unknown>, data: unknown) => EnvelopeMeta | undefined

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const rows = (value: unknown): Array<Record<string, unknown>> => Array.isArray(value) ? value.map(record) : []
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const plural = (count: number, noun: string, many = `${noun}s`) => `${count} ${count === 1 ? noun : many}`
export const usd = (value: number) => `$${value < 10 ? value.toFixed(2) : value.toFixed(0)}`

function listNames(names: string[], max = 4): string {
  if (!names.length) return ''
  const shown = names.slice(0, max).join(', ')
  return names.length > max ? `${shown} (+${names.length - max} more)` : shown
}

function countBy(items: Array<Record<string, unknown>>, key: string): string {
  const counts = new Map<string, number>()
  for (const item of items) {
    const value = str(item[key]) ?? 'unknown'
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts].map(([value, count]) => `${value} ${count}`).join(', ')
}

const projectsList: Summarizer = (_args, data) => {
  if (!Array.isArray(data)) return undefined
  const projects = rows(data)
  const unavailable = projects.filter((project) => project.available === false).length
  const first = str(projects[0]?.id)
  return {
    summary: projects.length
      ? `${plural(projects.length, 'registered project')}: ${listNames(projects.map((project) => str(project.name) ?? String(project.id)))}.${unavailable ? ` ${unavailable} unavailable right now.` : ''}`
      : 'No projects are registered yet. Add one in the app or with specrails_setup(add_project).',
    next: [
      { tool: 'specrails_status', args: {}, why: 'See what is running, what needs the person and today’s spend across all projects.' },
      ...(first ? [{ tool: 'specrails_context', args: { projectId: first, sections: ['overview', 'backlog'] }, why: 'Brief yourself on one project before acting.' }] : []),
    ],
  }
}

const projectsGet: Summarizer = (_args, data) => {
  const project = record(data)
  const id = str(project.id)
  if (!id) return undefined
  const providers = Array.isArray(project.providers) ? (project.providers as unknown[]).filter((p): p is string => typeof p === 'string') : []
  const repositories = Array.isArray(project.repositories) ? project.repositories.length : 0
  return {
    summary: `Project ${str(project.name) ?? id} (${id}) at ${str(project.path) ?? 'an unknown path'}; providers ${providers.length ? providers.join(', ') : str(project.provider) ?? 'none'}; ${plural(repositories, 'repository', 'repositories')}.${project.available === false ? ' Its database is unavailable right now.' : ''}`,
    ids: { projectId: id },
    next: [
      { tool: 'specrails_context', args: { projectId: id, sections: ['overview', 'backlog', 'runs'] }, why: 'Live backlog, rails and runs of this project.' },
      { tool: 'specrails_specs', args: { action: 'list', projectId: id }, why: 'Browse the backlog.' },
    ],
  }
}

const specsList: Summarizer = (args, data) => {
  const result = record(data)
  if (!Array.isArray(result.tickets)) return undefined
  const tickets = rows(result.tickets)
  const total = typeof result.total === 'number' ? result.total : tickets.length
  const matched = typeof result.matched === 'number' ? result.matched : tickets.length
  const nextOffset = typeof result.nextOffset === 'number' ? result.nextOffset : null
  const nextCursor = str(result.nextCursor)
  const projectId = str(args.projectId)
  const scope = projectId ? { projectId } : {}
  const next: NextCall[] = []
  if (tickets[0]?.id !== undefined) next.push({ tool: 'specrails_specs', args: { action: 'get', id: tickets[0].id, ...scope }, why: 'Read the full description and acceptance criteria.' })
  if (nextCursor || nextOffset !== null) {
    const { offset: _offset, ...rest } = args
    void _offset
    next.push({ tool: 'specrails_specs', args: nextCursor ? { ...rest, cursor: nextCursor } : { ...args, offset: nextOffset }, why: 'Fetch the next page.' })
  }
  const query = args.action === 'search' && str(args.q) ? ` for “${str(args.q)}”` : ''
  return {
    summary: tickets.length
      ? `Showing ${tickets.length} of ${matched} matching specs${query} (${total} in the backlog): ${countBy(tickets, 'status')}.`
      : `No specs match${query || (matched !== total ? '' : ' this filter')} (${total} in the backlog).`,
    truncated: nextCursor !== null || nextOffset !== null,
    cursor: nextCursor ?? nextOffset,
    next,
  }
}

const specsGet: Summarizer = (args, data) => {
  const ticket = record(record(data).ticket)
  if (ticket.id === undefined) return undefined
  const projectId = str(args.projectId)
  const priority = str(ticket.priority)
  return {
    summary: `Spec #${String(ticket.id)} “${str(ticket.title) ?? 'untitled'}” is ${str(ticket.status) ?? 'in an unknown status'}${priority ? ` (${priority} priority)` : ''}.${ticket.needs_review === true || ticket.needsReview === true ? ' It is flagged needs_review.' : ''}`,
    ids: { specId: ticket.id, ...(projectId ? { projectId } : {}) },
    status: str(ticket.status) ?? undefined,
    next: [{ tool: 'specrails_rails', args: { action: 'list', ...(projectId ? { projectId } : {}) }, why: 'See which rail is free to implement it, or which one carries it now.' }],
  }
}

const railsList: Summarizer = (args, data) => {
  const result = record(data)
  if (!Array.isArray(result.rails)) return undefined
  const rails = rows(result.rails)
  const activeJobs = Object.values(record(result.activeJobs)).map(record)
  const activeRuns = Object.values(record(result.activeLoopRuns)).map(record)
  const deliveries = Object.values(record(result.prDeliveries)).map(record)
  const reviewable = deliveries.filter((delivery) => delivery.decision === 'on_review')
  const projectId = str(args.projectId)
  const scope = projectId ? { projectId } : {}
  const next: NextCall[] = []
  for (const delivery of reviewable.slice(0, 2)) {
    if (str(delivery.id)) next.push({ tool: 'specrails_rails', args: { action: 'review_packet', prDeliveryId: delivery.id, ...scope }, why: 'Read the verification evidence before deciding on this delivery.' })
  }
  const running = [...activeJobs.map((job) => str(job.jobId)), ...activeRuns.map((run) => str(run.loopRunId))].filter((id): id is string => !!id)
  if (running[0]) next.push({ tool: 'specrails_watch', args: { ref: running[0], ...scope }, why: 'Wait for the running work to settle.' })
  const busy = activeJobs.length + activeRuns.length
  const nextCursor = str(result.nextCursor)
  if (nextCursor) next.push({ tool: 'specrails_rails', args: { ...args, cursor: nextCursor }, why: 'Fetch the next page of rails.' })
  const total = typeof result.total === 'number' ? result.total : rails.length
  return {
    summary: `${total > rails.length ? `Showing ${rails.length} of ${total} rails` : plural(rails.length, 'rail')}: ${busy ? `${busy} running` : 'none running'}, ${plural(reviewable.length, 'delivery', 'deliveries')} awaiting review${deliveries.length > reviewable.length ? `, ${deliveries.length - reviewable.length} other open` : ''}.`,
    next,
    ...(nextCursor ? { truncated: true, cursor: nextCursor } : {}),
  }
}

const jobsGet: Summarizer = (args, data) => {
  const job = record(record(data).job)
  const id = str(job.id)
  if (!id) return undefined
  const status = str(job.status) ?? 'unknown'
  const projectId = str(args.projectId)
  const scope = projectId ? { projectId } : {}
  const cost = typeof job.total_cost_usd === 'number' ? ` Cost ${usd(job.total_cost_usd)}.` : ''
  const diagnosis = record(job.failureDiagnosis)
  const reason = str(diagnosis.detail) ?? (str(diagnosis.kind) && diagnosis.kind !== 'unknown' ? String(diagnosis.kind).replace(/_/g, ' ') : null)
  const failed = status === 'failed' || status === 'canceled'
  const next: NextCall[] = failed
    ? [
        { tool: 'specrails_jobs', args: { action: 'diagnose_failure', jobId: id, ...scope }, why: 'Why it stopped: the diagnosis plus the saved AI analysis.' },
        { tool: 'specrails_jobs', args: { action: 'logs', jobId: id, ...scope }, why: 'The failed step’s log lines first, then the tail.' },
      ]
    : status === 'running' || status === 'queued'
      ? [{ tool: 'specrails_watch', args: { ref: id, ...scope }, why: 'Wait until it settles.' }]
      : []
  return {
    summary: `Job ${id} (${str(job.command) ?? 'command unknown'}) is ${status}.${failed && reason ? ` Reason: ${reason}.` : ''}${cost}`,
    status,
    ids: { jobId: id, ...scope },
    next,
  }
}

const analyticsSpending: Summarizer = (args, data) => {
  const result = record(data)
  const summary = record(result.summary)
  if (typeof summary.totalCostUsd !== 'number') return undefined
  const total = summary.totalCostUsd
  const runs = typeof summary.totalRuns === 'number' ? summary.totalRuns : 0
  const estimated = typeof summary.totalEstimatedCostUsd === 'number' ? summary.totalEstimatedCostUsd : 0
  const delta = typeof summary.deltaPct === 'number' ? ` (${summary.deltaPct >= 0 ? '+' : ''}${Math.round(summary.deltaPct)}% vs the previous period)` : ''
  const top = rows(result.byCategory).filter((entry) => typeof entry.costUsd === 'number' && (entry.costUsd as number) > 0)[0]
  const projectId = str(args.projectId)
  return {
    summary: `Spent ${usd(total)} across ${plural(runs, 'run')} in the ${str(args.period) ?? '30d'} window${delta}.${top ? ` Most went to ${String(top.category)} (${usd(top.costUsd as number)}).` : ''}${estimated > 0 ? ` ${usd(estimated)} of it is estimated.` : ''}`,
    next: [
      { tool: 'specrails_analytics', args: { action: 'budget_get', ...(projectId ? { projectId } : {}) }, why: 'Compare the spend with the budget caps.' },
      { tool: 'specrails_analytics', args: { action: 'invocations', sortBy: 'cost', limit: 10, ...(projectId ? { projectId } : {}) }, why: 'The costliest individual runs.' },
    ],
  }
}

const SUMMARIZERS: Record<string, Summarizer> = {
  ...READ_SUMMARIZERS,
  'specrails_projects:list': projectsList,
  'specrails_projects:get': projectsGet,
  'specrails_specs:list': specsList,
  'specrails_specs:search': specsList,
  'specrails_specs:get': specsGet,
  'specrails_rails:list': railsList,
  'specrails_jobs:get': jobsGet,
  'specrails_analytics:spending': analyticsSpending,
}

/** Envelope metadata for a known tool/action, or undefined for the generic summary. */
export function summarizeResult(tool: string, action: string | null, args: Record<string, unknown>, data: unknown): EnvelopeMeta | undefined {
  const summarizer = SUMMARIZERS[`${tool}:${action ?? ''}`]
  return summarizer ? summarizer(args, data) : undefined
}
