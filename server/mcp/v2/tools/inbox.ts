import { z } from 'zod'
import { createHash } from 'crypto'
import { defineTool, type V2CallContext } from '../core/registry'
import { F, WRITE_FIELDS, optionsOf } from '../core/views'
import { asRecord } from '../core/text'
import { relay, result, V2ToolError, type V2Envelope } from '../core/envelope'
import { formatRef, type Ref } from '../core/refs'
import { pageOf } from '../core/cursor'
import { untrusted } from '../core/untrusted'
import { projectDelivery, projectFailure, projectRunHold, type Projected } from '../core/decision-sources'
import type { DecisionState, DecisionStateInput, OfferCall, OfferDraft } from '../core/decision-state'
import { statusFromHold, type CanonicalStatus } from '../core/status-map'
import { projectChainState } from '../projectors/chain-state'
import type { MilestoneChainSnapshot } from '../../../modules/builder/runtime/milestone-progress'
import { apiCall, McpApiError } from '../../tools/types'
import type { InboxItem, InboxKind, InboxSnapshot } from '../../../modules/inbox'
import { RUN_HOLD_KINDS, type RunHold, type RunHoldKind } from '../../../modules/loops/runtime/loop-run-hold'
import { readLimitPause } from '../../../modules/loops/runtime/loop-limit-pauses'
import { getPrDelivery, type RailPrDeliveryRow } from '../../../modules/delivery/runtime/rail-pr-store'
import { peekMergePreview } from '../../../modules/delivery/runtime/merge-preview'
import { readFailureAnalysis } from '../../../modules/recovery/adapters/sqlite'
import type { ResolutionOption } from '../../../modules/recovery'
import { applyInboxDismissals, dismissInboxItem, restoreInboxItem } from '../../../mobile/mobile-inbox'
import type { DbInstance } from '../../../db'

/**
 * WP2 `specrails_inbox`: everything that needs the person, app-wide, as
 * decision-ready items. The read-model is the app's own inbox (`GET /api/inbox`,
 * the same projection as the desktop inbox and the live board's Needs column);
 * every item carries a `DecisionState` whose offers come from the domain
 * projectors (run holds, failure remedies, delivery decision policy) and run
 * through `act`. Snooze / Done are server-side (mobile-inbox.ts dismissals),
 * shared with the paired phone.
 */

type Row = Record<string, unknown>
const record = asRecord

const INBOX = 'specrails_inbox'
const RUNS = 'specrails_runs'
const DELIVERIES = 'specrails_deliveries'
const INSIGHTS = 'specrails_insights'
const INTEGRATIONS = 'specrails_integrations'
const BLUEPRINT = 'specrails_blueprint'
const MISSIONS = 'specrails_missions'

const MAX_ANSWER = 20_000
const MAX_REASON = 4_000

/** What waits hardest on the person first: a run blocked on an answer, then a decision, then holds and failures. */
const URGENCY: Record<InboxKind, number> = { question: 0, review: 1, mission: 2, budget: 3, chain: 4, blocked: 5, failed: 6, jira: 7 }

export function compareUrgency(a: InboxItem, b: InboxItem): number {
  const rank = (URGENCY[a.kind] ?? 9) - (URGENCY[b.kind] ?? 9)
  if (rank) return rank
  const at = Date.parse(b.at) - Date.parse(a.at)
  if (Number.isFinite(at) && at) return at
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// ── Facts ───────────────────────────────────────────────────────────────────

/** What the inbox item alone does not say, read from the item's own project database (only for the items shown). */
export interface InboxFacts {
  delivery?: RailPrDeliveryRow | null
  switchTargets?: Array<{ provider: string; model?: string | null }>
  analysis?: { options?: readonly ResolutionOption[]; headline?: string; cause?: string } | null
}

export interface ItemScope {
  /** projectId → slug (ref namespace). */
  slugOf(projectId: string): string
  dbOf(projectId: string): DbInstance | null
}

export function itemScope(ctx: V2CallContext): ItemScope {
  const slugs = new Map(ctx.v2.projects().map((row) => [row.id, row.slug]))
  return {
    slugOf: (projectId) => slugs.get(projectId) ?? projectId,
    dbOf: (projectId) => { try { return ctx.registry.getContext(projectId)?.db ?? null } catch { return null } },
  }
}

const lastRunOf = (row: RailPrDeliveryRow | null | undefined): string | null => {
  try {
    const ids = JSON.parse(String(row?.run_ids ?? '[]')) as unknown
    const last = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').pop() : undefined
    return last ?? null
  } catch { return null }
}

/** Facts of the given items, one guarded read per item (a missing table costs that fact only). */
export function readInboxFacts(scope: ItemScope, items: readonly InboxItem[], options: { analysis?: boolean } = {}): Map<string, InboxFacts> {
  const facts = new Map<string, InboxFacts>()
  for (const item of items) {
    const db = scope.dbOf(item.projectId)
    if (!db) continue
    const own: InboxFacts = {}
    try {
      if (item.action === 'open-review') own.delivery = getPrDelivery(db, item.subjectId) ?? null
      const hold = holdOfItem(item)
      if (hold?.kind === 'provider_limit') {
        const limit = readLimitPause(db, item.subjectId)
        if (limit?.switchTargets?.length) own.switchTargets = limit.switchTargets.map((target) => ({ provider: target.provider, model: target.model }))
      }
      if (options.analysis && (item.kind === 'failed' || item.kind === 'blocked')) {
        const runId = item.action === 'open-review' ? lastRunOf(own.delivery) : item.subjectId
        const stored = runId ? readFailureAnalysis(db, runId) : null
        if (stored) own.analysis = { options: stored.analysis.options, headline: stored.analysis.headline, cause: stored.analysis.cause }
      }
    } catch { /* the item still shows with what it says itself */ }
    facts.set(item.id, own)
  }
  return facts
}

// ── Projection ──────────────────────────────────────────────────────────────

/**
 * The run hold an inbox item stands for, from the item itself (the inbox
 * source classified it with `readRunHold`): a question or approval, a usage
 * limit or budget pause, or a held run (`held:<kind>[:<step>]`).
 */
export function holdOfItem(item: InboxItem): RunHold | null {
  const since = item.at
  if (item.kind === 'question') return { kind: item.question?.kind === 'approval' ? 'approval' : 'question', step: null, since }
  if (item.action !== 'resume-run') return null
  if (item.kind === 'budget') {
    const limit = /^usage_limit:([^:]*):(.*)$/.exec(item.detail ?? '')
    return limit ? { kind: 'provider_limit', step: null, since, resumeAt: limit[2] || null } : { kind: 'budget', step: null, since }
  }
  const held = /^held:([A-Za-z_]+)(?::(.*))?$/.exec(item.detail ?? '')
  const word = held?.[1] ?? 'paused'
  if (word === 'pausedByYou') return { kind: 'paused', step: held?.[2] ?? null, since, byYou: true }
  const kind: RunHoldKind = (RUN_HOLD_KINDS as readonly string[]).includes(word) ? word as RunHoldKind : 'paused'
  return { kind, step: held?.[2] ?? null, since }
}

/** The entity an item is about (its run or delivery), as a global ref. */
export function subjectRefOf(item: InboxItem, slug: string): Ref | null {
  if (item.action === 'open-review') return formatRef('delivery', item.subjectId, slug)
  if (item.action === 'open-run' || item.action === 'resume-run') return formatRef('run', item.subjectId, slug)
  if (item.action === 'resume-chain') return formatRef('chain', item.subjectId, slug)
  if (item.action === 'open-mission' && item.conversationId) return formatRef('mission', item.conversationId)
  return null
}

/**
 * A chain item's state: the chain row's own hold and controls (`projectChainState`,
 * read from the item alone, without the reconcile plan), plus Resume (the plan's
 * recommended step, `blueprint(chain_resume)`) and the full chain (`chain_get`).
 */
function chainProjection(item: InboxItem, chainRef: Ref, slug: string): { status: CanonicalStatus; projected: Projected } {
  const chain = item.chain!
  const snapshot = {
    id: item.subjectId, milestoneN: chain.milestoneN, mode: 'sequential', status: chain.status, pauseReason: chain.pauseReason,
    autoAdvance: chain.autoAdvance, nextChunk: chain.nextChunk, totalChunks: chain.totalChunks, currentRailIndex: item.railIndex ?? null,
    headBranch: null, retryChunk: chain.retryChunk, launched: [], createdAt: item.at, updatedAt: item.at, plan: null,
  } satisfies MilestoneChainSnapshot
  const state = projectChainState({ chain: chainRef, run: (runId) => formatRef('run', runId, slug) }, snapshot)
  const resume: OfferDraft = { id: 'chain.resume', labelKey: chain.status === 'awaiting_approval' ? 'inbox.offer.chain_continue' : 'inbox.offer.chain_resume', call: { tool: BLUEPRINT, args: { action: 'chain_resume', ref: chainRef } } }
  const open: OfferDraft = { id: 'chain.open', labelKey: 'inbox.offer.chain_open', call: { tool: BLUEPRINT, args: { action: 'chain_get', ref: chainRef } } }
  return { status: state.status, projected: { offers: [resume, ...state.offers, open], recommended: 'chain.resume', ...(state.hold ? { hold: state.hold } : {}) } }
}

/** A mission card item: the card's own decisions (`missions(card_decide)`) and the mission itself. */
function missionProjection(item: InboxItem, missionRef: Ref): Projected {
  const card = item.card!
  const decide = (id: string, labelKey: string, decision: string, labelParams?: Record<string, string>): OfferDraft => ({
    id, labelKey, ...(labelParams ? { labelParams } : {}), call: { tool: MISSIONS, args: { action: 'card_decide', ref: missionRef, cardId: card.id, decision } },
  })
  const offers: OfferDraft[] = []
  let recommended: string | undefined
  if (card.kind === 'rail-launch') {
    offers.push(decide('launch', 'missions.offer.rail_launch', 'launch', { specs: (card.ticketIds ?? []).map((id) => `#${id}`).join(', ') }), decide('dismiss', 'missions.offer.dismiss_card', 'dismiss'))
    recommended = 'launch'
  } else if (card.kind === 'flow-offer') {
    offers.push(decide('intent', 'missions.offer.flow_intent', 'intent'), decide('implement', 'missions.offer.flow_implement', 'implement'), decide('dismiss', 'missions.offer.dismiss_card', 'dismiss'))
  } else {
    offers.push(decide('ci', 'missions.offer.ci_start', 'start'), decide('dismiss', 'missions.offer.ci_not_now', 'dismiss'))
  }
  offers.push({ id: 'open', labelKey: 'inbox.offer.mission_open', call: { tool: MISSIONS, args: { action: 'get', ref: missionRef, fields: ['cards'] } } })
  return { offers, ...(recommended ? { recommended } : {}) }
}

export const inboxRefOf = (item: InboxItem): Ref => formatRef('inbox', item.id)

function questionOffers(ref: Ref, item: InboxItem, runRef: Ref): Projected {
  const question = item.question
  const offers: OfferDraft[] = []
  if (question?.kind === 'approval') {
    offers.push({ id: 'approve', labelKey: 'inbox.offer.approve', call: { tool: INBOX, args: { action: 'approve', ref } } })
    if (question.canReject) offers.push({ id: 'reject', labelKey: 'inbox.offer.reject', call: { tool: INBOX, args: { action: 'reject', ref } }, needs: ['options.reason'] })
  } else {
    for (const option of question?.options ?? []) {
      offers.push({ id: `answer.${option.id}`, labelKey: 'inbox.offer.option', label: option.label, call: { tool: INBOX, args: { action: 'answer', ref, optionId: option.id } }, ...(question?.recommended === option.id ? { whyKey: 'inbox.why.recommended_option' } : {}) })
    }
    offers.push({ id: 'answer', labelKey: 'inbox.offer.answer', call: { tool: INBOX, args: { action: 'answer', ref } }, needs: ['answer'] })
  }
  offers.push({ id: 'open', labelKey: 'inbox.offer.open_run', call: { tool: RUNS, args: { action: 'get', ref: runRef } } })
  const recommended = question?.recommended && offers.some((offer) => offer.id === `answer.${question.recommended}`) ? `answer.${question.recommended}` : undefined
  return { hold: { kind: question?.kind === 'approval' ? 'approval' : 'question', since: item.at }, offers, ...(recommended ? { recommended } : {}) }
}

function merge(...parts: Projected[]): Projected {
  const offers: OfferDraft[] = []
  for (const part of parts) for (const offer of part.offers) if (!offers.some((other) => other.id === offer.id)) offers.push(offer)
  const recommended = parts.map((part) => part.recommended).find((id): id is string => !!id && offers.some((offer) => offer.id === id))
  const hold = parts.map((part) => part.hold).find(Boolean)
  return { offers, ...(hold ? { hold } : {}), ...(recommended ? { recommended } : {}) }
}

/** The decision-state input of one item: its status, hold and the domain's offers. */
export function inboxStateInput(item: InboxItem, slug: string, facts: InboxFacts = {}, translate: (key: string, params?: Record<string, string | number | null | undefined>) => string): DecisionStateInput {
  const ref = inboxRefOf(item)
  const subject = subjectRefOf(item, slug)
  let status: CanonicalStatus
  let projected: Projected
  const hold = holdOfItem(item)
  if (item.kind === 'question' && subject) {
    status = 'needs_you'
    projected = questionOffers(ref, item, subject)
  } else if (item.action === 'resume-chain' && item.chain && subject) {
    // A rail-caused pause folded the rail's item in; Resume continues or retries that rail.
    const chain = chainProjection(item, subject, slug)
    status = chain.status
    projected = chain.projected
  } else if (item.action === 'open-mission' && item.card && subject) {
    status = 'needs_you'
    projected = missionProjection(item, subject)
  } else if (hold && subject) {
    status = statusFromHold(hold)
    projected = projectRunHold(subject, hold, null, translate, { switchTargets: facts.switchTargets })
  } else if (item.action === 'open-review' && subject) {
    status = item.kind === 'review' ? 'ready_for_review' : 'failed'
    const open: Projected = { offers: [{ id: 'open', labelKey: 'inbox.offer.open_delivery', call: { tool: DELIVERIES, args: { action: 'get', ref: subject } } }] }
    const row = facts.delivery
    const delivery = row ? projectDelivery(subject, row, { mergePreviewClean: peekMergePreview(item.projectId, item.subjectId)?.status === 'clean' }, item.at) : null
    const lastRun = item.kind !== 'review' ? lastRunOf(row) : null
    const failure = lastRun && item.diagnosis ? projectFailure(formatRef('run', lastRun, slug), { remedies: item.diagnosis.remedies as never }, facts.analysis) : null
    projected = merge(...[delivery, failure, open].filter((part): part is Projected => !!part))
  } else if (item.action === 'open-run' && subject) {
    status = item.kind === 'blocked' ? 'blocked' : 'failed'
    projected = projectFailure(subject, { remedies: (item.diagnosis?.remedies ?? []) as never }, facts.analysis)
  } else if (item.action === 'raise-cap' && item.cap) {
    status = 'blocked'
    const scope = item.cap.scope === 'desktop' ? 'app' : 'project'
    const where = scope === 'project' ? { project: slug } : {}
    projected = {
      hold: {
        kind: 'budget', code: `${item.cap.scope}_${item.cap.period}`, reasonKey: 'inbox.hold.cap', since: item.at,
        params: { scope: translate(`insights.scope.${scope}`), period: ['day', 'week', 'month', 'run'].includes(item.cap.period) ? translate(`insights.cap.${item.cap.period}`) : item.cap.period, spent: item.cap.spentUsd.toFixed(2), budget: item.cap.budgetUsd.toFixed(2), resetsAt: item.cap.resetsAt },
      },
      offers: [
        { id: 'budget.view', labelKey: 'inbox.offer.budget_view', call: { tool: INSIGHTS, args: { action: 'budget_get', scope, ...where } } },
        { id: 'budget.raise', labelKey: 'inbox.offer.budget_raise', call: { tool: INSIGHTS, args: { action: 'budget_set', scope, ...where } }, needs: ['options.limits'] },
      ],
    }
  } else if (item.action === 'retry-jira') {
    status = 'failed'
    projected = {
      offers: [
        { id: 'jira.retry', labelKey: 'inbox.offer.jira_retry', call: { tool: INTEGRATIONS, args: { action: 'jira_retry', project: slug, id: item.subjectId } } },
        { id: 'jira.outbox', labelKey: 'inbox.offer.jira_outbox', call: { tool: INTEGRATIONS, args: { action: 'jira_outbox', project: slug } } },
      ],
    }
  } else {
    status = 'waiting'
    projected = { offers: [] }
  }
  return { status, hold: projected.hold ?? null, offers: projected.offers, recommended: projected.recommended ?? null, versionFacts: { id: item.id, v: item.version } }
}

export function inboxItemState(ctx: V2CallContext, item: InboxItem, slug: string, facts?: InboxFacts): DecisionState {
  return ctx.v2.state(inboxStateInput(item, slug, facts, ctx.v2.t))
}

// ── Presentation ────────────────────────────────────────────────────────────

const LEAN_SELF_EXPLAINED: ReadonlySet<string> = new Set(['question', 'approval', 'pr_decision'])

/** The lean list shape: what it is, where, why, and the offer ids `act` takes. */
export function leanItem(item: InboxItem, slug: string, state: DecisionState): Row {
  return {
    ref: inboxRefOf(item),
    kind: item.kind,
    status: state.status,
    project: slug,
    title: item.title,
    ...(item.detail && !/^(held|usage_limit):/.test(item.detail) ? { detail: item.detail } : {}),
    // The kind already says a question, an approval or a review waits; other holds say why.
    ...(state.hold && !LEAN_SELF_EXPLAINED.has(state.hold.kind) ? { why: state.hold.reason } : {}),
    // Second precision is enough to order and age an item.
    at: typeof item.at === 'string' ? item.at.replace(/\.\d{3}Z$/, 'Z') : item.at,
    ...(subjectRefOf(item, slug) ? { subject: subjectRefOf(item, slug) } : {}),
    // The person's menu (recommended first): the ids `act` takes, each with its label and effect. Read offers
    // (open the run or delivery) stay in the full state: the subject ref already names them. Confirmation
    // facts live there too, and a confirmable act answers with its own preview. An offer that needs arguments says which.
    choices: state.offers.filter((offer) => offer.tier !== 'read').map((offer) => ({
      id: offer.id, label: offer.label, ...(offer.effect ? { effect: offer.effect } : {}),
      ...(offer.id === state.recommended ? { recommended: true } : {}), ...(offer.needs ? { needs: offer.needs } : {}),
    })),
    ...(item.attempt ? { attempt: item.attempt } : {}),
  }
}

/** The detail shape: lean plus the full state and the item's own card. */
export function detailItem(item: InboxItem, slug: string, state: DecisionState): Row {
  const { choices: _choices, why: _why, ...lean } = leanItem(item, slug, state)
  return {
    ...lean,
    state,
    ...(item.question ? { question: { kind: item.question.kind, text: item.question.text, ...(item.question.why ? { why: item.question.why } : {}), ...(item.question.detail ? { detail: item.question.detail } : {}), options: item.question.options, ...(item.question.recommended ? { recommended: item.question.recommended } : {}), mayEndRun: item.question.mayEndRun, endsRun: item.question.endsRun } } : {}),
    ...(item.diagnosis ? { diagnosis: { kind: item.diagnosis.kind, confidence: item.diagnosis.confidence, detail: item.diagnosis.detail, remedies: item.diagnosis.remedies } } : {}),
    ...(item.cap ? { cap: item.cap } : {}),
    ...(item.conversationId ? { mission: formatRef('mission', item.conversationId) } : {}),
    ...(item.chain ? { chain: item.chain } : {}),
    ...(item.card ? { card: item.card } : {}),
  }
}

/** Fields that hold run, spec or model text (never instructions). */
export const LEAN_UNTRUSTED = ['title', 'detail', 'why', 'choices/*/label'] as const
export const ITEM_UNTRUSTED = ['title', 'detail', 'why', 'choices/*/label', 'question', 'diagnosis/detail', 'state/offers/*/label', 'state/offers/*/why'] as const

// ── Reads ───────────────────────────────────────────────────────────────────

export async function readInbox(ctx: V2CallContext): Promise<InboxSnapshot> {
  const snapshot = record(await apiCall(ctx, 'GET', '/inbox'))
  return { items: (Array.isArray(snapshot.items) ? snapshot.items : []) as InboxItem[], projects: (Array.isArray(snapshot.projects) ? snapshot.projects : []) as InboxSnapshot['projects'], generatedAt: String(snapshot.generatedAt ?? new Date().toISOString()) }
}

const kindsOf = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter((kind): kind is string => typeof kind === 'string')

/** The item a call addresses: an inbox ref (or v1 `itemId`), or the run/delivery it is about. */
async function resolveItem(ctx: V2CallContext, args: Row): Promise<{ item: InboxItem; slug: string }> {
  const raw = args.ref ?? args.itemId ?? args.runId
  const target = ctx.v2.target({ ...args, ref: raw }, 'inbox', ['inbox', 'run', 'delivery', 'chain'])
  const items = (await readInbox(ctx)).items
  const item = target.kind === 'inbox'
    ? items.find((candidate) => candidate.id === target.id) ?? (args.runId ? items.find((candidate) => candidate.subjectId === target.id && candidate.kind === 'question') : undefined)
    : items.find((candidate) => candidate.subjectId === target.id && candidate.projectId === target.project?.id)
  if (!item) {
    throw new V2ToolError('not_found', ctx.v2.t('inbox.error.gone'), {
      choices: items.slice().sort(compareUrgency).slice(0, 10).map((candidate) => ({ ref: inboxRefOf(candidate), title: candidate.title })),
      next: [{ tool: INBOX, args: { action: 'list' }, why: 'What still waits for the person.' }],
    })
  }
  return { item, slug: itemScope(ctx).slugOf(item.projectId) }
}

// ── Answers (the run question card's own routes) ────────────────────────────

type RunAnswer = { type: 'option'; optionId: string; label: string } | { type: 'text'; text: string } | { type: 'approve' } | { type: 'reject'; reason: string }

/**
 * Deliver an answer exactly like the app's question card (`submitRunAnswer`):
 * a run paused in this process takes it on its turn door (`POST jobs/:id/messages`);
 * a run a restart retained is resumed with the same controls (`POST loop-runs/:id/resume`).
 * A question without a card (an older Core) goes through the runtime's pending question.
 */
async function deliverAnswer(ctx: V2CallContext, item: InboxItem, answer: RunAnswer): Promise<'live' | 'retained' | 'runtime'> {
  const base = `/projects/${encodeURIComponent(item.projectId)}`
  const runId = encodeURIComponent(item.subjectId)
  const question = item.question
  if (!question) {
    const status = record(await apiCall(ctx, 'GET', `${base}/agent-runtime/runs/${runId}`))
    const run = record((Array.isArray(status.runs) ? status.runs : [])[0])
    const pending = record(run.pendingQuestion)
    if (typeof pending.question !== 'string' || pending.answeredAt !== undefined) throw new V2ToolError('conflict', ctx.v2.t('inbox.error.gone'))
    const text = answer.type === 'option' ? answer.label : answer.type === 'text' ? answer.text : answer.type === 'reject' ? answer.reason : ''
    if (run.engineVersion === 2) await apiCall(ctx, 'POST', `${base}/loop-runs/${runId}/resume`, { answer: text, ...(typeof pending.stepId === 'string' ? { interruptId: pending.stepId } : {}) })
    else await apiCall(ctx, 'POST', `${base}/agent-runtime/runs/${runId}/resume`, answer.type === 'approve' ? {} : { answer: text })
    return 'runtime'
  }
  const id = question.interruptId
  const target = id ? { interruptId: id } : {}
  const message = answer.type === 'option' ? { text: answer.label, ...target, optionId: answer.optionId }
    : answer.type === 'text' ? { text: answer.text, ...target }
      : answer.type === 'approve' ? { text: '', ...target, approve: true }
        : { text: answer.reason, ...target, reject: true }
  try {
    await apiCall(ctx, 'POST', `${base}/jobs/${runId}/messages`, message)
    return 'live'
  } catch (err) {
    // Not paused in this process (a restart retained it): resume the retained run instead.
    if (!id || !(err instanceof McpApiError) || (err.status !== 409 && err.status !== 403)) throw err
  }
  const controls = answer.type === 'option' ? { answer: answer.label, interruptId: id, optionId: answer.optionId }
    : answer.type === 'text' ? { answer: answer.text, interruptId: id }
      : answer.type === 'approve' ? { approve: [id], interruptId: id }
        : { reject: id, reason: answer.reason }
  await apiCall(ctx, 'POST', `${base}/loop-runs/${runId}/resume`, controls)
  return 'retained'
}

function answered(ctx: V2CallContext, item: InboxItem, slug: string, key: string, via: string) {
  const run = formatRef('run', item.subjectId, slug)
  return result({ item: inboxRefOf(item), run, delivered: true, via }, { summary: ctx.v2.t(key), refs: { item: inboxRefOf(item), run, project: formatRef('project', slug) } })
}

// ── Snooze ──────────────────────────────────────────────────────────────────

/** `until`: an ISO instant, or `1h` / `3h` / `30m` / `2d`, or `tomorrow` (09:00 local next day). */
export function snoozeUntil(value: unknown, now: Date = new Date()): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const text = value.trim().toLowerCase()
  const relative = /^(\d{1,3})\s*([mhd])$/.exec(text)
  if (relative) return new Date(now.getTime() + Number(relative[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as 'm' | 'h' | 'd']).toISOString()
  if (text === 'hour') return new Date(now.getTime() + 3_600_000).toISOString()
  if (text === 'tomorrow') return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9).toISOString()
  const at = Date.parse(value)
  return Number.isFinite(at) && at > now.getTime() ? new Date(at).toISOString() : null
}

// ── act: run one offer through the catalog ──────────────────────────────────

/** Arguments of `act` that complete an offer's call (what the person supplied). */
const PASSTHROUGH = ['answer', 'optionId', 'confirm', 'dryRun', 'lang', 'view'] as const

/**
 * Re-dispatch an offer's call through the registered v2 callbacks
 * (`ctx.v2.dispatch`): the target tool's own tier, required fields,
 * confirmation protocol and legacy delegate apply (a token it issues is bound
 * to the target call, so resending `act` with `confirm` verifies it).
 */
export function dispatchOffer(ctx: V2CallContext, call: OfferCall): Promise<V2Envelope> {
  return ctx.v2.dispatch(call)
}

// ── Tool ────────────────────────────────────────────────────────────────────

const filterKey = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('base64url').slice(0, 10)

export const inboxTool = defineTool({
  name: 'specrails_inbox',
  title: 'Inbox',
  description: 'What needs the person across projects, most urgent first. act runs any offer by offerId.',
  owner: 'WP2',
  alwaysLoad: true,
  fields: {
    ...WRITE_FIELDS,
    offerId: z.string().describe('From state.offers'),
    answer: z.string(),
    optionId: z.string(),
    until: z.string().describe('snooze: ISO time'),
    filter: F.filter.describe('list: project, kind[]'),
  },
  actions: {
    list: {
      tier: 'read',
      doc: 'filter: { project, kind: question|review|mission|chain|failed|blocked|budget|jira (or a list) }; options.includeDismissed lists snoozed/done items too. Default limit 8 (detail 25). Lean items list write offers; open or detail has the full state.',
      handler: async (ctx, args) => {
        const filter = record(args.filter)
        const options = optionsOf(args)
        const projectArg = filter.project ?? args.project ?? args.projectId
        const project = typeof projectArg === 'string' && projectArg.trim() ? ctx.v2.project({ project: projectArg }) : null
        const kinds = kindsOf(filter.kind ?? args.kind)
        const snapshot = await readInbox(ctx)
        const scoped = snapshot.items.filter((item) => (!project || item.projectId === project.id) && (!kinds.length || kinds.includes(item.kind)))
        const { visible, hidden } = applyInboxDismissals(ctx.desktopDb, scoped, { prune: !project && !kinds.length })
        const all = (options.includeDismissed === true ? [...visible, ...hidden] : visible).sort(compareUrgency)
        const page = pageOf(all, { cursor: args.cursor, limit: args.limit, key: filterKey({ p: project?.id ?? null, k: kinds, d: options.includeDismissed === true }), defaultLimit: ctx.v2.view === 'detail' ? 25 : 8 })
        const scope = itemScope(ctx)
        const facts = readInboxFacts(scope, page.items)
        const detail = ctx.v2.view === 'detail'
        const items = page.items.map((item) => {
          const slug = scope.slugOf(item.projectId)
          const state = inboxItemState(ctx, item, slug, facts.get(item.id))
          const shaped = detail ? detailItem(item, slug, state) : leanItem(item, slug, state)
          const dismissed = (item as InboxItem & { dismissed?: unknown }).dismissed
          return dismissed ? { ...shaped, dismissed } : shaped
        })
        const byKind: Record<string, number> = {}
        for (const item of all) byKind[item.kind] = (byKind[item.kind] ?? 0) + 1
        const first = all[0]
        const t = ctx.v2.t
        const summary = !all.length
          ? hidden.length ? t('inbox.summary.empty_hidden', { hidden: hidden.length }) : t('inbox.summary.empty')
          : all.length === 1 ? t('inbox.summary.list_one', { title: first.title, project: first.projectName })
            : t('inbox.summary.list', { count: all.length, kinds: Object.entries(byKind).map(([kind, count]) => t(`inbox.kinds.${kind}`, { count })).join(', '), title: first.title, project: first.projectName })
        return result({ items, total: all.length, byKind, ...(hidden.length && options.includeDismissed !== true ? { dismissed: hidden.length } : {}) }, {
          summary, page: page.page, pageBase: page.base,
          untrusted: untrusted(...(detail ? ITEM_UNTRUSTED : LEAN_UNTRUSTED).map((field) => `/data/items/*/${field}`)),
        })
      },
    },
    open: {
      tier: 'read',
      required: ['ref'],
      doc: 'ref: inbox:<id>, or the run/delivery/chain ref it is about. Full state, question card, diagnosis and AI analysis.',
      handler: async (ctx, args) => {
        const { item, slug } = await resolveItem(ctx, args)
        const scope = itemScope(ctx)
        const facts = readInboxFacts(scope, [item], { analysis: true }).get(item.id) ?? {}
        const state = inboxItemState(ctx, item, slug, facts)
        const shaped = detailItem(item, slug, state)
        const { state: _state, ...data } = shaped
        const delivery = facts.delivery
        const extra = {
          ...(delivery ? { delivery: { decision: delivery.decision, statusCode: delivery.status_code, statusDetail: delivery.status_detail, branch: delivery.branch, prUrl: delivery.pr_url, specs: (() => { try { return (JSON.parse(delivery.ticket_ids) as unknown[]).filter((id): id is number => typeof id === 'number').map((id) => formatRef('spec', id, slug)) } catch { return [] } })() } } : {}),
          ...(facts.analysis ? { analysis: { headline: facts.analysis.headline, cause: facts.analysis.cause } } : {}),
        }
        const subject = subjectRefOf(item, slug)
        const reason = state.hold?.reason ?? item.detail ?? ''
        return result({ ...data, ...extra }, {
          summary: ctx.v2.t('inbox.summary.open', { kind: ctx.v2.t(`inbox.kind.${item.kind}`), project: item.projectName, title: item.title, reason }).trim(),
          state,
          refs: { item: inboxRefOf(item), project: formatRef('project', slug), ...(subject ? { subject } : {}), ...(item.conversationId ? { mission: formatRef('mission', item.conversationId) } : {}) },
          untrusted: untrusted('/data/title', '/data/detail', '/data/question', '/data/diagnosis/detail', '/data/delivery/statusDetail', '/data/analysis', '/state/offers/*/label', '/state/offers/*/why', '/summary'),
        })
      },
    },
    answer: {
      tier: 'write',
      required: ['ref'],
      oneOf: ['answer', 'optionId'],
      doc: 'optionId: one of the question\'s options (its label is sent); answer: free text.',
      handler: async (ctx, args) => {
        const { item, slug } = await resolveItem(ctx, args)
        if (item.kind !== 'question') throw new V2ToolError('invalid_input', ctx.v2.t('inbox.error.not_question'), { state: inboxItemState(ctx, item, slug) })
        if (item.question?.kind === 'approval') throw new V2ToolError('invalid_input', ctx.v2.t('inbox.error.use_approve'))
        let answer: RunAnswer
        if (typeof args.optionId === 'string' && args.optionId) {
          const option = item.question?.options.find((candidate) => candidate.id === args.optionId)
          if (!option) throw new V2ToolError('invalid_input', ctx.v2.t('inbox.error.bad_option', { optionId: args.optionId, options: (item.question?.options ?? []).map((candidate) => candidate.id).join(', ') || '—' }))
          answer = { type: 'option', optionId: option.id, label: option.label }
        } else {
          const text = String(args.answer ?? '').trim()
          if (!text || text.length > MAX_ANSWER) throw new V2ToolError('invalid_input', `answer must be 1–${MAX_ANSWER} characters.`)
          answer = { type: 'text', text }
        }
        return answered(ctx, item, slug, 'inbox.summary.answered', await deliverAnswer(ctx, item, answer))
      },
    },
    approve: {
      tier: 'write',
      required: ['ref'],
      handler: async (ctx, args) => {
        const { item, slug } = await resolveItem(ctx, args)
        if (item.kind !== 'question' || item.question?.kind !== 'approval') throw new V2ToolError('invalid_input', ctx.v2.t('inbox.error.not_approval'))
        return answered(ctx, item, slug, 'inbox.summary.approved', await deliverAnswer(ctx, item, { type: 'approve' }))
      },
    },
    reject: {
      tier: 'write',
      required: ['ref'],
      doc: 'options.reason (or answer): why, passed to the run.',
      handler: async (ctx, args) => {
        const { item, slug } = await resolveItem(ctx, args)
        if (item.kind !== 'question' || item.question?.kind !== 'approval') throw new V2ToolError('invalid_input', ctx.v2.t('inbox.error.not_approval'))
        if (!item.question.canReject) throw new V2ToolError('invalid_input', ctx.v2.t('inbox.error.cannot_reject'))
        const reason = String(optionsOf(args).reason ?? args.answer ?? '').trim().slice(0, MAX_REASON)
        return answered(ctx, item, slug, 'inbox.summary.rejected', await deliverAnswer(ctx, item, { type: 'reject', reason }))
      },
    },
    snooze: {
      tier: 'write',
      required: ['ref', 'until'],
      doc: 'until: ISO time, 1h/3h/1d or tomorrow (max 30 days). Shared with the paired phone.',
      handler: async (ctx, args) => {
        const until = snoozeUntil(args.until)
        if (!until) throw new V2ToolError('invalid_input', ctx.v2.t('inbox.error.bad_until'))
        const { item } = await resolveItem(ctx, args)
        const dismissed = dismissInboxItem(ctx.desktopDb, { itemId: item.id, version: item.version, until })
        return result({ item: inboxRefOf(item), dismissed }, { summary: ctx.v2.t('inbox.summary.snoozed', { until: dismissed.until }), refs: { item: inboxRefOf(item) } })
      },
    },
    done: {
      tier: 'write',
      required: ['ref'],
      doc: 'Hides the item until its state changes; options.undo brings a snoozed or done item back.',
      handler: async (ctx, args) => {
        if (optionsOf(args).undo === true) {
          const target = ctx.v2.target(args, 'inbox', ['inbox'])
          const restored = restoreInboxItem(ctx.desktopDb, target.id)
          return result({ item: target.ref, restored }, { summary: ctx.v2.t(restored ? 'inbox.summary.restored' : 'inbox.summary.not_dismissed'), refs: { item: target.ref } })
        }
        const { item } = await resolveItem(ctx, args)
        const dismissed = dismissInboxItem(ctx.desktopDb, { itemId: item.id, version: item.version })
        return result({ item: inboxRefOf(item), dismissed }, { summary: ctx.v2.t('inbox.summary.done'), refs: { item: inboxRefOf(item) } })
      },
    },
    // The offer's own tool, tier and confirmation class apply (re-dispatched through the catalog),
    // so `act` itself is read-tier: a read offer stays readable with writes off.
    act: {
      tier: 'read',
      required: ['ref', 'offerId'],
      doc: 'Runs state.offers[offerId].call; add what offer.needs names (answer, optionId, options.*). options.version: refuse if the item changed.',
      handler: async (ctx, args) => {
        const { item, slug } = await resolveItem(ctx, args)
        const facts = readInboxFacts(itemScope(ctx), [item], { analysis: true }).get(item.id)
        const state = inboxItemState(ctx, item, slug, facts)
        const options = optionsOf(args)
        if (typeof options.version === 'string' && options.version !== state.version) throw new V2ToolError('stale', ctx.v2.t('inbox.error.stale'), { state })
        const offer = state.offers.find((candidate) => candidate.id === args.offerId)
        if (!offer) throw new V2ToolError('invalid_input', ctx.v2.t('inbox.error.unknown_offer', { offerId: String(args.offerId), offers: state.offers.map((candidate) => candidate.id).join(', ') || '—' }), { state })
        const callArgs: Row = { ...offer.call.args }
        for (const field of PASSTHROUGH) if (args[field] !== undefined) callArgs[field] = args[field]
        const { version: _version, ...rest } = options
        if (Object.keys(rest).length) callArgs.options = { ...record(callArgs.options), ...rest }
        return relay(await dispatchOffer(ctx, { tool: offer.call.tool, args: callArgs }))
      },
    },
  },
})
