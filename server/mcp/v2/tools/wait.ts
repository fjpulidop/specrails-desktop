import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ProjectRow } from '../../../desktop-db'
import { getJob } from '../../../db/jobs'
import { JOURNAL_REF_KINDS, eventJournalFor, refKey, type EventJournal, type JournalEvent, type JournalFilter, type JournalRefKind } from '../../../modules/events-journal'
import type { McpToolContext } from '../../tools/types'
import { decodeCursor, encodeCursor } from '../core/cursor'
import { V2ToolError, result } from '../core/envelope'
import { translator, type Translate } from '../core/lang'
import { defineTool, type V2CallContext } from '../core/registry'
import { formatRef, parseRef, resolveProjectSelector, type RefKind } from '../core/refs'
import { approxTokens, RESPONSE_BUDGET } from '../core/size-guard'
import { statusFromChain, statusFromDelivery, statusFromJob, statusFromSpec, statusFromWord, type CanonicalStatus } from '../core/status-map'
import { neutralize, untrusted } from '../core/untrusted'
import { F } from '../core/views'
import type { RunHoldKind } from '../../../modules/loops/runtime/loop-run-hold'

/**
 * WP1. `specrails_wait`: one blocking call instead of polling, backed by the
 * durable event journal (server/modules/events-journal).
 *
 *   until  — returns as soon as a matching transition lands (or at once when the
 *            refs are already settled), else after `timeoutMs` (default 25 s,
 *            max 45 s: under every client's tool timeout). Re-call with `cursor`.
 *   events — a page of the journal after `since` ("what happened while I was away").
 *
 * Both answer with the same journal cursor, so either can resume the other.
 */

export const WAIT_DEFAULT_MS = 25_000
export const WAIT_MAX_MS = 45_000
const WAKE_ITEMS = 8
const EVENTS_DEFAULT = 25
const CURSOR_KEY = 'journal'
/** Room left in the 800-token wake-up for summary, cursor and envelope keys. */
const WAKE_ITEMS_BUDGET = RESPONSE_BUDGET.waitWake - 180
const EVENTS_ITEMS_BUDGET = RESPONSE_BUDGET.summaryCap - 250
const WAIT_FORS = ['settled', 'needs_you', 'changed', 'any'] as const
type WaitFor = (typeof WAIT_FORS)[number]

// ── Refs ─────────────────────────────────────────────────────────────────────

interface WatchedRef { kind: JournalRefKind; id: string; project: ProjectRow | null; ref: string }

const JOURNAL_KINDS = new Set<string>(JOURNAL_REF_KINDS)

function resolveRefs(ctx: V2CallContext, raw: unknown): WatchedRef[] {
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw) ? raw : [raw]
  if (list.length > 20) throw new V2ToolError('invalid_input', ctx.v2.t('wait.error.too_many_refs', { max: 20 }))
  const rows = ctx.v2.projects()
  const seen = new Set<string>()
  const out: WatchedRef[] = []
  for (const value of list) {
    const parsed = parseRef(value)
    if (!parsed) throw new V2ToolError('invalid_input', ctx.v2.t('core.error.bad_ref', { ref: String(value) }))
    if (!JOURNAL_KINDS.has(parsed.kind)) throw new V2ToolError('invalid_input', ctx.v2.t('wait.error.kind', { kind: parsed.kind, kinds: JOURNAL_REF_KINDS.join(', ') }))
    const kind = parsed.kind as JournalRefKind
    let watched: WatchedRef
    if (kind === 'project') {
      const project = resolveProjectSelector(rows, parsed.id, ctx.v2.t)
      watched = { kind, id: project.id, project, ref: formatRef('project', project.slug) }
    } else if (parsed.project) {
      const project = resolveProjectSelector(rows, parsed.project, ctx.v2.t)
      watched = { kind, id: parsed.id, project, ref: formatRef(kind as RefKind, parsed.id, project.slug) }
    } else {
      watched = { kind, id: parsed.id, project: null, ref: formatRef(kind as RefKind, parsed.id) }
    }
    const key = refKey(watched.kind, watched.id)
    if (!seen.has(key)) { seen.add(key); out.push(watched) }
  }
  return out
}

// ── Status and wording ───────────────────────────────────────────────────────

const RUN_HOLDS = new Set<string>(['restart', 'interrupted', 'provider_limit', 'budget', 'question', 'approval', 'paused', 'queued'])

/** Journal row → the v2 status vocabulary (core status-map; never hand-mapped beyond journal-only words). */
export function canonicalOf(event: Pick<JournalEvent, 'refKind' | 'status' | 'hold' | 'attention'>): CanonicalStatus {
  switch (event.refKind) {
    case 'run':
      if (event.hold === 'stuck') return 'blocked'
      return statusFromJob(event.status, event.hold && RUN_HOLDS.has(event.hold) ? { kind: event.hold as RunHoldKind } : null)
    case 'delivery': return statusFromDelivery(event.status)
    case 'chain': return statusFromChain(event.status)
    case 'spec': return event.status === 'deleted' ? 'discarded' : statusFromSpec(event.status)
    case 'intent': return statusFromWord(event.status === 'needs-review' ? 'review' : event.status)
    case 'project': return event.status === 'cap_reached' ? 'blocked' : statusFromWord(event.status === 'installed' ? 'completed' : event.status)
    default: return statusFromWord(event.status)
  }
}

function reasonOf(event: JournalEvent, t: Translate): string | undefined {
  if (event.refKind === 'run' && event.hold) {
    if (event.hold === 'stuck') return t('wait.reason.stuck')
    if (event.hold === 'provider_limit' && event.data?.resumeAt) return t('core.hold.provider_limit_until', { at: event.data.resumeAt })
    if (event.hold === 'queued' && event.data?.waitingFor) return t('core.hold.queued_for', { waitingFor: event.data.waitingFor })
    if (RUN_HOLDS.has(event.hold)) return t(`core.hold.${event.hold}`)
  }
  switch (event.attention) {
    case 'review': return t(event.refKind === 'delivery' ? 'core.hold.pr_decision' : 'wait.reason.review')
    case 'failed': return t('wait.reason.failed')
    case 'budget': return t('wait.reason.budget')
    case 'blocked': return t(event.refKind === 'chain' ? 'core.hold.chain' : 'wait.reason.blocked')
    case 'approval': return t('core.hold.approval')
    case 'question': return t('core.hold.question')
    default: return undefined
  }
}

interface NextCall { tool: string; args: Record<string, unknown>; needs?: string[] }

/** The call that opens or acts on the entity (always a catalog tool/action; wait.test.ts checks it). */
export function nextOf(event: Pick<JournalEvent, 'refKind' | 'hold' | 'attention' | 'kind'>, ref: string): NextCall {
  switch (event.refKind) {
    case 'run':
      if (event.hold === 'question') return { tool: 'specrails_runs', args: { action: 'answer', ref }, needs: ['answer|optionId'] }
      if (event.hold === 'approval') return { tool: 'specrails_runs', args: { action: 'approve', ref } }
      if (event.hold === 'provider_limit') return { tool: 'specrails_runs', args: { action: 'limit', ref } }
      if (event.attention === 'failed') return { tool: 'specrails_runs', args: { action: 'diagnose', ref } }
      return { tool: 'specrails_runs', args: { action: 'get', ref } }
    case 'delivery': return { tool: 'specrails_deliveries', args: { action: 'get', ref } }
    case 'chain': return { tool: 'specrails_blueprint', args: { action: 'chain_get', ref } }
    case 'intent': return { tool: 'specrails_missions', args: { action: 'intent_get', ref } }
    case 'spec': return { tool: 'specrails_specs', args: { action: 'get', ref } }
    case 'mission':
      if (event.hold === 'provider_limit') return { tool: 'specrails_missions', args: { action: 'limit_continue', ref } }
      return { tool: 'specrails_missions', args: { action: 'get', ref } }
    case 'project':
      if (event.kind === 'project.budget') return { tool: 'specrails_insights', args: { action: 'budget_get', ref } }
      return { tool: 'specrails_projects', args: { action: 'install_status', ref } }
    case 'blueprint': return { tool: 'specrails_blueprint', args: { action: 'get', ref } }
    case 'milestone': return { tool: 'specrails_blueprint', args: { action: 'milestones', ref } }
  }
}

export interface FiredItem {
  ref: string
  status: CanonicalStatus
  label: string
  from?: CanonicalStatus
  what: string
  needs?: string
  reason?: string
  title?: string
  detail?: string
  question?: { id: string; kind: string; text: string; options?: Array<{ id: string; label: string }>; recommended?: string }
  data?: Record<string, unknown>
  next?: NextCall
  at: string
  seq: number
}

function refOf(event: JournalEvent, slugs: Map<string, string>): string {
  const kind = event.refKind as RefKind
  if (kind === 'project') return formatRef('project', slugs.get(event.refId) ?? event.refId)
  if (kind === 'mission' || kind === 'blueprint') return formatRef(kind, event.refId)
  const slug = event.projectId ? slugs.get(event.projectId) ?? event.projectId : null
  return slug ? formatRef(kind, event.refId, slug) : `${kind}:${event.refId}`
}

function itemOf(event: JournalEvent, from: string | null, slugs: Map<string, string>, t: Translate): FiredItem {
  const ref = refOf(event, slugs)
  const status = canonicalOf(event)
  const prev = from !== null ? canonicalOf({ ...event, status: from, hold: null }) : undefined
  const q = event.data?.question
  const { question: _question, ...rest } = event.data ?? {}
  const item: FiredItem = {
    ref, status, label: t(`core.status.${status}`),
    ...(prev && prev !== status ? { from: prev } : {}),
    what: event.kind,
    ...(event.attention ? { needs: event.attention } : {}),
    ...(reasonOf(event, t) ? { reason: reasonOf(event, t) } : {}),
    ...(event.title ? { title: neutralize(event.title) } : {}),
    ...(event.detail && event.detail !== q?.text ? { detail: neutralize(event.detail) } : {}),
    ...(q ? { question: { id: q.interruptId, kind: q.kind, text: neutralize(q.text), ...(q.options.length ? { options: q.options.map((o) => ({ id: o.id, label: neutralize(o.label) })) } : {}), ...(q.recommended ? { recommended: q.recommended } : {}) } } : {}),
    ...(Object.keys(rest).length ? { data: rest } : {}),
    ...(event.attention || event.settled ? { next: nextOf(event, ref) } : {}),
    at: event.at,
    seq: event.seq,
  }
  return item
}

/**
 * Collapses rows to one item per ref (its latest state, `from` = the state
 * before the first row) within a token budget. Returns the items and the seq
 * of the last row they cover (the resume point when the budget cut the page).
 */
export function collapse(events: readonly JournalEvent[], slugs: Map<string, string>, t: Translate, budgetTokens: number): { items: FiredItem[]; lastSeq: number | null; cut: boolean } {
  const byRef = new Map<string, { item: FiredItem; from: string | null }>()
  let lastSeq: number | null = null
  for (const event of events) {
    const key = refKey(event.refKind, event.refId)
    const previous = byRef.get(key)
    const from = previous ? previous.from : event.prevStatus
    const candidate = new Map(byRef)
    candidate.delete(key)
    candidate.set(key, { item: itemOf(event, from, slugs, t), from })
    const items = [...candidate.values()].map((entry) => entry.item)
    if (lastSeq !== null && approxTokens(JSON.stringify(items)) > budgetTokens) {
      return { items: [...byRef.values()].map((entry) => entry.item), lastSeq, cut: true }
    }
    byRef.clear()
    for (const [k, v] of candidate) byRef.set(k, v)
    lastSeq = event.seq
  }
  return { items: [...byRef.values()].map((entry) => entry.item), lastSeq, cut: false }
}

// ── Cursor ───────────────────────────────────────────────────────────────────

function cursorFor(journal: EventJournal, seq: number): string {
  return encodeCursor({ offset: seq, path: '/items', key: CURSOR_KEY, inner: journal.epoch() })
}

/** The seq a `since` cursor resumes after; null when absent. Warnings for a reset or a retention gap. */
function sinceSeq(journal: EventJournal, since: unknown, t: Translate, warnings: string[]): number | null {
  const state = decodeCursor(since, CURSOR_KEY)
  if (!state) return null
  const { head, oldest } = journal.bounds()
  if (state.inner !== journal.epoch() || state.offset > head) {
    warnings.push(t('wait.warning.cursor_reset'))
    return null
  }
  if (oldest > 0 && state.offset < oldest - 1) warnings.push(t('wait.warning.gap'))
  return state.offset
}

function journalOf(ctx: McpToolContext): EventJournal {
  return eventJournalFor(ctx.desktopDb, ctx.eventBus)
}

function slugMap(ctx: V2CallContext): Map<string, string> {
  return new Map(ctx.v2.projects().map((row) => [row.id, row.slug]))
}

function filterFor(mode: WaitFor, refs: readonly WatchedRef[], projectId: string | undefined): JournalFilter {
  const base = { ...(refs.length ? { refs: refs.map((r) => ({ kind: r.kind, id: r.id })) } : {}), ...(projectId ? { projectId } : {}) }
  switch (mode) {
    case 'settled': return { ...base, match: 'settled' }
    case 'needs_you': return { ...base, match: 'attention' }
    case 'changed': return { ...base, match: 'all' }
    case 'any': return { ...base, match: 'all', alsoAttention: refs.length > 0 }
  }
}

/** Run refs the journal has never seen: their durable job row (finished before the journal knew them). */
function currentJobState(ctx: V2CallContext, ref: WatchedRef): JournalEvent | null {
  if (ref.kind !== 'run' || !ref.project) return null
  try {
    const db = ctx.registry.getContext?.(ref.project.id)?.db
    const job = db ? getJob(db, ref.id) : undefined
    if (!job) return null
    const status = String(job.status)
    const settled = ['completed', 'failed', 'canceled', 'skipped', 'zombie_terminated'].includes(status)
    return {
      seq: 0, at: String(job.finished_at ?? job.started_at ?? new Date().toISOString()), prevStatus: null,
      projectId: ref.project.id, refKind: 'run', refId: ref.id, kind: 'run.status', status,
      hold: null, attention: status === 'failed' || status === 'zombie_terminated' ? 'failed' : null, settled,
      title: null, detail: null, data: null, source: 'jobs',
    }
  } catch {
    return null
  }
}

const isSettledLike = (event: JournalEvent) => event.settled || event.attention !== null

// ── Handlers ─────────────────────────────────────────────────────────────────

const UNTRUSTED = (root: string) => untrusted(`${root}/*/title`, `${root}/*/detail`, `${root}/*/question`)

function summaryOf(items: readonly FiredItem[], t: Translate): string {
  const first = items[0]
  const phrase = t('wait.item', { ref: first.ref, label: first.label })
  return items.length === 1 ? t('wait.summary.fired_one', { item: phrase }) : t('wait.summary.fired', { count: items.length, item: phrase })
}

async function untilHandler(ctx: V2CallContext, args: Record<string, unknown>) {
  const t = ctx.v2.t
  const journal = journalOf(ctx)
  const refs = resolveRefs(ctx, args.refs)
  const mode: WaitFor = (WAIT_FORS as readonly string[]).includes(String(args.for)) ? args.for as WaitFor : refs.length ? 'settled' : 'needs_you'
  const project = typeof args.project === 'string' && args.project.trim() ? ctx.v2.project(args) : null
  const timeoutMs = Math.min(WAIT_MAX_MS, Math.max(1_000, typeof args.timeoutMs === 'number' ? args.timeoutMs : WAIT_DEFAULT_MS))
  const limit = Math.min(WAKE_ITEMS, typeof args.limit === 'number' && args.limit > 0 ? args.limit : WAKE_ITEMS)
  const warnings: string[] = []
  const filter = filterFor(mode, refs, project?.id)
  const slugs = slugMap(ctx)
  const since = sinceSeq(journal, args.since, t, warnings)

  const pendingOf = (fired: readonly FiredItem[]) => {
    if (mode !== 'settled' || !refs.length) return undefined
    const latest = journal.latest(refs)
    const done = new Set(fired.filter((item) => item.next).map((item) => item.ref))
    const waiting = refs.filter((ref) => {
      const last = latest.get(refKey(ref.kind, ref.id))
      return !done.has(ref.ref) && !(last && isSettledLike(last))
    }).map((ref) => ref.ref)
    return waiting.length ? waiting : undefined
  }
  const reply = (items: FiredItem[], cursorSeq: number, extra: { timedOut: boolean; more?: boolean; reason?: string; waitedMs?: number }) => {
    const pending = pendingOf(items)
    const summary = items.length ? summaryOf(items, t)
      : extra.reason === 'interrupted' ? t('wait.summary.interrupted')
        : t('wait.summary.timeout', { seconds: Math.round((extra.waitedMs ?? timeoutMs) / 1000) })
    return result({
      fired: items,
      ...(pending ? { pending } : {}),
      cursor: cursorFor(journal, cursorSeq),
      timedOut: extra.timedOut,
      ...(extra.more ? { more: true } : {}),
      ...(extra.reason === 'interrupted' ? { interrupted: true } : {}),
    }, { summary, warnings, untrusted: UNTRUSTED('/data/fired') })
  }

  // 1. Current state first: refs that already settled (or need the person) answer at once.
  if (since === null && refs.length && (mode === 'settled' || mode === 'needs_you')) {
    const head = journal.bounds().head
    const latest = journal.latest(refs)
    const now: JournalEvent[] = []
    for (const ref of refs) {
      const event = latest.get(refKey(ref.kind, ref.id)) ?? currentJobState(ctx, ref)
      if (!event) continue
      if (mode === 'settled' ? isSettledLike(event) : event.attention !== null) now.push(event)
    }
    if (now.length) {
      const { items } = collapse(now.map((event) => ({ ...event, prevStatus: null })), slugs, t, WAKE_ITEMS_BUDGET)
      return reply(items.map(({ from: _from, ...item }) => item), head, { timedOut: false })
    }
  }

  // 2. Block on the journal.
  const afterSeq = since ?? journal.bounds().head
  const progress = (ctx.v2 as { progress?: (elapsedMs: number, totalMs: number) => void }).progress
  const outcome = await journal.waitFor({
    afterSeq, filter, limit, timeoutMs,
    signal: ctx.signal,
    ...(progress ? { onProgress: (elapsed: number) => progress(elapsed, timeoutMs) } : {}),
    ...(ctx.onMissionInput ? { interrupt: (wake: () => void) => ctx.onMissionInput!(wake) } : {}),
  })
  const { items, lastSeq, cut } = collapse(outcome.events, slugs, t, WAKE_ITEMS_BUDGET)
  const cursorSeq = cut && lastSeq !== null ? lastSeq : outcome.cursorSeq
  return reply(items, cursorSeq, { timedOut: outcome.reason === 'timeout' && !items.length, more: cut || outcome.more, reason: outcome.reason, waitedMs: outcome.waitedMs })
}

function eventsHandler(ctx: V2CallContext, args: Record<string, unknown>) {
  const t = ctx.v2.t
  const journal = journalOf(ctx)
  const refs = resolveRefs(ctx, args.refs)
  const mode: WaitFor = (WAIT_FORS as readonly string[]).includes(String(args.for)) ? args.for as WaitFor : 'changed'
  const project = typeof args.project === 'string' && args.project.trim() ? ctx.v2.project(args) : null
  const limit = Math.min(100, typeof args.limit === 'number' && args.limit > 0 ? args.limit : EVENTS_DEFAULT)
  const warnings: string[] = []
  const filter = filterFor(mode, refs, project?.id)
  const slugs = slugMap(ctx)
  const since = sinceSeq(journal, args.since, t, warnings)

  let events: JournalEvent[]
  let cursorSeq: number
  let more: boolean
  if (since === null) {
    // No cursor: the latest rows, and a cursor at the head to follow from now on.
    events = journal.tail(filter, limit)
    cursorSeq = journal.bounds().head
    more = false
  } else {
    const page = journal.read(since, filter, limit)
    events = page.events
    cursorSeq = page.cursorSeq
    more = page.more
  }
  // One row per item here (history, not a collapsed wake-up), cut to the summary budget.
  const items: FiredItem[] = []
  for (const event of events) {
    const item = itemOf(event, event.prevStatus, slugs, t)
    delete item.next
    if (items.length && approxTokens(JSON.stringify([...items, item])) > EVENTS_ITEMS_BUDGET) { more = true; cursorSeq = items[items.length - 1].seq; break }
    items.push(item)
  }
  const summary = items.length ? t('wait.summary.events', { count: items.length }) : t('wait.summary.no_events')
  return result({ items, cursor: cursorFor(journal, cursorSeq), ...(more ? { more: true } : {}) }, {
    summary, warnings, untrusted: UNTRUSTED('/data/items'),
    page: { cursor: more ? cursorFor(journal, cursorSeq) : null, truncated: more },
  })
}

/** Blocking wait on the event journal; replaces every polling loop. */
export const waitTool = defineTool({
  name: 'specrails_wait',
  title: 'Wait',
  description: 'Block until refs change (no polling). until returns fired changes and a cursor; re-call with it. events pages the journal.',
  owner: 'WP1',
  readOnly: true,
  alwaysLoad: true,
  fields: {
    refs: F.refs.describe('Omit: anything that needs the person'),
    for: z.enum(WAIT_FORS),
    since: z.string().describe('Cursor from the last wait'),
    timeoutMs: z.number().int().min(1000).max(45000).describe('Default 25000'),
    project: F.project,
    limit: F.limit,
    lang: F.lang,
  },
  actions: {
    until: {
      tier: 'read',
      maxTokens: RESPONSE_BUDGET.waitWake,
      doc: 'Blocks ≤ timeoutMs (default 25 s, max 45 s). for: settled (default with refs: finished or needs you), needs_you (default without refs: app-wide), changed (any transition of refs), any (changes of refs plus anything that needs you). Already-settled refs return at once. Re-call with since:<cursor>; timedOut:true is not a failure.',
      handler: untilHandler,
    },
    events: {
      tier: 'read',
      doc: 'Journal page after since (oldest first); without since, the latest rows and a cursor at the head. Same filters as until.',
      handler: eventsHandler,
    },
  },
})

// ── MCP-native notifications (optional; clients that never listen lose nothing) ──

/**
 * Sends `notifications/message` (level `notice`) for every journal row that
 * needs the person, so clients that show server logs surface it without a
 * call. Must be registered before `connect`. Returns the disposer (session
 * close). Not wired by WP0 yet (see the WP1 report).
 */
export function registerWaitNotifications(server: McpServer, ctx: McpToolContext, options: { translate?: Translate } = {}): () => void {
  server.server.registerCapabilities({ logging: {} })
  const journal = journalOf(ctx)
  const t: Translate = options.translate ?? translator('en')
  return journal.onAppend((events) => {
    const needing = events.filter((event) => event.attention !== null)
    if (!needing.length) return
    let slugs: Map<string, string>
    try { slugs = new Map((ctx.registry.listProjects?.() ?? []).map((row) => [row.id, row.slug])) } catch { slugs = new Map() }
    for (const event of needing.slice(0, 5)) {
      const ref = refOf(event, slugs)
      server.server.sendLoggingMessage({
        level: 'notice', logger: 'specrails',
        data: { ref, needs: event.attention, status: canonicalOf(event), next: nextOf(event, ref), hint: t('wait.notice', { ref }) },
      }).catch(() => { /* the session may have closed */ })
    }
  })
}
