import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import { apiCall, requireProject } from './types'
import { toolResponse, type NextCall } from './envelope'
import { usd } from './summaries'

/**
 * `specrails_spend`: what was spent, on what, against which caps — app-wide
 * (`GET /api/analytics` + `GET /api/budget/caps`) or for one project
 * (`GET /projects/:id/spending` + `/budget/caps`). Categories include missions
 * (agent turns). Read-only; each source fails independently (partial:true).
 * Estimated (rate-card) cost is reported apart from billed cost.
 */

export const SPEND_PERIODS = ['today', '7d', '30d', '90d', 'all', 'custom'] as const
type Period = typeof SPEND_PERIODS[number]

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const round4 = (value: number) => Math.round(value * 10_000) / 10_000

export interface SpendCap { scope: string; period: string; budgetUsd: number | null; spentUsd: number | null; utilizationPct: number | null; exhausted: boolean; resetsAt: string | null }
export interface SpendItem { kind: 'project' | 'spec' | 'mission'; id: unknown; title: string; usd: number; runs: number | null }

export interface SpendSnapshot {
  scope: 'app' | 'project'
  projectId: string | null
  period: { name: Period; from: string | null; to: string | null }
  totalUsd: number | null
  estimatedUsd: number | null
  runs: number | null
  byCategory: Record<string, number>
  caps: SpendCap[]
  exhausted: SpendCap[]
  projection: Row | null
  top: SpendItem[]
  partial: boolean
  sources: Record<string, string>
}

/** The person's local day (same "today" as the caps and specrails_status). */
function localDay(now: Date): { from: string; to: string } {
  return {
    from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
  }
}

function periodQuery(period: Period, from: string | undefined, to: string | undefined, now: Date): { params: Record<string, string>; from: string | null; to: string | null } {
  if (period === 'today') {
    const day = localDay(now)
    return { params: { period: 'custom', from: day.from, to: day.to }, ...day }
  }
  if (period === 'custom') {
    if (!from && !to) throw new Error('period "custom" requires from and/or to (ISO dates).')
    return { params: { period: 'custom', ...(from ? { from } : {}), ...(to ? { to } : {}) }, from: from ?? null, to: to ?? null }
  }
  return { params: { period }, from: null, to: null }
}

async function attempt(sources: Record<string, string>, name: string, read: () => Promise<unknown>): Promise<Row | null> {
  try {
    const value = record(await read())
    sources[name] = 'ok'
    return value
  } catch (err) {
    sources[name] = err instanceof Error ? err.message.slice(0, 160) : 'failed'
    return null
  }
}

function capsOf(data: Row | null): { caps: SpendCap[]; projection: Row | null } {
  if (!data) return { caps: [], projection: null }
  const caps = rows(data.caps).map((cap) => {
    const budget = num(cap.budgetUsd)
    const spent = num(cap.spentUsd)
    return {
      scope: String(cap.scope ?? 'unknown'), period: String(cap.period ?? 'unknown'),
      budgetUsd: budget, spentUsd: spent === null ? null : round4(spent),
      utilizationPct: budget && spent !== null ? Math.round((spent / budget) * 1000) / 10 : null,
      exhausted: cap.exhausted === true, resetsAt: typeof cap.resetsAt === 'string' ? cap.resetsAt : null,
    }
  })
  const projection = data.projection && typeof data.projection === 'object' ? record(data.projection) : null
  return { caps, projection }
}

function categories(entries: unknown): Record<string, number> {
  return Object.fromEntries(rows(entries)
    .filter((entry) => typeof entry.category === 'string' && (num(entry.costUsd) ?? 0) > 0)
    .map((entry) => [entry.category as string, round4(entry.costUsd as number)]))
}

export async function collectSpend(ctx: McpToolContext, args: { projectId?: string; period?: Period; from?: string; to?: string; top?: number }, now = new Date()): Promise<SpendSnapshot> {
  const period = args.period ?? 'today'
  const top = Math.min(Math.max(args.top ?? 5, 0), 20)
  const window = periodQuery(period, args.from, args.to, now)
  const sources: Record<string, string> = {}
  const query = new URLSearchParams(window.params)

  if (args.projectId) {
    const { project } = requireProject(ctx, args.projectId)
    const base = `/projects/${encodeURIComponent(project.id)}`
    query.set('tzOffsetMinutes', String(-now.getTimezoneOffset()))
    const [spending, capsData] = await Promise.all([
      attempt(sources, 'spending', () => apiCall(ctx, 'GET', `${base}/spending?${query.toString()}`)),
      attempt(sources, 'caps', () => apiCall(ctx, 'GET', `${base}/budget/caps`)),
    ])
    const summary = record(spending?.summary)
    const { caps, projection } = capsOf(capsData)
    const missions = rows(record(spending?.agentMissions).topConversations)
    const items: SpendItem[] = [
      ...rows(spending?.topTickets).filter((ticket) => (num(ticket.totalCostUsd) ?? 0) > 0).map((ticket) => ({
        kind: 'spec' as const, id: ticket.ticketId ?? null,
        title: typeof ticket.ticketTitle === 'string' ? ticket.ticketTitle : ticket.isUnattributed ? 'Not linked to a spec' : `Spec #${String(ticket.ticketId)}`,
        usd: round4(ticket.totalCostUsd as number), runs: num(ticket.totalRuns),
      })),
      ...missions.filter((mission) => (num(mission.costUsd) ?? 0) > 0).map((mission) => ({
        kind: 'mission' as const, id: mission.conversationId ?? null, title: typeof mission.title === 'string' && mission.title ? mission.title : 'Untitled mission',
        usd: round4(mission.costUsd as number), runs: num(mission.turns),
      })),
    ].sort((a, b) => b.usd - a.usd).slice(0, top)
    return {
      scope: 'project', projectId: project.id, period: { name: period, from: window.from, to: window.to },
      totalUsd: num(summary.totalCostUsd) === null ? null : round4(summary.totalCostUsd as number),
      estimatedUsd: num(summary.totalEstimatedCostUsd) === null ? null : round4(summary.totalEstimatedCostUsd as number),
      runs: num(summary.totalRuns), byCategory: categories(spending?.byCategory),
      caps, exhausted: caps.filter((cap) => cap.exhausted), projection, top: items,
      partial: Object.values(sources).some((status) => status !== 'ok'), sources,
    }
  }

  const [analytics, capsData] = await Promise.all([
    attempt(sources, 'analytics', () => apiCall(ctx, 'GET', `/analytics?${query.toString()}`)),
    attempt(sources, 'caps', () => apiCall(ctx, 'GET', '/budget/caps')),
  ])
  const kpi = record(analytics?.kpi)
  const { caps, projection } = capsOf(capsData)
  const items: SpendItem[] = rows(analytics?.projectBreakdown)
    .filter((entry) => (num(entry.totalCostUsd) ?? 0) > 0)
    .map((entry) => ({
      kind: 'project' as const, id: entry.projectId ?? null,
      title: typeof entry.projectName === 'string' ? entry.projectName : String(entry.projectId ?? 'unknown'),
      usd: round4(entry.totalCostUsd as number), runs: num(entry.totalJobs),
    }))
    .sort((a, b) => b.usd - a.usd).slice(0, top)
  return {
    scope: 'app', projectId: null, period: { name: period, from: window.from, to: window.to },
    totalUsd: num(kpi.totalCostUsd) === null ? null : round4(kpi.totalCostUsd as number),
    estimatedUsd: num(kpi.estimatedCostUsd) === null ? null : round4(kpi.estimatedCostUsd as number),
    runs: num(kpi.totalJobs), byCategory: categories(analytics?.byCategory),
    caps, exhausted: caps.filter((cap) => cap.exhausted), projection, top: items,
    partial: Object.values(sources).some((status) => status !== 'ok'), sources,
  }
}

const PERIOD_TEXT: Record<Period, string> = { today: 'today', '7d': 'in the last 7 days', '30d': 'in the last 30 days', '90d': 'in the last 90 days', all: 'in total', custom: 'in the chosen window' }

export function spendSummary(spend: SpendSnapshot): string {
  if (spend.totalUsd === null) return `Spend ${PERIOD_TEXT[spend.period.name]} is unavailable right now.`
  const where = spend.scope === 'project' ? ' in this project' : ''
  const category = Object.entries(spend.byCategory).sort((a, b) => b[1] - a[1])[0]
  const estimated = spend.estimatedUsd && spend.estimatedUsd > 0 ? ` (${usd(spend.estimatedUsd)} estimated)` : ''
  const caps = spend.exhausted.length
    ? ` ${spend.exhausted.map((cap) => `The ${cap.scope} ${cap.period} cap of ${usd(cap.budgetUsd ?? 0)} is exhausted`).join('; ')}: launches are refused until it resets or is raised.`
    : spend.caps.length
      ? ` Caps: ${spend.caps.map((cap) => `${cap.scope} ${cap.period} ${cap.utilizationPct ?? '?'}%`).join(', ')}.`
      : ''
  return `Spent ${usd(spend.totalUsd)}${estimated}${where} ${PERIOD_TEXT[spend.period.name]}${spend.runs ? ` across ${spend.runs} ${spend.scope === 'app' ? 'job' : 'run'}${spend.runs === 1 ? '' : 's'}` : ''}.${category ? ` Most went to ${category[0]} (${usd(category[1])}).` : ''}${caps}`
}

function spendNext(spend: SpendSnapshot): NextCall[] {
  const next: NextCall[] = []
  // The Home & Blueprint row (`app:…`) is agent turns of no project, not a project id.
  const project = spend.top.find((item) => item.kind === 'project' && typeof item.id === 'string' && !item.id.startsWith('app:'))
  if (project && typeof project.id === 'string') next.push({ tool: 'specrails_spend', args: { projectId: project.id, period: spend.period.name }, why: `Break down ${project.title}, the costliest project.` })
  if (spend.projectId) next.push({ tool: 'specrails_analytics', args: { action: 'invocations', projectId: spend.projectId, sortBy: 'cost', limit: 10 }, why: 'The costliest individual runs.' })
  if (spend.exhausted.length) next.push({ tool: 'specrails_settings', args: { action: 'get' }, why: 'Read the budget settings before suggesting the person raises a cap (a write).' })
  return next.slice(0, 3)
}

export function spendTools(): McpToolSpec[] {
  return [{
    name: 'specrails_spend',
    title: 'Spend today or per period, budget caps',
    description:
      'What was spent, on what and against which caps: total (billed + estimated), byCategory (implementation, missions, specs, code, support), runs, every daily/weekly/monthly/run cap with utilization and whether it is exhausted, the month-end projection and the costliest projects (app-wide) or specs and missions (with projectId). Read-only.',
    tier: 'read',
    inputSchema: {
      projectId: z.string().optional().describe('Scope to one project; omit for app-wide'),
      period: z.enum(SPEND_PERIODS).optional().describe('Window (default today, the local day)'),
      from: z.string().optional().describe('custom: ISO start'),
      to: z.string().optional().describe('custom: ISO end'),
      top: z.number().int().min(0).max(20).optional().describe('Costliest items to return (default 5)'),
    },
    async handler(ctx, args) {
      const spend = await collectSpend(ctx, {
        projectId: args.projectId as string | undefined, period: args.period as Period | undefined,
        from: args.from as string | undefined, to: args.to as string | undefined, top: args.top as number | undefined,
      })
      return toolResponse(spend, {
        summary: spendSummary(spend),
        status: spend.exhausted.length ? 'cap_exhausted' : 'ok',
        ...(spend.projectId ? { ids: { projectId: spend.projectId } } : {}),
        next: spendNext(spend),
        ...(spend.partial ? { partial: true } : {}),
      })
    },
  }]
}
