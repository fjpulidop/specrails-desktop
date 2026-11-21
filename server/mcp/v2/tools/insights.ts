import { z } from 'zod'
import type { ProjectRow } from '../../../desktop-db'
import { periodEnd, periodStart, type CapPeriod } from '../../../modules/execution/domain/spend-caps'
import { apiCall } from '../../tools/types'
import { decodeCursor, encodeCursor } from '../core/cursor'
import { V2ToolError, result } from '../core/envelope'
import { hasMessage, type Lang } from '../core/lang'
import { formatRef, parseRef, type Ref } from '../core/refs'
import { defineTool, type V2CallContext } from '../core/registry'
import { neutralize, untrusted } from '../core/untrusted'
import { F, optionsOf } from '../core/views'

/**
 * WP8 `specrails_insights`: spend, analytics, subscription usage, provider
 * quotas, machine capacity, launch preflight, forecasts, what-if pricing,
 * budgets and machine resources. Every read goes through the app's own read
 * models (loopback routes); nothing here re-computes money or holds policy.
 *
 * Money stays honest: `usd` is the priced total, `estimatedUsd` the part that
 * came from the rate card (no provider-reported cost), `reportedUsd` the rest;
 * runs with no cost are counted, never priced at zero. Forecasts and
 * projections are always labelled estimates. App-wide reads use the
 * cross-project read models (`/api/analytics`, `/api/budget/caps`, `/api/inbox`,
 * in-memory usage/quota/capacity), never one call per project.
 */

type Row = Record<string, unknown>
const rec = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(rec) : []
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const str = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null
const cents = (value: number): number => Math.round(value * 100) / 100
const money4 = (value: number | null): number | null => value === null ? null : Math.round(value * 10_000) / 10_000
const present = (value: unknown) => value !== undefined && value !== null && value !== ''
/** A 0..1 ratio as a percentage with one decimal. */
const pct100 = (ratio: number | null): number | null => ratio === null ? null : Math.round(ratio * 1000) / 10

// ── Formatting (localized numbers, the person's clock) ─────────────────────

const LOCALE: Record<Lang, string> = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-PT', it: 'it-IT', zh: 'zh-CN', ja: 'ja-JP' }
const localeOf = (ctx: V2CallContext) => LOCALE[ctx.v2.lang] ?? 'en-US'

function usdText(ctx: V2CallContext, value: number | null): string {
  if (value === null) return '?'
  return new Intl.NumberFormat(localeOf(ctx), { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
}

const pctText = (value: number | null): string => value === null ? '?%' : `${Math.round(value)}%`

/** "23:10" today, "Mon 09:00" within a week, else "Dec 2, 09:00" (the machine's local time). */
export function clockText(lang: Lang, iso: string | null, now = new Date()): string {
  if (!iso) return '?'
  const at = new Date(iso)
  if (!Number.isFinite(at.getTime())) return '?'
  const locale = LOCALE[lang] ?? 'en-US'
  const time: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hour12: false }
  const sameDay = at.toDateString() === now.toDateString()
  if (sameDay) return new Intl.DateTimeFormat(locale, time).format(at)
  const days = Math.abs(at.getTime() - now.getTime()) / 86_400_000
  if (days < 6.5) return new Intl.DateTimeFormat(locale, { weekday: 'short', ...time }).format(at)
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...time }).format(at)
}

export function durationText(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '?'
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} s`
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

function bandText(lowMs: number, highMs: number): string {
  const low = durationText(lowMs)
  const high = durationText(highMs)
  if (low === high) return low
  const simple = /^(\d+) (s|min|h)$/
  const [a, b] = [simple.exec(low), simple.exec(high)]
  return a && b && a[2] === b[2] ? `${a[1]}–${high}` : `${low}–${high}`
}

/** A localized word with a raw fallback (unknown categories, providers). */
function word(ctx: V2CallContext, key: string, fallback: string): string {
  return hasMessage(key) ? ctx.v2.t(key) : fallback
}

/** `key_one` when count is 1 and the catalog has it (English plurals; WP12 adds the rest). */
function tc(ctx: V2CallContext, key: string, count: number, params: Record<string, string | number | null | undefined>): string {
  return ctx.v2.t(count === 1 && hasMessage(`${key}_one`) ? `${key}_one` : key, params)
}

const PROVIDER_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', kimi: 'Kimi', opencode: 'OpenCode' }
const providerName = (id: string) => PROVIDER_NAMES[id] ?? id

// ── Windows (since/until) ──────────────────────────────────────────────────

const KEYWORDS = ['today', 'week', 'month', '7d', '30d', '90d', 'all'] as const
type PeriodName = typeof KEYWORDS[number] | 'custom'

export interface Window {
  name: PeriodName
  from: string | null
  to: string | null
  /** Query parameters the spending routes understand. */
  params: Record<string, string>
  /** The cap period whose spend overview matches this window exactly. */
  capPeriod: CapPeriod | null
  /** Whole days covered (what-if, profiles). */
  days: number
}

function isoOf(value: string, label: string, t: V2CallContext['v2']['t']): string {
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) throw new V2ToolError('invalid_input', `${label}: ${t('insights.error.period')}`)
  return new Date(ms).toISOString()
}

export function windowOf(ctx: V2CallContext, args: Record<string, unknown>, fallback: typeof KEYWORDS[number], now = new Date()): Window {
  const since = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : fallback
  const until = typeof args.until === 'string' && args.until.trim() ? isoOf(args.until.trim(), 'until', ctx.v2.t) : null
  const span = (from: Date, to: Date) => Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000))
  const custom = (name: PeriodName, from: Date, to: Date, capPeriod: CapPeriod | null): Window => {
    const end = until ?? to.toISOString()
    return { name, from: from.toISOString(), to: end, params: { period: 'custom', from: from.toISOString(), to: end }, capPeriod: until ? null : capPeriod, days: span(from, new Date(end)) }
  }
  if (since === 'today') return custom('today', periodStart('day', now), periodEnd('day', now), 'day')
  if (since === 'week') return custom('week', periodStart('week', now), periodEnd('week', now), 'week')
  if (since === 'month') return custom('month', periodStart('month', now), periodEnd('month', now), 'month')
  if (since === '7d' || since === '30d' || since === '90d') {
    const days = parseInt(since, 10)
    if (until) return custom('custom', new Date(now.getTime() - days * 86_400_000), new Date(until), null)
    return { name: since, from: null, to: null, params: { period: since }, capPeriod: null, days }
  }
  if (since === 'all') return { name: 'all', from: null, to: until, params: until ? { period: 'custom', from: '1970-01-01T00:00:00.000Z', to: until } : { period: 'all' }, capPeriod: null, days: 365 }
  const from = new Date(isoOf(since, 'since', ctx.v2.t))
  return custom('custom', from, until ? new Date(until) : now, null)
}

const periodWord = (ctx: V2CallContext, window: Window) => ctx.v2.t(`insights.period.${window.name}`)
const query = (params: Record<string, unknown>): string => {
  const parts = Object.entries(params).filter(([, value]) => present(value)).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(Array.isArray(value) ? value.join(',') : String(value))}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// ── Scope, projects, refs ──────────────────────────────────────────────────

interface Scope { scope: 'app' | 'project'; project: ProjectRow | null }

function scopeOf(ctx: V2CallContext, args: Record<string, unknown>): Scope {
  if (args.scope === 'app') return { scope: 'app', project: null }
  if (args.scope === 'project' || present(args.project)) return { scope: 'project', project: ctx.v2.project(args) }
  return { scope: 'app', project: null }
}

const projectPath = (project: ProjectRow) => `/projects/${encodeURIComponent(project.id)}`
const projectRef = (project: Pick<ProjectRow, 'slug'>): Ref => formatRef('project', project.slug)
const whereText = (ctx: V2CallContext, project: ProjectRow | null) => project ? ctx.v2.t('insights.where.project', { name: project.name }) : ''

function slugMap(ctx: V2CallContext): Map<string, ProjectRow> {
  return new Map(ctx.v2.projects().map((row) => [row.id, row]))
}

function runRef(projects: Map<string, ProjectRow>, projectId: unknown, runId: unknown): Ref | null {
  const project = typeof projectId === 'string' ? projects.get(projectId) : undefined
  return project && present(runId) ? formatRef('run', String(runId), project.slug) : null
}

interface Sources { status: Record<string, string>; warnings: string[] }
const sourcesOf = (): Sources => ({ status: {}, warnings: [] })

/** One read model; a failure is recorded (partial answer), never fatal. */
async function attempt(ctx: V2CallContext, sources: Sources, name: string, read: () => Promise<unknown>): Promise<Row | null> {
  try {
    const value = rec(await read())
    sources.status[name] = 'ok'
    return value
  } catch (err) {
    sources.status[name] = err instanceof Error ? err.message.slice(0, 120) : 'failed'
    sources.warnings.push(ctx.v2.t('insights.warning.partial', { source: name }))
    return null
  }
}

// ── Caps ───────────────────────────────────────────────────────────────────

export interface CapView { scope: 'project' | 'app'; period: CapPeriod; budgetUsd: number; spentUsd: number; pct: number | null; exhausted: boolean; resetsAt: string | null }

export function capsOf(value: unknown): CapView[] {
  return rows(value).flatMap((cap) => {
    const budget = num(cap.budgetUsd)
    const spent = num(cap.spentUsd) ?? 0
    const period = cap.period === 'day' || cap.period === 'week' || cap.period === 'month' ? cap.period : null
    if (budget === null || !period) return []
    return [{
      scope: cap.scope === 'project' ? 'project' as const : 'app' as const, period, budgetUsd: budget, spentUsd: cents(spent),
      pct: budget > 0 ? Math.round((spent / budget) * 1000) / 10 : null, exhausted: cap.exhausted === true, resetsAt: str(cap.resetsAt),
    }]
  })
}

/** The exhausted cap first, else the one closest to its budget. */
export function tightest(caps: readonly CapView[]): CapView | null {
  return [...caps].sort((a, b) => Number(b.exhausted) - Number(a.exhausted) || (b.pct ?? 0) - (a.pct ?? 0))[0] ?? null
}

function capSentence(ctx: V2CallContext, cap: CapView): string {
  const params = { scope: ctx.v2.t(`insights.scope.${cap.scope}`), period: ctx.v2.t(`insights.cap.${cap.period}`), budget: usdText(ctx, cap.budgetUsd), pct: pctText(cap.pct), reset: clockText(ctx.v2.lang, cap.resetsAt) }
  const text = ctx.v2.t(cap.exhausted ? 'insights.summary.cap_exhausted' : 'insights.summary.cap', params)
  return cap.exhausted ? text : text.charAt(0).toUpperCase() + text.slice(1)
}

function projectionOf(value: unknown): { projectedUsd: number; monthToDateUsd: number; avgDailyUsd: number; estimate: true } | null {
  const projection = rec(value)
  const projected = num(projection.projectedUsd)
  if (projected === null) return null
  return { projectedUsd: cents(projected), monthToDateUsd: cents(num(projection.monthToDateUsd) ?? 0), avgDailyUsd: cents(num(projection.avgDailyUsd) ?? 0), estimate: true }
}

const join = (...sentences: Array<string | null | undefined | false>) => sentences.filter(Boolean).join(' ')

// ── spend ──────────────────────────────────────────────────────────────────

interface Money { provider?: string; model?: string; usd: number; estimatedUsd: number; reportedUsd: number; runs: number | null }
const money = (total: number, estimated: number, extra: Omit<Money, 'usd' | 'estimatedUsd' | 'reportedUsd'>): Money =>
  ({ ...extra, usd: cents(total), estimatedUsd: cents(estimated), reportedUsd: cents(Math.max(0, total - estimated)) })

async function spend(ctx: V2CallContext, args: Record<string, unknown>) {
  const window = windowOf(ctx, args, 'today')
  const { scope, project } = scopeOf(ctx, args)
  const detail = ctx.v2.view === 'detail'
  const sources = sourcesOf()
  const tz = String(-new Date().getTimezoneOffset())
  const data: Row = { scope, ...(project ? { project: projectRef(project) } : {}), period: { name: window.name, from: window.from, to: window.to } }
  const refs: Record<string, Ref> = project ? { project: projectRef(project) } : {}
  let total: number | null = null
  let estimated = 0
  let runs = 0
  let unpriced = 0
  let categories: Row[] = []
  let capsData: Row | null

  if (project) {
    const base = projectPath(project)
    const [spending, caps] = await Promise.all([
      attempt(ctx, sources, 'spending', () => apiCall(ctx, 'GET', `${base}/spending${query({ ...window.params, tzOffsetMinutes: tz })}`)),
      attempt(ctx, sources, 'caps', () => apiCall(ctx, 'GET', `${base}/budget/caps`)),
    ])
    capsData = caps
    const summary = rec(spending?.summary)
    total = num(summary.totalCostUsd)
    estimated = num(summary.totalEstimatedCostUsd) ?? 0
    runs = num(summary.totalRuns) ?? 0
    unpriced = num(summary.unpricedRuns) ?? 0
    categories = rows(spending?.byCategory)
    // byProvider.costUsd is the provider-reported part only; byModel.costUsd is the priced total.
    data.byProvider = rows(spending?.byProvider).map((entry) => money((num(entry.costUsd) ?? 0) + (num(entry.estimatedCostUsd) ?? 0), num(entry.estimatedCostUsd) ?? 0, { provider: String(entry.provider ?? 'claude'), runs: num(entry.count) }))
    const tickets = rows(spending?.topTickets).filter((ticket) => (num(ticket.totalCostUsd) ?? 0) > 0).map((ticket) => {
      const id = num(ticket.ticketId)
      const ref = id !== null ? formatRef('spec', id, project.slug) : null
      return { kind: 'spec', ...(ref ? { ref } : {}), title: str(ticket.ticketTitle) ? neutralize(String(ticket.ticketTitle)) : id === null ? 'Not linked to a spec' : `#${id}`, usd: cents(num(ticket.totalCostUsd)!), runs: num(ticket.totalRuns) }
    })
    const missions = rows(rec(spending?.agentMissions).topConversations).filter((mission) => (num(mission.costUsd) ?? 0) > 0).map((mission) => ({
      kind: 'mission', ...(str(mission.conversationId) ? { ref: formatRef('mission', String(mission.conversationId)) } : {}),
      title: str(mission.title) ? neutralize(String(mission.title)) : 'Untitled mission', usd: cents(num(mission.costUsd)!), runs: num(mission.turns),
    }))
    data.top = [...tickets, ...missions].sort((a, b) => b.usd - a.usd).slice(0, detail ? 20 : 5)
    if (detail) {
      data.byModel = rows(spending?.byModel).map((entry) => money(num(entry.costUsd) ?? 0, num(entry.estimatedCostUsd) ?? 0, { provider: String(entry.provider ?? 'claude'), model: String(entry.model ?? '?'), runs: num(entry.count) }))
      data.bySurface = rows(spending?.bySurface).filter((entry) => (num(entry.count) ?? 0) > 0).map((entry) => ({ surface: entry.surface, usd: cents(num(entry.costUsd) ?? 0), runs: num(entry.count) }))
      data.previous = { usd: money4(num(summary.prevTotalCostUsd)), deltaPct: num(summary.deltaPct) }
      data.timeline = rows(spending?.dailyTimeline).map((day) => ({ date: day.date, usd: cents(num(day.totalCostUsd) ?? 0) }))
    }
  } else {
    const [analytics, caps] = await Promise.all([
      attempt(ctx, sources, 'analytics', () => apiCall(ctx, 'GET', `/analytics${query(window.params)}`)),
      attempt(ctx, sources, 'caps', () => apiCall(ctx, 'GET', '/budget/caps')),
    ])
    capsData = caps
    const kpi = rec(analytics?.kpi)
    total = num(kpi.totalCostUsd)
    estimated = num(kpi.estimatedCostUsd) ?? 0
    runs = num(kpi.totalJobs) ?? 0
    unpriced = num(kpi.unpricedRuns) ?? 0
    categories = rows(analytics?.byCategory)
    const projects = slugMap(ctx)
    const breakdown = rows(analytics?.projectBreakdown).filter((entry) => (num(entry.totalCostUsd) ?? 0) > 0).map((entry) => {
      const row = typeof entry.projectId === 'string' ? projects.get(entry.projectId) : undefined
      return { kind: entry.kind === 'app' ? 'app' : 'project', ...(row ? { ref: projectRef(row) } : {}), title: String(entry.projectName ?? row?.name ?? entry.projectId ?? '?'),
        usd: cents(num(entry.totalCostUsd)!), estimatedUsd: cents(num(entry.estimatedCostUsd) ?? 0), runs: num(entry.totalJobs) }
    }).sort((a, b) => b.usd - a.usd)
    data.top = breakdown.slice(0, detail ? 100 : 5)
    if (breakdown.length > (data.top as unknown[]).length) data.projectsWithSpend = breakdown.length
    if (detail) data.timeline = rows(analytics?.costTimeline).map((day) => ({ date: day.date, usd: cents(num(day.costUsd) ?? 0), estimatedUsd: cents(num(day.estimatedCostUsd) ?? 0) }))
  }

  // Provider split app-wide: the caps read model carries it for the cap periods.
  if (!project && window.capPeriod) {
    const period = rec(rec(capsData?.spend)[window.capPeriod])
    data.byProvider = rows(period.byProvider).map((entry) => money(num(entry.usd) ?? 0, num(entry.estimatedUsd) ?? 0, { provider: String(entry.provider ?? 'claude'), runs: num(entry.invocations) }))
  }
  const caps = capsOf(capsData?.caps)
  const projection = projectionOf(capsData?.projection)
  Object.assign(data, total === null ? { usd: null } : money(total, estimated, { runs }), unpriced ? { unpricedRuns: unpriced } : {})
  data.byCategory = categories.filter((entry) => (num(entry.costUsd) ?? 0) > 0).map((entry) => ({ category: String(entry.category), usd: cents(num(entry.costUsd)!), estimatedUsd: cents(num(entry.estimatedCostUsd) ?? 0) })).sort((a, b) => b.usd - a.usd)
  data.caps = caps
  if (projection) data.projection = projection
  for (const item of (data.top as Array<{ ref?: Ref }>)) if (item.ref) refs[item.ref] = item.ref

  const params = { where: whereText(ctx, project), period: periodWord(ctx, window), runs, usd: usdText(ctx, total), estimated: usdText(ctx, cents(estimated)) }
  const head = total === null ? ctx.v2.t('insights.summary.spend_unavailable', params)
    : tc(ctx, estimated >= 0.005 ? 'insights.summary.spend_estimated' : 'insights.summary.spend', runs, params)
  const cap = tightest(caps)
  const top = (data.byCategory as Array<{ category: string; usd: number }>)[0]
  const tail = cap ? capSentence(ctx, cap)
    : top ? ctx.v2.t('insights.summary.top_category', { category: word(ctx, `insights.category.${top.category}`, top.category), usd: usdText(ctx, top.usd) }) : null
  return result(data, {
    summary: join(head, tail, unpriced && total !== null ? tc(ctx, 'insights.summary.spend_unpriced', unpriced, { count: unpriced }) : null),
    refs, warnings: sources.warnings, untrusted: untrusted('/data/top/*/title'),
  })
}

// ── analytics ──────────────────────────────────────────────────────────────

async function analytics(ctx: V2CallContext, args: Record<string, unknown>) {
  const report = typeof args.report === 'string' ? args.report : 'dashboard'
  const { project: scoped, scope } = scopeOf(ctx, args)
  if (report === 'dashboard' && scope === 'app') return appDashboard(ctx, args)
  const project = scoped ?? ctx.v2.project(args)
  switch (report) {
    case 'dashboard': return projectDashboard(ctx, args, project)
    case 'invocations': return invocations(ctx, args, project)
    case 'ticket_summary': return ticketSummary(ctx, args, project)
    case 'decision_times': return decisionTimes(ctx, args, project)
    case 'loop_economics': return loopEconomics(ctx, args, project)
    case 'profiles': return profiles(ctx, args, project)
    default: throw new V2ToolError('invalid_input', `Unknown report "${report}".`)
  }
}

async function appDashboard(ctx: V2CallContext, args: Record<string, unknown>) {
  const window = windowOf(ctx, args, '30d')
  const data = rec(await apiCall(ctx, 'GET', `/analytics${query(window.params)}`))
  const kpi = rec(data.kpi)
  const projects = slugMap(ctx)
  const detail = ctx.v2.view === 'detail'
  const breakdown = rows(data.projectBreakdown).map((entry) => {
    const row = typeof entry.projectId === 'string' ? projects.get(entry.projectId) : undefined
    return {
      ...(row ? { ref: projectRef(row) } : {}), title: String(entry.projectName ?? row?.name ?? '?'), runs: num(entry.totalJobs) ?? 0,
      successRatePct: pct100(num(entry.successRate)), avgDurationMs: num(entry.avgDurationMs), usd: cents(num(entry.totalCostUsd) ?? 0), estimatedUsd: cents(num(entry.estimatedCostUsd) ?? 0),
    }
  }).sort((a, b) => b.usd - a.usd || b.runs - a.runs)
  const shown = breakdown.slice(0, detail ? 100 : 10)
  const rate = num(kpi.successRate)
  const out: Row = {
    report: 'dashboard', scope: 'app', period: { name: window.name, from: window.from, to: window.to },
    successRatePct: pct100(rate), ...money(num(kpi.totalCostUsd) ?? 0, num(kpi.estimatedCostUsd) ?? 0, { runs: num(kpi.totalJobs) }),
    today: { usd: cents(num(kpi.costToday) ?? 0), estimatedUsd: cents(num(kpi.estimatedCostToday) ?? 0), runs: num(kpi.jobsToday) },
    projects: shown, projectCount: breakdown.length,
    ...(detail ? { timeline: rows(data.costTimeline).map((day) => ({ date: day.date, usd: cents(num(day.costUsd) ?? 0), estimatedUsd: cents(num(day.estimatedCostUsd) ?? 0) })) } : {}),
  }
  const costliest = breakdown.find((entry) => entry.usd > 0)
  return result(out, {
    summary: join(
      ctx.v2.t('insights.summary.dashboard_app', { runs: num(kpi.totalJobs) ?? 0, period: periodWord(ctx, window), rate: pctText(pct100(rate)), usd: usdText(ctx, num(kpi.totalCostUsd)) }),
      costliest ? ctx.v2.t('insights.summary.costliest_project', { name: costliest.title, usd: usdText(ctx, costliest.usd) }) : null,
    ),
    refs: Object.fromEntries(shown.filter((entry) => entry.ref).map((entry) => [entry.ref!, entry.ref!])),
  })
}


async function projectDashboard(ctx: V2CallContext, args: Record<string, unknown>, project: ProjectRow) {
  const window = windowOf(ctx, args, '30d')
  const base = projectPath(project)
  const sources = sourcesOf()
  const tz = String(-new Date().getTimezoneOffset())
  const [spending, economics] = await Promise.all([
    attempt(ctx, sources, 'spending', () => apiCall(ctx, 'GET', `${base}/spending${query({ ...window.params, tzOffsetMinutes: tz })}`)),
    attempt(ctx, sources, 'loop_economics', () => apiCall(ctx, 'GET', `${base}/analytics/loop-economics${query(window.params)}`)),
  ])
  if (!spending && !economics) throw new V2ToolError('provider_unavailable', sources.warnings.join(' '))
  const summary = rec(spending?.summary)
  const failure = num(summary.failureRate)
  const successRate = failure === null ? null : pct100(1 - failure)
  const group = rec(economics?.project)
  const rounds = rec(group.rounds)
  const decision = rec(rec(group.decisionTimes).toDecision)
  const out: Row = {
    report: 'dashboard', scope: 'project', project: projectRef(project), period: { name: window.name, from: window.from, to: window.to },
    successRatePct: successRate, ...money(num(summary.totalCostUsd) ?? 0, num(summary.totalEstimatedCostUsd) ?? 0, { runs: num(summary.totalRuns) }),
    avgCostPerRunUsd: money4(num(summary.avgCostPerRun)), previousUsd: money4(num(summary.prevTotalCostUsd)), deltaPct: num(summary.deltaPct),
    tokens: num(summary.totalTokens), unpricedRuns: num(summary.unpricedRuns) ?? 0,
    deliveries: economics ? {
      delivered: num(group.delivered), merged: num(group.merged), discarded: num(group.discarded), discardRate: num(group.discardRate),
      avgCostUsd: money4(num(rec(group.cost).avgCostUsd)), reviewRoundsPerDelivery: num(rounds.reviewPerDelivery), fixerRoundsPerDelivery: num(rounds.fixerPerDelivery),
      escapedDefects: group.escapedDefects ?? null, medianToDecisionMs: num(decision.medianMs),
    } : null,
    ...(ctx.v2.view === 'detail' ? {
      byMode: rows(spending?.byMode).map((mode) => ({ mode: mode.mode, runs: num(mode.totalRuns), specsCreated: num(mode.ticketsCreated), usd: cents(num(mode.totalCostUsd) ?? 0), avgCostPerSpecUsd: money4(num(mode.avgCostPerSpec)), avgDurationMs: num(mode.avgDurationMs), model: mode.dominantModel ?? null })),
      byLoop: rows(economics?.byLoop).slice(0, 20).map((loop) => loopRow(loop)),
    } : {}),
  }
  const deltaPct = num(summary.deltaPct)
  return result(out, {
    summary: join(
      ctx.v2.t('insights.summary.dashboard_project', { runs: num(summary.totalRuns) ?? 0, where: whereText(ctx, project), period: periodWord(ctx, window), rate: pctText(successRate), usd: usdText(ctx, num(summary.totalCostUsd)), delta: deltaPct === null ? '—' : `${deltaPct >= 0 ? '+' : ''}${Math.round(deltaPct)}%` }),
      economics && (num(group.delivered) ?? 0) > 0 ? ctx.v2.t('insights.summary.loop_brief', { delivered: num(group.delivered) ?? 0, merged: num(group.merged) ?? 0, rounds: num(rounds.reviewPerDelivery)?.toFixed(1) ?? '?' }) : null,
    ),
    refs: { project: projectRef(project) }, warnings: sources.warnings,
  })
}

function loopRow(loop: Row) {
  const cost = rec(loop.cost)
  const rounds = rec(loop.rounds)
  return {
    ...(str(loop.loopId) ? { ref: formatRef('loop', String(loop.loopId)) } : {}), name: loop.loopName, hasData: loop.hasData === true,
    delivered: num(loop.delivered), merged: num(loop.merged), discardRate: num(loop.discardRate),
    avgCostUsd: money4(num(cost.avgCostUsd)), estimatedShare: num(cost.estimatedShare),
    reviewRoundsPerDelivery: num(rounds.reviewPerDelivery), fixerRoundsPerDelivery: num(rounds.fixerPerDelivery), escapedDefects: loop.escapedDefects ?? null,
  }
}

const INVOCATION_FILTERS = ['provider', 'model', 'surface', 'status', 'minCostUsd', 'sortBy'] as const

function specIdOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value !== 'string') return null
  const parsed = parseRef(value)
  const raw = parsed ? (parsed.kind === 'spec' ? parsed.id : null) : value.replace(/^#/, '')
  const id = raw !== null ? Number(raw) : NaN
  return Number.isInteger(id) && id >= 0 ? id : null
}

async function invocations(ctx: V2CallContext, args: Record<string, unknown>, project: ProjectRow) {
  const window = windowOf(ctx, args, '30d')
  const options = optionsOf(args)
  const filters: Record<string, unknown> = Object.fromEntries(INVOCATION_FILTERS.map((key) => [key, options[key]]))
  const spec = options.spec !== undefined ? specIdOf(options.spec) : null
  if (options.spec !== undefined && spec === null) throw new V2ToolError('invalid_input', ctx.v2.t('insights.error.spec'))
  const key = `inv:${project.id}:${window.name}:${JSON.stringify(filters)}:${spec ?? ''}`.slice(0, 120)
  const offset = decodeCursor(args.cursor, key)?.offset ?? 0
  const limit = Math.min(typeof args.limit === 'number' && args.limit > 0 ? args.limit : 25, 100)
  const data = rec(await apiCall(ctx, 'GET', `${projectPath(project)}/invocations${query({ ...window.params, ...filters, ...(spec !== null ? { ticketId: spec } : {}), limit, offset })}`))
  const projects = slugMap(ctx)
  const items = rows(data.rows).map((row) => {
    const surface = String(row.surface ?? '?')
    const ticket = num(row.ticket_id)
    const run = surface === 'job' || surface === 'loop' ? runRef(projects, project.id, row.surface_ref_id) : null
    return {
      id: row.id, at: row.started_at, surface, provider: row.provider ?? 'claude', model: row.model ?? null, status: row.status,
      usd: money4(num(row.total_cost_usd)), estimated: row.total_cost_usd_estimated === 1, durationMs: num(row.duration_ms), turns: num(row.num_turns),
      tokens: [row.tokens_in, row.tokens_out, row.tokens_cache_read, row.tokens_cache_create].some((value) => num(value) !== null)
        ? (num(row.tokens_in) ?? 0) + (num(row.tokens_out) ?? 0) + (num(row.tokens_cache_read) ?? 0) + (num(row.tokens_cache_create) ?? 0) : null,
      ...(ticket !== null ? { spec: formatRef('spec', ticket, project.slug) } : {}),
      ...(run ? { run } : {}),
      ...(row.ledger === 'agent' && str(row.conversation_id) ? { mission: formatRef('mission', String(row.conversation_id)) } : {}),
      ...(str(row.ticket_title) ? { title: neutralize(String(row.ticket_title)) } : {}),
    }
  })
  const total = num(data.totalAvailable) ?? num(data.total) ?? items.length
  const end = offset + items.length
  const more = end < total && items.length > 0
  const params = { shown: items.length, total, where: whereText(ctx, project), period: periodWord(ctx, window) }
  return result({ report: 'invocations', project: projectRef(project), period: { name: window.name, from: window.from, to: window.to }, items }, {
    summary: items.length ? ctx.v2.t('insights.summary.invocations', params) : ctx.v2.t('insights.summary.invocations_empty', params),
    refs: { project: projectRef(project) },
    page: { cursor: more ? encodeCursor({ offset: end, path: '/items', key }) : null, total, truncated: more },
    untrusted: untrusted('/data/items/*/title'),
  })
}

async function ticketSummary(ctx: V2CallContext, args: Record<string, unknown>, project: ProjectRow) {
  const options = optionsOf(args)
  const id = specIdOf(options.spec ?? args.ref)
  if (id === null) throw new V2ToolError('invalid_input', ctx.v2.t('insights.error.spec'))
  const data = rec(await apiCall(ctx, 'GET', `${projectPath(project)}/tickets/${id}/spending-summary`))
  const usd = num(data.totalCostUsd) ?? 0
  const estimated = num(data.estimatedCostUsd) ?? 0
  const ref = formatRef('spec', id, project.slug)
  const out = {
    report: 'ticket_summary', spec: ref, title: str(data.ticketTitle) ? neutralize(String(data.ticketTitle)) : null, deleted: data.isDeleted === true,
    ...money(usd, estimated, { runs: num(data.totalRuns) }), unpricedRuns: num(data.unpricedRuns) ?? 0, tokens: num(data.totalTokens), turns: num(data.totalTurns),
    activeDurationMs: num(data.activeDurationMs),
    bySurface: Object.entries(rec(data.bySurface)).map(([surface, value]) => ({ surface, runs: num(rec(value).count) ?? 0, usd: cents(num(rec(value).costUsd) ?? 0) })).filter((entry) => entry.runs > 0),
  }
  const params = { id, usd: usdText(ctx, usd), runs: num(data.totalRuns) ?? 0, time: durationText(num(data.activeDurationMs)), estimated: usdText(ctx, cents(estimated)) }
  return result(out, {
    summary: tc(ctx, estimated >= 0.005 ? 'insights.summary.ticket_estimated' : 'insights.summary.ticket', params.runs, params),
    refs: { spec: ref, project: projectRef(project) }, untrusted: untrusted('/data/title'),
  })
}

function durationStats(value: unknown) {
  const stats = rec(value)
  return { measured: num(stats.measured) ?? 0, pending: num(stats.pending) ?? 0, unknown: num(stats.unknown) ?? 0, medianMs: num(stats.medianMs), p90Ms: num(stats.p90Ms) }
}

async function decisionTimes(ctx: V2CallContext, args: Record<string, unknown>, project: ProjectRow) {
  const window = windowOf(ctx, args, '30d')
  const data = rec(await apiCall(ctx, 'GET', `${projectPath(project)}/analytics/decision-times${query(window.params)}`))
  const group = rec(data.project)
  const toDecision = durationStats(group.toDecision)
  const toMerge = durationStats(group.toMerge)
  const out = {
    report: 'decision_times', project: projectRef(project), period: { name: window.name, from: window.from, to: window.to },
    deliveries: num(group.deliveries) ?? 0, toDecision, toMerge,
    byLoop: rows(data.byLoop).slice(0, ctx.v2.view === 'detail' ? 50 : 10).map((loop) => ({
      ...(str(loop.loopId) ? { ref: formatRef('loop', String(loop.loopId)) } : {}), name: loop.loopName, deliveries: num(loop.deliveries) ?? 0,
      toDecision: durationStats(loop.toDecision), toMerge: durationStats(loop.toMerge),
    })),
  }
  const params = { decision: durationText(toDecision.medianMs), p90: durationText(toDecision.p90Ms), measured: toDecision.measured, merge: durationText(toMerge.medianMs), pending: toDecision.pending, where: whereText(ctx, project), period: periodWord(ctx, window) }
  return result(out, {
    summary: ctx.v2.t(toDecision.measured ? 'insights.summary.decision_times' : 'insights.summary.decision_times_empty', params),
    refs: { project: projectRef(project) },
  })
}

async function loopEconomics(ctx: V2CallContext, args: Record<string, unknown>, project: ProjectRow) {
  const window = windowOf(ctx, args, '30d')
  const data = rec(await apiCall(ctx, 'GET', `${projectPath(project)}/analytics/loop-economics${query(window.params)}`))
  const loops = rows(data.byLoop).map(loopRow)
  const group = loopRow({ ...rec(data.project), loopName: 'project' })
  const withData = loops.filter((loop) => loop.hasData)
  const out = { report: 'loop_economics', project: projectRef(project), period: { name: window.name, from: window.from, to: window.to }, total: group, loops: ctx.v2.view === 'detail' ? loops : withData.slice(0, 10), sources: data.sources ?? null }
  const params = { delivered: group.delivered ?? 0, loops: withData.length, avg: usdText(ctx, group.avgCostUsd), rounds: group.reviewRoundsPerDelivery?.toFixed(1) ?? '?', where: whereText(ctx, project), period: periodWord(ctx, window) }
  return result(out, {
    summary: ctx.v2.t((group.delivered ?? 0) > 0 ? 'insights.summary.loop_economics' : 'insights.summary.loop_economics_empty', params),
    refs: { project: projectRef(project) },
  })
}

async function profiles(ctx: V2CallContext, args: Record<string, unknown>, project: ProjectRow) {
  const window = windowOf(ctx, args, '30d')
  const provider = str(optionsOf(args).provider)
  const data = rec(await apiCall(ctx, 'GET', `${projectPath(project)}/profiles/analytics${query({ windowDays: Math.min(365, window.days), provider })}`))
  const list = rows(data.rows).map((row) => ({
    profile: row.profileName, jobs: num(row.jobs) ?? 0, successRatePct: pct100(num(row.successRate)), avgDurationMs: num(row.avgDurationMs), avgCostUsd: money4(num(row.avgCostUsd)), avgTokens: num(row.avgTokens),
  }))
  const top = list[0]
  const out = { report: 'profiles', project: projectRef(project), provider: data.provider ?? provider, windowDays: num(data.windowDays) ?? window.days, items: list }
  return result(out, {
    summary: top
      ? ctx.v2.t('insights.summary.profiles', { count: list.length, jobs: list.reduce((sum, row) => sum + row.jobs, 0), days: out.windowDays, top: String(top.profile), rate: pctText(top.successRatePct) })
      : ctx.v2.t('insights.summary.profiles_empty', { days: out.windowDays }),
    refs: { project: projectRef(project) },
  })
}

// ── export ─────────────────────────────────────────────────────────────────

async function exportReport(ctx: V2CallContext, args: Record<string, unknown>) {
  const project = ctx.v2.project(args)
  const window = windowOf(ctx, args, '30d')
  const options = optionsOf(args)
  const format = options.format === 'json' ? 'json' : 'csv'
  const mode = options.mode === 'raw' ? 'raw' : 'summary'
  const filters = Object.fromEntries(INVOCATION_FILTERS.map((key) => [key, options[key]]))
  const body = await apiCall(ctx, 'GET', `${projectPath(project)}/analytics/export${query({ ...window.params, ...filters, format, mode })}`)
  return result({ format, mode, project: projectRef(project), period: { name: window.name, from: window.from, to: window.to }, content: body }, {
    summary: ctx.v2.t('insights.summary.export', { mode, format, where: whereText(ctx, project), period: periodWord(ctx, window) }),
    refs: { project: projectRef(project) }, untrusted: untrusted('/data/content'),
  })
}

// ── usage (subscription meters) ────────────────────────────────────────────

interface UsageWindowView { id: string; label: string; model: string | null; usedPct: number | null; resetsAt: string | null; minutes: number | null }

function windowName(ctx: V2CallContext, window: UsageWindowView): string {
  const base = word(ctx, `insights.window.${window.label}`, window.label)
  return window.model ? `${base} (${window.model})` : base
}

function usageSentence(ctx: V2CallContext, provider: Row): string {
  const id = String(provider.provider)
  const name = providerName(id)
  const plan = str(provider.plan) ? ` (${String(provider.plan).charAt(0).toUpperCase()}${String(provider.plan).slice(1)})` : ''
  const availability = String(provider.availability ?? 'unavailable')
  if (availability !== 'available') return ctx.v2.t(`insights.usage.${hasMessage(`insights.usage.${availability}`) ? availability : 'unavailable'}`, { provider: name })
  const windows = (provider.windows as UsageWindowView[])
  const account = windows.filter((window) => !window.model)
  const model = [...windows.filter((window) => window.model)].sort((a, b) => (b.usedPct ?? 0) - (a.usedPct ?? 0))[0]
  const shown = [...account, ...(model && (model.usedPct ?? 0) > Math.max(0, ...account.map((window) => window.usedPct ?? 0)) ? [model] : [])]
  const parts = shown.filter((window) => window.usedPct !== null).map((window) => ctx.v2.t(window.resetsAt ? 'insights.usage.window' : 'insights.usage.window_noreset', { window: windowName(ctx, window), pct: pctText(window.usedPct), reset: clockText(ctx.v2.lang, window.resetsAt) }))
  const spendRow = rec(provider.spend)
  if (num(spendRow.usedAmount) !== null) parts.push(ctx.v2.t('insights.usage.spend', { provider: name, used: usdText(ctx, num(spendRow.usedAmount)), limit: spendRow.limitStatus === 'unlimited' ? '∞' : usdText(ctx, num(spendRow.limitAmount)) }))
  const stale = provider.freshness === 'stale' && str(provider.observedAt) ? ctx.v2.t('insights.usage.stale', { at: clockText(ctx.v2.lang, String(provider.observedAt)) }) : ''
  if (!parts.length) return ctx.v2.t('insights.usage.no_windows', { provider: name, plan })
  const text = ctx.v2.t('insights.usage.available', { provider: name, plan, windows: parts.join('; ') })
  return stale ? text.replace(/\.$/, `${stale}.`) : text
}

export function usageView(snapshot: unknown, providerFilter: string | null): Row[] {
  return rows(rec(snapshot).providers).filter((row) => !providerFilter || row.providerId === providerFilter).map((row) => ({
    provider: row.providerId, availability: row.availability, plan: row.plan ?? null, freshness: row.freshness, observedAt: row.observedAt ?? null,
    refreshing: row.refreshState === 'refreshing',
    windows: rows(row.windows).map((window): UsageWindowView => ({ id: String(window.id), label: String(window.label ?? 'window'), model: str(window.model), usedPct: num(window.usedPercent), resetsAt: str(window.resetsAt), minutes: num(window.durationMinutes) })),
    ...(row.spend ? { spend: { usedUsd: num(rec(row.spend).usedAmount), limitUsd: num(rec(row.spend).limitAmount), limitStatus: rec(row.spend).limitStatus, currency: rec(row.spend).currency, usedPct: num(rec(row.spend).usedPercent), resetsAt: rec(row.spend).resetsAt ?? null } } : {}),
    ...(row.issue ? { issue: row.issue } : {}), ...(row.retryAt ? { retryAt: row.retryAt } : {}),
  }))
}

async function usage(ctx: V2CallContext, args: Record<string, unknown>) {
  const options = optionsOf(args)
  const filter = str(options.provider)
  let snapshot: unknown
  let refreshed = false
  if (options.refresh === true) {
    const answer = rec(await apiCall(ctx, 'POST', '/subscription-usage/refresh', filter ? { providerId: filter } : {}))
    snapshot = answer.snapshot
    refreshed = true
  } else {
    snapshot = await apiCall(ctx, 'GET', '/subscription-usage')
  }
  const providers = usageView(snapshot, filter)
  const sentences = providers.map((provider) => usageSentence(ctx, provider))
  return result({ providers, revision: rec(snapshot).revision ?? null }, {
    summary: join(sentences.length ? sentences.join(' ') : ctx.v2.t('insights.summary.usage_none'), refreshed && providers.some((provider) => provider.refreshing) ? ctx.v2.t('insights.summary.refreshing') : null),
  })
}

// ── quota (provider limit state) ───────────────────────────────────────────

interface HeldItem { ref: Ref | null; project: Ref | null; title: string; kind: string; provider?: string; resumeAt?: string | null; cap?: Row; since: string | null }

/** Runs and caps the inbox read model says are held by spend or provider limits. */
async function heldItems(ctx: V2CallContext, sources: Sources, filter: (item: Row) => boolean): Promise<HeldItem[]> {
  const inbox = await attempt(ctx, sources, 'inbox', () => apiCall(ctx, 'GET', '/inbox'))
  const projects = slugMap(ctx)
  return rows(inbox?.items).filter((item) => item.kind === 'budget' && filter(item)).map((item) => {
    const project = typeof item.projectId === 'string' ? projects.get(item.projectId) : undefined
    const detail = str(item.detail)
    const limit = detail?.startsWith('usage_limit:') ? detail.split(':') : null
    const cap = item.cap ? rec(item.cap) : null
    return {
      ref: cap ? null : runRef(projects, item.projectId, item.subjectId), project: project ? projectRef(project) : null, title: neutralize(String(item.title ?? '')),
      kind: cap ? 'cap' : limit ? 'provider_limit' : 'run_cap', since: str(item.at),
      ...(limit ? { provider: limit[1], resumeAt: limit.slice(2).join(':') || null } : {}),
      ...(cap ? { cap: { scope: cap.scope === 'project' ? 'project' : 'app', period: cap.period, budgetUsd: cap.budgetUsd, spentUsd: cap.spentUsd, resetsAt: cap.resetsAt } } : {}),
    }
  })
}

function quotaSentence(ctx: V2CallContext, view: Row): string {
  const name = providerName(String(view.provider))
  const level = String(view.level ?? 'unknown')
  if (level === 'rejected') return view.rejectedUntil ? ctx.v2.t('insights.quota.rejected', { provider: name, reset: clockText(ctx.v2.lang, str(view.rejectedUntil)) }) : ctx.v2.t('insights.quota.rejected_indefinitely', { provider: name })
  return ctx.v2.t(`insights.quota.${hasMessage(`insights.quota.${level}`) ? level : 'unknown'}`, { provider: name, pct: pctText(num(view.usedPct)) })
}

export function quotaView(value: unknown): Row[] {
  return rows(rec(value).providers).map((view) => ({
    provider: view.providerId, level: view.level, usedPct: num(view.usedPercent), window: view.windowId ?? null, rejectedUntil: view.rejectedUntil ?? null,
    rejectedIndefinitely: view.rejectedIndefinitely === true, observedAt: view.observedAt ?? null,
    windows: rows(view.windows).map((window) => ({ id: window.id, usedPct: num(window.usedPercent), resetsAt: window.resetsAt ?? null, minutes: num(window.windowMinutes), source: window.source })),
  }))
}

async function quota(ctx: V2CallContext, args: Record<string, unknown>) {
  const filter = str(optionsOf(args).provider)
  const sources = sourcesOf()
  const [quotaData, held] = await Promise.all([
    apiCall(ctx, 'GET', '/provider-quota'),
    heldItems(ctx, sources, (item) => String(item.detail ?? '').startsWith('usage_limit:')),
  ])
  const providers = quotaView(quotaData).filter((view) => !filter || view.provider === filter)
  const waiting = held.filter((item) => !filter || item.provider === filter)
  const detail = ctx.v2.view === 'detail'
  const data = { providers: detail ? providers : providers.map(({ windows: _windows, ...rest }) => rest), held: waiting.slice(0, detail ? 100 : 10), heldCount: waiting.length }
  return result(data, {
    summary: join(providers.map((view) => quotaSentence(ctx, view)).join(' ') || ctx.v2.t('insights.summary.usage_none'), waiting.length ? tc(ctx, 'insights.quota.held', waiting.length, { count: waiting.length }) : null),
    refs: Object.fromEntries(waiting.filter((item) => item.ref).slice(0, 10).map((item) => [item.ref!, item.ref!])),
    warnings: sources.warnings, untrusted: untrusted('/data/held/*/title'),
  })
}

// ── capacity ───────────────────────────────────────────────────────────────

async function capacity(ctx: V2CallContext) {
  const [snapshot, quotaData] = await Promise.all([
    apiCall(ctx, 'GET', '/capacity'),
    apiCall(ctx, 'GET', '/provider-quota').catch(() => null),
  ])
  const data = rec(snapshot)
  if (data.enabled === false) return result({ enabled: false }, { summary: ctx.v2.t('insights.summary.capacity_off') })
  const limits = rec(data.limits)
  const projects = slugMap(ctx)
  const active = rows(data.active)
  const queued = rows(data.queued)
  const count = <K extends string>(list: Row[], key: K) => list.reduce<Record<string, number>>((acc, row) => { const value = String(row[key] ?? '?'); acc[value] = (acc[value] ?? 0) + 1; return acc }, {})
  const byProvider = count(active, 'provider')
  const perProvider = rec(limits.perProvider)
  const maxRuns = num(limits.maxRuns) ?? 0
  const quotas = quotaView(quotaData)
  const reasons = count(queued, 'waitingFor')
  // Providers that could take a quota-held run now: room in their window and a free provider slot.
  const quotaHeld = queued.filter((run) => run.waitingFor === 'provider_quota' || run.waitingFor === 'provider_slots')
  const switchTo = quotaHeld.length && active.length < maxRuns
    ? quotas.filter((view) => {
      const id = String(view.provider)
      const cap = num(perProvider[id])
      return view.level === 'ok' && quotaHeld.some((run) => run.provider !== id) && (cap === null || (byProvider[id] ?? 0) < cap)
    }).map((view) => String(view.provider))
    : []
  const out = {
    enabled: true,
    limits: { maxRuns, maxRunsPerProject: num(limits.maxRunsPerProject), perProvider, cpuBusyLimit: num(limits.cpuBusyLimit), minAvailableMemoryMb: num(limits.minAvailableMemoryMb), quotaReservePercent: num(limits.quotaReservePercent) },
    active: { count: active.length, free: Math.max(0, maxRuns - active.length), byProvider, byProject: Object.entries(count(active, 'projectId')).map(([id, runs]) => ({ project: projects.get(id) ? projectRef(projects.get(id)!) : id, runs })) },
    queued: queued.slice(0, ctx.v2.view === 'detail' ? 100 : 10).map((run) => ({
      run: runRef(projects, run.projectId, run.runId), project: projects.get(String(run.projectId)) ? projectRef(projects.get(String(run.projectId))!) : run.projectId,
      provider: run.provider, waitingFor: run.waitingFor, position: num(run.position), since: num(run.since) !== null ? new Date(num(run.since)!).toISOString() : null,
    })),
    queuedCount: queued.length, waitingFor: reasons,
    perRunWindowPct: rec(data.perRunPercent),
    ...(switchTo.length ? { switchTo } : {}),
  }
  const reasonText = Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${word(ctx, `insights.wait.${reason}`, reason)} (${n})`).join(', ')
  return result(out, {
    summary: join(
      tc(ctx, queued.length ? 'insights.summary.capacity' : 'insights.summary.capacity_free', queued.length, { active: active.length, max: maxRuns, queued: queued.length }),
      queued.length ? ctx.v2.t('insights.summary.capacity_reasons', { reasons: reasonText }) : null,
      switchTo.length ? ctx.v2.t('insights.summary.capacity_switch', { providers: switchTo.map(providerName).join(', ') }) : null,
    ),
    refs: Object.fromEntries(out.queued.filter((run) => run.run).map((run) => [run.run!, run.run!])),
  })
}

// ── preflight ──────────────────────────────────────────────────────────────

/** Provider ids a target names (`"claude,codex"`, `["codex"]`, `{providers}`, `{provider}`); `['']` = the primary (also `"primary"`). */
export function targetProviders(target: unknown): string[] {
  const value = typeof target === 'string' ? target : Array.isArray(target) ? target : rec(target).providers ?? rec(target).provider ?? rec(target).engine
  const list = (typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value.map(String) : []).map((id) => id.trim()).filter((id) => id !== 'primary' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(id))
  return list.length ? [...new Set(list)].slice(0, 8) : ['']
}

const gib = (bytes: number | null) => bytes === null ? '?' : `${(bytes / 1024 ** 3).toFixed(1)} GB`

function chipSentence(ctx: V2CallContext, chip: Row): string | null {
  const state = String(chip.state)
  if (state === 'ok') return null
  const provider = providerName(String(chip.providerId ?? ''))
  switch (chip.kind) {
    case 'disk': return state === 'unknown' ? null : ctx.v2.t(`insights.chip.disk.${state === 'fail' ? 'fail' : 'warn'}`, { free: gib(num(chip.freeBytes)) })
    case 'provider': return ctx.v2.t(`insights.chip.provider.${chip.status === 'signed-out' || chip.status === 'missing' ? chip.status : 'unknown'}`, { provider })
    case 'github': return state === 'warn' ? ctx.v2.t('insights.chip.github.warn') : null
    case 'quota': return state !== 'warn' ? null : chip.level === 'rejected' ? ctx.v2.t('insights.chip.quota.rejected', { provider, reset: clockText(ctx.v2.lang, str(chip.rejectedUntil)) }) : ctx.v2.t('insights.chip.quota.warn', { provider, pct: pctText(num(chip.usedPercent)) })
    case 'headless': return ctx.v2.t('insights.chip.headless.warn', { framework: String(chip.framework) })
    default: return null
  }
}

async function preflight(ctx: V2CallContext, args: Record<string, unknown>) {
  const project = ctx.v2.project(args)
  const options = optionsOf(args)
  const providers = targetProviders(options.target)
  const sources = sourcesOf()
  const [report, capacityData, capsData] = await Promise.all([
    apiCall(ctx, 'GET', `/launch-preflight${query({ projectId: project.id, providers: providers.join(','), fresh: options.fresh === true ? '1' : undefined })}`),
    attempt(ctx, sources, 'capacity', () => apiCall(ctx, 'GET', '/capacity')),
    attempt(ctx, sources, 'caps', () => apiCall(ctx, 'GET', `${projectPath(project)}/budget/caps`)),
  ])
  const chips = rows(rec(report).chips)
  const failing = chips.filter((chip) => chip.state === 'fail')
  const warning = chips.filter((chip) => chip.state === 'warn')
  const exhausted = capsOf(capsData?.caps).filter((cap) => cap.exhausted)
  const limits = rec(capacityData?.limits)
  const active = rows(capacityData?.active)
  const maxRuns = num(limits.maxRuns)
  const maxPerProject = num(limits.maxRunsPerProject)
  const slotsFull = capacityData?.enabled !== false && maxRuns !== null && active.length >= maxRuns
  const projectFull = capacityData?.enabled !== false && maxPerProject !== null && active.filter((run) => run.projectId === project.id).length >= maxPerProject
  const blockers = [
    ...failing.map((chip) => chipSentence(ctx, chip)).filter((text): text is string => !!text),
    ...exhausted.map((cap) => ctx.v2.t('insights.preflight.cap', { scope: ctx.v2.t(`insights.scope.${cap.scope}`), period: ctx.v2.t(`insights.cap.${cap.period}`) })),
  ]
  const queuedFor = [
    ...(slotsFull ? [ctx.v2.t('insights.preflight.slots', { max: maxRuns })] : []),
    ...(!slotsFull && projectFull ? [ctx.v2.t('insights.preflight.project_slots', { max: maxPerProject })] : []),
  ]
  const verdict = blockers.length ? 'blocked' : queuedFor.length ? 'queued' : 'ready'
  const warnings = warning.map((chip) => chipSentence(ctx, chip)).filter((text): text is string => !!text)
  const out = {
    verdict, project: projectRef(project), providers: providers.filter(Boolean),
    chips: chips.map((chip) => ({ id: chip.id, kind: chip.kind, state: chip.state, ...(chip.providerId ? { provider: chip.providerId } : {}), ...(chip.status ? { status: chip.status } : {}), ...(chip.kind === 'disk' ? { freeBytes: num(chip.freeBytes) } : {}), ...(chip.kind === 'quota' ? { level: chip.level, usedPct: num(chip.usedPercent), rejectedUntil: chip.rejectedUntil ?? null } : {}) })),
    blockers, queuedFor, warnings, exhaustedCaps: exhausted,
    capacity: capacityData ? { enabled: capacityData.enabled !== false, freeSlots: maxRuns === null ? null : Math.max(0, maxRuns - active.length) } : null,
    checkedAt: rec(report).checkedAt ?? null,
  }
  const name = project.name
  return result(out, {
    summary: join(
      verdict === 'blocked' ? ctx.v2.t('insights.preflight.blocked', { name, reasons: blockers.join('; ') })
        : verdict === 'queued' ? ctx.v2.t('insights.preflight.queued', { name, reasons: queuedFor.join('; ') })
          : ctx.v2.t('insights.preflight.ready', { name }),
      warnings.length ? ctx.v2.t('insights.preflight.warnings', { warnings: warnings.join('; ') }) : null,
    ),
    refs: { project: projectRef(project) }, warnings: sources.warnings,
  })
}

// ── forecast ───────────────────────────────────────────────────────────────

async function forecast(ctx: V2CallContext, args: Record<string, unknown>) {
  const project = ctx.v2.project(args)
  const options = optionsOf(args)
  const target = rec(options.target)
  const loopId = str(options.loopId) ?? str(target.loopId)
  const command = str(options.command) ?? str(target.command)
  const provider = str(options.provider) ?? str(target.provider)
  const runsRaw = num(options.runs)
  const runs = runsRaw !== null && runsRaw >= 1 ? Math.min(Math.floor(runsRaw), 500) : 1
  const sources = sourcesOf()
  const [data, capsData] = await Promise.all([
    apiCall(ctx, 'GET', `${projectPath(project)}/launch-forecast${query({ loopId: loopId ?? (command ? undefined : 'factory:implement'), command, provider })}`),
    attempt(ctx, sources, 'caps', () => apiCall(ctx, 'GET', `${projectPath(project)}/budget/caps`)),
  ])
  const value = rec(data)
  const time = value.time ? rec(value.time) : null
  const cost = value.cost ? rec(value.cost) : null
  const headroom = value.budget ? rec(value.budget) : null
  const projection = projectionOf(capsData?.projection)
  const low = cost ? num(cost.lowUsd) ?? 0 : null
  const high = cost ? num(cost.highUsd) ?? 0 : null
  const out = {
    project: projectRef(project), target: { loopId: loopId ?? (command ? null : 'factory:implement'), command, provider },
    time: time ? { p25Ms: num(time.p25Ms), medianMs: num(time.medianMs), p75Ms: num(time.p75Ms), samples: num(time.sampleCount) } : null,
    cost: cost ? { lowUsd: low, highUsd: high, samples: num(cost.sampleCount), estimate: true } : null,
    runs, ...(cost && runs > 1 ? { totalUsd: [cents(low! * runs), cents(high! * runs)] } : {}),
    minSamples: num(value.minSamples),
    budget: headroom ? { scope: headroom.scope === 'project' ? 'project' : 'app', period: headroom.period ?? 'day', budgetUsd: num(headroom.budgetUsd), spentUsd: num(headroom.spentUsd), exhausted: headroom.exhausted === true, resetsAt: headroom.resetsAt ?? null } : null,
    ...(projection ? { projection } : {}),
  }
  const timeText = time ? bandText(num(time.p25Ms) ?? 0, num(time.p75Ms) ?? 0) : null
  const head = time && cost ? ctx.v2.t('insights.summary.forecast', { time: timeText, low: usdText(ctx, low), high: usdText(ctx, high), samples: num(cost.sampleCount) ?? 0 })
    : time ? ctx.v2.t('insights.summary.forecast_time', { time: timeText, samples: num(time.sampleCount) ?? 0 })
      : ctx.v2.t('insights.summary.forecast_none', { min: num(value.minSamples) ?? 5 })
  return result(out, {
    summary: join(head, cost && runs > 1 ? ctx.v2.t('insights.summary.forecast_total', { runs, low: usdText(ctx, cents(low! * runs)), high: usdText(ctx, cents(high! * runs)) }) : null,
      projection ? ctx.v2.t('insights.summary.projection', { usd: usdText(ctx, projection.projectedUsd) }) : null),
    refs: { project: projectRef(project) }, warnings: sources.warnings,
  })
}

// ── what-if pricing ────────────────────────────────────────────────────────

const MODEL_REF = /^[a-z0-9][a-z0-9_-]{0,63}:[^\s:][^\s]{0,190}$/i

export function scenarioOf(value: unknown): { from: string; to: string; days: number | null } | 'list' | null {
  if (value === 'list') return 'list'
  if (typeof value === 'string') {
    const [from, to] = value.split(/\s*(?:->|→|=>)\s*/)
    return from && to && MODEL_REF.test(from) && MODEL_REF.test(to) ? { from, to, days: null } : null
  }
  const scenario = rec(value)
  const from = str(scenario.from)
  const to = str(scenario.to)
  const days = num(scenario.days)
  if (!from && !to) return Object.keys(scenario).length === 0 || scenario.list === true ? 'list' : null
  return from && to && MODEL_REF.test(from) && MODEL_REF.test(to) ? { from, to, days } : null
}

async function whatIf(ctx: V2CallContext, args: Record<string, unknown>) {
  const project = ctx.v2.project(args)
  const scenario = scenarioOf(optionsOf(args).scenario)
  if (!scenario) throw new V2ToolError('invalid_input', ctx.v2.t('insights.error.scenario'))
  const window = windowOf(ctx, args, '30d')
  const days = scenario !== 'list' && scenario.days ? scenario.days : window.days
  const data = rec(await apiCall(ctx, 'GET', `${projectPath(project)}/budget/what-if${query({ days, ...(scenario !== 'list' ? { from: scenario.from, to: scenario.to } : {}) })}`))
  const sources = rows(data.sources).map((source) => ({ model: `${String(source.provider)}:${String(source.model)}`, invocations: num(source.invocations) ?? 0, recordedUsd: money4(num(source.recordedUsd)), priced: source.priced === true }))
    .sort((a, b) => (b.recordedUsd ?? 0) - (a.recordedUsd ?? 0))
  const resultRow = data.result ? rec(data.result) : null
  const used = num(data.days) ?? days
  const out: Row = { project: projectRef(project), days: used, sources: sources.slice(0, ctx.v2.view === 'detail' ? 100 : 10) }
  if (ctx.v2.view === 'detail') out.targets = rows(data.targets).map((target) => `${String(target.provider)}:${String(target.model)}`)
  let summary: string
  if (resultRow) {
    const noPricing = resultRow.noPricing ? rec(resultRow.noPricing) : null
    out.result = {
      from: scenario !== 'list' ? scenario.from : null, to: scenario !== 'list' ? scenario.to : null, invocations: num(resultRow.invocations), repriced: num(resultRow.repriced), skipped: num(resultRow.skipped),
      tokens: resultRow.tokens ?? null, recordedUsd: num(resultRow.recordedUsd), currentUsd: num(resultRow.estimateCurrentUsd), whatIfUsd: num(resultRow.estimateWhatIfUsd), deltaUsd: num(resultRow.deltaUsd),
      noPricing: noPricing ? `${String(noPricing.provider)}:${String(noPricing.model)}` : null, estimate: true,
    }
    const delta = num(resultRow.deltaUsd)
    summary = noPricing ? ctx.v2.t('insights.summary.what_if_no_pricing', { model: `${String(noPricing.provider)}:${String(noPricing.model)}` })
      : !num(resultRow.repriced) ? ctx.v2.t('insights.summary.what_if_none', { from: scenario !== 'list' ? scenario.from : '?', days: used })
        : ctx.v2.t('insights.summary.what_if', {
          count: num(resultRow.repriced) ?? 0, from: scenario !== 'list' ? scenario.from : '?', to: scenario !== 'list' ? scenario.to : '?', days: used,
          current: usdText(ctx, num(resultRow.estimateCurrentUsd)), whatIf: usdText(ctx, num(resultRow.estimateWhatIfUsd)), delta: delta === null ? '?' : `${delta >= 0 ? '+' : '−'}${usdText(ctx, Math.abs(delta))}`,
        })
  } else {
    summary = sources.length
      ? ctx.v2.t('insights.summary.what_if_list', { count: sources.length, days: used, top: sources[0].model, usd: usdText(ctx, sources[0].recordedUsd) })
      : ctx.v2.t('insights.summary.what_if_list_empty', { days: used })
  }
  return result(out, { summary, refs: { project: projectRef(project) } })
}

// ── budgets ────────────────────────────────────────────────────────────────

const LIMIT_ALIASES: Record<string, 'day' | 'week' | 'month' | 'run' | 'alert'> = {
  day: 'day', daily: 'day', dailyBudgetUsd: 'day', desktopDailyBudgetUsd: 'day',
  week: 'week', weekly: 'week', weeklyBudgetUsd: 'week', desktopWeeklyBudgetUsd: 'week',
  month: 'month', monthly: 'month', monthlyBudgetUsd: 'month', desktopMonthlyBudgetUsd: 'month',
  run: 'run', runCapUsd: 'run',
  alert: 'alert', jobCostThresholdUsd: 'alert', costAlertThresholdUsd: 'alert',
}
const APP_FIELDS = { day: 'desktopDailyBudgetUsd', week: 'desktopWeeklyBudgetUsd', month: 'desktopMonthlyBudgetUsd', run: 'runCapUsd', alert: 'costAlertThresholdUsd' } as const
const PROJECT_FIELDS = { day: 'dailyBudgetUsd', week: 'weeklyBudgetUsd', month: 'monthlyBudgetUsd', run: 'runCapUsd', alert: 'jobCostThresholdUsd' } as const

/** `options.limits` → the PATCH body of the scope's budget route. Numbers > 0 set, null clears. */
export function budgetPatch(scope: 'app' | 'project', limits: unknown, message: string): Record<string, number | null> {
  const value = rec(limits)
  const entries = Object.entries(value)
  if (!entries.length) throw new V2ToolError('invalid_input', message)
  const fields = scope === 'app' ? APP_FIELDS : PROJECT_FIELDS
  const body: Record<string, number | null> = {}
  for (const [key, raw] of entries) {
    const limit = LIMIT_ALIASES[key]
    const valid = raw === null || (typeof raw === 'number' && Number.isFinite(raw) && raw > 0 && raw <= 1_000_000)
    if (!limit || !valid) throw new V2ToolError('invalid_input', `${key}: ${message}`)
    body[fields[limit]] = raw === null ? null : Math.round((raw as number) * 100) / 100
  }
  return body
}

async function readBudget(ctx: V2CallContext, scope: Scope) {
  const sources = sourcesOf()
  const project = scope.project
  const tz = String(-new Date().getTimezoneOffset())
  const [budget, caps, held] = await Promise.all([
    attempt(ctx, sources, 'budget', () => apiCall(ctx, 'GET', project ? `${projectPath(project)}/budget${query({ tzOffsetMinutes: tz })}` : '/budget')),
    attempt(ctx, sources, 'caps', () => apiCall(ctx, 'GET', project ? `${projectPath(project)}/budget/caps` : '/budget/caps')),
    heldItems(ctx, sources, (item) => !String(item.detail ?? '').startsWith('usage_limit:') && (!project || item.projectId === project.id)),
  ])
  if (!budget && !caps) throw new V2ToolError('provider_unavailable', sources.warnings.join(' '))
  const b = rec(budget)
  const limits = project
    ? { day: num(b.dailyBudgetUsd), week: num(b.weeklyBudgetUsd), month: num(b.monthlyBudgetUsd), run: num(b.runCapUsd), alert: num(b.jobCostThresholdUsd) }
    : { day: num(b.desktopDailyBudgetUsd), week: num(b.desktopWeeklyBudgetUsd), month: num(b.desktopMonthlyBudgetUsd), run: num(b.runCapUsd), alert: num(b.costAlertThresholdUsd) }
  const capViews = capsOf(caps?.caps)
  // A project's caps read model also lists the app-wide caps that bind it.
  const appLimits = project && caps?.appConfig ? rec(caps.appConfig) : null
  const heldRuns = held.filter((item) => item.kind === 'run_cap')
  const data = {
    scope: scope.scope, ...(project ? { project: projectRef(project) } : {}), limits,
    ...(appLimits ? { appLimits: { day: num(appLimits.day), week: num(appLimits.week), month: num(appLimits.month), run: num(appLimits.run) } } : {}),
    caps: capViews, today: { usd: cents(num(b.costToday) ?? 0), pricedRuns: num(b.pricedRuns), unpricedRuns: num(b.unpricedRuns) },
    held: held.slice(0, ctx.v2.view === 'detail' ? 100 : 10), heldRuns: heldRuns.length,
    ...(projectionOf(caps?.projection) ? { projection: projectionOf(caps?.projection) } : {}),
  }
  return { data, sources, capViews, heldRuns, limits }
}

function budgetSummary(ctx: V2CallContext, scope: Scope, read: Awaited<ReturnType<typeof readBudget>>): string {
  const cap = tightest(read.capViews)
  const head = cap ? capSentence(ctx, cap)
    : read.limits.run === null ? ctx.v2.t('insights.summary.budget_none', { where: whereText(ctx, scope.project), usd: usdText(ctx, read.data.today.usd) }) : null
  return join(head,
    read.limits.run !== null ? ctx.v2.t('insights.summary.run_cap', { budget: usdText(ctx, read.limits.run) }) : null,
    read.heldRuns.length ? tc(ctx, 'insights.summary.budget_held', read.heldRuns.length, { count: read.heldRuns.length }) : null)
}

function budgetState(ctx: V2CallContext, scope: Scope, read: Awaited<ReturnType<typeof readBudget>>) {
  const exhausted = read.capViews.find((cap) => cap.exhausted)
  if (!exhausted) return undefined
  const args = { scope: exhausted.scope === 'app' ? 'app' : 'project', ...(exhausted.scope === 'project' && scope.project ? { project: projectRef(scope.project) } : {}) }
  return ctx.v2.state({
    status: 'blocked',
    hold: {
      kind: 'budget', code: `cap_${exhausted.period}`, reasonKey: 'insights.hold.cap_exhausted', since: null, resumeAt: exhausted.resetsAt,
      params: { scope: ctx.v2.t(`insights.scope.${exhausted.scope}`), period: ctx.v2.t(`insights.cap.${exhausted.period}`), budget: usdText(ctx, exhausted.budgetUsd), reset: clockText(ctx.v2.lang, exhausted.resetsAt) },
    },
    offers: [{ id: 'budget.raise', labelKey: 'insights.offer.raise_cap', call: { tool: 'specrails_insights', args: { action: 'budget_set', ...args } }, needs: ['options.limits'] }],
    recommended: null,
    versionFacts: read.capViews.map((cap) => [cap.scope, cap.period, cap.budgetUsd, cap.exhausted]),
  })
}

async function budgetGet(ctx: V2CallContext, args: Record<string, unknown>) {
  const scope = scopeOf(ctx, args)
  const read = await readBudget(ctx, scope)
  const refs: Record<string, Ref> = scope.project ? { project: projectRef(scope.project) } : {}
  for (const item of read.data.held) if (item.ref) refs[item.ref] = item.ref
  return result(read.data, {
    summary: budgetSummary(ctx, scope, read), refs, state: budgetState(ctx, scope, read),
    warnings: read.sources.warnings, untrusted: untrusted('/data/held/*/title'),
  })
}

async function budgetSet(ctx: V2CallContext, args: Record<string, unknown>) {
  const scope: Scope = args.scope === 'project' ? { scope: 'project', project: ctx.v2.project(args) } : { scope: 'app', project: null }
  const body = budgetPatch(scope.scope, optionsOf(args).limits, ctx.v2.t('insights.error.limits'))
  await apiCall(ctx, 'PATCH', scope.project ? `${projectPath(scope.project)}/budget` : '/budget', body)
  const read = await readBudget(ctx, scope)
  return result(read.data, {
    summary: join(ctx.v2.t('insights.summary.budget_saved', { scope: ctx.v2.t(`insights.scope.${scope.scope}`) }), budgetSummary(ctx, scope, read)),
    refs: scope.project ? { project: projectRef(scope.project) } : {}, state: budgetState(ctx, scope, read),
    warnings: read.sources.warnings, untrusted: untrusted('/data/held/*/title'),
  })
}

// ── resources (CPU, memory) ────────────────────────────────────────────────

function bytesText(bytes: number | null): string {
  if (bytes === null) return '?'
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}
const totalsOf = (value: unknown) => ({ cpuPercent: num(rec(value).cpuPercent), memoryBytes: num(rec(value).memoryBytes), processCount: num(rec(value).processCount) })

async function resources(ctx: V2CallContext, args: Record<string, unknown>) {
  const options = optionsOf(args)
  const missionArg = str(options.mission)
  const top = ctx.v2.view === 'detail' ? 20 : 5
  if (missionArg) return missionResources(ctx, args, missionArg, top)
  const data = rec(await apiCall(ctx, 'GET', '/resources'))
  const totals = totalsOf(data.totals)
  const projects = slugMap(ctx)
  const categories = rows(data.categories).map((category) => ({
    id: category.id, ...totalsOf(category), itemCount: rows(category.items).length,
    items: rows(category.items).sort((a, b) => (num(b.memoryBytes) ?? 0) - (num(a.memoryBytes) ?? 0)).slice(0, top).map((item) => {
      const project = typeof item.projectId === 'string' ? projects.get(item.projectId) : undefined
      return {
        label: neutralize(String(item.label ?? '')), ...(project ? { project: projectRef(project) } : {}),
        ...(str(item.chatId) ? { mission: formatRef('mission', String(item.chatId)) } : {}), ...(item.runId ? { run: runRef(projects, item.projectId, item.runId) } : {}), ...totalsOf(item),
      }
    }),
  })).filter((category) => (category.processCount ?? 0) > 0 || category.itemCount > 0)
  const heaviest = [...categories].sort((a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0))[0]
  if (data.supported === false) return result({ supported: false }, { summary: ctx.v2.t('insights.summary.resources_unsupported') })
  return result({ supported: true, measuredAt: data.measuredAt ?? null, totals, categories }, {
    summary: join(
      ctx.v2.t('insights.summary.resources', { cpu: pctText(totals.cpuPercent), memory: bytesText(totals.memoryBytes), processes: totals.processCount ?? '?' }),
      heaviest ? ctx.v2.t('insights.summary.resources_heaviest', { category: String(heaviest.id), memory: bytesText(heaviest.memoryBytes) }) : null,
    ),
    untrusted: untrusted('/data/categories/*/items/*/label'),
  })
}

async function missionResources(ctx: V2CallContext, args: Record<string, unknown>, missionArg: string, top: number) {
  const parsed = parseRef(missionArg)
  const conversationId = parsed?.kind === 'mission' ? parsed.id : missionArg
  let project: ProjectRow | null = present(args.project) ? ctx.v2.project(args) : null
  if (!project) {
    const conversation = rec(rec(await apiCall(ctx, 'GET', `/agent/conversations/${encodeURIComponent(conversationId)}`).catch(() => null)).conversation)
    const pinned = typeof conversation.pinned_project_id === 'string' ? ctx.v2.projects().find((row) => row.id === conversation.pinned_project_id) : undefined
    project = pinned ?? (ctx.sessionState.activeProjectId ? ctx.v2.project(args) : null)
  }
  if (!project) throw new V2ToolError('ambiguous', ctx.v2.t('insights.error.mission_project'))
  const data = rec(await apiCall(ctx, 'GET', `${projectPath(project)}/missions/${encodeURIComponent(conversationId)}/resources`))
  const totals = totalsOf(data.totals)
  const entries = rows(data.entries).sort((a, b) => (num(b.cpuPercent) ?? 0) - (num(a.cpuPercent) ?? 0))
  const ref = formatRef('mission', conversationId)
  if (data.supported === false) return result({ supported: false, mission: ref }, { summary: ctx.v2.t('insights.summary.resources_unsupported'), refs: { mission: ref } })
  return result({
    supported: true, mission: ref, project: projectRef(project), sampledAt: data.sampledAt ?? null, totals,
    entries: entries.slice(0, top).map((entry) => ({ label: neutralize(String(entry.label ?? entry.command ?? '')), pid: entry.pid ?? null, ...totalsOf(entry) })), entryCount: entries.length,
    ...(ctx.v2.view === 'detail' ? { history: rows(data.history).slice(-20) } : {}), worktree: data.worktree ?? null,
  }, {
    summary: ctx.v2.t('insights.summary.mission_resources', { cpu: pctText(totals.cpuPercent), memory: bytesText(totals.memoryBytes), processes: totals.processCount ?? entries.length }),
    refs: { mission: ref, project: projectRef(project) }, untrusted: untrusted('/data/entries/*/label'),
  })
}

// ── The tool ───────────────────────────────────────────────────────────────

/** WP8. Spend, analytics, subscription usage, quotas, capacity, forecasts and budgets. */
export const insightsTool = defineTool({
  name: 'specrails_insights',
  title: 'Insights',
  description: 'Spend and analytics, subscription usage and provider quotas, capacity, preflight, forecasts, what-if, budgets, machine resources.',
  owner: 'WP8',
  fields: {
    project: F.project,
    scope: z.enum(['app', 'project']),
    report: z.enum(['dashboard', 'invocations', 'ticket_summary', 'decision_times', 'loop_economics', 'profiles']).describe('analytics'),
    since: z.string().describe('today|week|month|7d|30d|90d|all or ISO'),
    until: z.string(),
    view: F.view,
    cursor: F.cursor,
    limit: F.limit,
    lang: F.lang,
    options: F.options,
  },
  actions: {
    spend: { tier: 'read', doc: 'Spend by period (default today), app-wide or per project: billed vs estimated, by category/provider, costliest projects/specs/missions, caps, projection.', handler: spend },
    analytics: { tier: 'read', doc: 'report: dashboard (default), invocations (paged; options provider/model/surface/status/minCostUsd/sortBy/spec), ticket_summary (options.spec), decision_times, loop_economics, profiles.', handler: analytics },
    export: { tier: 'read', maxTokens: 10_000, doc: 'Analytics export inline; options.format csv|json, options.mode summary|raw.', handler: exportReport },
    usage: { tier: (args) => (args.options as Record<string, unknown> | undefined)?.refresh === true ? 'write' : 'read', doc: 'Subscription meters per provider (5-hour/weekly windows, resets); options.refresh asks the providers again; options.provider filters.', handler: usage },
    quota: { tier: 'read', doc: 'Provider usage-limit state and the runs waiting for a limit reset.', handler: quota },
    capacity: { tier: 'read', doc: 'Run admission: slots, queued runs and what each waits for, providers with room.', handler: capacity },
    preflight: { tier: 'read', required: ['options.target'], doc: 'Would a launch start now? options.target: provider ids ("claude,codex", "primary") or {providers}; options.fresh re-probes.', handler: preflight },
    forecast: { tier: 'read', doc: 'Duration and cost band of runs like this (options.loopId|command|provider|runs) plus the month-end projection.', handler: forecast },
    what_if: { tier: 'read', required: ['options.scenario'], doc: 'Re-price recorded usage: options.scenario {from:"claude:opus", to:"claude:sonnet", days?} or "list".', handler: whatIf },
    budget_get: { tier: 'read', doc: 'Caps (day/week/month/run, alert) with spend, resets and what they hold; scope app or project.', handler: budgetGet },
    budget_set: { tier: 'write', required: ['scope', 'options.limits'], doc: 'options.limits {day, week, month, run, alert}: number > 0 sets, null clears.', handler: budgetSet },
    resources: { tier: 'read', doc: 'CPU and memory of everything Specrails launched; options.mission for one mission.', handler: resources },
  },
})
