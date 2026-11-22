import { parseIntentDraft } from '../../../modules/specs/domain/intent'
import { transition, IntentTransitionError, type IntentCommand, type IntentSession } from '../../../modules/intent'
import type { CanonicalStatus } from '../core/status-map'
import type { DecisionStateInput, HoldDraft, OfferDraft } from '../core/decision-state'
import { formatRef, type Ref } from '../core/refs'

/**
 * WP7. Pure projectors of a mission (agent conversation) and its Intent
 * session into the v2 decision state. They read only what the app itself
 * shows: the cards an agent message carries (```options, ```intent-draft,
 * ```rail-launch, ```flow-offer fences) and the app-authored system rows
 * (pr_decision, pr-ci-offer, usage-limit, flow-*, run-failure), decided by the
 * persisted `agent_messages.intents`. Intent offers come from the Intent
 * domain's own `transition` table (a command is offered only when it is legal
 * and not a no-op). No clock, no IO.
 */

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown) => typeof value === 'string' ? value : ''
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const int = (value: unknown, min = 0): number | null => typeof value === 'number' && Number.isInteger(value) && value >= min ? value : null

const TOOL = 'specrails_missions'

// ── Fences ──────────────────────────────────────────────────────────────────

function fences(content: string, tag: string): unknown[] {
  if (!content.includes('```' + tag)) return []
  const re = new RegExp('```' + tag + '[^\\S\\n]*\\n([\\s\\S]*?)\\n[^\\S\\n]*```', 'g')
  const out: unknown[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(content)) !== null) {
    try { out.push(JSON.parse(match[1])) } catch { /* unreadable block: the app shows it as unreadable too */ }
  }
  return out
}

/** ```options chips (2–8 short replies), the last block of the message. */
export function parseOptions(content: string): string[] | null {
  const blocks = fences(content, 'options')
  const last = blocks[blocks.length - 1]
  if (!Array.isArray(last)) return null
  const items = last.filter((item): item is string => typeof item === 'string' && !!item.trim()).map((item) => item.trim().slice(0, 200))
  return items.length >= 2 ? items.slice(0, 8) : null
}

export interface RailLaunchProposal {
  railIndex: number | null
  newRail: { name: string | null } | null
  ticketIds: number[]
  mode: 'implement' | 'loop'
  loopId: string | null
  aiEngine: string | null
  model: string | null
  reasoningEffort: string | null
  profileName: string | null
  targetPrNumber: number | null
  baseBranch: string | null
  repositoryIds?: string[]
  railName: string | null
  rationale: string | null
}

function ticketIdsOf(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const out: number[] = []
  for (const item of value) {
    const n = typeof item === 'number' ? item : typeof item === 'string' ? Number(item.trim().replace(/^#/, '')) : NaN
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n)
  }
  return out
}

/** Same reading as the client's `coerceRailLaunchProposal` (rail-launch-draft.ts); null = the card shows it as unreadable. */
export function coerceRailLaunch(value: unknown): RailLaunchProposal | null {
  const raw = record(value)
  const ticketIds = ticketIdsOf(raw.ticketIds ?? raw.specs ?? raw.tickets)
  if (!ticketIds.length) return null
  const modeRaw = (str(raw.mode) ?? 'implement').toLowerCase().replace(/_/g, '-')
  const mode = ['batch', 'batch-implement', 'freestyle', 'ultracode'].includes(modeRaw) ? 'implement' : modeRaw
  if (mode !== 'implement' && mode !== 'loop') return null
  const newRail = raw.newRail === true ? { name: null } : raw.newRail && typeof raw.newRail === 'object' ? { name: str(record(raw.newRail).name) } : null
  const repositoryIds = Array.isArray(raw.repositoryIds) && raw.repositoryIds.every((id) => typeof id === 'string' && id.trim()) && raw.repositoryIds.length ? raw.repositoryIds as string[] : undefined
  return {
    railIndex: newRail ? null : int(raw.railIndex),
    newRail,
    ticketIds,
    mode,
    loopId: str(raw.loopId),
    aiEngine: str(raw.aiEngine ?? raw.provider ?? raw.engine),
    model: str(raw.model),
    reasoningEffort: str(raw.reasoningEffort ?? raw.reasoning_effort ?? raw.effort),
    profileName: str(raw.profileName ?? raw.profile),
    targetPrNumber: int(raw.targetPrNumber, 1),
    baseBranch: str(raw.baseBranch),
    ...(repositoryIds ? { repositoryIds } : {}),
    railName: str(raw.railName ?? raw.name),
    rationale: str(raw.rationale ?? raw.reason ?? raw.why),
  }
}

export interface FlowOffer { idea: string; reason: string | null; title: string | null; repositoryId: string | null; ticketId: number | null }

/** Same reading as the client's `parseFlowOffer` (intent-offer.ts). */
export function coerceFlowOffer(value: unknown): FlowOffer | null {
  const raw = record(value)
  const idea = text(raw.idea).trim().slice(0, 2000)
  if (!idea) return null
  return { idea, reason: str(raw.reason), title: str(raw.title), repositoryId: str(raw.repositoryId), ticketId: int(raw.ticketId, 1) }
}

// ── Cards ───────────────────────────────────────────────────────────────────

export type CardKind = 'options' | 'intent-draft' | 'rail-launch' | 'flow-offer' | 'pr_decision' | 'pr-ci-offer' | 'usage-limit'
  | 'flow-delivered' | 'flow-return-briefing' | 'flow-boundary' | 'run-failure' | 'session-summary'

/** One card of a mission, as the app renders it. `pending` cards wait for the person. */
export interface MissionCard {
  /** `<messageId>:<kind>:<index>` (card_decide takes it). */
  id: string
  kind: CardKind
  messageId: string
  pending: boolean
  /** The persisted decision (launched / dismissed / accepted…) or the row's own state. */
  decided?: string
  /** Decisions card_decide accepts while pending. */
  decisions?: string[]
  /** Short machine facts (no third-party prose except where `untrusted` says so). */
  data: Row
  at: string
}

export interface MessageLike {
  id: string
  role: string
  content: string
  intents?: Array<{ kind: string; proposalIndex: number; status: string; runIds?: string[]; railIndex?: number; chosenMode?: string | null; prDeliveryId?: string | null; config?: Row }>
  created_at: string
}

const cardId = (messageId: string, kind: CardKind, index: number) => `${messageId}:${kind}:${index}`

export function parseCardId(id: unknown): { messageId: string; kind: CardKind; index: number } | null {
  if (typeof id !== 'string') return null
  const match = /^(.+):([a-z_-]+):(\d+)$/.exec(id)
  if (!match) return null
  return { messageId: match[1], kind: match[2] as CardKind, index: Number(match[3]) }
}

function systemCard(message: MessageLike): MissionCard | null {
  let row: Row
  try { row = record(JSON.parse(message.content)) } catch { return null }
  const kind = text(row.kind) as CardKind
  const base = { id: cardId(message.id, kind, 0), kind, messageId: message.id, at: text(row.at) || message.created_at }
  switch (kind) {
    case 'pr_decision': {
      const decision = text(row.decision)
      const pending = ['pending', 'pr_draft', 'pr_ready', 'implementation_failed', 'delivery_failed', 'no_changes'].includes(decision) || row.phase === 'awaiting_decision'
      return { ...base, pending, decided: decision || undefined, data: pick(row, ['railIndex', 'railName', 'ticketIds', 'runIds', 'prDeliveryId', 'prNumber', 'decision', 'phase', 'baseBranch', 'statusCode']) }
    }
    case 'pr-ci-offer': {
      const state = text(row.state)
      return { ...base, pending: state === 'offered', decided: state, ...(state === 'offered' ? { decisions: ['start', 'dismiss'] } : {}), data: pick(row, ['prDeliveryId', 'admissionId', 'prNumber', 'prUrl', 'railIndex', 'state', 'runId', 'reason']) }
    }
    case 'usage-limit':
      return { ...base, pending: false, data: pick(row, ['provider', 'resumeAt', 'message']) }
    case 'flow-delivered':
      return { ...base, pending: false, data: pick(row, ['flowId', 'deliveryId', 'ticketId', 'specTitle', 'branch', 'prUrl', 'prNumber', 'integration', 'specRewrite', 'jiraKey', 'changeName', 'diff', 'cost', 'settled']) }
    case 'flow-return-briefing':
      return { ...base, pending: false, data: pick(row, ['flowId', 'deliveryId', 'reason', 'score', 'summary', 'issues', 'failingChecks', 'failure']) }
    case 'flow-boundary':
      return { ...base, pending: false, data: pick(row, ['flowId', 'event', 'reason', 'branch']) }
    case 'run-failure':
      return { ...base, pending: false, data: pick(row, ['runId', 'railIndex', 'prDeliveryId', 'ticketIds', 'code', 'detail', 'stepId']) }
    case 'session-summary':
      return { ...base, pending: false, data: pick(row, ['summary', 'language']) }
    default:
      return null
  }
}

function pick(row: Row, keys: string[]): Row {
  return Object.fromEntries(keys.filter((key) => row[key] !== undefined && row[key] !== null).map((key) => [key, row[key]]))
}

/**
 * Every card of the transcript, oldest first. `busy`: a turn is running, so the
 * newest message's chips (options, readings) are not answerable yet, exactly
 * like the app (newest card only, not mid-turn). System rows re-posted in
 * place keep only their latest copy per dedupe identity.
 */
export function projectCards(messages: readonly MessageLike[], options: { busy: boolean }): MissionCard[] {
  const cards: MissionCard[] = []
  const lastAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  for (const message of messages) {
    if (message.role === 'system') {
      const card = systemCard(message)
      if (card) cards.push(card)
      continue
    }
    if (message.role !== 'assistant') continue
    const content = message.content ?? ''
    const newest = message.id === lastAssistant?.id && !options.busy
    const decided = (kind: string, index: number) => (message.intents ?? []).find((intent) => intent.kind === kind && intent.proposalIndex === index)
    const opts = parseOptions(content)
    if (opts) cards.push({ id: cardId(message.id, 'options', 0), kind: 'options', messageId: message.id, pending: newest, ...(newest ? { decisions: opts.map((_, i) => String(i)) } : {}), data: { options: opts }, at: message.created_at })
    const drafts = fences(content, 'intent-draft').map(parseIntentDraft).filter((draft) => draft !== null)
    const draft = drafts[drafts.length - 1]
    if (draft) {
      cards.push({
        id: cardId(message.id, 'intent-draft', 0), kind: 'intent-draft', messageId: message.id, pending: newest,
        ...(newest ? { decisions: draft.ready ? ['restated', 'alternative', 'delegate'] : ['restated', 'alternative'] } : {}),
        data: { title: draft.title ?? null, problem: draft.intent.problem, outcome: draft.intent.outcome, readings: draft.readings, ready: draft.ready, openQuestions: draft.intent.openQuestions.filter((item) => !item.answer).map((item) => item.question) },
        at: message.created_at,
      })
    }
    fences(content, 'rail-launch').forEach((raw, index) => {
      const proposal = coerceRailLaunch(raw)
      if (!proposal) return
      const intent = decided('rail-launch', index)
      cards.push({
        id: cardId(message.id, 'rail-launch', index), kind: 'rail-launch', messageId: message.id, pending: !intent,
        ...(intent ? { decided: intent.status } : { decisions: ['launch', 'dismiss'] }),
        data: { ticketIds: proposal.ticketIds, railIndex: intent?.railIndex ?? proposal.railIndex, newRail: proposal.newRail !== null, mode: proposal.mode, loopId: proposal.loopId, aiEngine: proposal.aiEngine, model: proposal.model, ...(intent?.runIds?.length ? { runIds: intent.runIds } : {}), ...(proposal.rationale ? { rationale: proposal.rationale } : {}) },
        at: message.created_at,
      })
    })
    fences(content, 'flow-offer').forEach((raw, index) => {
      const offer = coerceFlowOffer(raw)
      if (!offer) return
      const intent = decided('flow-offer', index)
      cards.push({
        id: cardId(message.id, 'flow-offer', index), kind: 'flow-offer', messageId: message.id, pending: !intent,
        ...(intent ? { decided: intent.chosenMode ?? intent.status } : { decisions: ['intent', 'implement', 'dismiss'] }),
        data: { idea: offer.idea, ...(offer.reason ? { reason: offer.reason } : {}), ...(offer.ticketId ? { ticketId: offer.ticketId } : {}), ...(offer.repositoryId ? { repositoryId: offer.repositoryId } : {}) },
        at: message.created_at,
      })
    })
  }
  return dedupeSystemCards(cards)
}

/** A re-posted row (pr_decision per rail, pr-ci-offer per delivery, flow-delivered per Intent) keeps its newest copy. */
function dedupeSystemCards(cards: MissionCard[]): MissionCard[] {
  const identity = (card: MissionCard): string | null => {
    if (card.kind === 'pr_decision') return `pr:${String(card.data.prDeliveryId ?? card.data.railIndex)}`
    if (card.kind === 'pr-ci-offer') return `ci:${String(card.data.prDeliveryId ?? card.data.admissionId)}`
    if (card.kind === 'flow-delivered') return `fd:${String(card.data.flowId)}`
    return null
  }
  const last = new Map<string, number>()
  cards.forEach((card, index) => { const key = identity(card); if (key) last.set(key, index) })
  return cards.filter((card, index) => { const key = identity(card); return !key || last.get(key) === index })
}

/** The texts a decision sends as the person's reply (options and intent readings). */
export function replyFor(card: MissionCard, decision: string): string | null {
  if (card.kind === 'options') {
    const options = card.data.options as string[]
    const index = /^\d+$/.test(decision) ? Number(decision) : options.findIndex((option) => option === decision)
    return options[index] ?? null
  }
  if (card.kind === 'intent-draft') {
    const readings = record(card.data.readings)
    if (decision === 'restated' || decision === 'alternative') return str(readings[decision])
    if (decision === 'delegate' && card.data.ready === true) return 'delegate'
  }
  return null
}

// ── Mission state ───────────────────────────────────────────────────────────

export interface MissionFacts {
  ref: Ref
  conversationId: string
  updatedAt: string
  archived: boolean
  busy: boolean
  queued: number
  cards: readonly MissionCard[]
  /** Scheduled continue at a usage-limit reset (manager.limitContinueAt). */
  limitContinueAt: string | null
  /** The newest usage-limit row when nothing ran after it. */
  limit: { resumeAt: string | null; provider: string | null; at: string } | null
  /** Project slug of the pin (refs of linked deliveries and runs). */
  projectSlug: string | null
  flow?: { ref: Ref; state: string } | null
}

/**
 * What a mission can do now. Pending cards come first (the person's
 * decisions), then the limit continue, then the ordinary conversation moves.
 */
export function projectMissionState(facts: MissionFacts): DecisionStateInput {
  const offers: OfferDraft[] = []
  const self = (action: string, extra: Row = {}) => ({ tool: TOOL, args: { action, ref: facts.ref, ...extra } })
  let recommended: string | null = null
  const pending = facts.cards.filter((card) => card.pending)
  for (const card of pending) {
    const short = card.id
    switch (card.kind) {
      case 'options':
        (card.data.options as string[]).forEach((option, index) => offers.push({ id: `option.${index}`, labelKey: 'missions.offer.option', labelParams: { option }, call: self('card_decide', { cardId: short, decision: String(index) }) }))
        break
      case 'intent-draft':
        for (const decision of card.decisions ?? []) offers.push({ id: `reading.${decision}`, labelKey: `missions.offer.reading_${decision}`, call: self('card_decide', { cardId: short, decision }) })
        break
      case 'rail-launch':
        offers.push({ id: `launch.${short}`, labelKey: 'missions.offer.rail_launch', labelParams: { specs: (card.data.ticketIds as number[]).map((id) => `#${id}`).join(', ') }, call: self('card_decide', { cardId: short, decision: 'launch' }) })
        offers.push({ id: `dismiss.${short}`, labelKey: 'missions.offer.dismiss_card', call: self('card_decide', { cardId: short, decision: 'dismiss' }) })
        recommended ??= `launch.${short}`
        break
      case 'flow-offer':
        offers.push({ id: `intent.${short}`, labelKey: 'missions.offer.flow_intent', call: self('card_decide', { cardId: short, decision: 'intent' }) })
        offers.push({ id: `implement.${short}`, labelKey: 'missions.offer.flow_implement', call: self('card_decide', { cardId: short, decision: 'implement' }) })
        offers.push({ id: `dismiss.${short}`, labelKey: 'missions.offer.dismiss_card', call: self('card_decide', { cardId: short, decision: 'dismiss' }) })
        break
      case 'pr-ci-offer':
        offers.push({ id: `ci.${short}`, labelKey: 'missions.offer.ci_start', call: self('card_decide', { cardId: short, decision: 'start' }) })
        offers.push({ id: `dismiss.${short}`, labelKey: 'missions.offer.ci_not_now', call: self('card_decide', { cardId: short, decision: 'dismiss' }) })
        break
      case 'pr_decision':
        if (typeof card.data.prDeliveryId === 'string' && facts.projectSlug) {
          offers.push({ id: `delivery.${card.data.prDeliveryId}`, labelKey: 'missions.offer.review_delivery', call: { tool: 'specrails_deliveries', args: { action: 'get', ref: formatRef('delivery', card.data.prDeliveryId, facts.projectSlug) } } })
          recommended ??= `delivery.${card.data.prDeliveryId}`
        }
        break
    }
  }
  if (facts.limit && !facts.busy) {
    if (facts.limitContinueAt) offers.push({ id: 'limit.cancel', labelKey: 'missions.offer.limit_cancel', call: self('limit_continue', { options: { at: null } }) })
    else if (facts.limit.resumeAt) offers.push({ id: 'limit.continue', labelKey: 'missions.offer.limit_continue', labelParams: { at: facts.limit.resumeAt }, call: self('limit_continue', { options: { at: facts.limit.resumeAt } }) })
  }
  if (facts.archived) {
    offers.push({ id: 'unarchive', labelKey: 'missions.offer.unarchive', call: self('unarchive') })
  } else {
    if (facts.busy) offers.push({ id: 'abort', labelKey: 'missions.offer.abort', call: self('abort') })
    offers.push({ id: 'send', labelKey: facts.busy ? 'missions.offer.queue' : 'missions.offer.send', call: self('send'), needs: ['message'] })
  }
  if (facts.flow) offers.push({ id: 'intent', labelKey: 'missions.offer.intent_get', call: { tool: TOOL, args: { action: 'intent_get', ref: facts.flow.ref } } })

  const needsYou = pending.length > 0 && !facts.busy
  const status: CanonicalStatus = facts.busy ? 'running' : facts.limit && !facts.limitContinueAt ? 'blocked' : needsYou ? 'needs_you' : facts.limitContinueAt ? 'waiting' : 'succeeded'
  let hold: HoldDraft | null = null
  if (!facts.busy && facts.limit) hold = facts.limitContinueAt
    ? { kind: 'provider_limit', reasonKey: 'missions.hold.limit_scheduled', params: { at: facts.limitContinueAt }, since: facts.limit.at, resumeAt: facts.limitContinueAt }
    : { kind: 'provider_limit', reasonKey: facts.limit.resumeAt ? 'core.hold.provider_limit_until' : 'core.hold.provider_limit', params: { at: facts.limit.resumeAt ?? '' }, since: facts.limit.at, resumeAt: facts.limit.resumeAt }
  else if (needsYou) hold = { kind: pending.some((card) => card.kind === 'pr_decision') ? 'pr_decision' : 'question', reasonKey: 'missions.hold.cards', params: { count: pending.length }, since: pending[0].at }
  return {
    status,
    ...(facts.busy ? { phase: facts.queued ? `turn · ${facts.queued} queued` : 'turn' } : {}),
    hold,
    offers,
    recommended,
    versionFacts: { u: facts.updatedAt, q: facts.queued, c: pending.map((card) => card.id), l: facts.limitContinueAt },
  }
}

/** The newest usage-limit row that no later assistant reply superseded. */
export function openLimit(messages: readonly MessageLike[]): MissionFacts['limit'] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'assistant') return null
    if (message.role !== 'system') continue
    let row: Row
    try { row = record(JSON.parse(message.content)) } catch { continue }
    if (row.kind === 'usage-limit') return { resumeAt: str(row.resumeAt), provider: str(row.provider), at: text(row.at) || message.created_at }
  }
  return null
}

// ── Intent state ────────────────────────────────────────────────────────────

const INTENT_STATUS: Record<string, CanonicalStatus> = {
  active: 'running', paused: 'paused', handed_off: 'running', delivered: 'delivered',
  discarded: 'discarded', closed: 'cancelled', 'needs-review': 'needs_you',
}

/** True when the Intent domain accepts the command and it changes something (no idempotent no-op). */
function legal(session: IntentSession, command: IntentCommand): boolean {
  try {
    const next = transition(session, command)
    return next.session !== session || next.effects.length > 0
  } catch (error) {
    if (error instanceof IntentTransitionError) return false
    throw error
  }
}

/** The legal Intent moves, by the domain's transition table. `missionRef` names the conversation. */
export function projectIntentState(session: IntentSession, refs: { intent: Ref; mission: Ref }, facts: { now: string }): DecisionStateInput {
  const offers: OfferDraft[] = []
  const self = (action: string, extra: Row = {}) => ({ tool: TOOL, args: { action, ref: refs.intent, ...extra } })
  const now = facts.now
  if (legal(session, { type: 'pause', now })) offers.push({ id: 'pause', labelKey: 'missions.offer.intent_pause', call: self('intent_pause') })
  if (legal(session, { type: 'resume', now })) offers.push({ id: 'resume', labelKey: 'missions.offer.intent_resume', call: self('intent_resume') })
  if (legal(session, { type: 'begin-hand-off', railIndex: Number.MAX_SAFE_INTEGER - 1, now })) offers.push({ id: 'hand_off', labelKey: 'missions.offer.intent_hand_off', call: self('intent_hand_off'), needs: ['options.rail'] })
  if (session.deliveryId && legal(session, { type: 'returned', deliveryId: session.deliveryId, briefing: '', now })) {
    offers.push({ id: 'return', labelKey: 'missions.offer.intent_return', call: self('intent_return') })
    offers.push({ id: 'relaunch', labelKey: 'missions.offer.intent_relaunch', call: self('intent_relaunch') })
  }
  if (legal(session, { type: 'discard', now })) offers.push({ id: 'discard', labelKey: 'missions.offer.intent_discard', call: self('intent_discard') })
  if (legal(session, { type: 'close', now })) offers.push({ id: 'close', labelKey: 'missions.offer.intent_close', call: self('intent_close') })
  if (session.state === 'active' || session.state === 'paused') offers.push({ id: 'send', labelKey: 'missions.offer.send', call: { tool: TOOL, args: { action: 'send', ref: refs.mission } }, needs: ['message'] })
  const status = INTENT_STATUS[session.state] ?? 'waiting'
  const hold: HoldDraft | null = session.state === 'paused'
    ? { kind: 'paused', since: session.updatedAt }
    : session.state === 'needs-review' ? { kind: 'question', reasonKey: 'missions.hold.intent_needs_review', since: session.updatedAt } : null
  return {
    status,
    ...(session.step ? { phase: session.step } : {}),
    hold,
    offers,
    recommended: session.state === 'needs-review' ? 'close' : null,
    versionFacts: { u: session.updatedAt, h: session.headSha, d: session.deliveryId, s: session.step },
  }
}
