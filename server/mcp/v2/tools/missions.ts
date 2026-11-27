import fs from 'fs'
import { asRecord, clip } from '../core/text'
import { launchForecast, scaledCost, turnCostFromLedger } from '../core/forecast'
import path from 'path'
import { randomUUID } from 'crypto'
import { z } from 'zod'
import { defineTool, type PreviewInput, type V2ActionDef, type V2CallContext } from '../core/registry'
import { F, WRITE_FIELDS, optionsOf, resolveFields } from '../core/views'
import { V2ToolError, isV2Result, oneLine, result } from '../core/envelope'
import { decodeCursor, encodeCursor, pageOf } from '../core/cursor'
import { formatRef, parseRef, type Ref } from '../core/refs'
import { neutralize, untrusted } from '../core/untrusted'
import { shortHash } from '../core/canonical'
import { approxTokens } from '../core/size-guard'
import { choicesFromState, type ChoicePoint } from '../core/choices'
import type { DecisionState } from '../core/decision-state'
import { apiCall } from '../../tools/types'
import { railsSnapshot } from './runs'
import { loadOrGenerateToken } from '../../../auth'
import { FLOW_SPEC_LOOP_ID, type IntentSession } from '../../../modules/intent'
import type { ProjectRow } from '../../../desktop-db'
import type { WsMessage } from '../../../types'
import {
  coerceFlowOffer, coerceRailLaunch, intentDraftOf, openLimit, parseCardId, projectCards, projectIntentState, projectMissionState, replyFor,
  type MessageLike, type MissionCard,
} from '../projectors/mission-state'

/**
 * WP7. `specrails_missions`: missions (the app's agent conversations), their
 * cards, queue, attachments and sub-agents, Intent sessions, and the legacy
 * per-project Explore chats. Thin over the routes the app itself uses:
 * `/api/agent/*` (agent-chat-router.ts), `/api/projects/:id/flow/*` (Intent
 * HTTP adapter, all 14 routes), `/api/projects/:id/chat/*`, the mission
 * resources and background-process routes, and the rails/CI routes a card's
 * own button calls. The server keeps every rule (archive-before-delete, live
 * missions, queue dispatch, Intent transitions).
 *
 * Refs: `mission:<conversationId>`, `intent:<project>/<flowId>` (a mission ref
 * also addresses its open Intent), `chat:<conversationId>` with `project`.
 * Mission text (messages, replies, titles, card prose, sub-agent output) is
 * model or person text: every such field is listed in `untrusted`.
 */

type Row = Record<string, unknown>
const record = asRecord
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const excerpt = (value: unknown, max = 200) => neutralize(oneLine(typeof value === 'string' ? value : '', max))
const minute = (iso: unknown) => typeof iso === 'string' ? iso.replace(/:\d\d(\.\d+)?Z$/, 'Z') : iso
const enc = encodeURIComponent

const MISSION_SECTIONS = ['messages', 'queue', 'cards', 'subagents', 'attachments', 'intent', 'links', 'resources', 'processes'] as const
const MESSAGE_CHARS = 2_000
/** `message` reads one message whole, up to this. */
const FULL_MESSAGE_CHARS = 40_000
/** The mission's reply is the conversation itself: it arrives whole, not as an excerpt. */
const REPLY_CHARS = 16_000
/** Room for a whole reply in the conversational actions (send, create with a goal, Intent's opening, a card reply). */
const CONVERSE_TOKENS = 6_000
const DEFAULT_MESSAGES = 10
const MESSAGES_BUDGET_SUMMARY = 800
const MESSAGES_BUDGET_DETAIL = 5_000
// A turn often takes 20–45 s: waiting the full window settles most of them in one call.
const WAIT_DEFAULT_MS = 45_000
const WAIT_MAX_MS = 45_000
const ATTACH_PATH_MAX = 25 * 1024 * 1024
const ATTACH_INLINE_MAX = 5 * 1024 * 1024
const SELECTION_CHARS = 8_000
const LIVE_CHARS = 600
const SETTLE_POLLS = 60
const SETTLE_POLL_MS = 125
const AGENT = '/agent/conversations'

// ── Targets ─────────────────────────────────────────────────────────────────

function missionId(ctx: V2CallContext, args: Row): { id: string; ref: Ref } {
  const target = ctx.v2.target(args, 'mission')
  return { id: target.id, ref: target.ref }
}

const missionRef = (id: string) => formatRef('mission', id)

/** A mission an external MCP client creates is marked as such (Desktop shows where it came from). */
function mcpOrigin(ctx: V2CallContext): Row {
  const session = ctx.sessionState
  if (ctx.firstPartyAgent || session.external !== true) return {}
  let client: string | null = null
  try { client = session.clientName?.() ?? null } catch { /* unknown client */ }
  return { origin: 'mcp', ...(client ? { originClient: client } : {}) }
}

/** A mission must not message, stop or question itself (it would loop on its own turn). */
function refuseSelf(ctx: V2CallContext, id: string): void {
  if (ctx.firstPartyAgent && ctx.originConversationId === id) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.self'))
}

function projectOfPin(ctx: V2CallContext, pin: unknown): ProjectRow | null {
  if (typeof pin !== 'string') return null
  return ctx.v2.projects().find((row) => row.id === pin) ?? null
}

interface MissionRead { conversation: Row; messages: MessageLike[]; pending: Row[]; live: Row; session: Row | null; limitContinueAt: string | null }

async function readMission(ctx: V2CallContext, id: string): Promise<MissionRead> {
  const body = record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}`))
  return {
    conversation: record(body.conversation),
    messages: rows(body.messages).map((message) => ({
      id: String(message.id), role: String(message.role), content: typeof message.content === 'string' ? message.content : '',
      intents: Array.isArray(message.intents) ? message.intents as MessageLike['intents'] : [], created_at: String(message.created_at ?? ''),
      ...(Array.isArray(message.attachment_ids) && message.attachment_ids.length ? { attachments: message.attachment_ids.length } : {}),
    })) as MessageLike[],
    pending: rows(body.pendingMessages),
    live: record(body.live),
    session: body.session ? record(body.session) : null,
    limitContinueAt: str(body.limitContinueAt),
  }
}

function missionState(ctx: V2CallContext, id: string, read: MissionRead, cards: MissionCard[], flow?: { ref: Ref; state: string; session?: IntentSession } | null): DecisionState {
  const row = projectOfPin(ctx, read.conversation.pinned_project_id)
  return ctx.v2.state(projectMissionState({
    ref: missionRef(id), conversationId: id, updatedAt: String(read.conversation.updated_at ?? ''), archived: Boolean(read.conversation.archivedAt),
    busy: read.live.isStreaming === true, queued: read.pending.length, cards, limitContinueAt: read.limitContinueAt,
    limit: openLimit(read.messages), projectSlug: row?.slug ?? null, flow: flow ?? null,
  }))
}

/** The lean row every mission listing returns. */
function missionItem(ctx: V2CallContext, conversation: Row, live: { running: Set<string>; background: Set<string> }): Row {
  const id = String(conversation.id)
  const row = projectOfPin(ctx, conversation.pinned_project_id)
  const usage = record(conversation.contextUsage)
  return {
    ref: missionRef(id),
    title: str(conversation.title) ?? null,
    ...(row ? { project: row.slug } : {}),
    provider: conversation.provider ?? null,
    ...(conversation.model ? { model: conversation.model } : {}),
    ...(conversation.reasoning_effort ? { effort: conversation.reasoning_effort } : {}),
    status: live.running.has(id) ? 'running' : live.background.has(id) ? 'background' : 'idle',
    ...(conversation.archivedAt ? { archived: true } : {}),
    ...(typeof usage.percent === 'number' ? { contextPct: usage.percent } : {}),
    updated: minute(conversation.updated_at),
  }
}

async function liveSets(ctx: V2CallContext): Promise<{ running: Set<string>; background: Set<string> }> {
  const turns = record(await apiCall(ctx, 'GET', '/agent/active-turns'))
  return {
    running: new Set(rows(turns.turns).map((turn) => String(turn.conversationId))),
    background: new Set(rows(turns.sessions).filter((session) => session.residentPhase !== 'idle' || Number(session.liveSubagents) > 0).map((session) => String(session.conversationId))),
  }
}

const brief = (card: MissionCard): Row => ({ id: card.id, kind: card.kind, ...(card.decisions ? { decisions: card.decisions } : {}), ...(card.decided ? { decided: card.decided } : {}) })

function messageView(message: MessageLike & { attachments?: number }): Row {
  if (message.role === 'system') {
    let kind = 'system'
    try { kind = String(record(JSON.parse(message.content)).kind ?? 'system') } catch { /* plain system row */ }
    return { id: message.id, role: 'system', card: kind, at: minute(message.created_at) }
  }
  // A long message is cut here; `message` (options.message=<id>) reads it whole.
  const truncated = message.content.length > MESSAGE_CHARS
  return { id: message.id, role: message.role, at: minute(message.created_at), text: neutralize(clip(message.content, MESSAGE_CHARS)), ...(truncated ? { truncated: true, chars: message.content.length } : {}), ...(message.attachments ? { attachments: message.attachments } : {}) }
}

/** Runs, specs and deliveries the mission's cards name. */
function linksOf(cards: readonly MissionCard[], slug: string | null, flowTicket?: number | null): Row {
  if (!slug) return {}
  const runs = new Set<string>(); const specs = new Set<number>(); const deliveries = new Set<string>()
  for (const card of cards) {
    for (const id of Array.isArray(card.data.runIds) ? card.data.runIds : []) if (typeof id === 'string') runs.add(id)
    if (typeof card.data.runId === 'string') runs.add(card.data.runId)
    for (const id of Array.isArray(card.data.ticketIds) ? card.data.ticketIds : []) if (typeof id === 'number') specs.add(id)
    if (typeof card.data.ticketId === 'number') specs.add(card.data.ticketId)
    for (const key of ['prDeliveryId', 'deliveryId']) if (typeof card.data[key] === 'string') deliveries.add(card.data[key] as string)
  }
  if (typeof flowTicket === 'number') specs.add(flowTicket)
  return {
    ...(runs.size ? { runs: [...runs].slice(-20).map((id) => formatRef('run', id, slug)) } : {}),
    ...(specs.size ? { specs: [...specs].slice(-20).map((id) => formatRef('spec', id, slug)) } : {}),
    ...(deliveries.size ? { deliveries: [...deliveries].slice(-20).map((id) => formatRef('delivery', id, slug)) } : {}),
  }
}

// ── Messages paging ─────────────────────────────────────────────────────────

/**
 * Newest messages first page (default 10), older on the cursor; or, with
 * `options.after`, every message after that one (oldest first) — the
 * continuation of a `send` that returned before the reply.
 */
function pageMessages(args: Row, id: string, messages: readonly MessageLike[], budgetTokens?: number): { items: Row[]; page: { cursor: string | null; total: number; truncated: boolean } } {
  const key = `m:${id}`
  const limit = typeof args.limit === 'number' ? Math.min(Math.max(1, args.limit), 100) : DEFAULT_MESSAGES
  const after = str(optionsOf(args).after)
  if (after) {
    const index = messages.findIndex((message) => message.id === after)
    if (index < 0) throw new V2ToolError('not_found', `No message ${after} in this mission.`)
    const tail = messages.slice(index + 1)
    const { items, page } = pageOf(tail, { cursor: args.cursor, limit, key: `${key}:a:${after}`, defaultLimit: DEFAULT_MESSAGES })
    return { items: items.map(messageView), page }
  }
  const state = decodeCursor(args.cursor, key)
  const fromEnd = state?.offset ?? 0
  const end = Math.max(0, messages.length - fromEnd)
  // Newest first, within the view's token budget (so the size guard never cuts the newest messages).
  const budget = budgetTokens ?? MESSAGES_BUDGET_SUMMARY
  const views: Row[] = []
  let used = 0
  for (let i = end - 1; i >= Math.max(0, end - limit); i--) {
    const view = messageView(messages[i])
    used += approxTokens(JSON.stringify(view)) + 1
    if (used > budget && views.length) break
    views.unshift(view)
  }
  const start = end - views.length
  const slice = views
  return {
    items: slice,
    page: { cursor: start > 0 ? encodeCursor({ offset: fromEnd + slice.length, path: '/messages', key }) : null, total: messages.length, truncated: start > 0 },
  }
}

// ── Waiting for a reply ─────────────────────────────────────────────────────

interface Settled { status: 'replied' | 'failed' | 'pending'; messageId?: string; text?: string; error?: string }

function waitMsOf(args: Row): number {
  const raw = optionsOf(args).waitMs
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return WAIT_DEFAULT_MS
  return Math.min(Math.max(0, Math.floor(raw)), WAIT_MAX_MS)
}

/**
 * Starts a turn and waits (bounded) for its settling event. The listener is
 * attached before the request so a fast reply is never missed. A queued input
 * settles on the first reply after it starts (`agent_input_started` with its
 * queueId); the current turn's reply does not count.
 */
async function sendAndWait(ctx: V2CallContext, conversationId: string, start: () => Promise<Row>, options: { waitMs: number; queueId: string | null; done: string[]; failed: string[]; started?: string[]; waitsFor?: () => boolean }): Promise<{ response: Row; settled: Settled }> {
  let response: Row | null = null
  let started = false
  let resolve: ((settled: Settled) => void) | null = null
  const settledPromise = new Promise<Settled>((done) => { resolve = done })
  const early: WsMessage[] = []
  const handle = (msg: WsMessage) => {
    const m = msg as unknown as Row
    if (m.conversationId !== conversationId) return
    if (response === null) { early.push(msg); return }
    if (!started && (options.started ?? []).includes(String(m.type)) && m.queueId === options.queueId) { started = true; return }
    if (!started) return
    if (options.done.includes(String(m.type)) && typeof m.fullText === 'string') resolve?.({ status: 'replied', ...(typeof m.messageId === 'string' ? { messageId: m.messageId } : {}), text: m.fullText })
    else if (options.failed.includes(String(m.type))) resolve?.({ status: 'failed', error: String(m.error ?? 'failed') })
  }
  const unsubscribe = options.waitMs > 0 && ctx.eventBus?.onMessage ? ctx.eventBus.onMessage(handle) : null
  try {
    response = await start()
    started = response.queued !== true
    for (const msg of early.splice(0)) handle(msg)
    if (!unsubscribe || options.waitsFor?.() === false) return { response, settled: { status: 'pending' } }
    let timer: NodeJS.Timeout | undefined
    const settled = await Promise.race([settledPromise, new Promise<Settled>((done) => { timer = setTimeout(() => done({ status: 'pending' }), options.waitMs) })])
    clearTimeout(timer)
    return { response, settled }
  } finally {
    unsubscribe?.()
  }
}

// ── Cost forecast ───────────────────────────────────────────────────────────

/**
 * The band of this mission's own provider-reported turn costs (last 10, at
 * least 3 billed turns in agent_invocations, estimates left out): median to max. Null = unknown,
 * which the confirmation protocol treats as above the threshold.
 */
export function missionForecast(ctx: V2CallContext, conversationId: string): [number, number] | null {
  // agent_invocations (desktop DB): the mission's provider-billed turns, newest first.
  return turnCostFromLedger(ctx.desktopDb,
    "SELECT total_cost_usd AS cost FROM agent_invocations WHERE conversation_id = ? AND surface = 'agent-chat' AND status = 'success' AND total_cost_usd_estimated = 0 AND total_cost_usd > 0 ORDER BY started_at DESC LIMIT 10",
    [conversationId], { minSamples: 3, low: 'median' })
}

/** A new mission's first turn: the machine's recent mission turns (no history of its own yet). */
export function newMissionForecast(ctx: V2CallContext): [number, number] | null {
  return turnCostFromLedger(ctx.desktopDb,
    "SELECT total_cost_usd AS cost FROM agent_invocations WHERE surface = 'agent-chat' AND status = 'success' AND total_cost_usd_estimated = 0 AND total_cost_usd > 0 ORDER BY started_at DESC LIMIT 10",
    [], { minSamples: 3, low: 'median' })
}

async function spendPreview(ctx: V2CallContext, args: Row, effectKey: string): Promise<PreviewInput> {
  const { id, ref } = missionId(ctx, args)
  const conversation = record(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}`)).conversation)
  return {
    effect: ctx.v2.t(effectKey, { title: str(conversation.title) ?? ref }),
    refs: [ref],
    version: `m${shortHash({ p: conversation.provider, m: conversation.model, e: conversation.reasoning_effort, a: conversation.archivedAt ?? null })}`,
    cost: { forecastUsd: missionForecast(ctx, id), runs: 1 },
  }
}

// ── Attachments ─────────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.md': 'text/markdown', '.txt': 'text/plain', '.json': 'application/json', '.csv': 'text/csv', '.html': 'text/html', '.log': 'text/plain',
}

async function readUpload(ctx: V2CallContext, args: Row): Promise<{ buffer: Buffer; name: string; type: string }> {
  const options = optionsOf(args)
  const file = String(options.file)
  let buffer: Buffer
  let name: string
  if (typeof options.base64 === 'string') {
    buffer = Buffer.from(options.base64, 'base64')
    name = path.basename(file)
    if (buffer.length > ATTACH_INLINE_MAX) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.file_too_large', { max: 5 }))
  } else {
    const resolved = path.resolve(file.replace(/^~(?=$|\/)/, process.env.HOME ?? '~'))
    const stat = await fs.promises.stat(resolved).catch(() => null)
    if (!stat?.isFile()) throw new V2ToolError('not_found', ctx.v2.t('missions.error.file_missing', { file }))
    if (stat.size > ATTACH_PATH_MAX) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.file_too_large', { max: 25 }))
    buffer = await fs.promises.readFile(resolved)
    name = path.basename(resolved)
  }
  const type = typeof options.mimeType === 'string' ? options.mimeType : MIME[path.extname(name).toLowerCase()] ?? 'application/octet-stream'
  return { buffer, name, type }
}

async function upload(ctx: V2CallContext, id: string, file: { buffer: Buffer; name: string; type: string }): Promise<Row> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(file.buffer)], { type: file.type }), file.name)
  const timeout = AbortSignal.timeout(60_000)
  const res = await fetch(`http://127.0.0.1:${ctx.desktopPort}/api${AGENT}/${enc(id)}/attachments`, {
    method: 'POST', headers: { Authorization: `Bearer ${loadOrGenerateToken()}` }, body: form, signal: ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
  })
  const body = record(await res.json().catch(() => ({})))
  if (!res.ok) throw new V2ToolError(res.status === 404 ? 'not_found' : 'invalid_input', `Upload refused (${res.status}): ${str(body.error) ?? 'unknown error'}`)
  return record(body.attachment)
}

const attachmentView = (a: Row): Row => ({ attachmentId: a.id, name: a.filename ?? a.name, type: a.mimeType ?? a.mimetype, size: a.size })

// ── Intent ──────────────────────────────────────────────────────────────────

interface IntentTarget { row: ProjectRow; flowId: string; ref: Ref; flow: IntentSession }

const flowBase = (row: ProjectRow) => `/projects/${enc(row.id)}/flow`
const intentRef = (row: ProjectRow, flowId: string) => formatRef('intent', flowId, row.slug)

/** An `intent:` ref, or a mission ref (its open or latest Intent, project from the pin or `project`). */
async function intentTarget(ctx: V2CallContext, args: Row): Promise<IntentTarget> {
  const parsed = parseRef(args.ref)
  if (parsed?.kind === 'intent') {
    const target = ctx.v2.target(args, 'intent')
    const flow = record(record(await apiCall(ctx, 'GET', `${flowBase(target.project!)}/${enc(target.id)}`)).flow) as unknown as IntentSession
    return { row: target.project!, flowId: target.id, ref: target.ref, flow }
  }
  const { id } = ctx.v2.target(args, 'mission', ['mission', 'intent'])
  const conversation = record(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}`)).conversation)
  const row = projectOfPin(ctx, conversation.pinned_project_id) ?? ctx.v2.project(args)
  const flow = record(await apiCall(ctx, 'GET', `${flowBase(row)}/by-conversation/${enc(id)}`)).flow
  if (!flow) throw new V2ToolError('not_found', ctx.v2.t('missions.error.no_intent', { mission: missionRef(id) }), { next: [{ tool: 'specrails_missions', args: { action: 'intent_start', ref: missionRef(id) }, why: 'Start an Intent session in this mission.' }] })
  const session = record(flow) as unknown as IntentSession
  return { row, flowId: session.id, ref: intentRef(row, session.id), flow: session }
}

function intentView(target: IntentTarget): Row {
  const flow = target.flow
  return {
    ref: target.ref, mission: missionRef(flow.conversationId), state: flow.state,
    ...(flow.step ? { step: flow.step } : {}),
    ...(flow.branch ? { branch: flow.branch } : {}),
    ...(flow.ticketId ? { spec: formatRef('spec', flow.ticketId, target.row.slug) } : {}),
    ...(flow.deliveryId ? { delivery: formatRef('delivery', flow.deliveryId, target.row.slug) } : {}),
    ...(typeof flow.railIndex === 'number' ? { rail: formatRef('rail', flow.railIndex, target.row.slug) } : {}),
    ...(flow.specOrigin ? { specOrigin: flow.specOrigin } : {}),
    ...(flow.returnBriefing ? { returnBriefing: neutralize(clip(flow.returnBriefing, 1_200)) } : {}),
    updated: minute(flow.updatedAt),
  }
}

function intentState(ctx: V2CallContext, target: IntentTarget, busy?: boolean): DecisionState {
  return ctx.v2.state(projectIntentState(target.flow, { intent: target.ref, mission: missionRef(target.flow.conversationId) }, { now: new Date().toISOString(), ...(busy !== undefined ? { busy } : {}) }))
}

/** The tail of the running turn's streamed text (what the app shows live), or null. */
function liveTail(live: Row): string | null {
  const text = typeof live.streamingText === 'string' ? live.streamingText.trim() : ''
  return text ? neutralize(text.length > LIVE_CHARS ? `…${text.slice(-LIVE_CHARS)}` : text) : null
}

/**
 * What the Intent is doing now, read in one call: the running turn (and its
 * streamed tail), the agent's last reply with its pending choice, and the
 * preview apps it started (their URLs open in any browser).
 */
async function intentProgress(ctx: V2CallContext, target: IntentTarget): Promise<{ data: Row; busy: boolean; marks: string[] }> {
  if (!target.flow.conversationId) return { data: {}, busy: false, marks: [] }
  const read = await readMission(ctx, target.flow.conversationId).catch(() => null)
  const data: Row = {}
  const marks: string[] = []
  const busy = read?.live.isStreaming === true
  if (read) {
    const tail = busy ? liveTail(read.live) : null
    data.turn = { running: busy, ...(busy && read.live.startedAt ? { started: minute(read.live.startedAt) } : {}), ...(read.pending.length ? { queued: read.pending.length } : {}), ...(tail ? { live: tail } : {}) }
    if (tail) marks.push('/data/turn/live')
    const last = [...read.messages].reverse().find((message) => message.role === 'assistant')
    if (last) { data.lastReply = { id: last.id, at: minute(last.created_at), text: neutralize(clip(last.content, 800)) }; marks.push('/data/lastReply/text') }
    const pending = projectCards(read.messages, { busy }).filter((card) => card.pending)
    if (pending.length) data.pendingCards = pending.map(brief)
  }
  try {
    const processes = rows(record(await apiCall(ctx, 'GET', `/projects/${enc(target.row.id)}/background-processes?chatId=${enc(target.flow.conversationId)}`)).processes)
    const apps = processes.filter((p) => String(p.flowId ?? '') === target.flowId && p.status === 'running')
      .map((p) => ({ pid: p.pid, command: neutralize(clip(String(p.command ?? ''), 200)), ...(Array.isArray(p.appUrls) && p.appUrls.length ? { appUrls: p.appUrls } : p.appUrl ? { appUrls: [p.appUrl] } : {}) }))
    if (apps.length) { data.apps = apps; marks.push('/data/apps/*/command') }
  } catch { /* processes are best effort */ }
  return { data, busy, marks }
}

async function intentResult(ctx: V2CallContext, target: IntentTarget, flowValue: unknown, summaryKey: string, extra: Row = {}, progress?: { busy: boolean; marks: string[] }): Promise<unknown> {
  const flow = record(flowValue)
  const session = (flow.id ? flow : target.flow) as unknown as IntentSession
  const next: IntentTarget = session.id && session.id !== target.flowId
    ? { row: target.row, flowId: session.id, ref: intentRef(target.row, session.id), flow: session }
    : { ...target, flow: session }
  const state = intentState(ctx, next, progress?.busy)
  return result({ ...intentView(next), ...extra }, {
    summary: ctx.v2.t(summaryKey, { ref: next.ref, state: state.label }),
    refs: { intent: next.ref, mission: missionRef(next.flow.conversationId) },
    state,
    untrusted: untrusted('/data/returnBriefing', ...(progress?.marks ?? [])),
  })
}

/**
 * Cost of an Intent step (core forecast helpers): `turn` reopens the mission's
 * agent session (its own billed turns), `launch` starts a rail run (the
 * project's launch forecast for the loop, implement by default).
 */
async function intentPreview(ctx: V2CallContext, args: Row, effectKey: string, spend: 'turn' | 'launch' | null): Promise<PreviewInput> {
  const target = await intentTarget(ctx, args)
  const options = optionsOf(args)
  const forecastUsd = spend === 'turn' ? missionForecast(ctx, target.flow.conversationId)
    : spend === 'launch' ? scaledCost(await launchForecast(ctx, target.row, { loopId: str(options.loopId) ?? FLOW_SPEC_LOOP_ID, provider: str(args.provider) ?? str(options.provider) }), 1)
      : null
  return {
    effect: ctx.v2.t(effectKey, { ref: target.ref, branch: target.flow.branch ?? '—' }),
    refs: [target.ref],
    version: intentState(ctx, target).version,
    ...(spend ? { cost: { forecastUsd, runs: 1 } } : {}),
  }
}

function railIndexOf(ctx: V2CallContext, value: unknown): number {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  const parsed = parseRef(value)
  if (parsed?.kind === 'rail' && /^\d+$/.test(parsed.id)) return Number(parsed.id)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.rail_required'), { next: [{ tool: 'specrails_rails', args: { action: 'list' }, why: 'Pick a free rail.' }] })
}

/**
 * The rail an Intent hands off to: the one asked for, else the app's own pick
 * (the first free rail that carries no other spec), else a new rail (created
 * only by the handler; the preview says "a new rail").
 */
async function handOffRail(ctx: V2CallContext, target: IntentTarget, asked: unknown, opts: { create: boolean }): Promise<{ index: number | null }> {
  if (asked !== undefined && asked !== null && asked !== '') return { index: railIndexOf(ctx, asked) }
  const snapshot = record(await railsSnapshot(ctx, target.row))
  const free = rows(snapshot.rails).find((rail) => rail.availability === 'free'
    && (!Array.isArray(rail.ticketIds) || rail.ticketIds.length === 0 || (rail.ticketIds.length === 1 && Number(rail.ticketIds[0]) === target.flow.ticketId)))
  if (free && Number.isSafeInteger(Number(free.railIndex))) return { index: Number(free.railIndex) }
  if (!opts.create) return { index: null }
  const created = record(record(await apiCall(ctx, 'POST', `/projects/${enc(target.row.id)}/rails`, {})).rail)
  const index = Number(created.railIndex)
  if (!Number.isSafeInteger(index) || index < 0) throw new V2ToolError('conflict', ctx.v2.t('missions.error.rail_required'), { next: [{ tool: 'specrails_rails', args: { action: 'list' }, why: 'Pick a free rail.' }] })
  return { index }
}

// ── Cards ───────────────────────────────────────────────────────────────────

async function cardOf(ctx: V2CallContext, args: Row): Promise<{ id: string; ref: Ref; read: MissionRead; cards: MissionCard[]; card: MissionCard; row: ProjectRow | null }> {
  const { id, ref } = missionId(ctx, args)
  const read = await readMission(ctx, id)
  const cards = projectCards(read.messages, { busy: read.live.isStreaming === true })
  const wanted = parseCardId(args.cardId)
  const card = wanted ? cards.find((item) => item.id === args.cardId) : undefined
  if (!card) throw new V2ToolError('not_found', ctx.v2.t('missions.error.card_unknown', { card: String(args.cardId) }), { next: [{ tool: 'specrails_missions', args: { action: 'get', ref, fields: ['cards'] }, why: 'The mission cards and their ids.' }] })
  if (!card.pending || !(card.decisions ?? []).includes(String(args.decision))) {
    if (card.kind === 'pr_decision') {
      const row = projectOfPin(ctx, read.conversation.pinned_project_id)
      throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.card_delivery'), row && typeof card.data.prDeliveryId === 'string' ? { next: [{ tool: 'specrails_deliveries', args: { action: 'get', ref: formatRef('delivery', card.data.prDeliveryId, row.slug) }, why: 'Decide the delivery.' }] } : {})
    }
    throw new V2ToolError('conflict', ctx.v2.t('missions.error.card_decided', { card: card.id, decisions: (card.decisions ?? []).join(', ') || '—' }))
  }
  return { id, ref, read, cards, card, row: projectOfPin(ctx, read.conversation.pinned_project_id) }
}

/** Every decision but dismiss starts AI work (a reply turn, a launch, an Intent, a CI run). */
const isSpendDecision = (args: Row) => String(args.decision) !== 'dismiss'

function proposalOf(read: MissionRead, card: MissionCard): unknown {
  const message = read.messages.find((item) => item.id === card.messageId)
  const re = new RegExp('```' + card.kind + '[^\\S\\n]*\\n([\\s\\S]*?)\\n[^\\S\\n]*```', 'g')
  const blocks = [...(message?.content ?? '').matchAll(re)].map((match) => { try { return JSON.parse(match[1]) } catch { return null } })
  return blocks.filter((block) => block !== null)[Number(card.id.split(':').pop())]
}

async function recordDecision(ctx: V2CallContext, id: string, card: MissionCard, body: Row): Promise<void> {
  await apiCall(ctx, 'PATCH', `${AGENT}/${enc(id)}/messages/${enc(card.messageId)}/intent`, { kind: card.kind, proposalIndex: Number(card.id.split(':').pop()), ...body })
}

async function decideCard(ctx: V2CallContext, args: Row): Promise<unknown> {
  const { id, ref, read, card, row } = await cardOf(ctx, args)
  refuseSelf(ctx, id)
  const decision = String(args.decision)
  const done = (key: string, data: Row, refs: Record<string, Ref> = {}) => result({ mission: ref, card: card.id, decision, ...data }, { summary: ctx.v2.t(key, { card: card.id, mission: ref }), refs: { mission: ref, ...refs } })
  const needRow = () => { if (!row) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.no_pin', { mission: ref })); return row }

  if (card.kind === 'intent-draft' && decision === 'explore') {
    // The card's Explore: an Intent session from this intent (its placeholder spec carries it), as the app starts it.
    const project = needRow()
    const message = read.messages.find((item) => item.id === card.messageId)
    const draft = message ? intentDraftOf(message.content) : null
    if (!draft?.ready) throw new V2ToolError('conflict', ctx.v2.t('missions.error.card_unreadable', { card: card.id }))
    const flow = record(record(await apiCall(ctx, 'POST', flowBase(project), { conversationId: id, idea: draft.intent.problem, intent: draft.intent, ...(draft.title ? { title: draft.title } : {}) })).flow) as unknown as IntentSession
    return intentResult(ctx, { row: project, flowId: flow.id, ref: intentRef(project, flow.id), flow }, flow, 'missions.summary.intent_started')
  }
  if (card.kind === 'options' || card.kind === 'intent-draft') {
    const reply = replyFor(card, decision)
    if (!reply) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.card_decided', { card: card.id, decisions: (card.decisions ?? []).join(', ') }))
    return sendMessage(ctx, { ...args, ref, message: reply })
  }
  if (card.kind === 'rail-launch') {
    if (decision === 'dismiss') { await recordDecision(ctx, id, card, { status: 'dismissed' }); return done('missions.summary.card_dismissed', {}) }
    const project = needRow()
    const proposal = coerceRailLaunch(proposalOf(read, card))
    if (!proposal) throw new V2ToolError('conflict', ctx.v2.t('missions.error.card_unreadable', { card: card.id }))
    const name = proposal.newRail?.name ?? proposal.railName
    const engine = proposal.aiEngine ? { aiEngine: proposal.aiEngine } : {}
    const launchBody: Row = {
      mode: proposal.mode, originConversationId: id, originSurface: 'agent-chat', ...engine,
      ...(proposal.loopId ? { loopId: proposal.loopId } : {}),
      ...(proposal.model ? { model: proposal.model } : {}),
      ...(proposal.reasoningEffort ? { reasoning_effort: proposal.reasoningEffort } : {}),
      ...(proposal.profileName ? { profileName: proposal.profileName } : {}),
      ...(proposal.repositoryIds ? { repositoryIds: proposal.repositoryIds } : {}),
      ...(proposal.targetPrNumber ? { targetPrNumber: proposal.targetPrNumber } : {}),
      ...(proposal.baseBranch ? { baseBranch: proposal.baseBranch } : {}),
    }
    // One door with runs(launch): assign + launch atomically (a refused launch restores the rails it touched).
    const launched = record(await apiCall(ctx, 'POST', `/projects/${enc(project.id)}/rails/launch-specs`, {
      specIds: proposal.ticketIds, ...(proposal.railIndex !== null ? { railIndex: proposal.railIndex } : {}), ...(name ? { railName: name } : {}), ...launchBody,
    }))
    if (typeof launched.railIndex !== 'number') throw new V2ToolError('internal', 'The rail launch answered without a rail.')
    const railIndex = launched.railIndex
    const runIds = (Array.isArray(launched.loopRunIds) && launched.loopRunIds.length ? launched.loopRunIds : Array.isArray(launched.jobIds) && launched.jobIds.length ? launched.jobIds : launched.jobId ? [launched.jobId] : []).filter((x): x is string => typeof x === 'string')
    const prDeliveryId = typeof launched.prDeliveryId === 'string' ? launched.prDeliveryId : null
    await recordDecision(ctx, id, card, { status: 'launched', railIndex, runIds, prDeliveryId, config: { ...launchBody, ticketIds: proposal.ticketIds, railName: name ?? null } })
    const runRefs = runIds.map((runId) => formatRef('run', runId, project.slug))
    return result({ mission: ref, card: card.id, decision, rail: formatRef('rail', railIndex, project.slug), runs: runRefs, ...(prDeliveryId ? { delivery: formatRef('delivery', prDeliveryId, project.slug) } : {}) }, {
      summary: ctx.v2.t('missions.summary.card_launched', { count: runRefs.length, specs: proposal.ticketIds.map((t) => `#${t}`).join(', ') }),
      refs: { mission: ref, rail: formatRef('rail', railIndex, project.slug), ...(runRefs[0] ? { run: runRefs[0] } : {}) },
    })
  }
  if (card.kind === 'flow-offer') {
    const offer = coerceFlowOffer(proposalOf(read, card))
    if (!offer) throw new V2ToolError('conflict', ctx.v2.t('missions.error.card_unreadable', { card: card.id }))
    if (decision === 'dismiss') { await recordDecision(ctx, id, card, { status: 'dismissed', chosenMode: null }); return done('missions.summary.card_dismissed', {}) }
    if (decision === 'implement') {
      await recordDecision(ctx, id, card, { status: 'accepted', chosenMode: 'implement', ...(offer.ticketId ? { config: { ticketId: offer.ticketId } } : {}) })
      const reply = offer.ticketId ? ctx.v2.t('missions.reply.implement_existing', { id: offer.ticketId }) : ctx.v2.t('missions.reply.implement')
      // The reply is the person's answer to the offer (a new turn): it rides the normal send.
      return sendMessage(ctx, { ref, message: reply, options: optionsOf(args) }, { skipSelf: true })
    }
    const project = needRow()
    const flow = record(record(await apiCall(ctx, 'POST', flowBase(project), { conversationId: id, idea: offer.idea, ...(offer.ticketId ? { ticketId: offer.ticketId } : {}), ...(offer.title ? { title: offer.title } : {}), ...(offer.repositoryId ? { repositoryId: offer.repositoryId } : {}) })).flow) as unknown as IntentSession
    await recordDecision(ctx, id, card, { status: 'accepted', chosenMode: 'flow', config: { flowId: flow.id, ...(offer.ticketId ? { ticketId: offer.ticketId } : {}) } })
    return intentResult(ctx, { row: project, flowId: flow.id, ref: intentRef(project, flow.id), flow }, flow, 'missions.summary.intent_started')
  }
  if (card.kind === 'pr-ci-offer') {
    const project = needRow()
    const rails = `/projects/${enc(project.id)}/rails`
    const admission = str(card.data.admissionId)
    const delivery = str(card.data.prDeliveryId)
    if (decision === 'dismiss') {
      if (admission) await apiCall(ctx, 'POST', `${rails}/pr-ci/admissions/${enc(admission)}/dismiss`)
      else await apiCall(ctx, 'POST', `${rails}/pr-ci-offer/dismiss`, { prDeliveryId: delivery })
      return done('missions.summary.card_dismissed', {})
    }
    const started = record(admission
      ? await apiCall(ctx, 'POST', `${rails}/pr-ci/admissions/${enc(admission)}/start`)
      : await apiCall(ctx, 'POST', `${rails}/${Number(card.data.railIndex)}/pr-ci`, { prDeliveryId: delivery, originConversationId: id }))
    const runId = str(started.runId) ?? str(Array.isArray(started.loopRunIds) ? started.loopRunIds[0] : null)
    const run = runId ? formatRef('run', runId, project.slug) : null
    return result({ mission: ref, card: card.id, decision, ...(run ? { run } : {}) }, { summary: ctx.v2.t('missions.summary.ci_started', { mission: ref }), refs: { mission: ref, ...(run ? { run } : {}) } })
  }
  throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.card_decided', { card: card.id, decisions: '—' }))
}

/** A pending card as a menu (its decisions, recommended first); the person's own words go to the agent as a message. */
async function cardPoint(ctx: V2CallContext, args: Row): Promise<ChoicePoint | null> {
  const { id, ref } = missionId(ctx, args)
  const read = await readMission(ctx, id)
  const cards = projectCards(read.messages, { busy: read.live.isStreaming === true })
  const card = cards.find((item) => item.id === args.cardId && item.pending)
  if (!card || card.kind === 'pr_decision') return null
  const state = missionState(ctx, id, read, cards)
  const choices = choicesFromState(state, (offer) => offer.call.args.action === 'card_decide' && offer.call.args.cardId === card.id)
  const title = neutralize(String(read.conversation.title ?? ''))
  return {
    question: oneLine(title ? `${title} — ${state.hold?.reason ?? state.label}` : state.hold?.reason ?? state.label, 300), choices,
    other: { call: { tool: 'specrails_missions', args: { action: 'send', ref } }, field: 'message', title: ctx.v2.t('core.choose.other_message') },
  }
}

async function cardPreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const { id, ref, read, cards, card } = await cardOf(ctx, args)
  const state = missionState(ctx, id, read, cards)
  const explore = card.kind === 'intent-draft' && String(args.decision) === 'explore'
  const kind = explore ? 'flow-offer' : card.kind === 'options' || card.kind === 'intent-draft' ? 'reply' : card.kind
  return {
    effect: ctx.v2.t(`missions.preview.card_${kind.replace(/-/g, '_')}`, { mission: ref, decision: String(args.decision), specs: Array.isArray(card.data.ticketIds) ? (card.data.ticketIds as number[]).map((t) => `#${t}`).join(', ') : '' }),
    refs: [ref],
    version: state.version,
    cost: { forecastUsd: !explore && (card.kind === 'options' || card.kind === 'intent-draft') ? missionForecast(ctx, id) : null, runs: 1 },
  }
}

// ── Actions ─────────────────────────────────────────────────────────────────

async function sendMessage(ctx: V2CallContext, rawArgs: Row, flags: { skipSelf?: boolean } = {}): Promise<unknown> {
  const args = rawArgs
  const { id, ref } = missionId(ctx, args)
  if (!flags.skipSelf) refuseSelf(ctx, id)
  const options = optionsOf(args)
  const text = str(args.message)
  if (!text) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.message_required'))
  const deliveryMode = options.deliveryMode ?? args.deliveryMode
  if (deliveryMode !== undefined && !['queue', 'steer', 'interrupt'].includes(String(deliveryMode))) throw new V2ToolError('invalid_input', 'options.deliveryMode must be queue, steer or interrupt.')
  const queueId = str(options.queueId) ?? `mcp-${randomUUID()}`
  const attachmentIds = Array.isArray(options.attachmentIds) ? options.attachmentIds.filter((x): x is string => typeof x === 'string') : []
  const { response, settled } = await sendAndWait(ctx, id, async () => record(await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/send`, {
    text, queueId, ...(deliveryMode ? { deliveryMode } : {}), ...(attachmentIds.length ? { attachments: { ids: attachmentIds } } : {}),
    // The person writes from their own client: the turn tells the agent, so it names MCP actions, never app buttons.
    ...(ctx.firstPartyAgent ? {} : { surface: 'mcp' }),
  })), { waitMs: waitMsOf(args), queueId, done: ['agent_done', 'agent_turn_done'], failed: ['agent_error'], started: ['agent_input_started', 'agent_dequeued'] })
  return turnResult(ctx, id, ref, response, settled, { queueId })
}

/**
 * What a mission turn the caller started came to (send, a created mission's first turn, Intent's
 * opening turn): the reply as untrusted text, and the mission's own pending choices (its option
 * chips and cards) as the state's offers, so the person picks from what the mission proposed.
 */
async function turnResult(ctx: V2CallContext, id: string, ref: Ref, response: Row, settled: Settled, extra: { queueId?: string; keys?: { replied?: string; working?: string }; vars?: Row } = {}): Promise<unknown> {
  const queueId = extra.queueId
  const sent = record(response.message)
  const after = str(sent.id)
  const data: Row = {
    ref, ...(queueId ? { queueId } : {}), accepted: response.accepted === true, queued: response.queued === true,
    ...(response.duplicate ? { duplicate: true } : {}),
    status: settled.status === 'replied' ? 'replied' : settled.status === 'failed' ? 'failed' : response.queued ? 'queued' : 'running',
    ...(settled.text !== undefined ? { reply: { ...(settled.messageId ? { messageId: settled.messageId } : {}), text: neutralize(clip(settled.text, REPLY_CHARS)) } } : {}),
    ...(settled.error ? { error: excerpt(settled.error, 400) } : {}),
    ...(after ? { after } : {}),
  }
  // The reply arrives a moment before the turn settles: wait for that (bounded), so the fresh
  // state carries the reply's chips as decidable cards (an Intent's options, a launch card…).
  let state: DecisionState | undefined
  if (settled.status === 'replied') {
    let read = await readMission(ctx, id).catch(() => null)
    for (let i = 0; read && read.live.isStreaming === true && i < SETTLE_POLLS; i++) {
      await new Promise((done) => setTimeout(done, SETTLE_POLL_MS))
      read = await readMission(ctx, id).catch(() => null)
    }
    if (read) {
      const cards = projectCards(read.messages, { busy: read.live.isStreaming === true })
      const pending = cards.filter((card) => card.pending)
      if (pending.length) data.pendingCards = pending.map(brief)
      const row = projectOfPin(ctx, read.conversation.pinned_project_id)
      const flow = row ? await missionFlow(ctx, row, id) : null
      state = missionState(ctx, id, read, cards, flow && row ? { ref: intentRef(row, flow.id), state: flow.state, session: flow } : null)
    }
  }
  const summary = settled.status === 'replied'
    ? ctx.v2.t(extra.keys?.replied ?? 'missions.summary.replied', { mission: ref, reply: excerpt(settled.text, 200), ...extra.vars })
    : settled.status === 'failed' ? ctx.v2.t('missions.summary.turn_failed', { mission: ref, error: excerpt(settled.error, 160) })
      : ctx.v2.t(response.queued ? 'missions.summary.queued' : extra.keys?.working ?? 'missions.summary.working', { mission: ref, ...extra.vars })
  return result(data, { summary, refs: { mission: ref }, ...(state ? { state } : {}), untrusted: untrusted('/data/reply/text', '/data/error') })
}

/**
 * What a mission's settled turn said, for a wake-up that should not need a `get`: its last reply
 * (whole, untrusted) and the choices still open on it. Null when there is no reply to show.
 */
export async function missionTurnDigest(ctx: V2CallContext, conversationId: string): Promise<Row | null> {
  const read = await readMission(ctx, conversationId).catch(() => null)
  if (!read || read.live.isStreaming === true) return null
  const last = [...read.messages].reverse().find((message) => message.role === 'assistant')
  if (!last) return null
  const pending = projectCards(read.messages, { busy: false }).filter((card) => card.pending)
  return { reply: { messageId: last.id, at: minute(last.created_at), text: neutralize(clip(last.content, REPLY_CHARS)) }, ...(pending.length ? { pendingCards: pending.map(brief) } : {}) }
}

/** The mission's open (or latest) Intent, or null (never throws: Intent may be unavailable here). */
async function missionFlow(ctx: V2CallContext, row: ProjectRow, id: string): Promise<IntentSession | null> {
  try { return (record(await apiCall(ctx, 'GET', `${flowBase(row)}/by-conversation/${enc(id)}`)).flow ?? null) as IntentSession | null } catch { return null }
}

async function getMission(ctx: V2CallContext, args: Row): Promise<unknown> {
  const { id, ref } = missionId(ctx, args)
  const read = await readMission(ctx, id)
  const conversation = read.conversation
  const row = projectOfPin(ctx, conversation.pinned_project_id)
  const busy = read.live.isStreaming === true
  const cards = projectCards(read.messages, { busy })
  const sections = resolveFields(args, MISSION_SECTIONS)
  // Intent mark: the mission's open Intent (project-scoped; only for a pinned mission).
  const flow = row && (sections.includes('intent') || sections.length === 0) ? await missionFlow(ctx, row, id) : null
  const flowRef = flow && row ? intentRef(row, flow.id) : null
  const state = missionState(ctx, id, read, cards, flow && flowRef ? { ref: flowRef, state: flow.state, session: flow } : null)
  const live = new Set(busy ? [id] : [])
  const pendingCards = cards.filter((card) => card.pending)
  const lastReply = [...read.messages].reverse().find((message) => message.role === 'assistant')
  const data: Row = {
    ...missionItem(ctx, conversation, { running: live, background: new Set() }),
    ...(busy && read.live.startedAt ? { turnStarted: read.live.startedAt } : {}),
    ...(busy && liveTail(read.live) ? { live: liveTail(read.live) } : {}),
    ...(read.pending.length ? { queued: read.pending.length } : {}),
    messages: read.messages.length,
    ...(lastReply ? { lastReply: { id: lastReply.id, at: minute(lastReply.created_at), text: neutralize(clip(lastReply.content, sections.includes('messages') ? 600 : 800)) } } : {}),
    ...(pendingCards.length ? { pendingCards: pendingCards.map(brief) } : {}),
    ...(flow && flowRef ? { intent: { ref: flowRef, state: flow.state } } : {}),
    ...(read.limitContinueAt ? { limitContinueAt: read.limitContinueAt } : {}),
    ...(conversation.forkSource ? { forkedFrom: missionRef(String(record(conversation.forkSource).conversationId)) } : {}),
  }
  const marks = ['/data/title', '/data/lastReply/text', '/data/live']
  let page
  if (sections.includes('messages') || str(optionsOf(args).after)) {
    const paged = pageMessages(args, id, read.messages, ctx.v2.view === 'detail' ? MESSAGES_BUDGET_DETAIL : MESSAGES_BUDGET_SUMMARY)
    data.messageList = paged.items
    page = paged.page
    marks.push('/data/messageList/*/text')
  }
  if (sections.includes('queue')) { data.queue = read.pending.map((item) => ({ queueId: item.queueId, text: neutralize(clip(String(item.text ?? ''), 600)), mode: item.deliveryMode, at: minute(item.timestamp) })); marks.push('/data/queue/*/text') }
  if (sections.includes('cards')) { data.cards = cards.slice(-20).map((card) => ({ ...brief(card), at: minute(card.at), data: card.data })); marks.push('/data/cards/*/data') }
  if (sections.includes('links')) data.links = linksOf(cards, row?.slug ?? null, flow?.ticketId)
  if (sections.includes('intent') && flow && row && flowRef) data.intent = intentView({ row, flowId: flow.id, ref: flowRef, flow })
  if (sections.includes('subagents')) {
    const subs = rows(record(read.session).subagents)
    data.subagents = subs.slice(-25).map(subagentView)
    marks.push('/data/subagents/*/description', '/data/subagents/*/result')
  }
  if (sections.includes('attachments')) {
    data.attachments = rows(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}/attachments`)).attachments).map(attachmentView)
    marks.push('/data/attachments/*/name')
  }
  if (row && sections.includes('resources')) {
    try {
      const res = record(await apiCall(ctx, 'GET', `/projects/${enc(row.id)}/missions/${enc(id)}/resources`))
      data.resources = { supported: res.supported, totals: res.totals, processes: rows(res.entries).length, ...(res.worktree ? { worktree: record(res.worktree).path } : {}) }
    } catch { data.resources = null }
  }
  if (row && sections.includes('processes')) {
    const processes = rows(record(await apiCall(ctx, 'GET', `/projects/${enc(row.id)}/background-processes?chatId=${enc(id)}`)).processes)
    data.processes = processes.slice(0, 20).map((p) => ({ pid: p.pid, command: neutralize(clip(String(p.command ?? ''), 200)), status: p.status, ...(p.flowId ? { intent: intentRef(row, String(p.flowId)) } : {}), ...(Array.isArray(p.appUrls) && p.appUrls.length ? { appUrls: p.appUrls } : p.appUrl ? { appUrls: [p.appUrl] } : {}), ...(p.startedAt ? { started: minute(p.startedAt) } : {}) }))
    marks.push('/data/processes/*/command')
  }
  const summary = ctx.v2.t(busy ? 'missions.summary.get_running' : 'missions.summary.get', {
    title: excerpt(conversation.title, 80) || ref, status: state.label, count: read.messages.length, cards: pendingCards.length,
  })
  return result(data, { summary, refs: { mission: ref, ...(row ? { project: formatRef('project', row.slug) } : {}), ...(flowRef ? { intent: flowRef } : {}) }, state, ...(page ? { page } : {}), untrusted: untrusted(...marks) })
}

function subagentView(node: Row): Row {
  return {
    subagentId: node.subagentId, description: excerpt(node.description, 200), phase: node.phase,
    ...(node.agentType ? { type: node.agentType } : {}),
    ...(node.resultSummary ? { result: neutralize(clip(String(node.resultSummary), 800)) } : {}),
    ...(record(node.delegated).driver ? { provider: record(node.delegated).driver, model: record(node.delegated).model } : {}),
    ...(node.startedAt ? { started: minute(node.startedAt) } : {}),
  }
}

async function listMissions(ctx: V2CallContext, args: Row): Promise<unknown> {
  const filter = record(args.filter)
  // v1: projectId / includeArchived.
  const projectSel = filter.project ?? args.projectId ?? args.project
  const archived = filter.archived ?? (args.includeArchived === true ? 'all' : undefined)
  const scope = archived === true ? 'archived' : archived === 'all' ? 'all' : 'active'
  const [listed, live] = await Promise.all([apiCall(ctx, 'GET', `${AGENT}?archiveScope=${scope}`), liveSets(ctx)])
  let conversations = rows(record(listed).conversations)
  if (projectSel !== undefined && projectSel !== null) {
    if (projectSel === 'home' || projectSel === false) conversations = conversations.filter((c) => !c.pinned_project_id)
    else { const pin = ctx.v2.project({ project: projectSel }); conversations = conversations.filter((c) => c.pinned_project_id === pin.id) }
  }
  if (filter.pinned === true) conversations = conversations.filter((c) => !!c.pinned_project_id)
  let items = conversations.map((c) => missionItem(ctx, c, live))
  if (filter.active === true || args.action === 'active') items = items.filter((item) => item.status !== 'idle')
  items.sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || String(b.updated ?? '').localeCompare(String(a.updated ?? '')))
  const running = items.filter((item) => item.status === 'running').length
  const { items: shown, page } = pageOf(items, { cursor: args.cursor, limit: args.limit, key: shortHash({ scope, projectSel: projectSel ?? null, f: filter }) })
  return result({ items: shown }, {
    summary: items.length ? ctx.v2.t('missions.summary.list', { count: items.length, running }) : ctx.v2.t('missions.summary.list_empty'),
    page, untrusted: untrusted('/data/items/*/title'),
  })
}

async function lifecycle(ctx: V2CallContext, args: Row, method: 'POST' | 'DELETE', suffix: string, key: string, body?: unknown): Promise<unknown> {
  const { id, ref } = missionId(ctx, args)
  const res = record(await apiCall(ctx, method, `${AGENT}/${enc(id)}${suffix}`, body))
  const conversation = record(res.conversation)
  return result({ ref, ...(conversation.id ? { archived: Boolean(conversation.archivedAt) } : {}), ...(res.restorable ? { restorable: true } : {}) }, { summary: ctx.v2.t(key, { mission: ref }), refs: { mission: ref } })
}

async function purgePreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const { id, ref } = missionId(ctx, args)
  const trash = rows(record(await apiCall(ctx, 'GET', `${AGENT}/trash`)).items).map((item) => record(item.conversation)).find((c) => c.id === id)
  const conversation = trash ?? record(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}`).catch(() => ({}))).conversation)
  if (!conversation.id) throw new V2ToolError('not_found', `${ref} does not exist.`)
  return { effect: ctx.v2.t('missions.preview.purge', { title: excerpt(conversation.title, 80) || ref }), refs: [ref], version: `p${shortHash({ u: conversation.updated_at, d: conversation.deleted_at ?? null, a: conversation.archivedAt ?? null })}` }
}

async function attachmentPreview(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const { id, ref } = missionId(ctx, args)
  const attachmentId = String(optionsOf(args).attachmentId)
  const hit = rows(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}/attachments`)).attachments).find((a) => a.id === attachmentId)
  if (!hit) throw new V2ToolError('not_found', ctx.v2.t('missions.error.attachment_unknown', { id: attachmentId }))
  return { effect: ctx.v2.t('missions.preview.detach', { name: excerpt(hit.filename ?? hit.name, 120), mission: ref }), refs: [ref], version: `a${shortHash({ id: attachmentId, size: hit.size })}` }
}

// ── Legacy Explore chats (per project) ──────────────────────────────────────

function chatTarget(ctx: V2CallContext, args: Row): { row: ProjectRow; id: string; ref: Ref } {
  const target = ctx.v2.target(args, 'chat')
  const row = ctx.v2.project(args)
  return { row, id: target.id, ref: target.ref }
}
const chatBase = (row: ProjectRow) => `/projects/${enc(row.id)}/chat/conversations`

async function chatGet(ctx: V2CallContext, args: Row): Promise<unknown> {
  const { row, id, ref } = chatTarget(ctx, args)
  const body = record(await apiCall(ctx, 'GET', `${chatBase(row)}/${enc(id)}`))
  const conversation = record(body.conversation)
  const messages = rows(body.messages).map((m) => ({ id: String(m.id ?? ''), role: String(m.role ?? ''), content: String(m.content ?? ''), created_at: String(m.created_at ?? '') })) as MessageLike[]
  const paged = pageMessages(args, `chat:${id}`, messages)
  const draft = conversation.kind === 'explore' ? record(await apiCall(ctx, 'GET', `${chatBase(row)}/${enc(id)}/spec-draft`).catch(() => ({}))) : {}
  return result({
    ref, project: row.slug, title: conversation.title ?? null, kind: conversation.kind ?? null, model: conversation.model ?? null, messageList: paged.items,
    ...(draft.draft ? { specDraft: { ready: draft.ready === true, title: record(draft.draft).title ?? null } } : {}),
  }, {
    summary: ctx.v2.t('missions.summary.chat_get', { title: excerpt(conversation.title, 80) || ref, count: messages.length }),
    refs: { chat: ref, project: formatRef('project', row.slug) }, page: paged.page,
    untrusted: untrusted('/data/title', '/data/messageList/*/text', '/data/specDraft'),
  })
}

async function chatSend(ctx: V2CallContext, args: Row): Promise<unknown> {
  const { row, id, ref } = chatTarget(ctx, args)
  const options = optionsOf(args)
  const text = str(args.message)
  if (!text) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.message_required'))
  const { settled } = await sendAndWait(ctx, id, async () => {
    await apiCall(ctx, 'POST', `${chatBase(row)}/${enc(id)}/messages`, { text, ...(options.lightweight !== undefined ? { lightweight: options.lightweight === true } : {}), ...(typeof options.maxTurns === 'number' ? { maxTurns: options.maxTurns } : {}), ...(options.attachments ? { attachments: options.attachments } : {}) })
    return { accepted: true }
  }, { waitMs: waitMsOf(args), queueId: null, done: ['chat_done'], failed: ['chat_error'] })
  return result({ ref, status: settled.status === 'replied' ? 'replied' : settled.status === 'failed' ? 'failed' : 'running', ...(settled.text !== undefined ? { reply: { text: neutralize(clip(settled.text, REPLY_CHARS)) } } : {}), ...(settled.error ? { error: excerpt(settled.error, 400) } : {}) }, {
    summary: settled.status === 'replied' ? ctx.v2.t('missions.summary.replied', { mission: ref, reply: excerpt(settled.text, 200) }) : settled.status === 'failed' ? ctx.v2.t('missions.summary.turn_failed', { mission: ref, error: excerpt(settled.error, 160) }) : ctx.v2.t('missions.summary.working', { mission: ref }),
    refs: { chat: ref }, untrusted: untrusted('/data/reply/text', '/data/error'),
  })
}

// ── The tool ────────────────────────────────────────────────────────────────

const read: V2ActionDef = { tier: 'read', required: ['ref'] }
const write: V2ActionDef = { tier: 'write', required: ['ref'] }
const spend: V2ActionDef = { tier: 'ai-spawn', confirm: 'costly', required: ['ref'] }
/**
 * Talking to a mission (a message, a side question, answering its option): a turn, like typing in the
 * app, which never asks. Costly work of its own (launches, Intent, hand-off, renew) keeps `spend`.
 */
const converse: V2ActionDef = { tier: 'ai-spawn', confirm: null, required: ['ref'], maxTokens: CONVERSE_TOKENS }
/** Card decisions that start work of their own (a rail, Intent, CI repair): confirmed like a launch. */
const LAUNCH_DECISIONS = new Set(['launch', 'implement', 'intent', 'start', 'explore', 'delegate'])

const simpleIntent = (path: string, key: string): V2ActionDef['handler'] => async (ctx, args) => {
  const target = await intentTarget(ctx, args)
  const flow = record(await apiCall(ctx, 'POST', `${flowBase(target.row)}/${enc(target.flowId)}/${path}`)).flow
  return intentResult(ctx, target, flow, key)
}

/** WP7. Missions (agent conversations), Intent sessions and legacy Explore chats. */
export const missionsTool = defineTool({
  name: 'specrails_missions',
  title: 'Missions',
  description: 'Missions (agent conversations): create, send, ask, queue, attachments, subagents, cards; intent_* sessions; chat_* legacy Explore chats.',
  owner: 'WP7',
  v1Aliases: [['text', 'message'], ['question', 'message']],
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(MISSION_SECTIONS),
    message: z.string(),
    query: z.string(),
    title: z.string(),
    provider: z.string(),
    model: z.string(),
    effort: z.string(),
    cardId: z.string().describe('card_decide'),
    decision: z.string().describe('card_decide: the card option'),
    filter: F.filter.describe('list: project, archived, pinned'),
  },
  actions: {
    list: { tier: 'read', doc: 'Missions, running first. filter.project (or "home"), filter.archived (true | "all"), filter.active, filter.pinned.', handler: listMissions },
    search: {
      tier: 'read', required: ['query'], doc: 'Full-text search over titles and messages.',
      handler: async (ctx, args) => {
        const limit = typeof args.limit === 'number' ? Math.min(args.limit, 50) : 20
        const hits = rows(record(await apiCall(ctx, 'GET', `/agent/search?q=${enc(String(args.query))}&limit=${limit}`)).results)
        const items = hits.map((hit) => {
          const conversation = record(hit.conversation)
          const snippet = record(hit.snippet)
          return { ref: missionRef(String(conversation.id)), title: conversation.title ?? null, match: hit.match, ...(hit.messageId ? { messageId: hit.messageId } : {}), ...(snippet.text ? { snippet: excerpt(snippet.text, 240) } : {}) }
        })
        return result({ items }, { summary: ctx.v2.t('missions.summary.search', { count: items.length, query: excerpt(args.query, 60) }), untrusted: untrusted('/data/items/*/title', '/data/items/*/snippet') })
      },
    },
    message: {
      ...read, maxTokens: 12_000,
      doc: 'One message of the mission whole (options.message=<id> from get messages, where long ones are truncated; default the last reply), up to 40 000 characters.',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const read = await readMission(ctx, id)
        const wanted = str(optionsOf(args).message)
        const message = wanted ? read.messages.find((item) => item.id === wanted) : [...read.messages].reverse().find((item) => item.role === 'assistant')
        if (!message) throw new V2ToolError('not_found', ctx.v2.t('missions.error.no_messages', { mission: ref }))
        const text = clip(message.content, FULL_MESSAGE_CHARS)
        return result({ mission: ref, id: message.id, role: message.role, at: minute(message.created_at), text: neutralize(text), chars: message.content.length, ...(message.content.length > FULL_MESSAGE_CHARS ? { truncated: true } : {}) }, {
          summary: ctx.v2.t('missions.summary.message', { mission: ref, chars: message.content.length }), refs: { mission: ref }, untrusted: untrusted('/data/text'),
        })
      },
    },
    get: { ...read, doc: 'One mission: state, last reply, pending cards. fields: messages (newest first; cursor pages older; options.after=<messageId> reads what followed), queue, cards, subagents, attachments, intent, links (runs/specs/deliveries), resources, processes (dev servers and preview app URLs).', handler: getMission },
    create: {
      // With the person's message it starts working in the same call (a turn: the send's tier and confirmation).
      tier: (args) => str(args.message) ? 'ai-spawn' : 'write',
      // Like typing the goal in the app: no confirmation, the reply arrives whole.
      confirm: null,
      maxTokens: CONVERSE_TOKENS,
      doc: 'New mission. message = what the person wants: it starts working on it now (the mission names itself; title optional). Without message, ask the person its goal in one open question, then send. project pins it (omit for Home); provider, model, effort.',
      preview: (ctx, args) => {
        const pin = args.project !== undefined && args.project !== null && args.project !== 'home' ? ctx.v2.project(args) : null
        return { effect: ctx.v2.t('missions.preview.create_send', { project: pin?.slug ?? 'Home' }), refs: [], version: `c${shortHash({ p: pin?.id ?? null, m: str(args.message) ?? '' })}`, cost: { forecastUsd: newMissionForecast(ctx), runs: 1 } }
      },
      handler: async (ctx, args) => {
        const pin = args.project !== undefined && args.project !== null && args.project !== 'home' ? ctx.v2.project(args) : null
        const created = record(record(await apiCall(ctx, 'POST', AGENT, {
          pinnedProjectId: pin?.id ?? null, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}), ...(args.effort ? { reasoningEffort: args.effort } : {}),
          ...(str(args.title) ? { title: str(args.title) } : {}), ...mcpOrigin(ctx),
        })).conversation)
        const id = String(created.id)
        const ref = missionRef(id)
        const engine = { ...(pin ? { project: pin.slug } : {}), provider: created.provider, model: created.model ?? null, effort: created.reasoning_effort ?? null }
        if (str(args.message)) {
          // Created and started at once, like typing the goal in the app: the reply comes back here.
          const sent = await sendMessage(ctx, { ...args, ref }, { skipSelf: true })
          if (isV2Result(sent)) {
            return result({ ...engine, ...(sent.data as Row) }, {
              ...sent, summary: `${ctx.v2.t('missions.summary.created_started', { mission: ref })} ${sent.summary ?? ''}`.trim(), refs: { mission: ref },
            })
          }
          return sent
        }
        return result({ ref, ...engine, ask: ctx.v2.t('missions.ask.goal') }, {
          summary: ctx.v2.t('missions.summary.created', { mission: ref }), refs: { mission: ref },
        })
      },
    },
    send: {
      ...converse, required: ['ref', 'message'],
      doc: 'Sends the person\'s message and waits up to options.waitMs (default and max 45000) for the reply. Busy mission: queued (options.deliveryMode queue|steer|interrupt). options.attachmentIds, options.queueId (idempotent retry). Not replied yet: specrails_wait(until, refs:[ref]) wakes with the reply.',
      preview: (ctx, args) => spendPreview(ctx, args, 'missions.preview.send'),
      handler: (ctx, args) => sendMessage(ctx, args),
    },
    ask: {
      ...converse, required: ['ref', 'message'],
      doc: 'Side question about the mission (nothing is written to it). options.selection (default: the last reply), options.throughMessageId.',
      preview: (ctx, args) => spendPreview(ctx, args, 'missions.preview.ask'),
      handler: async (ctx, rawArgs) => {
        const args = rawArgs
        const { id, ref } = missionId(ctx, args)
        refuseSelf(ctx, id)
        const options = optionsOf(args)
        let selection = str(options.selection) ?? str(args.selection)
        let through = str(options.throughMessageId) ?? str(args.throughMessageId)
        if (!selection || !through) {
          const { messages } = await readMission(ctx, id)
          if (!messages.length) throw new V2ToolError('conflict', ctx.v2.t('missions.error.no_messages'))
          const last = [...messages].reverse().find((message) => message.role === 'assistant' && message.content.trim())
          through ??= messages[messages.length - 1].id
          selection ??= clip((last?.content ?? messages[messages.length - 1].content).trim() || String(args.message), SELECTION_CHARS - 20)
        }
        const body = record(await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/side-questions`, { selection, throughMessageId: through, question: String(args.message) }))
        const answer = str(body.answer) ?? str(body.text) ?? ''
        return result({ ref, answer: neutralize(clip(answer, REPLY_CHARS)) }, { summary: ctx.v2.t('missions.summary.answered', { answer: excerpt(answer, 240) }), refs: { mission: ref }, untrusted: untrusted('/data/answer') })
      },
    },
    abort: {
      ...write, doc: 'Stops the running turn (queued messages stay).',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        refuseSelf(ctx, id)
        const res = record(await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/abort`))
        return result({ ref, aborted: res.aborted === true }, { summary: ctx.v2.t(res.aborted ? 'missions.summary.aborted' : 'missions.summary.idle', { mission: ref }), refs: { mission: ref } })
      },
    },
    update: {
      ...write, doc: 'Rename (title), provider, model, effort, options.pin (project, or null for Home). The permission level stays the person\'s.',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const options = optionsOf(args)
        const body: Row = {}
        if (args.title !== undefined) body.title = args.title
        if (args.provider !== undefined) body.provider = args.provider
        if (args.model !== undefined) body.model = args.model
        if (args.effort !== undefined) body.reasoningEffort = args.effort
        if ('pin' in options) body.pinnedProjectId = options.pin === null || options.pin === 'home' ? null : ctx.v2.project({ project: options.pin }).id
        if (!Object.keys(body).length) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.nothing_to_update'))
        const conversation = record(record(await apiCall(ctx, 'PATCH', `${AGENT}/${enc(id)}`, body)).conversation)
        const live = await liveSets(ctx)
        return result(missionItem(ctx, conversation, live), { summary: ctx.v2.t('missions.summary.updated', { mission: ref }), refs: { mission: ref }, untrusted: untrusted('/data/title') })
      },
    },
    archive: { ...write, doc: 'Archives (refused while the mission is live).', handler: (ctx, args) => lifecycle(ctx, args, 'POST', '/archive', 'missions.summary.archived') },
    unarchive: { ...write, handler: (ctx, args) => lifecycle(ctx, args, 'POST', '/unarchive', 'missions.summary.unarchived') },
    delete: {
      tier: 'write', required: ['ref'], doc: 'Moves to trash (restore undoes it). Archives first; stops live work. Permanent: purge.',
      handler: async (ctx, args) => {
        const { id } = missionId(ctx, args)
        const conversation = record(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}`)).conversation)
        if (!conversation.archivedAt) await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/archive`)
        return lifecycle(ctx, args, 'DELETE', '', 'missions.summary.deleted')
      },
    },
    restore: { ...write, doc: 'Restores a trashed mission.', handler: (ctx, args) => lifecycle(ctx, args, 'POST', '/restore', 'missions.summary.restored') },
    trash: {
      tier: 'read', doc: 'Recently deleted missions (purged after the retention). filter.project.',
      handler: async (ctx, args) => {
        const filter = record(args.filter)
        const pin = filter.project !== undefined ? ctx.v2.project({ project: filter.project }) : null
        const body = record(await apiCall(ctx, 'GET', `${AGENT}/trash${pin ? `?projectId=${enc(pin.id)}` : ''}`))
        const all = rows(body.items).map((item) => ({ ref: missionRef(String(record(item.conversation).id)), title: record(item.conversation).title ?? null, deleted: minute(item.deletedAt), purgeAt: minute(item.purgeAt) }))
        const { items, page } = pageOf(all, { cursor: args.cursor, limit: args.limit, key: `t:${pin?.id ?? ''}` })
        return result({ items, retentionDays: body.retentionDays }, { summary: ctx.v2.t('missions.summary.trash', { count: all.length, days: Number(body.retentionDays ?? 30) }), page, untrusted: untrusted('/data/items/*/title') })
      },
    },
    purge: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'], doc: 'Deletes a mission permanently (history, attachments, process history). Always confirmed.',
      preview: purgePreview,
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const conversation = record(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}`).catch(() => ({}))).conversation)
        if (conversation.id && !conversation.archivedAt) await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/archive`)
        await apiCall(ctx, 'DELETE', `${AGENT}/${enc(id)}?permanent=1`)
        return result({ ref, purged: true }, { summary: ctx.v2.t('missions.summary.purged', { mission: ref }) })
      },
    },
    branch: {
      tier: 'write', required: ['ref'], doc: 'New mission from this one: options.mode fork (history up to options.throughMessageId, default the last message) or empty.',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const options = optionsOf(args)
        const mode = options.mode === 'empty' ? 'empty' : 'fork'
        let through = str(options.throughMessageId)
        if (!through) {
          const { messages } = await readMission(ctx, id)
          through = messages.length ? messages[messages.length - 1].id : null
          if (!through) throw new V2ToolError('conflict', ctx.v2.t('missions.error.no_messages'))
        }
        const created = record(record(await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/branch`, { mode, throughMessageId: through })).conversation)
        const fork = missionRef(String(created.id))
        return result({ ref: fork, from: ref, mode }, { summary: ctx.v2.t('missions.summary.branched', { mission: fork, from: ref }), refs: { mission: fork, from: ref } })
      },
    },
    renew: {
      ...spend, doc: 'Starts fresh with a summary: writes a summary of the mission (AI) and the next turn opens a new provider session from it. Refused while busy or in Intent.',
      preview: (ctx, args) => spendPreview(ctx, args, 'missions.preview.renew'),
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const body = record(await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/session/renew`, { language: ctx.v2.lang }))
        const summary = record(body.summary)
        return result({ ref, messageId: body.messageId, summary: neutralize(clip(String(summary.summary ?? summary.content ?? ''), 1_500)) }, { summary: ctx.v2.t('missions.summary.renewed', { mission: ref }), refs: { mission: ref }, untrusted: untrusted('/data/summary') })
      },
    },
    queue_edit: {
      tier: 'write', required: ['ref', 'options.queueId', 'message'], doc: 'Edits a queued message (refused once dispatched).',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        await apiCall(ctx, 'PATCH', `${AGENT}/${enc(id)}/queue/${enc(String(optionsOf(args).queueId))}`, { text: String(args.message) })
        return result({ ref, queueId: optionsOf(args).queueId, edited: true }, { summary: ctx.v2.t('missions.summary.queue_edited', { mission: ref }), refs: { mission: ref } })
      },
    },
    queue_steer: {
      tier: 'write', required: ['ref', 'options.queueId'], doc: 'Injects a queued message into the running turn now.',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/queue/${enc(String(optionsOf(args).queueId))}/steer`)
        return result({ ref, queueId: optionsOf(args).queueId, steered: true }, { summary: ctx.v2.t('missions.summary.queue_steered', { mission: ref }), refs: { mission: ref } })
      },
    },
    queue_remove: {
      tier: 'write', required: ['ref', 'options.queueId'], doc: 'Drops a queued message.',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        await apiCall(ctx, 'DELETE', `${AGENT}/${enc(id)}/queue/${enc(String(optionsOf(args).queueId))}`)
        return result({ ref, queueId: optionsOf(args).queueId, removed: true }, { summary: ctx.v2.t('missions.summary.queue_removed', { mission: ref }), refs: { mission: ref } })
      },
    },
    attach: {
      tier: 'write', required: ['ref', 'options.file'], doc: 'Uploads a local file (options.file path, ≤ 25 MB) or inline options.base64 (≤ 5 MB, options.file names it). Send it with send(options.attachmentIds).',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const file = await readUpload(ctx, args)
        const attachment = await upload(ctx, id, file)
        return result({ ref, ...attachmentView(attachment) }, { summary: ctx.v2.t('missions.summary.attached', { name: file.name, mission: ref }), refs: { mission: ref }, untrusted: untrusted('/data/name') })
      },
    },
    attachments: {
      ...read,
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const items = rows(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}/attachments`)).attachments).map(attachmentView)
        return result({ ref, items }, { summary: ctx.v2.t('missions.summary.attachments', { count: items.length, mission: ref }), refs: { mission: ref }, untrusted: untrusted('/data/items/*/name') })
      },
    },
    detach: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref', 'options.attachmentId'], doc: 'Deletes an attachment file. Always confirmed.',
      preview: attachmentPreview,
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        await apiCall(ctx, 'DELETE', `${AGENT}/${enc(id)}/attachments/${enc(String(optionsOf(args).attachmentId))}`)
        return result({ ref, attachmentId: optionsOf(args).attachmentId, deleted: true }, { summary: ctx.v2.t('missions.summary.detached', { mission: ref }), refs: { mission: ref } })
      },
    },
    subagents: {
      ...read, doc: 'Sub-agents of the mission\'s Core session; options.subagentId pages its activity (options.after seq, limit).',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const options = optionsOf(args)
        if (str(options.subagentId)) {
          const after = typeof options.after === 'number' ? options.after : 0
          const limit = typeof args.limit === 'number' ? args.limit : 50
          const page = record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}/subagents/${enc(String(options.subagentId))}/events?after=${after}&limit=${limit}`))
          const events = rows(page.events).map((event) => ({ seq: event.seq, channel: event.channel, ...(event.delta ? { text: neutralize(clip(String(event.delta), 600)) } : {}), ...(event.tool ? { tool: record(event.tool).name ?? record(event.tool).tool } : {}), at: minute(event.createdAt) }))
          const last = events[events.length - 1]
          return result({ ref, subagentId: options.subagentId, events, ...(page.hasMore && last ? { nextAfter: last.seq } : {}) }, { summary: ctx.v2.t('missions.summary.subagent_events', { count: events.length }), refs: { mission: ref }, untrusted: untrusted('/data/events/*/text') })
        }
        const body = record(await apiCall(ctx, 'GET', `${AGENT}/${enc(id)}/subagents`))
        const items = (rows(body.subagents).length ? rows(body.subagents) : rows(record(body.session).subagents)).map(subagentView)
        const working = items.filter((item) => item.phase === 'running').length
        return result({ ref, items }, { summary: ctx.v2.t('missions.summary.subagents', { count: items.length, working }), refs: { mission: ref }, untrusted: untrusted('/data/items/*/description', '/data/items/*/result') })
      },
    },
    subagents_stop: {
      ...write, doc: 'Stops sub-agents (options.subagentIds; default all of the mission).',
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const ids = optionsOf(args).subagentIds
        const body = record(await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/subagents/stop`, Array.isArray(ids) ? { subagentIds: ids } : {}))
        const stopped = Array.isArray(body.stopped) ? body.stopped : []
        return result({ ref, stopped }, { summary: ctx.v2.t('missions.summary.subagents_stopped', { count: stopped.length }), refs: { mission: ref } })
      },
    },
    card_decide: {
      tier: (args) => isSpendDecision(args) ? 'ai-spawn' : 'write',
      confirm: (args) => LAUNCH_DECISIONS.has(String(args.decision)) ? 'costly' : null,
      maxTokens: CONVERSE_TOKENS,
      required: ['ref', 'cardId', 'decision'],
      choose: { fields: ['decision'], point: cardPoint },
      doc: 'Decides a pending card (ids and decisions in get: pendingCards; no decision: the person picks). options: option index or text; intent-draft: restated|alternative|explore (start Intent from it)|delegate; rail-launch: launch|dismiss; flow-offer: intent|implement|dismiss; pr-ci-offer: start|dismiss. Delivery cards: specrails_deliveries.',
      preview: cardPreview,
      handler: decideCard,
    },
    limit_continue: {
      ...spend,
      // Cancelling the scheduled continue spends nothing.
      tier: (args) => optionsOf(args).at === null ? 'write' : 'ai-spawn',
      confirm: (args) => optionsOf(args).at === null ? null : 'costly',
      doc: 'After a usage limit: continue by itself at the reset (options.at ISO; default the reset time) or cancel (options.at null).',
      preview: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const readValue = await readMission(ctx, id)
        const limit = openLimit(readValue.messages)
        const at = 'at' in optionsOf(args) ? optionsOf(args).at : limit?.resumeAt ?? null
        return { effect: ctx.v2.t(at ? 'missions.preview.limit_continue' : 'missions.preview.limit_cancel', { at: String(at ?? '') }), refs: [ref], version: missionState(ctx, id, readValue, projectCards(readValue.messages, { busy: readValue.live.isStreaming === true })).version, ...(at ? { cost: { forecastUsd: missionForecast(ctx, id), runs: 1 } } : {}) }
      },
      handler: async (ctx, args) => {
        const { id, ref } = missionId(ctx, args)
        const options = optionsOf(args)
        let at = 'at' in options ? options.at : undefined
        if (at === undefined) {
          at = openLimit((await readMission(ctx, id)).messages)?.resumeAt ?? undefined
          if (!at) throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.no_limit'))
        }
        const body = record(await apiCall(ctx, 'POST', `${AGENT}/${enc(id)}/limit-continue`, { at: at ?? null }))
        return result({ ref, at: body.at ?? null }, { summary: ctx.v2.t(body.at ? 'missions.summary.limit_scheduled' : 'missions.summary.limit_cancelled', { at: String(body.at ?? '') }), refs: { mission: ref } })
      },
    },
    intent_list: {
      tier: 'read', doc: 'Missions in Intent in a project, and whether Intent can run here (availability, missing capabilities).',
      handler: async (ctx, args) => {
        const row = ctx.v2.project(args)
        const [availability, open] = await Promise.all([
          apiCall(ctx, 'GET', `${flowBase(row)}/availability`).catch((err: unknown) => ({ available: false, reason: err instanceof Error ? oneLine(err.message, 160) : 'unavailable' })),
          apiCall(ctx, 'GET', `${flowBase(row)}/open`).catch(() => ({ flows: [] })),
        ])
        const items = rows(record(open).flows).map((flow) => ({ ref: intentRef(row, String(flow.id)), mission: missionRef(String(flow.conversationId)), state: flow.state, ...(flow.branch ? { branch: flow.branch } : {}) }))
        const avail = record(availability)
        return result({ available: avail.available === true, ...(avail.missing ? { missing: avail.missing } : {}), ...(avail.reason ? { reason: avail.reason } : {}), items }, {
          summary: ctx.v2.t(avail.available === true ? 'missions.summary.intent_list' : 'missions.summary.intent_unavailable', { count: items.length, project: row.slug }),
          refs: { project: formatRef('project', row.slug) },
        })
      },
    },
    intent_start: {
      tier: 'ai-spawn', confirm: 'costly', oneOf: ['message', 'options.spec'], maxTokens: CONVERSE_TOKENS,
      doc: 'Starts Intent (build in an isolated worktree, then hand off): message = the idea, or options.spec (start from that spec); ref = an existing mission (default: a new mission in project, with provider/model/effort); options.repository for multi-repository projects.',
      preview: async (ctx, args) => {
        const row = args.ref ? null : ctx.v2.project(args)
        return { effect: ctx.v2.t('missions.preview.intent_start', { project: row?.slug ?? String(args.ref) }), refs: args.ref ? [String(args.ref)] : [], version: `i${shortHash({ r: args.ref ?? null, p: row?.id ?? null })}`, cost: { forecastUsd: null, runs: 1 } }
      },
      handler: async (ctx, args) => {
        const options = optionsOf(args)
        let conversationId: string
        let row: ProjectRow
        if (args.ref) {
          conversationId = missionId(ctx, args).id
          const conversation = record(record(await apiCall(ctx, 'GET', `${AGENT}/${enc(conversationId)}`)).conversation)
          row = projectOfPin(ctx, conversation.pinned_project_id) ?? ctx.v2.project(args)
        } else {
          row = ctx.v2.project(args)
          const created = record(record(await apiCall(ctx, 'POST', AGENT, { pinnedProjectId: row.id, ...(args.provider ? { provider: args.provider } : {}), ...(args.model ? { model: args.model } : {}), ...(args.effort ? { reasoningEffort: args.effort } : {}), ...mcpOrigin(ctx) })).conversation)
          conversationId = String(created.id)
        }
        let ticketId: number | undefined
        if (options.spec !== undefined) {
          const spec = ctx.v2.target({ project: row.slug, ref: typeof options.spec === 'number' ? String(options.spec) : options.spec }, 'spec')
          ticketId = Number(spec.id)
        }
        let flow = null as unknown as IntentSession
        // A seeded Intent (a spec or a stored intent) begins with its own opening turn: wait for it like a
        // send, so the person hears what the mission found and picks from the choices it proposed.
        const { response, settled } = await sendAndWait(ctx, conversationId, async () => {
          flow = record(record(await apiCall(ctx, 'POST', flowBase(row), {
            conversationId, idea: str(args.message) ?? '', ...(ticketId ? { ticketId } : {}), ...(str(args.title) ? { title: str(args.title) } : {}), ...(str(options.repository) ? { repositoryId: str(options.repository) } : {}),
          })).flow) as unknown as IntentSession
          return {}
        }, { waitMs: waitMsOf(args), queueId: null, done: ['agent_done', 'agent_turn_done'], failed: ['agent_error'], waitsFor: () => Boolean(flow?.returnBriefing) })
        const target: IntentTarget = { row, flowId: flow.id, ref: intentRef(row, flow.id), flow }
        if (!flow.returnBriefing) return intentResult(ctx, target, flow, 'missions.summary.intent_started')
        const turn = await turnResult(ctx, conversationId, missionRef(conversationId), response, settled, {
          keys: { replied: 'missions.summary.intent_replied', working: 'missions.summary.intent_working' }, vars: { ref: target.ref },
        })
        if (!isV2Result(turn)) return turn
        const { ref: _missionRef, accepted: _accepted, queued: _queued, ...turnData } = turn.data as Row
        return result({ ...intentView(target), turn: turnData }, {
          summary: turn.summary, refs: { intent: target.ref, mission: missionRef(conversationId) },
          state: turn.state ?? intentState(ctx, target, settled.status === 'pending'),
          untrusted: untrusted('/data/returnBriefing', '/data/turn/reply/text', '/data/turn/error'),
        })
      },
    },
    intent_get: {
      ...read, doc: 'The Intent session (intent or mission ref): state, branch, spec, delivery, legal moves; while open, its turn (running, live text), last reply, pending cards and preview apps (appUrls). view detail adds diff totals and cost.',
      handler: async (ctx, args) => {
        const target = await intentTarget(ctx, args)
        const progress = target.flow.state === 'active' || target.flow.state === 'paused' ? await intentProgress(ctx, target) : null
        const extra: Row = { ...(progress?.data ?? {}) }
        if (ctx.v2.view === 'detail') {
          const [diff, cost] = await Promise.all([
            apiCall(ctx, 'GET', `${flowBase(target.row)}/${enc(target.flowId)}/diff`).catch(() => null),
            apiCall(ctx, 'GET', `${flowBase(target.row)}/${enc(target.flowId)}/cost`).catch(() => null),
          ])
          if (diff) extra.diff = record(diff).totals
          if (cost) extra.cost = costView(record(cost))
        }
        return intentResult(ctx, target, target.flow, 'missions.summary.intent_get', extra, progress ?? undefined)
      },
    },
    intent_pause: { ...write, doc: 'Pauses (stops its dev servers, closes the agent session).', handler: simpleIntent('pause', 'missions.summary.intent_paused') },
    intent_resume: { ...spend, doc: 'Resumes a paused Intent (reopens its agent session).', preview: (ctx, args) => intentPreview(ctx, args, 'missions.preview.intent_resume', 'turn'), handler: simpleIntent('resume', 'missions.summary.intent_resumed') },
    intent_hand_off: {
      ...spend, required: ['ref'], doc: 'Hands the worktree to a rail that derives the spec and delivers (Intent → Spec). Like the app\'s Hand off: options.rail (index or rail ref) defaults to the first free rail (a new one when none is free), the engine to the mission\'s (provider, model, effort override); options.loopId.',
      preview: async (ctx, args) => {
        const base = await intentPreview(ctx, args, 'missions.preview.intent_hand_off', 'launch')
        const target = await intentTarget(ctx, args)
        const rail = await handOffRail(ctx, target, optionsOf(args).rail, { create: false })
        return { ...base, effect: `${base.effect} ${rail.index === null ? ctx.v2.t('missions.preview.hand_off_new_rail') : ctx.v2.t('missions.preview.hand_off_rail', { rail: `Rail ${rail.index + 1}` })}`, version: `i${shortHash({ v: base.version, rail: rail.index })}` }
      },
      handler: async (ctx, args) => {
        const target = await intentTarget(ctx, args)
        const options = optionsOf(args)
        const { index: railIndex } = await handOffRail(ctx, target, options.rail, { create: true })
        const body = record(await apiCall(ctx, 'POST', `${flowBase(target.row)}/${enc(target.flowId)}/hand-off`, {
          railIndex, ...(str(options.loopId) ? { loopId: str(options.loopId) } : {}), ...(args.provider ? { aiEngine: args.provider } : { engine: 'mission' }), ...(args.model ? { model: args.model } : {}), ...(args.effort ? { reasoningEffort: args.effort } : {}),
        }))
        return intentResult(ctx, target, body.flow, 'missions.summary.intent_handed_off', runsOf(target.row, body))
      },
    },
    intent_return: {
      ...write, doc: 'Back to Intent: the stopped Intent → Spec run gives the worktree back (intent or delivery ref).',
      handler: async (ctx, args) => {
        const { target, deliveryId } = await byDelivery(ctx, args)
        const flow = record(await apiCall(ctx, 'POST', `${flowBase(target.row)}/by-delivery/${enc(deliveryId)}/return`)).flow
        return intentResult(ctx, target, flow, 'missions.summary.intent_returned')
      },
    },
    intent_relaunch: {
      ...spend, doc: 'Relaunches the Intent → Spec run on the same worktree, rail and engine (intent or delivery ref).',
      preview: (ctx, args) => intentPreview(ctx, args, 'missions.preview.intent_relaunch', 'launch'),
      handler: async (ctx, args) => {
        const { target, deliveryId } = await byDelivery(ctx, args)
        const body = record(await apiCall(ctx, 'POST', `${flowBase(target.row)}/by-delivery/${enc(deliveryId)}/relaunch`))
        return intentResult(ctx, target, body.flow, 'missions.summary.intent_relaunched', runsOf(target.row, body))
      },
    },
    intent_discard: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'], doc: 'Discards the Intent: removes its worktree and branch (a placeholder spec is deleted; an existing spec is restored). Always confirmed.',
      preview: (ctx, args) => intentPreview(ctx, args, 'missions.preview.intent_discard', null),
      handler: simpleIntent('discard', 'missions.summary.intent_discarded'),
    },
    intent_close: { ...write, doc: 'Closes an Intent that needs review, keeping the branch and spec.', handler: simpleIntent('close', 'missions.summary.intent_closed') },
    intent_diff: {
      ...read, doc: 'Files changed on the Intent branch (paged).',
      handler: async (ctx, args) => {
        const target = await intentTarget(ctx, args)
        const diff = record(await apiCall(ctx, 'GET', `${flowBase(target.row)}/${enc(target.flowId)}/diff`))
        const files = rows(diff.files).map((file) => ({ path: file.path, ...(file.status ? { status: file.status } : {}), additions: file.additions, deletions: file.deletions }))
        const { items, page } = pageOf(files, { cursor: args.cursor, limit: args.limit ?? 50, key: `d:${target.flowId}` })
        const totals = record(diff.totals)
        return result({ ref: target.ref, branch: diff.branch ?? null, totals, items }, { summary: ctx.v2.t('missions.summary.intent_diff', { files: Number(totals.files ?? files.length), add: Number(totals.additions ?? 0), del: Number(totals.deletions ?? 0) }), refs: { intent: target.ref }, page, untrusted: untrusted('/data/items/*/path') })
      },
    },
    intent_cost: {
      ...read, doc: 'Provider-billed cost of the Intent turns (never estimated).',
      handler: async (ctx, args) => {
        const target = await intentTarget(ctx, args)
        const cost = costView(record(await apiCall(ctx, 'GET', `${flowBase(target.row)}/${enc(target.flowId)}/cost`)))
        return result({ ref: target.ref, ...cost }, { summary: ctx.v2.t('missions.summary.intent_cost', { usd: Number(cost.costUsd ?? 0).toFixed(2), turns: Number(cost.turns ?? 0) }), refs: { intent: target.ref } })
      },
    },
    chat_list: {
      tier: 'read', doc: 'Legacy project chat and Explore Spec conversations (project).',
      handler: async (ctx, args) => {
        const row = ctx.v2.project(args)
        const all = rows(record(await apiCall(ctx, 'GET', chatBase(row))).conversations).map((c) => ({ ref: formatRef('chat', String(c.id)), title: c.title ?? null, kind: c.kind ?? null, model: c.model ?? null, updated: minute(c.updated_at) }))
        const { items, page } = pageOf(all, { cursor: args.cursor, limit: args.limit, key: `c:${row.id}` })
        return result({ items }, { summary: ctx.v2.t('missions.summary.chat_list', { count: all.length, project: row.slug }), page, untrusted: untrusted('/data/items/*/title') })
      },
    },
    chat_get: { ...read, doc: 'One chat with its messages (paged) and the Explore spec draft.', handler: chatGet },
    chat_create: {
      tier: 'write', doc: 'New chat (options.kind sidebar|explore, provider, model, options.contextScope).',
      handler: async (ctx, args) => {
        const row = ctx.v2.project(args)
        const options = optionsOf(args)
        const created = record(record(await apiCall(ctx, 'POST', chatBase(row), { ...(options.kind ? { kind: options.kind } : {}), ...(args.provider ? { aiEngine: args.provider } : {}), ...(args.model ? { model: args.model } : {}), ...(options.contextScope ? { contextScope: options.contextScope } : {}) })).conversation)
        const ref = formatRef('chat', String(created.id))
        return result({ ref, project: row.slug, kind: created.kind ?? null }, { summary: ctx.v2.t('missions.summary.chat_created', { chat: ref }), refs: { chat: ref } })
      },
    },
    chat_update: {
      ...write, doc: 'Rename (title), model; options.minimize true|false arms or cancels the Explore idle timer.',
      handler: async (ctx, args) => {
        const { row, id, ref } = chatTarget(ctx, args)
        const options = optionsOf(args)
        const body: Row = {}
        if (args.title !== undefined) body.title = args.title
        if (args.model !== undefined) body.model = args.model
        if (Object.keys(body).length) await apiCall(ctx, 'PATCH', `${chatBase(row)}/${enc(id)}`, body)
        if (typeof options.minimize === 'boolean') await apiCall(ctx, 'POST', `${chatBase(row)}/${enc(id)}/${options.minimize ? 'minimize' : 'restore'}`)
        if (!Object.keys(body).length && typeof options.minimize !== 'boolean') throw new V2ToolError('invalid_input', ctx.v2.t('missions.error.nothing_to_update'))
        return result({ ref, updated: true }, { summary: ctx.v2.t('missions.summary.updated', { mission: ref }), refs: { chat: ref } })
      },
    },
    chat_send: {
      ...spend, required: ['ref', 'message'], doc: 'Sends a chat turn and waits (options.waitMs). options.lightweight, maxTurns, attachments {ticketKey, ids}.',
      preview: async (ctx, args) => {
        const { ref } = chatTarget(ctx, args)
        return { effect: ctx.v2.t('missions.preview.send', { title: ref }), refs: [ref], version: `c${shortHash({ ref })}`, cost: { forecastUsd: null, runs: 1 } }
      },
      handler: chatSend,
    },
    chat_abort: {
      ...write,
      handler: async (ctx, args) => {
        const { row, id, ref } = chatTarget(ctx, args)
        await apiCall(ctx, 'DELETE', `${chatBase(row)}/${enc(id)}/messages/stream`)
        return result({ ref, aborted: true }, { summary: ctx.v2.t('missions.summary.aborted', { mission: ref }), refs: { chat: ref } })
      },
    },
    chat_delete: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'], doc: 'Deletes a chat and its messages. Always confirmed.',
      preview: async (ctx, args) => {
        const { row, id, ref } = chatTarget(ctx, args)
        const conversation = record(record(await apiCall(ctx, 'GET', `${chatBase(row)}/${enc(id)}`)).conversation)
        return { effect: ctx.v2.t('missions.preview.chat_delete', { title: excerpt(conversation.title, 80) || ref }), refs: [ref], version: `c${shortHash({ u: conversation.updated_at ?? null })}` }
      },
      handler: async (ctx, args) => {
        const { row, id, ref } = chatTarget(ctx, args)
        await apiCall(ctx, 'DELETE', `${chatBase(row)}/${enc(id)}`)
        return result({ ref, deleted: true }, { summary: ctx.v2.t('missions.summary.chat_deleted', { chat: ref }) })
      },
    },
  },
})

function costView(cost: Row): Row {
  return {
    costUsd: cost.costUsd ?? null, turns: cost.turns ?? null, ...(cost.unpricedTurns ? { unpricedTurns: cost.unpricedTurns } : {}),
    ...(Array.isArray(cost.providers) ? { providers: rows(cost.providers).map((p) => ({ provider: p.provider, costUsd: p.costUsd, turns: p.turns })) } : {}),
  }
}

function runsOf(row: ProjectRow, body: Row): Row {
  const ids = Array.isArray(body.loopRunIds) ? body.loopRunIds.filter((id): id is string => typeof id === 'string') : []
  return {
    ...(ids.length ? { runs: ids.map((id) => formatRef('run', id, row.slug)) } : {}),
    ...(typeof body.deliveryId === 'string' ? { delivery: formatRef('delivery', body.deliveryId, row.slug) } : {}),
  }
}

/** Return/relaunch address the Intent's delivery: a delivery ref, or the Intent's own `deliveryId`. */
async function byDelivery(ctx: V2CallContext, args: Row): Promise<{ target: IntentTarget; deliveryId: string }> {
  const parsed = parseRef(args.ref)
  if (parsed?.kind === 'delivery') {
    const delivery = ctx.v2.target(args, 'delivery')
    const row = delivery.project!
    const open = rows(record(await apiCall(ctx, 'GET', `${flowBase(row)}/open`).catch(() => ({ flows: [] }))).flows)
    // The delivery's Intent is not open while handed off; read it through its own route after the call.
    const flowRow = open.find((flow) => flow.deliveryId === delivery.id)
    const flow = (flowRow ?? { id: '', conversationId: '', state: 'handed_off', deliveryId: delivery.id, updatedAt: '' }) as unknown as IntentSession
    return { target: { row, flowId: flow.id, ref: flow.id ? intentRef(row, flow.id) : delivery.ref, flow }, deliveryId: delivery.id }
  }
  const target = await intentTarget(ctx, args)
  if (!target.flow.deliveryId) throw new V2ToolError('conflict', ctx.v2.t('missions.error.no_delivery', { ref: target.ref }))
  return { target, deliveryId: target.flow.deliveryId }
}
