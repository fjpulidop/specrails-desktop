import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { defineTool, type V2CallContext, type PreviewInput } from '../core/registry'
import { F, WRITE_FIELDS, optionsOf, resolveFields } from '../core/views'
import { asRecord, clip } from '../core/text'
import { V2ToolError, result, type ResultMeta } from '../core/envelope'
import { decodeCursor, encodeCursor, pageOf } from '../core/cursor'
import { formatRef, parseRef, type Ref } from '../core/refs'
import { statusFromSpec } from '../core/status-map'
import { specStatusWord } from '../core/lang'
import { untrusted, neutralize } from '../core/untrusted'
import { approxTokens } from '../core/size-guard'
import { shortHash } from '../core/canonical'
import type { DecisionStateInput, OfferDraft } from '../core/decision-state'
import { apiCall, originConversationDefaults } from '../../tools/types'
import { loadOrGenerateToken } from '../../../auth'
import { readSpecAddenda, type SpecAddendum } from '../../../modules/specs/runtime/spec-addenda-core'
import { answeredSpecIntent, checkSpecFraming, recordSpecCommitted } from '../../../modules/missions/runtime/agent-spec-framing'
import type { ProjectRow } from '../../../desktop-db'
import type { WsMessage } from '../../../types'

/**
 * WP5. `specrails_specs`: everything a person does with specs from Claude Code
 * or Codex. Thin over the ticket routes (`project-router-tickets-*.ts`) and the
 * bulk route (`project-router-tickets-bulk.ts`); the server owns validation,
 * the trash, Jira write-back and every WebSocket event.
 *
 * Refs: `spec:<project>/<id>`; addenda `addendum:<project>/<specId>:<addendumId>`;
 * attachments `attachment:<project>/<specId>:<attachmentId>`.
 */

type Row = Record<string, unknown>
/** `bulk_update {trash: true}` on more specs than this asks first (class risky). */
const BULK_TRASH_CONFIRM_ABOVE = 20
const asArray = (value: unknown): unknown[] => Array.isArray(value) ? value : []

const AI_CREATE_MODES = new Set(['request'])
const DETAIL_SECTIONS = ['criteria', 'addenda', 'timeline', 'handoff', 'attachments', 'files', 'spend'] as const
const STATUSES = ['draft', 'todo', 'in_progress', 'on_review', 'done', 'cancelled'] as const
/** The board's `active` tab. */
const ACTIVE_STATUSES = ['draft', 'todo', 'in_progress', 'on_review']
const CONTRACT_LAYER = '## Contract Layer'
const LIST_BUDGET_TOKENS = 1_250
const DETAIL_BUDGET_TOKENS = 8_500
const EXCERPT_CHARS = 600
const ASYNC_WAIT_DEFAULT_MS = 20_000
const ASYNC_WAIT_MAX_MS = 45_000
const ASYNC_KEEP_MS = 15 * 60_000
const ATTACH_MAX_BYTES = 5 * 1024 * 1024

/** Patch keys the single-spec PATCH route takes, by v2 name → route name. */
const UPDATE_KEYS: Record<string, string> = {
  title: 'title', body: 'description', description: 'description', status: 'status', priority: 'priority', labels: 'labels',
  assignee: 'assignee', prerequisites: 'prerequisites', metadata: 'metadata', criteria: 'acceptanceCriteria',
  acceptanceCriteria: 'acceptanceCriteria', summary: 'short_summary', shortSummary: 'short_summary', intent: 'intent',
  nonGoals: 'nonGoals', repositoryIds: 'repositoryIds',
}
/** Patch keys the bulk route takes. */
const BULK_KEYS = new Set(['status', 'priority', 'labels', 'addLabels', 'removeLabels', 'assignee', 'milestone'])
/** Patch keys that are their own operation (update and bulk_update). */
const OP_KEYS = new Set(['rail', 'trash', 'restore', 'mergeInto', 'reorder', 'order', 'regressionOf'])

// ── Small helpers ───────────────────────────────────────────────────────────

const base = (row: ProjectRow) => `/projects/${encodeURIComponent(row.id)}`
const specRef = (row: ProjectRow, id: number | string) => formatRef('spec', id, row.slug)

function specIdOf(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new V2ToolError('invalid_input', `"${raw}" is not a spec id. Spec refs look like spec:<project>/42.`)
  return id
}

/** The spec of `args.ref` (a ref, or a bare id scoped by project). */
function specTarget(ctx: V2CallContext, args: Row): { row: ProjectRow; id: number; ref: Ref } {
  const target = ctx.v2.target(args, 'spec')
  return { row: target.project!, id: specIdOf(target.id), ref: target.ref }
}

/** The specs of `args.refs` (all in one project). */
function specTargets(ctx: V2CallContext, args: Row): { row: ProjectRow; ids: number[]; refs: Ref[] } {
  const refs = asArray(args.refs).map((value) => typeof value === 'number' ? String(value) : value)
  if (!refs.length) throw new V2ToolError('invalid_input', 'refs must list at least one spec.')
  if (refs.length > 200) throw new V2ToolError('invalid_input', 'At most 200 specs per call.')
  const targets = refs.map((ref) => ctx.v2.target({ ...args, ref }, 'spec'))
  const row = targets[0].project!
  if (targets.some((target) => target.project!.id !== row.id)) throw new V2ToolError('invalid_input', 'refs must belong to one project.')
  const ids = [...new Set(targets.map((target) => specIdOf(target.id)))]
  return { row, ids, refs: ids.map((id) => specRef(row, id)) }
}

/** A child ref (`addendum:<p>/<spec>:<id>`), or a spec ref plus `options.<idKey>`. */
function childTarget(ctx: V2CallContext, args: Row, kind: 'addendum' | 'attachment', idKey: string): { row: ProjectRow; specId: number; childId: string; ref: Ref; specRef: Ref } {
  const parsed = parseRef(args.ref)
  if (parsed?.kind === kind) {
    const target = ctx.v2.target(args, kind)
    const colon = target.id.indexOf(':')
    if (colon <= 0) throw new V2ToolError('invalid_input', `${kind} refs look like ${kind}:<project>/<specId>:<id>.`)
    const specId = specIdOf(target.id.slice(0, colon))
    return { row: target.project!, specId, childId: target.id.slice(colon + 1), ref: target.ref, specRef: specRef(target.project!, specId) }
  }
  const spec = specTarget(ctx, args)
  const childId = optionsOf(args)[idKey]
  if (typeof childId !== 'string' || !childId) throw new V2ToolError('invalid_input', `Pass an ${kind} ref, or the spec ref plus options.${idKey}.`)
  return { row: spec.row, specId: spec.id, childId, ref: formatRef(kind, `${spec.id}:${childId}`, spec.row.slug), specRef: spec.ref }
}

const childRef = (row: ProjectRow, kind: 'addendum' | 'attachment', specId: number, id: string) => formatRef(kind, `${specId}:${id}`, row.slug)

async function readTicket(ctx: V2CallContext, row: ProjectRow, id: number): Promise<Row> {
  return asRecord(asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets/${id}`)).ticket)
}

const textOf = (value: unknown) => typeof value === 'string' ? value : ''
const minute = (iso: unknown) => typeof iso === 'string' ? iso.replace(/:\d\d(\.\d+)?Z$/, 'Z') : iso

/** The description without the generated Contract Layer (shown on demand in detail). */
export function bodyOf(description: string): { body: string; contractLayer: boolean } {
  const at = description.indexOf(CONTRACT_LAYER)
  return at < 0 ? { body: description, contractLayer: false } : { body: description.slice(0, at).trimEnd(), contractLayer: true }
}

/** Acceptance criteria bullets of the `## Acceptance Criteria` section. */
export function criteriaOf(description: string): string[] {
  const lines = description.split('\n')
  const start = lines.findIndex((line) => /^#{2,3}\s+acceptance criteria\s*$/i.test(line.trim()))
  if (start < 0) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,3}\s/.test(line.trim())) break
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+)$/.exec(line)
    if (bullet) out.push(bullet[1].trim())
  }
  return out
}

function triageBrief(ticket: Row): Row | undefined {
  const triage = asRecord(asRecord(ticket.metadata).triage)
  if (triage.status === 'ready') return { size: triage.size, loop: triage.recommendedLoopName ?? triage.recommendedLoop, confidence: triage.confidence }
  if (triage.status) return { status: triage.status }
  return undefined
}

const openAddenda = (ticket: Row): SpecAddendum[] => readSpecAddenda(ticket.addenda as never).filter((addendum) => addendum.status === 'open')

/** The lean row every listing returns. */
export function listItem(row: ProjectRow, ticket: Row, detail = false): Row {
  const labels = asArray(ticket.labels)
  const open = openAddenda(ticket).length
  return {
    ref: specRef(row, ticket.id as number),
    title: ticket.title,
    status: ticket.status,
    ...(ticket.priority ? { priority: ticket.priority } : {}),
    ...(labels.length ? { labels } : {}),
    ...(ticket.is_epic ? { epic: true } : {}),
    ...(typeof ticket.parent_epic_id === 'number' ? { parent: specRef(row, ticket.parent_epic_id) } : {}),
    ...(open ? { openAddenda: open } : {}),
    ...(ticket.needs_review === true ? { needsReview: true } : {}),
    updated: minute(ticket.updated_at),
    ...(detail ? {
      ...(ticket.short_summary ? { summary: ticket.short_summary } : {}),
      ...(triageBrief(ticket) ? { triage: triageBrief(ticket) } : {}),
      ...(ticket.jira_key ? { jira: ticket.jira_key } : {}),
      ...(typeof ticket.execution_order === 'number' ? { order: ticket.execution_order } : {}),
    } : {}),
  }
}

/** How many leading items fit a token budget (so the page cursor stays absolute). */
function fitting(items: readonly unknown[], budget: number): number {
  let used = 0
  for (let i = 0; i < items.length; i++) {
    used += approxTokens(JSON.stringify(items[i])) + 1
    if (used > budget) return Math.max(1, i)
  }
  return items.length
}

// ── Decision state (domain rules of a spec) ─────────────────────────────────

/**
 * What a spec can do next, from the spec's own rules: status workflow
 * (validatePriorityForStatus: leaving draft needs a priority), SMASH
 * eligibility (checkSmashEligibility: not a draft, not a child, has a Contract
 * Layer, no children yet), open addenda (they ride into the next launch) and
 * the triage record (metadata.triage).
 */
export function projectSpecState(row: ProjectRow, ticket: Row, facts: { children?: number } = {}): DecisionStateInput {
  const id = ticket.id as number
  const ref = specRef(row, id)
  const status = String(ticket.status)
  const description = textOf(ticket.description)
  const contract = description.includes(CONTRACT_LAYER)
  const open = openAddenda(ticket).length
  const triage = asRecord(asRecord(ticket.metadata).triage)
  const offers: OfferDraft[] = []
  let recommended: string | null = null
  const self = (action: string, extra: Row = {}) => ({ tool: 'specrails_specs', args: { action, ref, ...extra } })
  const launch: OfferDraft = { id: 'launch', labelKey: open ? 'specs.offer.launch_addenda' : 'specs.offer.launch', labelParams: { count: open }, call: { tool: 'specrails_runs', args: { action: 'launch', project: row.slug, target: { specIds: [ref] } } } }
  switch (status) {
    case 'draft':
      offers.push({ id: 'promote', labelKey: 'specs.offer.promote', call: self('update', { patch: { status: 'todo', ...(ticket.priority ? {} : { priority: 'medium' }) } }) })
      if (!contract) offers.push({ id: 'refine', labelKey: 'specs.offer.refine', call: self('refine') })
      recommended = 'promote'
      break
    case 'todo':
      offers.push(launch)
      if (triage.status !== 'ready') offers.push({ id: 'triage', labelKey: 'specs.offer.triage', call: self('triage') })
      if (!contract) offers.push({ id: 'refine', labelKey: 'specs.offer.refine', call: self('refine') })
      recommended = 'launch'
      break
    case 'in_progress':
      offers.push({ id: 'runs', labelKey: 'specs.offer.runs', call: { tool: 'specrails_runs', args: { action: 'list', project: row.slug, filter: { spec: ref } } } })
      recommended = 'runs'
      break
    case 'on_review':
      offers.push({ id: 'review', labelKey: 'specs.offer.review', call: { tool: 'specrails_deliveries', args: { action: 'list', project: row.slug, filter: { spec: ref } } } })
      if (open) offers.push(launch)
      recommended = open ? 'launch' : 'review'
      break
    case 'done':
      offers.push({ id: 'iterate', labelKey: 'specs.offer.iterate', call: self('addendum_add'), needs: ['body'] })
      if (open) { offers.push(launch); recommended = 'launch' }
      offers.push({ id: 'reopen', labelKey: 'specs.offer.reopen', call: self('update', { patch: { status: 'todo' } }) })
      break
    case 'cancelled':
      offers.push({ id: 'reopen', labelKey: 'specs.offer.reopen', call: self('update', { patch: { status: 'todo', ...(ticket.priority ? {} : { priority: 'medium' }) } }) })
      break
  }
  const smashable = status !== 'draft' && status !== 'done' && status !== 'cancelled' && status !== 'in_progress'
    && ticket.parent_epic_id == null && contract && !(ticket.is_epic && (facts.children ?? 0) > 0)
  if (smashable) offers.push({ id: 'smash', labelKey: 'specs.offer.smash', call: self('smash') })
  return {
    status: statusFromSpec(status),
    offers,
    recommended,
    versionFacts: { u: ticket.updated_at ?? null, a: open, t: triage.inputsHash ?? null },
  }
}

// ── Async AI results (spec generation, AI edit, SMASH) ──────────────────────

interface AsyncOutcome { status: 'pending' | 'done' | 'failed'; kind: string; spec?: number; text?: string; error?: string; smashedAt?: string; children?: number[]; at: number }
/** Results of async AI actions of this process, kept 15 minutes so a later `get(options.request)` can read them. */
const asyncOutcomes = new Map<string, AsyncOutcome>()

function sweepOutcomes(): void {
  const now = Date.now()
  for (const [key, outcome] of asyncOutcomes) if (now - outcome.at > ASYNC_KEEP_MS) asyncOutcomes.delete(key)
}

/** The event that settles an async action, mapped to its outcome; null when the message is unrelated. */
function settle(kind: string, key: string, msg: WsMessage): AsyncOutcome | null {
  const m = msg as unknown as Row
  const at = Date.now()
  switch (kind) {
    case 'generate':
      if (m.requestId !== key) return null
      if (m.type === 'spec_gen_done') return { status: 'done', kind, spec: asRecord(m.ticket).id as number, at }
      if (m.type === 'spec_gen_error') return { status: 'failed', kind, error: String(m.error ?? 'failed'), at }
      return null
    case 'ai_edit':
      if (m.requestId !== key) return null
      if (m.type === 'ticket_ai_edit_done') return { status: 'done', kind, spec: m.ticketId as number, text: String(m.fullText ?? ''), at }
      if (m.type === 'ticket_ai_edit_error') return { status: 'failed', kind, spec: m.ticketId as number, error: String(m.error ?? 'failed'), at }
      return null
    case 'smash':
      if (`smash:${m.ticketId}` !== key) return null
      if (m.type === 'smash.completed') return { status: 'done', kind, spec: m.ticketId as number, smashedAt: String(m.smashedAt ?? ''), children: asArray(m.childrenIds) as number[], at }
      if (m.type === 'smash.failed') return { status: 'failed', kind, spec: m.ticketId as number, error: String(m.reason ?? 'failed'), at }
      return null
    case 'refine': {
      const id = m.ticketId ?? asRecord(m.ticket).id
      if (`refine:${id}` !== key) return null
      if (m.type === 'explore.contract_refine_failed') return { status: 'failed', kind, spec: m.ticketId as number, error: String(m.reason ?? m.error ?? 'failed'), at }
      if (m.type === 'ticket_updated' && textOf(asRecord(m.ticket).description).includes(CONTRACT_LAYER)) return { status: 'done', kind, spec: id as number, at }
      return null
    }
  }
  return null
}

/**
 * Starts an async AI action and waits (bounded) for its settling event. The
 * listener is attached before the request, so a fast completion is never
 * missed; it stays attached after the wait (up to 15 min) to keep the outcome.
 */
async function runAsync(ctx: V2CallContext, kind: string, start: () => Promise<{ key: string; response: Row }>, waitMs: number): Promise<{ key: string; response: Row; outcome: AsyncOutcome }> {
  sweepOutcomes()
  const early: WsMessage[] = []
  let key: string | null = null
  let resolveDone: ((outcome: AsyncOutcome) => void) | null = null
  const done = new Promise<AsyncOutcome>((resolve) => { resolveDone = resolve })
  let unsubscribe: (() => void) | null = null
  const finish = (outcome: AsyncOutcome) => {
    asyncOutcomes.set(key!, outcome)
    unsubscribe?.()
    clearTimeout(expiry)
    resolveDone?.(outcome)
  }
  const onMessage = (msg: WsMessage) => {
    if (key === null) { early.push(msg); return }
    const outcome = settle(kind, key, msg)
    if (outcome) finish(outcome)
  }
  unsubscribe = ctx.eventBus?.onMessage ? ctx.eventBus.onMessage(onMessage) : null
  const expiry = setTimeout(() => unsubscribe?.(), ASYNC_KEEP_MS)
  expiry.unref?.()
  let started: { key: string; response: Row }
  try {
    started = await start()
  } catch (err) {
    unsubscribe?.()
    clearTimeout(expiry)
    throw err
  }
  key = started.key
  asyncOutcomes.set(key, { status: 'pending', kind, at: Date.now() })
  for (const msg of early.splice(0)) { const outcome = settle(kind, key, msg); if (outcome) { finish(outcome); break } }
  const current = asyncOutcomes.get(key)!
  if (current.status !== 'pending' || waitMs <= 0) return { ...started, outcome: current }
  let timer: NodeJS.Timeout | undefined
  const outcome = await Promise.race([done, new Promise<AsyncOutcome>((resolve) => { timer = setTimeout(() => resolve(asyncOutcomes.get(key!)!), waitMs) })])
  clearTimeout(timer)
  return { ...started, outcome }
}

function waitMsOf(args: Row): number {
  const raw = optionsOf(args).waitMs
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return ASYNC_WAIT_DEFAULT_MS
  return Math.min(Math.max(0, Math.floor(raw)), ASYNC_WAIT_MAX_MS)
}

// ── Cost forecast of a spec AI action ───────────────────────────────────────

/**
 * Measured band of this project's own provider-reported costs for the same
 * surface (the launch-forecast honesty rule: IQR of ≥ 3 reported costs,
 * estimates and missing costs left out, never a default). Null = unknown,
 * which the confirmation protocol treats as above the threshold.
 */
export function forecastFor(ctx: V2CallContext, row: ProjectRow, surfaces: readonly string[]): [number, number] | null {
  try {
    const db = ctx.registry.getContext?.(row.id)?.db
    if (!db) return null
    const rows = db.prepare(
      `SELECT total_cost_usd AS cost FROM ai_invocations
       WHERE surface IN (${surfaces.map(() => '?').join(', ')}) AND total_cost_usd IS NOT NULL AND COALESCE(total_cost_usd_estimated, 0) = 0
       ORDER BY started_at DESC LIMIT 30`,
    ).all(...surfaces) as Array<{ cost: number }>
    const costs = rows.map((r) => r.cost).filter((c) => Number.isFinite(c)).sort((a, b) => a - b)
    if (costs.length < 3) return null
    // Nearest-rank quartiles, widened outward (low rounds down, high rounds up).
    const cents = (usd: number) => Math.round(usd * 100) / 100
    return [cents(costs[Math.floor(0.25 * (costs.length - 1))]), cents(costs[Math.ceil(0.75 * (costs.length - 1))])]
  } catch {
    return null
  }
}

const SURFACES = { create: ['quick-spec'], refine: ['quick-spec', 'explore-spec'], ai_edit: ['ai-edit'], smash: ['smash'] } as const

function costlyPreview(ctx: V2CallContext, args: Row, surfaces: readonly string[], effectKey: string, row: ProjectRow, ref: Ref | null, versionFacts: unknown): PreviewInput {
  const forecast = forecastFor(ctx, row, surfaces)
  return {
    effect: ctx.v2.t(effectKey, { ref: ref ?? row.slug }),
    refs: ref ? [ref] : [],
    version: `p${shortHash({ facts: versionFacts, a: args.ref ?? null })}`,
    cost: { forecastUsd: forecast, runs: 1 },
  }
}

// ── List / search / get ─────────────────────────────────────────────────────

function statusFilter(value: unknown): string | undefined {
  const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []).map((s) => String(s).trim()).filter(Boolean)
  if (!list.length) return undefined
  const expanded = [...new Set(list.flatMap((status) => status === 'active' ? ACTIVE_STATUSES : status === 'all' ? [...STATUSES] : [status]))]
  const bad = expanded.filter((status) => !(STATUSES as readonly string[]).includes(status))
  if (bad.length) {
    const deleted = bad.some((status) => /^(trash|trashed|deleted|removed)$/i.test(status))
    throw new V2ToolError('invalid_input', `Unknown status ${bad.join(', ')}. Use ${[...STATUSES, 'active', 'all'].join(', ')}.${deleted ? ' Deleted specs are listed by specrails_specs(trash) and come back with specrails_specs(restore).' : ''}`,
      deleted ? { next: [{ tool: 'specrails_specs', args: { action: 'trash' }, why: 'Deleted specs.' }] } : {})
  }
  return expanded.join(',')
}

const csvOf = (value: unknown): string | undefined => {
  const list = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : typeof value === 'number' ? [value] : []).map((s) => String(s).trim()).filter(Boolean)
  return list.length ? list.join(',') : undefined
}

function milestoneLabel(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const match = /^m?(\d{1,3})$/i.exec(String(value).trim())
  if (!match) throw new V2ToolError('invalid_input', 'filter.milestone takes a milestone number (2) or label (M2).')
  return `M${Number(match[1])}`
}

/** Rail (index or name) → its spec ids, from the rails read model. */
async function railSpecIds(ctx: V2CallContext, row: ProjectRow, rail: unknown): Promise<number[]> {
  const rails = asArray(asRecord(await apiCall(ctx, 'GET', `${base(row)}/rails`)).rails).map(asRecord)
  const hit = findRail(rails, rail)
  if (!hit) throw new V2ToolError('not_found', `No rail matches "${String(rail)}".`, { choices: rails.map((r) => ({ rail: r.railIndex, name: r.name ?? null })) as never })
  return asArray(hit.ticketIds) as number[]
}

function findRail(rails: Row[], rail: unknown): Row | undefined {
  const raw = typeof rail === 'string' ? rail.trim() : rail
  const index = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null
  return rails.find((r) => index !== null && r.railIndex === index)
    ?? rails.find((r) => typeof raw === 'string' && typeof r.name === 'string' && r.name.toLowerCase() === raw.toLowerCase())
}

async function listSpecs(ctx: V2CallContext, args: Row): Promise<unknown> {
  const row = ctx.v2.project(args)
  const filter = asRecord(args.filter)
  const options = optionsOf(args)
  const qs = new URLSearchParams()
  const status = statusFilter(filter.status)
  if (status) qs.set('status', status)
  const label = csvOf(filter.label ?? filter.labels)
  if (label) qs.set('label', label)
  const priority = csvOf(filter.priority)
  if (priority) qs.set('priority', priority)
  const milestone = milestoneLabel(filter.milestone)
  if (milestone) qs.set('labelsAll', milestone)
  if (typeof filter.since === 'string' && filter.since) qs.set('since', filter.since)
  if (filter.epic !== undefined) qs.set('epic', String(ctx.v2.target({ ...args, ref: filter.epic }, 'spec').id))
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (query) qs.set('q', query)
  if (filter.rail !== undefined && filter.rail !== null) {
    const ids = await railSpecIds(ctx, row, filter.rail)
    if (!ids.length) return result({ items: [] }, { summary: ctx.v2.t('specs.summary.list_empty', { project: row.name }), page: { cursor: null, total: 0, truncated: false } })
    qs.set('ids', ids.join(','))
  }
  const sort = typeof options.sort === 'string' ? options.sort : undefined
  if (sort) {
    if (!['updated', 'priority', 'id', 'created'].includes(sort)) throw new V2ToolError('invalid_input', 'options.sort is updated, priority, id or created.')
    qs.set('sort', sort)
  }
  const key = shortHash({ p: row.id, q: qs.toString() })
  const cursor = decodeCursor(args.cursor, key)
  const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, Math.floor(args.limit)), 100) : 25
  const offset = cursor?.offset ?? 0
  qs.set('limit', String(limit))
  qs.set('offset', String(offset))
  const response = asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets?${qs.toString()}`))
  const tickets = asArray(response.tickets).map(asRecord)
  const detail = ctx.v2.view === 'detail'
  const all = tickets.map((ticket) => listItem(row, ticket, detail))
  const kept = fitting(all, detail ? DETAIL_BUDGET_TOKENS : LIST_BUDGET_TOKENS)
  const items = all.slice(0, kept)
  const matched = typeof response.matched === 'number' ? response.matched : items.length
  const end = offset + items.length
  const more = end < matched
  const counts = asRecord(response.statusCounts)
  const countText = Object.entries(counts).map(([s, n]) => `${specStatusWord(ctx.v2.lang, s)} ${n}`).join(', ')
  const summary = matched === 0
    ? ctx.v2.t(query || Object.keys(filter).length ? 'specs.summary.list_none' : 'specs.summary.list_empty', { project: row.name })
    : ctx.v2.t('specs.summary.list', { shown: items.length, from: offset + 1, matched, total: response.total as number, counts: countText || '-' })
  return result({ items, ...(countText ? { statusCounts: counts } : {}) }, {
    summary,
    page: { cursor: more ? encodeCursor({ offset: end, path: '/items', key }) : null, total: matched, truncated: more },
    pageBase: { offset, key },
    ...(response.cursorStale === true ? { warnings: [ctx.v2.t('specs.warning.cursor_stale')] } : {}),
    untrusted: untrusted('/data/items/*/title', '/data/items/*/summary'),
  })
}

async function searchSpecs(ctx: V2CallContext, args: Row): Promise<unknown> {
  // Filters narrow a search through the list's text match; otherwise the ranked ⌘K search (title, summary, body, labels, addenda…).
  if (args.filter && Object.keys(asRecord(args.filter)).length) return listSpecs(ctx, args)
  const row = ctx.v2.project(args)
  const query = String(args.query).trim()
  if (query.length > 200 || /[\r\n]/.test(query)) throw new V2ToolError('invalid_input', 'query is one line of at most 200 characters.')
  const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, Math.floor(args.limit)), 30) : 15
  const response = asRecord(await apiCall(ctx, 'GET', `${base(row)}/search/specs?q=${encodeURIComponent(query)}&limit=${limit}`))
  const items = asArray(response.results).map(asRecord).map((hit) => ({
    ref: specRef(row, hit.id as number), title: hit.title, status: hit.status, ...(hit.priority ? { priority: hit.priority } : {}),
    match: hit.field, ...(asRecord(hit.snippet).text ? { snippet: clip(neutralize(String(asRecord(hit.snippet).text)), 160) } : {}),
  }))
  return result({ items }, {
    summary: items.length ? ctx.v2.t('specs.summary.search', { count: items.length, query: clip(neutralize(query), 60) }) : ctx.v2.t('specs.summary.search_none', { query: clip(neutralize(query), 60) }),
    page: { cursor: null, total: items.length, truncated: false },
    untrusted: untrusted('/data/items/*/title', '/data/items/*/snippet'),
  })
}

async function getAsyncOutcome(ctx: V2CallContext, args: Row, requestKey: string): Promise<unknown> {
  const outcome = asyncOutcomes.get(requestKey)
  if (!outcome) throw new V2ToolError('not_found', ctx.v2.t('specs.error.request_unknown', { request: requestKey }))
  const row = ctx.v2.project(args)
  return asyncResult(ctx, row, requestKey, outcome, {})
}

/** The envelope of an async AI action (pending, done or failed). */
function asyncResult(ctx: V2CallContext, row: ProjectRow, key: string, outcome: AsyncOutcome, response: Row): unknown {
  const data: Row = { request: key, status: outcome.status, kind: outcome.kind, ...response }
  const refs: Record<string, Ref> = {}
  if (outcome.spec) { data.spec = specRef(row, outcome.spec); refs.spec = specRef(row, outcome.spec) }
  if (outcome.error) data.error = outcome.error
  if (outcome.smashedAt) data.smashedAt = outcome.smashedAt
  if (outcome.children?.length) data.children = outcome.children.map((id) => specRef(row, id))
  if (outcome.text !== undefined) data.proposal = outcome.text
  const next = outcome.status === 'pending'
    ? [ctx.v2.t('specs.hint.pending', { request: key })]
    : outcome.kind === 'ai_edit' && outcome.status === 'done' ? [ctx.v2.t('specs.hint.ai_edit_apply')] : []
  return result(data, {
    summary: ctx.v2.t(`specs.summary.async.${outcome.kind}.${outcome.status}`, { spec: outcome.spec ? specRef(row, outcome.spec) : '', request: key, error: outcome.error ?? '' }),
    refs,
    ...(next.length ? { warnings: next } : {}),
    ...(outcome.text !== undefined ? { untrusted: untrusted('/data/proposal') } : {}),
  })
}

async function getSpec(ctx: V2CallContext, args: Row): Promise<unknown> {
  const request = optionsOf(args).request
  if (typeof request === 'string' && request) return getAsyncOutcome(ctx, args, request)
  const { row, id, ref } = specTarget(ctx, args)
  const ticket = await readTicket(ctx, row, id)
  const description = textOf(ticket.description)
  const { body, contractLayer } = bodyOf(description)
  const children = typeof ticket.is_epic === 'boolean' && ticket.is_epic
    ? asArray(asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets?epic=${id}&limit=100&sort=id`).catch(() => ({}))).tickets).map(asRecord)
    : []
  const state = ctx.v2.state(projectSpecState(row, ticket, { children: children.length }))
  const addenda = readSpecAddenda(ticket.addenda as never)
  const criteria = criteriaOf(description)
  const sections = resolveFields(args, DETAIL_SECTIONS)
  const detail = ctx.v2.view === 'detail' || sections.length > 0
  const warnings: string[] = []
  const refs: Record<string, Ref> = { spec: ref }
  const data: Row = {
    ...listItem(row, ticket, true),
    ...(detail ? { body: description } : { excerpt: clip(body, EXCERPT_CHARS) }),
    ...(contractLayer ? { contractLayer: true } : {}),
    criteria: detail && sections.includes('criteria') ? criteria : criteria.length,
    addenda: { open: addenda.filter((a) => a.status === 'open').length, total: addenda.length },
    ...(asArray(ticket.prerequisites).length ? { prerequisites: asArray(ticket.prerequisites).map((p) => specRef(row, p as number)) } : {}),
    ...(children.length ? { children: children.map((child) => ({ ref: specRef(row, child.id as number), title: child.title, status: child.status, ...(typeof child.execution_order === 'number' ? { order: child.execution_order } : {}) })) } : {}),
    ...(asArray(ticket.repositoryIds).length ? { repositories: ticket.repositoryIds } : {}),
    ...(ticket.intent ? { intent: ticket.intent } : {}),
    ...(asArray(ticket.nonGoals).length ? { nonGoals: ticket.nonGoals } : {}),
    ...(asRecord(ticket.metadata).regressionOf ? { regressionOf: formatRef('delivery', String(asRecord(ticket.metadata).regressionOf), row.slug) } : {}),
    source: ticket.source,
    created: minute(ticket.created_at),
  }
  const untrustedPaths = ['/data/title', '/data/summary', '/data/excerpt', '/data/body', '/data/criteria', '/data/intent', '/data/nonGoals', '/data/children/*/title']
  const section = async (name: string, read: () => Promise<unknown>) => {
    try { data[name] = await read() } catch (err) { warnings.push(ctx.v2.t('specs.warning.section_failed', { section: name, error: err instanceof Error ? clip(err.message, 160) : String(err) })) }
  }
  if (sections.includes('addenda')) {
    data.addenda = addenda.map((a) => ({ ref: childRef(row, 'addendum', id, a.id), kind: a.kind, status: a.status, ...(a.title ? { title: a.title } : {}), body: a.body, created: minute(a.created_at), by: a.created_by }))
    untrustedPaths.push('/data/addenda/*/title', '/data/addenda/*/body')
  }
  if (sections.includes('timeline')) {
    await section('timeline', async () => {
      const qs = new URLSearchParams({ limit: String(typeof args.limit === 'number' ? Math.min(args.limit, 50) : 20) })
      const kinds = csvOf(optionsOf(args).kinds)
      if (kinds) qs.set('kinds', kinds)
      if (typeof args.cursor === 'string' && args.cursor) qs.set('cursor', args.cursor)
      const page = asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets/${id}/timeline?${qs.toString()}`))
      return { items: page.entries ?? page.items ?? [], cursor: page.nextCursor ?? null }
    })
    untrustedPaths.push('/data/timeline/items')
  }
  if (sections.includes('handoff')) {
    await section('handoff', async () => {
      const format = ['md', 'pr', 'html'].includes(String(optionsOf(args).format)) ? String(optionsOf(args).format) : 'pr'
      const rendered = asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets/${id}/handoff?format=${format}&locale=${ctx.v2.lang}`))
      return { format, ...rendered }
    })
    untrustedPaths.push('/data/handoff')
  }
  if (sections.includes('attachments')) {
    await section('attachments', async () => asArray(asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets/${id}/attachments`)).attachments).map(asRecord).map((a) => ({
      ref: childRef(row, 'attachment', id, String(a.id)), name: a.filename ?? a.name ?? a.originalName, type: a.mimeType ?? a.mimetype, size: a.size,
    })))
    untrustedPaths.push('/data/attachments/*/name')
  }
  if (sections.includes('files')) {
    await section('files', async () => {
      const repository = optionsOf(args).repository
      const prefix = typeof repository === 'string' && repository ? `${base(row)}/repositories/${encodeURIComponent(repository)}` : base(row)
      return apiCall(ctx, 'GET', `${prefix}/code/provenance?ticketId=${id}`)
    })
    untrustedPaths.push('/data/files')
  }
  if (sections.includes('spend')) await section('spend', () => apiCall(ctx, 'GET', `${base(row)}/tickets/${id}/spending-summary`))
  return result(data, {
    summary: ctx.v2.t('specs.summary.get', { ref, title: clip(neutralize(textOf(ticket.title)), 80), status: state.label }),
    refs,
    state,
    ...(warnings.length ? { warnings } : {}),
    untrusted: untrusted(...untrustedPaths),
  })
}

// ── Writes ──────────────────────────────────────────────────────────────────

function routePatch(patch: Row): Row {
  const out: Row = {}
  const unknown: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (OP_KEYS.has(key) || key === 'milestone' || key === 'addLabels' || key === 'removeLabels') continue
    const target = UPDATE_KEYS[key]
    if (!target) { unknown.push(key); continue }
    out[target] = value
  }
  if (unknown.length) throw new V2ToolError('invalid_input', `Unknown patch fields: ${unknown.join(', ')}. See specrails_system(help, describe: specrails_specs.update).`)
  if (patch.regressionOf !== undefined) {
    const raw = patch.regressionOf
    const parsed = parseRef(raw)
    out.metadata = { ...asRecord(out.metadata), regressionOf: raw === null ? null : parsed?.kind === 'delivery' ? parsed.id : raw }
  }
  return out
}

/** Sets a spec's rail (index or name; null removes it from its rail) through the rails routes. */
async function assignRail(ctx: V2CallContext, row: ProjectRow, ids: number[], rail: unknown): Promise<Row> {
  const response = asRecord(await apiCall(ctx, 'GET', `${base(row)}/rails`))
  const rails = asArray(response.rails).map(asRecord)
  const busy = new Set([...Object.keys(asRecord(response.activeJobs)), ...Object.keys(asRecord(response.activeLoopRuns))].map(Number))
  const target = rail === null ? null : findRail(rails, rail)
  if (rail !== null && !target) throw new V2ToolError('not_found', `No rail matches "${String(rail)}".`, { choices: rails.map((r) => ({ rail: r.railIndex, name: r.name ?? null })) as never })
  if (target && busy.has(target.railIndex as number)) throw new V2ToolError('conflict', ctx.v2.t('specs.error.rail_running', { rail: String(target.name ?? target.railIndex) }))
  const moving = new Set(ids)
  const writes: Array<{ railIndex: number; ticketIds: number[] }> = []
  for (const r of rails) {
    if (target && r.railIndex === target.railIndex) continue
    const own = asArray(r.ticketIds) as number[]
    if (!own.some((id) => moving.has(id))) continue
    if (busy.has(r.railIndex as number)) throw new V2ToolError('conflict', ctx.v2.t('specs.error.rail_running', { rail: String(r.name ?? r.railIndex) }))
    writes.push({ railIndex: r.railIndex as number, ticketIds: own.filter((id) => !moving.has(id)) })
  }
  if (target) writes.push({ railIndex: target.railIndex as number, ticketIds: [...new Set([...(asArray(target.ticketIds) as number[]), ...ids])] })
  for (const write of writes) await apiCall(ctx, 'PUT', `${base(row)}/rails/${write.railIndex}/tickets`, { ticketIds: write.ticketIds })
  return { rail: target ? { index: target.railIndex, name: target.name ?? null } : null }
}

async function bulk(ctx: V2CallContext, row: ProjectRow, body: Row): Promise<Row> {
  return asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/bulk`, body))
}

async function updateSpec(ctx: V2CallContext, args: Row): Promise<unknown> {
  const { row, id, ref } = specTarget(ctx, args)
  const patch = asRecord(args.patch)
  if (patch.mergeInto !== undefined || patch.trash !== undefined || patch.restore !== undefined) throw new V2ToolError('invalid_input', 'update edits one spec; merge, trash and restore go through bulk_update, delete or restore.')
  const body = routePatch(patch)
  const bulkPatch: Row = {}
  for (const key of ['milestone', 'addLabels', 'removeLabels'] as const) if (patch[key] !== undefined) bulkPatch[key] = patch[key]
  if (bulkPatch.milestone !== undefined && bulkPatch.milestone !== null) bulkPatch.milestone = Number(milestoneLabel(bulkPatch.milestone)!.slice(1))
  const before = await readTicket(ctx, row, id)
  let ticket = before
  if (Object.keys(body).length) ticket = asRecord(asRecord(await apiCall(ctx, 'PATCH', `${base(row)}/tickets/${id}`, body)).ticket)
  if (Object.keys(bulkPatch).length) {
    const out = await bulk(ctx, row, { op: 'update', ids: [id], patch: bulkPatch })
    const changed = asArray(out.tickets).map(asRecord)[0]
    if (changed) ticket = changed
  }
  const extra: Row = {}
  if (patch.rail !== undefined) Object.assign(extra, await assignRail(ctx, row, [id], patch.rail))
  const order = patch.order ?? patch.reorder
  if (order !== undefined) throw new V2ToolError('invalid_input', 'Order specs with bulk_update(refs in order, patch: {reorder: true}).')
  if (!Object.keys(body).length && !Object.keys(bulkPatch).length && patch.rail === undefined) throw new V2ToolError('invalid_input', 'patch changes nothing.')
  const previous: Row = {}
  for (const key of Object.keys(body)) {
    const field = key === 'acceptanceCriteria' ? 'description' : key
    previous[field === 'description' ? 'body' : field === 'short_summary' ? 'summary' : field] = before[field] ?? null
  }
  if (bulkPatch.milestone !== undefined || bulkPatch.addLabels || bulkPatch.removeLabels) previous.labels = before.labels
  const state = ctx.v2.state(projectSpecState(row, ticket))
  return result({ ...listItem(row, ticket, true), ...extra, undo: { tool: 'specrails_specs', args: { action: 'update', ref, patch: previous } } }, {
    summary: ctx.v2.t('specs.summary.updated', { ref, status: state.label }),
    refs: { spec: ref },
    state,
    untrusted: untrusted('/data/title', '/data/summary', '/data/undo/args/patch'),
  })
}

/** Resolves the `bulk_update` operation a patch asks for. */
function bulkOperation(patch: Row): 'update' | 'trash' | 'restore' | 'merge' | 'reorder' | 'rail' {
  const ops = [patch.trash === true && 'trash', patch.restore === true && 'restore', patch.mergeInto !== undefined && 'merge', (patch.reorder === true || patch.order === true) && 'reorder'].filter(Boolean) as string[]
  const fieldKeys = Object.keys(patch).filter((key) => !OP_KEYS.has(key))
  if (ops.length > 1 || (ops.length && (fieldKeys.length || patch.rail !== undefined))) throw new V2ToolError('invalid_input', 'One bulk operation per call: field edits (+ rail), trash, restore, mergeInto or reorder.')
  if (ops.length) return ops[0] as 'trash'
  if (!fieldKeys.length && patch.rail !== undefined) return 'rail'
  return 'update'
}

async function bulkVersion(ctx: V2CallContext, row: ProjectRow, ids: number[]): Promise<{ version: string; tickets: Row[] }> {
  const response = asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets?ids=${ids.join(',')}&limit=200`))
  const tickets = asArray(response.tickets).map(asRecord)
  return { version: `b${shortHash(tickets.map((t) => [t.id, t.updated_at]).sort())}`, tickets }
}

async function bulkPreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const { row, ids, refs } = specTargets(ctx, args)
  const patch = asRecord(args.patch)
  if (patch.mergeInto === undefined) {
    // A dry run of a reversible bulk edit: what it touches, bound to the specs' current versions.
    const { version } = await bulkVersion(ctx, row, ids)
    return { effect: ctx.v2.t('specs.confirm.bulk', { count: ids.length }), refs, version }
  }
  const target = ctx.v2.target({ ...args, ref: patch.mergeInto }, 'spec')
  const targetId = specIdOf(target.id)
  const { version, tickets } = await bulkVersion(ctx, row, [targetId, ...ids])
  const titles = tickets.filter((t) => ids.includes(t.id as number)).map((t) => `#${t.id} ${clip(neutralize(textOf(t.title)), 40)}`).join('; ')
  return { effect: ctx.v2.t('specs.confirm.merge', { count: ids.length, target: specRef(row, targetId), titles }), refs: [specRef(row, targetId), ...refs], version }
}

async function bulkUpdate(ctx: V2CallContext, args: Row): Promise<unknown> {
  const { row, ids, refs } = specTargets(ctx, args)
  const patch = asRecord(args.patch)
  const items = optionsOf(args).items
  const op = Array.isArray(items) ? 'items' : bulkOperation(patch)
  const say = (key: string, out: Row, extra: Record<string, string | number> = {}) => ctx.v2.t(key, { changed: asArray(out.changed).length, skipped: asArray(out.skipped).length, ...extra })
  const skipped = (out: Row) => asArray(out.skipped).map(asRecord).map((s) => ({ ref: specRef(row, s.id as number), reason: s.reason }))
  const refList = (out: Row) => asArray(out.changed).map((id) => specRef(row, id as number))
  switch (op) {
    case 'items': {
      // An undo of an earlier bulk edit: a patch per spec, keyed by ref.
      const list = (items as unknown[]).map(asRecord).map((item) => ({ id: specIdOf(ctx.v2.target({ ...args, ref: item.ref }, 'spec').id), patch: asRecord(item.patch) }))
      const out = await bulk(ctx, row, { op: 'update', items: list })
      return result({ changed: refList(out), skipped: skipped(out) }, { summary: say('specs.summary.bulk.update', out) })
    }
    case 'update': {
      const bulkPatch: Row = {}
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'rail') continue
        if (!BULK_KEYS.has(key)) throw new V2ToolError('invalid_input', `bulk_update edits ${[...BULK_KEYS].join(', ')} (+ rail, trash, restore, mergeInto, reorder); "${key}" is per spec: use update.`)
        bulkPatch[key] = key === 'milestone' && value !== null ? Number(milestoneLabel(value)!.slice(1)) : value
      }
      const out = Object.keys(bulkPatch).length ? await bulk(ctx, row, { op: 'update', ids, patch: bulkPatch }) : { changed: [], skipped: [] }
      const extra: Row = {}
      if (patch.rail !== undefined) Object.assign(extra, await assignRail(ctx, row, ids, patch.rail))
      const previous = asRecord(out.previous)
      const undoItems = Object.entries(previous).map(([id, prev]) => ({ ref: specRef(row, Number(id)), patch: prev }))
      return result({
        changed: refList(out), skipped: skipped(out), ...extra,
        ...(undoItems.length ? { undo: { tool: 'specrails_specs', args: { action: 'bulk_update', refs: undoItems.map((i) => i.ref), patch: {}, options: { items: undoItems } } } } : {}),
      }, { summary: Object.keys(bulkPatch).length ? say('specs.summary.bulk.update', out) : ctx.v2.t('specs.summary.bulk.rail', { count: ids.length }) })
    }
    case 'rail': {
      const extra = await assignRail(ctx, row, ids, patch.rail)
      return result({ changed: refs, skipped: [], ...extra }, { summary: ctx.v2.t('specs.summary.bulk.rail', { count: ids.length }) })
    }
    case 'trash': {
      const out = await bulk(ctx, row, { op: 'trash', ids })
      const changed = refList(out)
      return result({ changed, skipped: skipped(out), ...(changed.length ? { undo: { tool: 'specrails_specs', args: { action: 'bulk_update', refs: changed, patch: { restore: true } } } } : {}) },
        { summary: say('specs.summary.bulk.trash', out) })
    }
    case 'restore': {
      const out = await bulk(ctx, row, { op: 'restore', ids })
      return result({ changed: refList(out), skipped: skipped(out) }, { summary: say('specs.summary.bulk.restore', out) })
    }
    case 'merge': {
      const targetId = specIdOf(ctx.v2.target({ ...args, ref: patch.mergeInto }, 'spec').id)
      const out = await bulk(ctx, row, { op: 'merge', targetId, ids })
      const target = asRecord(out.target)
      return result({ target: listItem(row, target, true), merged: ids.map((id) => specRef(row, id)), skipped: skipped(out),
        undo: { tool: 'specrails_specs', args: { action: 'bulk_update', refs: ids.map((id) => specRef(row, id)), patch: { restore: true } } } },
      { summary: ctx.v2.t('specs.summary.bulk.merge', { count: ids.length, target: specRef(row, targetId) }), refs: { spec: specRef(row, targetId) }, untrusted: untrusted('/data/target/title', '/data/target/summary') })
    }
    case 'reorder': {
      const out = await bulk(ctx, row, { op: 'reorder', ids })
      return result({ order: ids.map((id) => specRef(row, id)), changed: refList(out), skipped: skipped(out) }, { summary: say('specs.summary.bulk.reorder', out) })
    }
  }
}

// ── Create ──────────────────────────────────────────────────────────────────

function ideaOf(args: Row): string {
  return [args.title, args.body].filter((v): v is string => typeof v === 'string' && v.trim().length > 0).join('\n\n').trim()
}

const pass = (options: Row, keys: readonly string[]) => Object.fromEntries(keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]))

/** A created ticket as the create result. */
function createdResult(ctx: V2CallContext, row: ProjectRow, ticket: Row, mode: string): unknown {
  const ref = specRef(row, ticket.id as number)
  const state = ctx.v2.state(projectSpecState(row, ticket))
  return result(listItem(row, ticket, true), { summary: ctx.v2.t('specs.summary.created', { ref, mode }), refs: { spec: ref }, state, untrusted: untrusted('/data/title', '/data/summary') })
}

async function createSpec(ctx: V2CallContext, args: Row): Promise<unknown> {
  const row = ctx.v2.project(args)
  const mode = String(args.mode)
  const options = optionsOf(args)
  const repositoryIds = options.repositoryIds ?? options.repositories
  const scope = repositoryIds === undefined ? {} : { repositoryIds }
  switch (mode) {
    case 'request': {
      // Add Spec → Quick (the propose flow): the project's spec agent writes the spec from the person's request.
      const idea = ideaOf(args)
      const body = {
        idea, ...scope, ...pass(options, ['model', 'aiEngine', 'contextScope', 'attachmentIds', 'pendingSpecId', 'createLocal']),
        contractRefine: typeof options.contractRefine === 'boolean' ? options.contractRefine : true,
        ...(options.intent === true ? { intent: true } : {}),
      }
      const run = await runAsync(ctx, 'generate', async () => {
        const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/generate-spec`, body))
        return { key: String(response.requestId), response: {} }
      }, waitMsOf(args))
      if (run.outcome.status === 'done' && run.outcome.spec) {
        const ticket = await readTicket(ctx, row, run.outcome.spec).catch(() => null)
        if (ticket) return createdResult(ctx, row, ticket, mode)
      }
      return asyncResult(ctx, row, run.key, run.outcome, {})
    }
    case 'draft': {
      // A complete spec the agent authored with the person (v1 commit_draft).
      const framed = ctx.firstPartyAgent ? ctx.originConversationId ?? null : null
      if (framed) {
        const refusal = checkSpecFraming(ctx.desktopDb, framed)
        if (refusal) throw new V2ToolError('invalid_input', refusal)
      }
      const intent = options.intent ?? (framed ? answeredSpecIntent(ctx.desktopDb, framed) : null)
      const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/from-draft`, {
        title: args.title, description: args.body, ...scope,
        ...pass(options, ['labels', 'priority', 'assignee', 'prerequisites', 'metadata', 'createLocal', 'pendingSpecId', 'conversationId', 'draftTicketId']),
        ...(options.criteria !== undefined ? { acceptanceCriteria: options.criteria } : {}),
        ...(options.summary !== undefined ? { shortSummary: options.summary } : {}),
        contractRefine: options.contractRefine === true,
        ...(framed ? { agentProvider: originConversationDefaults(ctx).provider } : {}),
        ...(intent ? { intent } : {}),
      }))
      if (framed) recordSpecCommitted(ctx.desktopDb, framed)
      return createdResult(ctx, row, asRecord(response.ticket), mode)
    }
    case 'verbatim': {
      // Add Spec → Raw: the text becomes the spec as written, no AI.
      if (typeof args.body !== 'string' || !args.body.trim()) throw new V2ToolError('invalid_input', ctx.v2.t('specs.error.verbatim_body'))
      const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/from-prompt`, {
        description: args.body, title: args.title, structured: false, ...scope, ...pass(options, ['labels', 'priority', 'pendingSpecId']),
      }))
      return createdResult(ctx, row, asRecord(response.ticket), mode)
    }
    case 'idea': {
      // A captured idea: a draft spec to shape later (promote, refine or Explore).
      const title = typeof args.title === 'string' && args.title.trim() ? args.title : clip(textOf(args.body).split('\n')[0], 120)
      const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets`, {
        title, description: textOf(args.body), status: 'draft', priority: null, source: 'mcp', ...pass(options, ['labels']),
      }))
      return createdResult(ctx, row, asRecord(response.ticket), mode)
    }
    default:
      throw new V2ToolError('invalid_input', 'mode is request, draft, verbatim or idea.')
  }
}

// ── Trash ───────────────────────────────────────────────────────────────────

async function trashList(ctx: V2CallContext, args: Row): Promise<unknown> {
  const row = ctx.v2.project(args)
  const response = asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets/trash`))
  const entries = asArray(response.items).map(asRecord).map((entry) => {
    const ticket = asRecord(entry.ticket)
    return { ref: specRef(row, ticket.id as number), title: ticket.title, status: ticket.status, deleted: minute(entry.deletedAt), purge: minute(entry.purgeAt) }
  })
  const page = pageOf(entries, { cursor: args.cursor, limit: args.limit, key: `trash:${row.id}` })
  return result({ items: page.items, retentionDays: response.retentionDays }, {
    pageBase: page.base,
    summary: ctx.v2.t(entries.length ? 'specs.summary.trash' : 'specs.summary.trash_empty', { count: entries.length, days: response.retentionDays as number }),
    page: page.page,
    untrusted: untrusted('/data/items/*/title'),
  })
}

function purgeTargets(ctx: V2CallContext, args: Row): { row: ProjectRow; ids: number[] } {
  if (args.refs !== undefined) { const t = specTargets(ctx, args); return { row: t.row, ids: t.ids } }
  const t = specTarget(ctx, args)
  return { row: t.row, ids: [t.id] }
}

async function purgePreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const { row, ids } = purgeTargets(ctx, args)
  const response = asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets/trash`))
  const entries = asArray(response.items).map(asRecord).filter((entry) => ids.includes(asRecord(entry.ticket).id as number))
  const missing = ids.filter((id) => !entries.some((entry) => asRecord(entry.ticket).id === id))
  if (missing.length) throw new V2ToolError('not_found', ctx.v2.t('specs.error.not_in_trash', { refs: missing.map((id) => specRef(row, id)).join(', ') }))
  const titles = entries.map((entry) => `#${asRecord(entry.ticket).id} ${clip(neutralize(textOf(asRecord(entry.ticket).title)), 40)}`).join('; ')
  return {
    effect: ctx.v2.t('specs.confirm.purge', { count: ids.length, titles }),
    refs: ids.map((id) => specRef(row, id)),
    version: `t${shortHash(entries.map((entry) => [asRecord(entry.ticket).id, entry.deletedAt]).sort())}`,
  }
}

// ── Addenda and attachments ─────────────────────────────────────────────────

function addendumResult(ctx: V2CallContext, row: ProjectRow, specId: number, response: Row, summaryKey: string): unknown {
  const addendum = asRecord(response.addendum)
  const ref = childRef(row, 'addendum', specId, String(addendum.id))
  const warnings = asArray(response.warnings).map((w) => typeof w === 'string' ? w : textOf(asRecord(w).message) || JSON.stringify(w))
  const ticket = asRecord(response.ticket)
  return result({ ref, spec: specRef(row, specId), kind: addendum.kind, status: addendum.status, ...(addendum.title ? { title: addendum.title } : {}), body: addendum.body }, {
    summary: ctx.v2.t(summaryKey, { ref, spec: specRef(row, specId) }),
    refs: { addendum: ref, spec: specRef(row, specId) },
    ...(Object.keys(ticket).length ? { state: ctx.v2.state(projectSpecState(row, ticket)) } : {}),
    ...(warnings.length ? { warnings } : {}),
    untrusted: untrusted('/data/title', '/data/body'),
  })
}

async function addendumPreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const { row, specId, childId, ref } = childTarget(ctx, args, 'addendum', 'addendumId')
  const ticket = await readTicket(ctx, row, specId)
  const addendum = readSpecAddenda(ticket.addenda as never).find((a) => a.id === childId)
  if (!addendum) throw new V2ToolError('not_found', ctx.v2.t('specs.error.addendum_unknown', { ref }))
  return { effect: ctx.v2.t('specs.confirm.addendum_delete', { ref, title: clip(neutralize(addendum.title ?? addendum.body), 60) }), refs: [ref], version: `a${shortHash([addendum.id, addendum.status, addendum.body, addendum.title ?? null])}` }
}

async function attachmentPreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const { row, specId, childId, ref } = childTarget(ctx, args, 'attachment', 'attachmentId')
  const list = asArray(asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets/${specId}/attachments`)).attachments).map(asRecord)
  const hit = list.find((a) => String(a.id) === childId)
  if (!hit) throw new V2ToolError('not_found', ctx.v2.t('specs.error.attachment_unknown', { ref }))
  return { effect: ctx.v2.t('specs.confirm.detach', { ref, name: neutralize(String(hit.filename ?? hit.name ?? childId)) }), refs: [ref], version: `f${shortHash([hit.id, hit.size ?? null])}` }
}

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html',
}

/** Uploads a local file (path) or inline base64 (≤ 5 MB) through the multipart attachment route. */
async function attachFile(ctx: V2CallContext, args: Row): Promise<unknown> {
  const { row, id, ref } = specTarget(ctx, args)
  const options = optionsOf(args)
  const file = String(options.file)
  let buffer: Buffer
  let name: string
  if (typeof options.base64 === 'string') {
    buffer = Buffer.from(options.base64, 'base64')
    name = path.basename(file)
  } else {
    const resolved = path.resolve(file.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
    const stat = await fs.promises.stat(resolved).catch(() => null)
    if (!stat?.isFile()) throw new V2ToolError('not_found', ctx.v2.t('specs.error.file_missing', { file }))
    if (stat.size > ATTACH_MAX_BYTES) throw new V2ToolError('invalid_input', ctx.v2.t('specs.error.file_too_large', { max: 5 }))
    buffer = await fs.promises.readFile(resolved)
    name = path.basename(resolved)
  }
  if (buffer.length > ATTACH_MAX_BYTES) throw new V2ToolError('invalid_input', ctx.v2.t('specs.error.file_too_large', { max: 5 }))
  const type = typeof options.mimeType === 'string' ? options.mimeType : MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)], { type }), name)
  const timeout = AbortSignal.timeout(60_000)
  const res = await fetch(`http://127.0.0.1:${ctx.desktopPort}/api${base(row)}/tickets/${id}/attachments`, {
    method: 'POST', headers: { Authorization: `Bearer ${loadOrGenerateToken()}` }, body: form, signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  })
  const body = asRecord(await res.json().catch(() => ({})))
  if (!res.ok) throw new V2ToolError(res.status === 404 ? 'not_found' : 'invalid_input', `Upload refused (${res.status}): ${textOf(body.error) || 'unknown error'}`)
  const attachment = asRecord(body.attachment)
  const attachmentRef = childRef(row, 'attachment', id, String(attachment.id))
  return result({ ref: attachmentRef, spec: ref, name: attachment.filename ?? name, type: attachment.mimeType ?? type, size: attachment.size ?? buffer.length }, {
    summary: ctx.v2.t('specs.summary.attached', { name, spec: ref }),
    refs: { attachment: attachmentRef, spec: ref },
    untrusted: untrusted('/data/name'),
  })
}

// ── The tool ────────────────────────────────────────────────────────────────

const writeSummary = (ctx: V2CallContext, key: string, params: Record<string, string | number>, meta: ResultMeta = {}) => ({ summary: ctx.v2.t(key, params), ...meta })

/** WP5. Specs: read, write, AI authoring, trash, addenda, attachments. */
export const specsTool = defineTool({
  name: 'specrails_specs',
  title: 'Specs',
  description: 'Specs: list, get views, search, create (request=AI, draft, verbatim, idea), edit, bulk edit, AI refine, trash, addenda, attachments.',
  owner: 'WP5',
  alwaysLoad: true,
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(DETAIL_SECTIONS),
    refs: F.refs.describe('bulk_update/purge: specs'),
    query: z.string(),
    mode: z.enum(['request', 'draft', 'verbatim', 'idea']),
    title: z.string(),
    body: z.string(),
    patch: F.object().describe('Fields to change'),
    filter: F.filter.describe('list: status[], label, priority, milestone, rail, since'),
  },
  actions: {
    list: {
      tier: 'read', handler: listSpecs,
      doc: 'Paged backlog (default 25, max 100). filter: status (draft|todo|in_progress|on_review|done|cancelled|active|all; array or CSV), label (any of), priority, milestone (2 or M2), rail (index or name), since (ISO), epic (ref); query = text; options.sort updated|priority|id|created. view detail adds summary, triage, jira, order.',
    },
    get: {
      tier: 'read', required: ['ref'], handler: getSpec,
      doc: 'One spec with its decision state. view detail (or fields) adds body and sections: criteria, addenda, timeline (runs, deliveries, edits; cursor/limit page it, options.kinds), handoff (options.format pr|md|html), attachments, files (options.repository), spend. options.request reads an async AI result (create request, ai_edit, smash).',
    },
    search: { tier: 'read', required: ['query'], handler: searchSpecs, doc: 'Ranked text search over title, summary, body, labels, addenda, comments (≤ 30). With filter it narrows list instead.' },
    create: {
      tier: (args) => AI_CREATE_MODES.has(String(args.mode)) || (args.mode === 'draft' && optionsOf(args).contractRefine === true) ? 'ai-spawn' : 'write',
      confirm: (args) => AI_CREATE_MODES.has(String(args.mode)) || (args.mode === 'draft' && optionsOf(args).contractRefine === true) ? 'costly' : null,
      required: ['mode'], oneOf: ['title', 'body'],
      doc: 'mode request: the spec agent writes the spec from the person\'s request or problem (AI; waits up to options.waitMs, default 20 s); draft: a complete spec you wrote (title, body, options.criteria/labels/priority/intent/summary); verbatim: the body as written (no AI); idea: a draft-status spec to shape later. options.repositoryIds, labels, priority, model, aiEngine, contractRefine.',
      preview: (ctx, args) => costlyPreview(ctx, args, SURFACES.create, 'specs.confirm.create', ctx.v2.project(args), null, { idea: ideaOf(args) }),
      handler: createSpec,
    },
    update: {
      tier: 'write', required: ['ref', 'patch'], handler: updateSpec,
      doc: 'patch: title, body, status (done marks it done), priority, labels, addLabels, removeLabels, milestone (n or null), assignee, prerequisites, criteria, summary, intent, nonGoals, repositoryIds, metadata, regressionOf (delivery ref), rail (index/name; null removes). Returns an undo call.',
    },
    bulk_update: {
      tier: 'write',
      // Merging cannot be undone; trashing many specs at once is restorable but always confirmed (risky).
      confirm: (args) => asRecord(args.patch).mergeInto !== undefined ? 'irreversible'
        : asRecord(args.patch).trash === true && Array.isArray(args.refs) && args.refs.length > BULK_TRASH_CONFIRM_ABOVE ? 'risky' : null,
      required: ['refs', 'patch'],
      doc: 'One operation on up to 200 specs. patch: status, priority, labels, addLabels, removeLabels, assignee, milestone, rail; or {trash: true} (restorable; over 20 specs confirmed), {restore: true}, {mergeInto: ref} (folds bodies into the target, trashes the rest; confirmed), {reorder: true} (execution order = refs order). Returns skipped specs with reasons and an undo call.',
      preview: (ctx, args) => bulkPreview(ctx, args),
      handler: bulkUpdate,
    },
    delete: {
      tier: 'write', required: ['ref'], doc: 'Moves to trash (restore undoes it).',
      handler: async (ctx, args) => {
        const { row, id, ref } = specTarget(ctx, args)
        await apiCall(ctx, 'DELETE', `${base(row)}/tickets/${id}`)
        return result({ ref, trashed: true, undo: { tool: 'specrails_specs', args: { action: 'restore', ref } } }, writeSummary(ctx, 'specs.summary.deleted', { ref }, { refs: { spec: ref } }))
      },
    },
    restore: {
      tier: 'write', required: ['ref'],
      handler: async (ctx, args) => {
        const { row, id, ref } = specTarget(ctx, args)
        const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/${id}/restore`))
        const ticket = asRecord(response.ticket)
        return result(listItem(row, ticket, true), writeSummary(ctx, response.alreadyLive ? 'specs.summary.restore_live' : 'specs.summary.restored', { ref },
          { refs: { spec: ref }, state: ctx.v2.state(projectSpecState(row, ticket)), untrusted: untrusted('/data/title', '/data/summary') }))
      },
    },
    trash: { tier: 'read', handler: trashList, doc: 'Recently deleted specs (newest first, paged) and their purge dates.' },
    purge: {
      tier: 'destructive', confirm: 'irreversible', oneOf: ['ref', 'refs'], doc: 'Deletes trashed specs permanently (attachments too). Always confirmed.',
      preview: purgePreview,
      handler: async (ctx, args) => {
        const { row, ids } = purgeTargets(ctx, args)
        const out = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/bulk`, { op: 'purge', ids }))
        const changed = asArray(out.changed).map((id) => specRef(row, id as number))
        return result({ purged: changed, skipped: asArray(out.skipped).map(asRecord).map((s) => ({ ref: specRef(row, s.id as number), reason: s.reason })) },
          writeSummary(ctx, 'specs.summary.purged', { count: changed.length }))
      },
    },
    refine: {
      tier: 'ai-spawn', confirm: 'costly', required: ['ref'], doc: 'Adds or redoes the Contract Layer (AI). options.aiEngine. Waits up to options.waitMs.',
      preview: async (ctx, args) => { const t = specTarget(ctx, args); const ticket = await readTicket(ctx, t.row, t.id); return costlyPreview(ctx, args, SURFACES.refine, 'specs.confirm.refine', t.row, t.ref, ticket.updated_at) },
      handler: async (ctx, args) => {
        const { row, id } = specTarget(ctx, args)
        const run = await runAsync(ctx, 'refine', async () => {
          await apiCall(ctx, 'POST', `${base(row)}/tickets/${id}/contract-refine`, pass(optionsOf(args), ['aiEngine']))
          return { key: `refine:${id}`, response: {} }
        }, waitMsOf(args))
        return asyncResult(ctx, row, run.key, { ...run.outcome, spec: id }, {})
      },
    },
    ai_edit: {
      tier: 'ai-spawn', confirm: 'costly', required: ['ref', 'body'],
      doc: 'body = editing instructions. Returns the AI proposal (not applied): apply it with update(patch.body). options.priorProposal and priorInstructions refine a proposal; options.cancel = request id stops one.',
      preview: async (ctx, args) => { const t = specTarget(ctx, args); const ticket = await readTicket(ctx, t.row, t.id); return costlyPreview(ctx, args, SURFACES.ai_edit, 'specs.confirm.ai_edit', t.row, t.ref, ticket.updated_at) },
      handler: async (ctx, args) => {
        const { row, id, ref } = specTarget(ctx, args)
        const options = optionsOf(args)
        if (typeof options.cancel === 'string' && options.cancel) {
          await apiCall(ctx, 'DELETE', `${base(row)}/tickets/${id}/ai-edit?requestId=${encodeURIComponent(options.cancel)}`)
          return result({ request: options.cancel, cancelled: true }, writeSummary(ctx, 'specs.summary.ai_edit_cancelled', { ref }))
        }
        const ticket = await readTicket(ctx, row, id)
        const run = await runAsync(ctx, 'ai_edit', async () => {
          const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/${id}/ai-edit`, {
            instructions: args.body, description: textOf(ticket.description) || ' ', title: ticket.title, ...pass(options, ['attachmentIds', 'priorInstructions', 'priorProposal', 'aiEngine']),
          }))
          return { key: String(response.requestId), response: {} }
        }, waitMsOf(args))
        return asyncResult(ctx, row, run.key, { ...run.outcome, spec: id }, {})
      },
    },
    smash: {
      tier: 'ai-spawn', confirm: 'costly', required: ['ref'], doc: 'Splits a spec into ordered sub-specs (an epic). options.mode simple|full, model. Needs a Contract Layer; waits up to options.waitMs.',
      preview: async (ctx, args) => { const t = specTarget(ctx, args); const ticket = await readTicket(ctx, t.row, t.id); return costlyPreview(ctx, args, SURFACES.smash, 'specs.confirm.smash', t.row, t.ref, ticket.updated_at) },
      handler: async (ctx, args) => {
        const { row, id } = specTarget(ctx, args)
        const run = await runAsync(ctx, 'smash', async () => {
          await apiCall(ctx, 'POST', `${base(row)}/tickets/${id}/smash`, pass(optionsOf(args), ['mode', 'model']))
          return { key: `smash:${id}`, response: {} }
        }, waitMsOf(args))
        return asyncResult(ctx, row, run.key, { ...run.outcome, spec: id }, {})
      },
    },
    smash_undo: {
      tier: 'write', required: ['ref'], doc: 'Reverses the last SMASH of an epic (removes its sub-specs). options.smashedAt when not the latest.',
      handler: async (ctx, args) => {
        const { row, id, ref } = specTarget(ctx, args)
        let smashedAt = optionsOf(args).smashedAt
        if (typeof smashedAt !== 'string' || !smashedAt) {
          const children = asArray(asRecord(await apiCall(ctx, 'GET', `${base(row)}/tickets?epic=${id}&limit=200`)).tickets).map(asRecord)
          const created = children.map((child) => textOf(child.created_at)).filter(Boolean).sort()
          if (!created.length) throw new V2ToolError('invalid_input', ctx.v2.t('specs.error.not_smashed', { ref }))
          smashedAt = created[0]
        }
        const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/${id}/smash/undo`, { smashedAt }))
        return result({ ref, removed: asArray(response.deletedChildren).map((child) => specRef(row, (typeof child === 'number' ? child : asRecord(child).id) as number)) },
          writeSummary(ctx, 'specs.summary.smash_undone', { ref }, { refs: { spec: ref } }))
      },
    },
    triage: {
      tier: 'write', oneOf: ['ref', 'refs'], doc: 'Recomputes the triage (size, likely files, recommended loop) of one or more specs.',
      handler: async (ctx, args) => {
        const { row, ids } = purgeTargets(ctx, args)
        const items: Row[] = []
        for (const id of ids) {
          try {
            const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/${id}/triage`))
            const triage = asRecord(response.triage)
            items.push({ ref: specRef(row, id), ...(triage.status === 'ready' ? { size: triage.size, loop: triage.recommendedLoopName ?? triage.recommendedLoop, confidence: triage.confidence, rationale: triage.rationale, files: asArray(triage.filesLikely).slice(0, 8) } : { status: triage.status, reason: triage.reason ?? triage.error }) })
          } catch (err) {
            items.push({ ref: specRef(row, id), status: 'failed', reason: err instanceof Error ? clip(err.message, 160) : String(err) })
          }
        }
        return result({ items }, { summary: ctx.v2.t('specs.summary.triaged', { count: items.filter((i) => i.size).length, total: ids.length }), untrusted: untrusted('/data/items/*/rationale', '/data/items/*/reason') })
      },
    },
    addendum_add: {
      tier: 'write', required: ['ref', 'body'], doc: 'The way to iterate on a spec: the note rides into its next launch. options.kind change-request|review-feedback|clarification|constraint, options.title.',
      handler: async (ctx, args) => {
        const { row, id } = specTarget(ctx, args)
        const options = optionsOf(args)
        const response = asRecord(await apiCall(ctx, 'POST', `${base(row)}/tickets/${id}/addenda`, {
          body: args.body, ...pass(options, ['kind']), ...(typeof args.title === 'string' ? { title: args.title } : pass(options, ['title'])),
          createdBy: ctx.originConversationId ? 'agent' : 'mcp', originConversationId: ctx.originConversationId ?? undefined,
        }))
        return addendumResult(ctx, row, id, response, 'specs.summary.addendum_added')
      },
    },
    addendum_update: {
      tier: 'write', required: ['ref', 'body'], doc: 'Rewrites an open or dismissed addendum (ref addendum:<p>/<spec>:<id>). options.kind, options.title.',
      handler: async (ctx, args) => {
        const { row, specId, childId } = childTarget(ctx, args, 'addendum', 'addendumId')
        const response = asRecord(await apiCall(ctx, 'PATCH', `${base(row)}/tickets/${specId}/addenda/${encodeURIComponent(childId)}`, {
          body: args.body, ...pass(optionsOf(args), ['kind']), ...(typeof args.title === 'string' ? { title: args.title } : pass(optionsOf(args), ['title'])),
        }))
        return addendumResult(ctx, row, specId, response, 'specs.summary.addendum_updated')
      },
    },
    addendum_dismiss: {
      tier: 'write', required: ['ref'],
      handler: async (ctx, args) => {
        const { row, specId, childId } = childTarget(ctx, args, 'addendum', 'addendumId')
        const response = asRecord(await apiCall(ctx, 'PATCH', `${base(row)}/tickets/${specId}/addenda/${encodeURIComponent(childId)}`, { status: 'dismissed' }))
        return addendumResult(ctx, row, specId, response, 'specs.summary.addendum_dismissed')
      },
    },
    addendum_reopen: {
      tier: 'write', required: ['ref'], doc: 'Reopens a dismissed or applied addendum. options.force releases one stuck in flight.',
      handler: async (ctx, args) => {
        const { row, specId, childId } = childTarget(ctx, args, 'addendum', 'addendumId')
        const response = asRecord(await apiCall(ctx, 'PATCH', `${base(row)}/tickets/${specId}/addenda/${encodeURIComponent(childId)}`, { status: 'open', ...(optionsOf(args).force === true ? { force: true } : {}) }))
        return addendumResult(ctx, row, specId, response, 'specs.summary.addendum_reopened')
      },
    },
    addendum_delete: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'],
      preview: addendumPreview,
      handler: async (ctx, args) => {
        const { row, specId, childId, ref } = childTarget(ctx, args, 'addendum', 'addendumId')
        await apiCall(ctx, 'DELETE', `${base(row)}/tickets/${specId}/addenda/${encodeURIComponent(childId)}`)
        return result({ ref, deleted: true }, writeSummary(ctx, 'specs.summary.addendum_deleted', { ref }, { refs: { spec: specRef(row, specId) } }))
      },
    },
    attach: {
      tier: 'write', required: ['ref', 'options.file'], doc: 'options.file = local path (≤ 5 MB), or a file name plus options.base64. options.mimeType.',
      handler: attachFile,
    },
    detach: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'], doc: 'Deletes an attachment (ref attachment:<p>/<spec>:<id>).',
      preview: attachmentPreview,
      handler: async (ctx, args) => {
        const { row, specId, childId, ref } = childTarget(ctx, args, 'attachment', 'attachmentId')
        await apiCall(ctx, 'DELETE', `${base(row)}/tickets/${specId}/attachments/${encodeURIComponent(childId)}`)
        return result({ ref, deleted: true }, writeSummary(ctx, 'specs.summary.detached', { ref }, { refs: { spec: specRef(row, specId) } }))
      },
    },
  },
})
