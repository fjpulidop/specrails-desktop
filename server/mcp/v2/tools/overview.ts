import { defineTool, type V2CallContext } from '../core/registry'
import { F, resolveFields } from '../core/views'
import { asRecord } from '../core/text'
import { result } from '../core/envelope'
import { formatRef, type Ref } from '../core/refs'
import { untrusted } from '../core/untrusted'
import { statusFromDelivery, statusFromJob, statusFromWord, type CanonicalStatus } from '../core/status-map'
import { apiCall, McpApiError } from '../../tools/types'
import { collectBoard } from '../../tools/board'
import { contextTools } from '../../tools/context'
import type { InboxItem } from '../../../modules/inbox'
import type { ProviderQuotaView } from '../../../modules/provider-quota/domain'
import { applyInboxDismissals } from '../../../mobile/mobile-inbox'
import { compareUrgency, inboxItemState, inboxRefOf, itemScope, leanItem, readInboxFacts, ITEM_UNTRUSTED, LEAN_UNTRUSTED } from './inbox'

/**
 * WP2 `specrails_overview`: "what is going on" in one call, from the app's
 * own app-level read models — the live board (`GET /api/live-board`, which
 * already carries every inbox item, today's spend and the per-project
 * settled-read cache, read in event-loop slices), provider quota (memory) and
 * running mission turns (memory). No per-project fan-out on the hot path:
 * decision-ready state is projected only for the few items shown.
 */

type Row = Record<string, unknown>

/**
 * The `GET /api/live-board` wire shape this tool reads (modules/live-board
 * domain.ts, structurally; MCP reads the route, not the module).
 */
export type LiveRunStatus =
  | { source: 'job'; status: string }
  | { source: 'loop-run'; status: 'running' | 'paused' | 'completed'; outcome: string | null; restartReason: string | null }
  | { source: 'delivery'; decision: string; statusCode: string | null; paused?: boolean; queued?: { waitingFor: string; position: number } }
  | { source: 'intent'; state: string }
  | { source: 'attention' }
interface Card {
  id: string
  projectId: string
  kind: string | null
  column: 'needs' | 'working' | 'done'
  status: LiveRunStatus
  title: string | null
  phase: string | null
  provider: string | null
  model: string | null
  at: string
  costUsd: number | null
  costEstimated: boolean
  steps: { done: number; total: number } | null
  ticketIds: number[]
  conversationId: string | null
  jobId: string | null
  deliveryId: string | null
  attempt?: { number: number; of: number } | null
  attention: InboxItem | null
  mergePreview?: { status: string } | null
}
interface Lane { conversationId: string | null; title: string | null; provider: string | null; cardIds: string[]; todayCostUsd: number | null }
interface Board {
  cards: Card[]
  lanes: Lane[]
  totals: { needsYou: number; inProgress: number; doneToday: number; costTodayUsd: number | null; costTodayEstimated: boolean }
}
const record = asRecord

const SOURCE_TIMEOUT_MS = 8_000
/** Items per list in the summary view and in detail. */
const LIST = { summary: 5, detail: 15 } as const
/** Running and delivered cards in the app glance. */
const CARDS = { summary: 3, detail: 15 } as const
const LIVE_LIST = { summary: 8, detail: 30 } as const

type Read<T> = { ok: true; value: T } | { ok: false; error: string; disabled?: boolean }

async function read<T>(ctx: V2CallContext, path: string, optional404 = false): Promise<Read<T>> {
  try {
    return { ok: true, value: await apiCall(ctx, 'GET', path, undefined, { timeoutMs: SOURCE_TIMEOUT_MS }) as T }
  } catch (err) {
    if (ctx.signal?.aborted) throw err
    if (err instanceof McpApiError) return { ok: false, error: `HTTP ${err.status}`, disabled: optional404 && err.status === 404 }
    return { ok: false, error: err instanceof Error ? err.message.slice(0, 120) : 'failed' }
  }
}

// ── Cards ───────────────────────────────────────────────────────────────────

/** A live-board card's status in the v2 vocabulary (the owning capability's word, mapped by status-map). */
export function cardStatus(status: LiveRunStatus): CanonicalStatus {
  switch (status.source) {
    case 'job': return statusFromJob(status.status)
    case 'loop-run': return status.status === 'completed' ? statusFromWord(status.outcome ?? 'completed') : statusFromWord(status.status)
    case 'delivery': return status.queued ? 'queued' : status.paused ? 'paused' : statusFromDelivery(status.decision)
    case 'intent': return statusFromWord(status.state === 'needs-review' ? 'review' : status.state)
    case 'attention': return 'needs_you'
  }
}

/** The entity a card stands for, as a global ref. */
export function cardRef(card: Card, slug: string): Ref | null {
  if (card.deliveryId) return formatRef('delivery', card.deliveryId, slug)
  if (card.status.source === 'intent') return formatRef('intent', card.id.split(':').slice(2).join(':'), slug)
  if (card.jobId) return formatRef('run', card.jobId, slug)
  if (card.attention) return inboxRefOf(card.attention)
  return null
}

function cardLine(card: Card, slug: string, detail: boolean): Row {
  const ref = cardRef(card, slug)
  return {
    ...(ref ? { ref } : {}),
    // The ref names the project; a card without one (an inbox item that is not a run) says it.
    ...(!ref || detail || ref.startsWith('inbox:') ? { project: slug } : {}),
    ...(card.kind ? { kind: card.kind } : {}),
    title: card.title,
    status: cardStatus(card.status),
    ...(card.phase ? { phase: card.phase } : {}),
    ...(card.attempt ? { attempt: `${card.attempt.number}/${card.attempt.of}` } : {}),
    ...(card.provider ? { provider: card.provider } : {}),
    ...(detail ? { at: card.at } : {}),
    ...(card.attention ? { item: inboxRefOf(card.attention) } : {}),
    ...(detail && card.model ? { model: card.model } : {}),
    ...(detail && card.costUsd !== null && card.costUsd !== undefined ? { costUsd: Math.round(card.costUsd * 100) / 100, ...(card.costEstimated ? { costEstimated: true } : {}) } : {}),
    ...(detail && card.steps ? { steps: `${card.steps.done}/${card.steps.total}` } : {}),
    ...(detail && card.ticketIds?.length ? { specs: card.ticketIds.slice(0, 5).map((id) => formatRef('spec', id, slug)) } : {}),
    ...(detail && card.conversationId ? { mission: formatRef('mission', card.conversationId) } : {}),
    ...(detail && card.mergePreview && card.mergePreview.status !== 'unknown' ? { merge: card.mergePreview.status } : {}),
  }
}

const CARD_UNTRUSTED = (path: string) => [`${path}/*/title`, `${path}/*/phase`]

/** Inbox items as the board carries them, minus the ones snoozed or done server-side, most urgent first. */
function attentionOf(ctx: V2CallContext, board: Board, projectId: string | null): InboxItem[] {
  const items = board.cards.map((card) => card.attention).filter((item): item is InboxItem => !!item && (!projectId || item.projectId === projectId))
  return applyInboxDismissals(ctx.desktopDb, items).visible.sort(compareUrgency)
}

// ── app ─────────────────────────────────────────────────────────────────────

type Mood = 'idle' | 'working' | 'needs_you' | 'failing'

async function appOverview(ctx: V2CallContext, args: Row) {
  const detail = ctx.v2.view === 'detail'
  const sections = resolveFields(args, ['columns', 'rails', 'queue', 'blueprint', 'lanes', 'sections'] as const)
  const [boardRead, quotaRead, turnsRead] = await Promise.all([
    read<Board>(ctx, '/live-board'),
    read<{ providers?: ProviderQuotaView[] }>(ctx, '/provider-quota'),
    read<{ turns?: Row[]; sessions?: Row[] }>(ctx, '/agent/active-turns', true),
  ])
  const warnings: string[] = []
  for (const [name, source] of [['live-board', boardRead], ['provider-quota', quotaRead], ['active-turns', turnsRead]] as const) {
    if (!source.ok && !source.disabled) warnings.push(`partial: ${name} unavailable (${source.error})`)
  }
  const board: Board = boardRead.ok ? boardRead.value : { cards: [], lanes: [], totals: { needsYou: 0, inProgress: 0, doneToday: 0, costTodayUsd: null, costTodayEstimated: false } }
  const scope = itemScope(ctx)
  const limit = detail ? LIST.detail : LIST.summary

  const attention = attentionOf(ctx, board, null)
  const shownItems = attention.slice(0, limit)
  const facts = readInboxFacts(scope, shownItems)
  const states = new Map(shownItems.map((item) => [item.id, inboxItemState(ctx, item, scope.slugOf(item.projectId), facts.get(item.id))]))
  const needsYou = shownItems.map((item) => leanItem(item, scope.slugOf(item.projectId), states.get(item.id)!))

  const working = board.cards.filter((card) => card.column === 'working')
  const done = board.cards.filter((card) => card.column === 'done')
  const failing = attention.filter((item) => item.kind === 'failed' || item.kind === 'blocked').length
  const asks = attention.length - failing
  const turns = turnsRead.ok ? (Array.isArray(turnsRead.value.turns) ? turnsRead.value.turns.map(record) : []) : []
  const mood: Mood = asks ? 'needs_you' : failing ? 'failing' : working.length || turns.length ? 'working' : 'idle'

  const caps = attention.filter((item) => item.cap).map((item) => ({ item: inboxRefOf(item), scope: item.cap!.scope === 'desktop' ? 'app' : 'project', ...(item.cap!.scope === 'project' ? { project: scope.slugOf(item.projectId) } : {}), period: item.cap!.period, budgetUsd: item.cap!.budgetUsd, spentUsd: item.cap!.spentUsd, resetsAt: item.cap!.resetsAt }))
  const quota = (quotaRead.ok ? quotaRead.value.providers ?? [] : [])
    .filter((view) => view.level === 'warning' || view.level === 'critical' || view.level === 'rejected')
    .map((view) => ({ provider: view.providerId, level: view.level, ...(view.usedPercent !== null ? { usedPercent: Math.round(view.usedPercent) } : {}), ...(view.rejectedUntil ? { until: view.rejectedUntil } : view.rejectedIndefinitely ? { until: null } : {}) }))
  const costToday = board.totals.costTodayUsd

  // Recommended next actions: the domain's recommended offer (or the first) of the most urgent items, runnable as is.
  const next: Row[] = []
  for (const item of shownItems) {
    if (next.length >= 2) break
    const state = states.get(item.id)!
    const offer = state.offers.find((candidate) => candidate.id === state.recommended) ?? state.offers[0]
    if (!offer) continue
    next.push({ label: ctx.v2.t('overview.next.act', { label: offer.label, title: item.title }), call: { tool: 'specrails_inbox', args: { action: 'act', ref: inboxRefOf(item), offerId: offer.id } }, ...(offer.needs ? { needs: offer.needs } : {}), ...(offer.needsConfirm ? { confirm: true } : {}) })
  }
  if (attention.length > shownItems.length) next.push({ label: ctx.v2.t('overview.next.inbox'), call: { tool: 'specrails_inbox', args: { action: 'list' } } })
  const runningRefs = working.slice(0, 10).map((card) => cardRef(card, scope.slugOf(card.projectId))).filter((ref): ref is Ref => !!ref)
  if (!attention.length && runningRefs.length) next.push({ label: ctx.v2.t('overview.next.wait'), call: { tool: 'specrails_wait', args: { action: 'until', refs: runningRefs, for: 'settled' } } })
  if (!next.length) next.push({ label: ctx.v2.t('overview.next.projects'), call: { tool: 'specrails_projects', args: { action: 'list' } } })

  const data: Row = {
    mood,
    counts: { needsYou: attention.length, running: board.totals.inProgress, doneToday: board.totals.doneToday, failing, projects: ctx.v2.projects().length, missionsRunning: turns.length },
    needsYou,
    running: working.slice(0, detail ? CARDS.detail : CARDS.summary).map((card) => cardLine(card, scope.slugOf(card.projectId), detail)),
    delivered: done.slice(0, detail ? CARDS.detail : CARDS.summary).map((card) => cardLine(card, scope.slugOf(card.projectId), detail)),
    spend: { todayUsd: costToday === null ? null : Math.round(costToday * 100) / 100, ...(board.totals.costTodayEstimated ? { estimated: true } : {}), ...(caps.length ? { capsReached: caps } : {}) },
    ...(quota.length ? { quota } : {}),
    ...(turns.length ? { missions: turns.slice(0, limit).map((turn) => formatRef('mission', String(turn.conversationId))) } : {}),
    next,
  }
  if (detail && sections.includes('lanes')) {
    data.lanes = board.lanes.slice(0, 10).map((lane) => ({ ...(lane.conversationId ? { mission: formatRef('mission', lane.conversationId) } : {}), title: lane.title, provider: lane.provider, cards: lane.cardIds.length, ...(lane.todayCostUsd !== null ? { todayCostUsd: Math.round(lane.todayCostUsd * 100) / 100 } : {}) }))
  }

  const t = ctx.v2.t
  const parts = [
    board.totals.inProgress ? t('overview.summary.running', { count: board.totals.inProgress }) : null,
    asks ? t('overview.summary.needs_you', { count: asks }) : null,
    failing ? t('overview.summary.failing', { count: failing }) : null,
    board.totals.doneToday ? t('overview.summary.done_today', { count: board.totals.doneToday }) : null,
  ].filter(Boolean)
  const spend = costToday === null ? '' : t(board.totals.costTodayEstimated ? 'overview.summary.spend_estimated' : 'overview.summary.spend', { usd: costToday.toFixed(2) })
  const top = attention[0]
  const summary = `${t('overview.summary.app', { headline: parts.length ? parts.join(', ') : t('overview.mood.idle'), spend })}${top ? t('overview.summary.top', { title: top.title, project: top.projectName }) : ''}`
  return result(data, {
    summary,
    ...(warnings.length ? { warnings } : {}),
    untrusted: untrusted(...(detail ? ITEM_UNTRUSTED : LEAN_UNTRUSTED).map((field) => `/data/needsYou/*/${field}`), ...CARD_UNTRUSTED('/data/running'), ...CARD_UNTRUSTED('/data/delivered'), '/data/next/*/label', '/data/lanes/*/title', '/summary'),
  })
}

// ── live ────────────────────────────────────────────────────────────────────

async function liveOverview(ctx: V2CallContext, args: Row) {
  const detail = ctx.v2.view === 'detail'
  const sections = resolveFields(args, ['columns', 'rails', 'queue', 'blueprint', 'lanes', 'sections'] as const)
  const project = typeof args.project === 'string' && args.project.trim() ? ctx.v2.project(args) : null
  const board = record(await apiCall(ctx, 'GET', '/live-board')) as unknown as Board
  const scope = itemScope(ctx)
  const cards = (board.cards ?? []).filter((card) => !project || card.projectId === project.id)
  const dismissed = new Set(applyInboxDismissals(ctx.desktopDb, cards.map((card) => card.attention).filter((item): item is InboxItem => !!item)).hidden.map((item) => item.id))
  const visible = cards.filter((card) => !card.attention || !dismissed.has(card.attention.id))
  const limit = detail ? LIVE_LIST.detail : LIVE_LIST.summary
  const column = (name: 'needs' | 'working' | 'done') => visible.filter((card) => card.column === name)
  const columns = { needs: column('needs'), working: column('working'), done: column('done') }
  const data: Row = {
    counts: { needs: columns.needs.length, working: columns.working.length, done: columns.done.length },
    needs: columns.needs.slice(0, limit).map((card) => cardLine(card, scope.slugOf(card.projectId), detail)),
    working: columns.working.slice(0, limit).map((card) => cardLine(card, scope.slugOf(card.projectId), detail)),
    done: columns.done.slice(0, limit).map((card) => cardLine(card, scope.slugOf(card.projectId), detail)),
    ...(board.totals?.costTodayUsd !== null && board.totals?.costTodayUsd !== undefined ? { costTodayUsd: Math.round(board.totals.costTodayUsd * 100) / 100 } : {}),
    ...(dismissed.size ? { dismissed: dismissed.size } : {}),
  }
  if (detail && sections.includes('lanes')) {
    const ids = new Set(visible.map((card) => card.id))
    data.lanes = (board.lanes ?? []).filter((lane) => lane.cardIds.some((id) => ids.has(id))).slice(0, 15).map((lane) => {
      const own = visible.filter((card) => lane.cardIds.includes(card.id))
      return { ...(lane.conversationId ? { mission: formatRef('mission', lane.conversationId) } : {}), title: lane.title, provider: lane.provider, ...(lane.todayCostUsd !== null ? { todayCostUsd: Math.round(lane.todayCostUsd * 100) / 100 } : {}), cards: own.slice(0, 10).map((card) => cardRef(card, scope.slugOf(card.projectId))).filter(Boolean) }
    })
  }
  return result(data, {
    summary: ctx.v2.t('overview.summary.live', { needs: columns.needs.length, working: columns.working.length, done: columns.done.length, scope: project ? ` (${project.slug})` : '' }),
    ...(project ? { refs: { project: formatRef('project', project.slug) } } : {}),
    untrusted: untrusted(...CARD_UNTRUSTED('/data/needs'), ...CARD_UNTRUSTED('/data/working'), ...CARD_UNTRUSTED('/data/done'), '/data/lanes/*/title'),
  })
}

// ── project ─────────────────────────────────────────────────────────────────

async function projectOverview(ctx: V2CallContext, args: Row) {
  const row = ctx.v2.project({ ...args, project: args.project ?? args.projectId })
  const detail = ctx.v2.view === 'detail'
  const sections = resolveFields(args, ['columns', 'rails', 'queue', 'blueprint', 'lanes', 'sections'] as const)
  const board = await collectBoard(ctx, row.id, { perColumn: detail && sections.includes('columns') ? 5 : 0 })
  const slug = row.slug
  const warnings = Object.entries(board.sources).filter(([, status]) => status !== 'ok').map(([name, status]) => `partial: ${name} unavailable (${status})`)
  const rails = board.rails.map((rail) => {
    const running = rail.running && typeof rail.running.jobId === 'string' ? { ref: formatRef('run', rail.running.jobId, slug), kind: rail.running.kind, ...(rail.running.startedAt ? { since: rail.running.startedAt } : {}) } : null
    const delivery = rail.delivery && typeof rail.delivery.id === 'string' ? { ref: formatRef('delivery', rail.delivery.id, slug), status: statusFromDelivery(String(rail.delivery.decision ?? '')), decision: rail.delivery.decision ?? null } : null
    return {
      ref: formatRef('rail', rail.railIndex, slug), label: rail.label, ...(rail.availability ? { availability: rail.availability } : {}),
      ...(rail.ticketIds.length ? { specs: rail.ticketIds.map((id) => formatRef('spec', id, slug)) } : {}),
      ...(running ? { running } : {}), ...(delivery ? { delivery } : {}),
    }
  })
  const data: Row = {
    project: formatRef('project', slug),
    specs: { total: board.total, columns: Object.fromEntries(board.columns.filter((column) => column.count > 0).map((column) => [column.status, column.count])) },
    rails,
    ...(board.queue ? { queue: board.queue.activeJobId ? { ...board.queue, activeJobId: undefined, active: formatRef('run', board.queue.activeJobId, slug) } : { queued: board.queue.queued, paused: board.queue.paused } } : {}),
  }
  if (detail && sections.includes('columns')) {
    data.top = Object.fromEntries(board.columns.filter((column) => column.top.length).map((column) => [column.status, column.top.map((spec) => ({ ref: formatRef('spec', String(spec.id), slug), title: spec.title, ...(spec.priority ? { priority: spec.priority } : {}) }))]))
  }
  if (detail && sections.includes('blueprint')) {
    const blueprint = await read<Row>(ctx, `/projects/${encodeURIComponent(row.id)}/blueprint`)
    const value = blueprint.ok ? record(blueprint.value.blueprint) : null
    if (value && Object.keys(value).length) {
      const milestones = (Array.isArray(value.milestones) ? value.milestones : []).map(record)
      data.blueprint = { product: record(value.product).name ?? value.product ?? null, milestones: milestones.slice(0, 10).map((milestone) => ({ title: milestone.title ?? milestone.name ?? null, ...(milestone.status ? { status: milestone.status } : {}) })), total: milestones.length }
    }
  }
  const t = ctx.v2.t
  const reviews = board.rails.filter((rail) => rail.delivery?.decision === 'on_review').length
  const queued = board.queue?.queued ?? 0
  return result(data, {
    summary: t('overview.summary.project', {
      name: row.name, specs: board.total,
      columns: board.columns.filter((column) => column.count > 0).map((column) => `${column.status.replace(/_/g, ' ')} ${column.count}`).join(', ') || '—',
      rails: board.rails.length, running: board.running.length,
      reviews: reviews ? t('overview.summary.project_reviews', { count: reviews }) : '',
      queue: queued ? `${t('overview.summary.project_queue', { count: queued })}${board.queue?.paused ? t('overview.summary.project_queue_paused') : ''}` : '',
    }),
    refs: { project: formatRef('project', slug) },
    ...(warnings.length ? { warnings } : {}),
    untrusted: untrusted('/data/top/*/*/title', '/data/rails/*/label', '/data/blueprint'),
  })
}

// ── context ─────────────────────────────────────────────────────────────────

const contextHandler = contextTools()[0].handler

async function contextOverview(ctx: V2CallContext, args: Row) {
  const row = ctx.v2.project({ ...args, project: args.project ?? args.projectId })
  const detail = ctx.v2.view === 'detail'
  const briefing = record(await contextHandler(ctx, { projectId: row.id, limit: detail ? 10 : 5 }))
  const sections = record(briefing.sections)
  const section = (name: string) => record(sections[name])
  const backlog = record(section('backlog').data)
  const runs = record(section('runs'))
  const rails = record(record(runs.rails).data)
  const jobs = record(record(runs.jobs).data)
  const git = record(section('git').data)
  const blueprint = record(section('blueprint').data)
  const unavailable = Object.entries(sections).filter(([, value]) => record(value).status === 'unavailable').map(([name]) => name)
  const slug = row.slug
  const data: Row = detail ? { project: formatRef('project', slug), sections } : {
    project: formatRef('project', slug),
    providers: row.providers,
    backlog: { total: backlog.total ?? null, statusCounts: backlog.statusCounts ?? null, recent: (Array.isArray(backlog.recent) ? backlog.recent.map(record) : []).map((spec) => ({ ref: formatRef('spec', String(spec.id), slug), title: spec.title, status: spec.status })) },
    rails: { total: rails.total ?? null },
    runs: { recent: (Array.isArray(jobs.recent) ? jobs.recent.map(record) : []).map((job) => ({ ref: formatRef('run', String(job.id), slug), status: statusFromJob(String(job.status ?? '')), command: job.command ?? null })) },
    git: { branch: git.branch ?? null, dirty: git.dirty ?? null, worktrees: git.worktreeCount ?? null },
    ...(Object.keys(blueprint).length ? { blueprint: { product: blueprint.product ?? null, milestones: Array.isArray(blueprint.milestones) ? blueprint.milestones.length : null } } : {}),
    ...(unavailable.length ? { unavailable } : {}),
  }
  return result(data, {
    summary: ctx.v2.t('overview.summary.context', { name: row.name, specs: Number(backlog.total ?? 0), rails: Number(rails.total ?? 0), branch: String(git.branch ?? '—'), dirty: git.dirty === true ? ctx.v2.t('overview.summary.context_dirty') : '' }),
    refs: { project: formatRef('project', slug) },
    untrusted: untrusted('/data/sections', '/data/backlog/recent/*/title', '/data/runs/recent/*/command', '/data/blueprint'),
  })
}

export const overviewTool = defineTool({
  name: 'specrails_overview',
  title: 'Overview',
  description: 'Start here. app: needs-you, running, failures, spend, quotas; project: board, rails, queue, blueprint; live: lanes; context: briefing.',
  owner: 'WP2',
  readOnly: true,
  alwaysLoad: true,
  fields: { project: F.project, view: F.view, fields: F.fields(['columns', 'rails', 'queue', 'blueprint', 'lanes', 'sections']), lang: F.lang },
  actions: {
    app: { tier: 'read', doc: 'App-wide: mood, counts, the most urgent items with their offers, running and delivered work, spend today and reached caps, quota warnings, next calls. detail: longer lists; fields [lanes] adds mission lanes.', handler: (ctx, args) => appOverview(ctx, args) },
    project: { tier: 'read', doc: 'One project: spec columns, rails (specs, running run, delivery), queue. detail fields: columns (newest specs), blueprint.', handler: (ctx, args) => projectOverview(ctx, args) },
    live: { tier: 'read', doc: 'The live board: needs / working / done today, optionally one project. detail fields: lanes (by mission).', handler: (ctx, args) => liveOverview(ctx, args) },
    context: { tier: 'read', doc: 'Planning briefing of one project: backlog, rails and recent runs, git, blueprint. detail: every section as read.', handler: (ctx, args) => contextOverview(ctx, args) },
  },
})
