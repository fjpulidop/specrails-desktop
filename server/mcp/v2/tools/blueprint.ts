import { z } from 'zod'
import type { DbInstance } from '../../../db'
import type { ProjectRow } from '../../../desktop-db'
import type { ChainOffer, ChainResumeFrom } from '../../../modules/builder/runtime/milestone-chain-reconcile'
import type { MilestoneChainSnapshot, MilestoneProgress, MilestoneRail } from '../../../modules/builder/runtime/milestone-progress'
import { parseBlueprintDraftBlocks } from '../../../modules/builder/runtime/blueprint-draft-parser'
import { analyzeBuilderSpecBatch, type BuilderSpecBatchQualityReport } from '../../../modules/builder/runtime/blueprint-spec-quality'
import type { Blueprint } from '../../../modules/builder/runtime/blueprint-types'
import { shortHash } from '../core/canonical'
import { pageOf } from '../core/cursor'
import type { DecisionState, OfferDraft } from '../core/decision-state'
import { V2ToolError, result } from '../core/envelope'
import { formatRef, parseRef, type Ref } from '../core/refs'
import { defineTool, type PreviewInput, type V2CallContext } from '../core/registry'
import { clipUntrusted, untrusted } from '../core/untrusted'
import { asRecord, clipDeep, type Row } from '../core/text'
import { api, maybe } from '../core/loopback'
import { listen, waitMsOf as waitMs } from '../core/bus'
import { launchForecast, scaledCost, turnCostFromLedger } from '../core/forecast'
import { rememberCommit, trackCommits, trackedCommit, type CommitTrack } from '../core/commit-tracker'
import { F, WRITE_FIELDS, optionsOf, resolveFields } from '../core/views'
import { isActiveChain, projectChainState, projectMilestoneState, projectRailState, chainPhase } from '../projectors/chain-state'

/**
 * WP6 · specrails_blueprint: everything the Project Builder and the Blueprint
 * popover do, from an MCP client.
 *
 * - Day-0 Builder (app-level `/api/blueprint/*`): sessions, start, send
 *   (message / surprise / approve), repair, abort, get, commit (202 + a
 *   `blueprint:<commitId>` ref that `specrails_wait` follows).
 * - Milestones (project `/blueprint*`): progress per milestone (state, counts,
 *   rails with their holds, specs), generate / regenerate / refine a
 *   milestone's specs (a read-only `kind: milestone` chat, as the popover's
 *   generation shell) and commit them to the board.
 * - Chains: launch (engine, auto-advance), state with the reconcile plan's
 *   offers, resume (`from`), auto-advance, cancel; the next rail's engine.
 * - Settings: the usual configuration and "only for M<n>" per milestone.
 *
 * Builder turns and milestone generation stream over WS; the handler can wait
 * for the reply (`options.waitMs`, ≤ 45 s, default 25 s) by listening to the
 * same in-process bus the WS broadcast feeds. Legality stays in the builder
 * module: offers come from the reconcile plan and the run holds
 * (projectors/chain-state.ts).
 */

const IMPLEMENT_LOOP = 'factory:implement'
/** blueprint-generation.ts `MAX_GENERATION_TURNS`: outline + detail turns + audit + repair. */
const MAX_GENERATION_TURNS = 8
const WAIT_DEFAULT_MS = 25_000
const WAIT_MAX_MS = 45_000
const MESSAGE_CHARS = 1_500
const DETAIL_MESSAGES = 12

const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : []
const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const rec = asRecord
const clip = clipUntrusted

const projectBase = (project: ProjectRow) => `/projects/${encodeURIComponent(project.id)}`
const milestoneId = (n: number) => `m${n}`
const engineWord = (ctx: V2CallContext, engine: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null | undefined) =>
  engine && str(engine.provider) ? [engine.provider, engine.model, engine.reasoningEffort].filter((part) => typeof part === 'string' && part).join(' · ') : ctx.v2.t('blueprint.engine.default')

// ── Waiting for a streamed turn ─────────────────────────────────────────────

const waitMsOf = (args: Record<string, unknown>, fallback = WAIT_DEFAULT_MS): number => waitMs(optionsOf(args), fallback, WAIT_MAX_MS)

const builderTurn = (conversationId: string) => (msg: Row): 'done' | 'error' | null =>
  msg.conversationId !== conversationId ? null
    : msg.type === 'blueprint.done' && msg.continuing !== true ? 'done'
      : msg.type === 'blueprint.error' ? 'error' : null

const chatTurn = (conversationId: string) => (msg: Row): 'done' | 'error' | null =>
  msg.conversationId !== conversationId ? null : msg.type === 'chat_done' ? 'done' : msg.type === 'chat_error' ? 'error' : null

// ── Cost forecasts from the app's own ledgers ───────────────────────────────

/** Day-0 Builder turns (agent_invocations, project_id NULL, Builder conversations). */
const builderTurnCost = (db: DbInstance | undefined) => turnCostFromLedger(db, `SELECT total_cost_usd AS cost FROM agent_invocations
  WHERE project_id IS NULL AND conversation_id IN (SELECT id FROM blueprint_conversations)
  ORDER BY started_at DESC LIMIT 20`)

/** Milestone generation turns (project ai_invocations of `kind: milestone` conversations). */
const generationTurnCost = (db: DbInstance | null) => turnCostFromLedger(db, `SELECT total_cost_usd AS cost FROM ai_invocations
  WHERE COALESCE(conversation_id, surface_ref_id) IN (SELECT id FROM chat_conversations WHERE kind = 'milestone')
  ORDER BY started_at DESC LIMIT 20`)

/** One implement run's forecast band (`launch-forecast`), times `runs`. */
async function launchCost(ctx: V2CallContext, project: ProjectRow, provider: string | null, runs: number): Promise<[number, number] | null> {
  if (runs <= 0) return [0, 0]
  return scaledCost(await launchForecast(ctx, project, { loopId: IMPLEMENT_LOOP, provider }), runs)
}

// ── Day-0 Builder ───────────────────────────────────────────────────────────

const conversationRef = (id: string) => formatRef('blueprint', id)

function projectRefOf(ctx: V2CallContext, projectId: string | null): Ref | null {
  if (!projectId) return null
  const row = ctx.v2.projects().find((p) => p.id === projectId)
  return row ? formatRef('project', row.slug) : null
}

interface BuilderView {
  data: Row
  state: DecisionState
  refs: Record<string, Ref>
  title: string
  writing: boolean
}

/** A Builder conversation from its rehydration payload (GET /blueprint/conversations/:id). */
function builderView(ctx: V2CallContext, body: Row, writingHint: boolean | null, sections: readonly string[]): BuilderView {
  const conversation = rec(body.conversation)
  const id = String(conversation.id)
  const ref = conversationRef(id)
  const messages = arr(body.messages).map(rec)
  const lastMessage = messages[messages.length - 1]
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const writing = writingHint ?? (lastMessage?.role === 'user')
  const blueprint = rec(body.blueprint)
  const snapshot = rec(body.snapshot)
  const committed = str(conversation.committed_project_id)
  const projectRef = projectRefOf(ctx, committed)
  const milestones = arr(blueprint.milestones).map(rec)
  const specs = arr(blueprint.m1Specs).map(rec)
  const quality = arr(snapshot.qualityIssues)
  const status = str(snapshot.status) ?? 'none'
  const claimsComplete = snapshot.claimsComplete === true
  const written = specs.filter((spec) => typeof spec.description === 'string' && spec.description.trim()).length
  const ready = status === 'accepted' && claimsComplete && quality.length === 0 && specs.length > 0
  const title = clip(conversation.title, 80) ?? clip(rec(blueprint.product).name, 80) ?? id

  const data: Row = {
    ref, title, provider: conversation.provider, model: conversation.model ?? null,
    writing, ...(projectRef ? { project: projectRef } : {}),
    reply: clip(lastAssistant?.content, MESSAGE_CHARS),
    snapshot: {
      status, ...(str(snapshot.reason) ? { reason: snapshot.reason, detail: clip(snapshot.detail, 300) } : {}),
      product: clip(rec(blueprint.product).name, 80), pitch: clip(rec(blueprint.product).pitch, 200), platform: clip(blueprint.platform, 80),
      stack: clipDeep(blueprint.stack, 80),
      milestones: milestones.map((m) => clip(m.title, 80)),
      m1: { specs: specs.length, written, complete: claimsComplete, issues: quality.length, titles: specs.map((s) => clip(s.title, 80)) },
    },
  }
  if (sections.includes('conversation')) {
    data.transcript = messages.slice(-DETAIL_MESSAGES).map((m) => ({ role: m.role, text: clip(m.content, MESSAGE_CHARS), ...(str(m.intent) ? { intent: m.intent } : {}) }))
  }
  if (sections.includes('blueprint')) data.blueprint = clipDeep(body.rawBlueprint ?? body.blueprint, 900, 12)
  if (quality.length && sections.length) data.issues = quality.slice(0, 10).map((issue) => clipDeep(issue, 200))

  const offers: OfferDraft[] = []
  if (committed && projectRef) {
    offers.push({ id: 'launch_m1', labelKey: 'blueprint.offer.launch_m1', call: { tool: 'specrails_blueprint', args: { action: 'chain_launch', project: projectRef, milestone: 1 } } })
  } else if (!writing) {
    if (ready) offers.push({ id: 'commit', labelKey: 'blueprint.offer.create_project', call: { tool: 'specrails_blueprint', args: { action: 'commit', ref } } })
    if (status === 'rejected' || (claimsComplete && quality.length) || (specs.length && written < specs.length && !claimsComplete && written > 0)) {
      offers.push({ id: 'repair', labelKey: written < specs.length && status !== 'rejected' ? 'blueprint.offer.continue' : 'blueprint.offer.repair', call: { tool: 'specrails_blueprint', args: { action: 'repair', ref } } })
    }
    if (status === 'accepted' && milestones.length && !specs.length) offers.push({ id: 'approve', labelKey: 'blueprint.offer.approve', call: { tool: 'specrails_blueprint', args: { action: 'send', ref, intent: 'approve' } } })
    offers.push({ id: 'reply', labelKey: 'blueprint.offer.reply', call: { tool: 'specrails_blueprint', args: { action: 'send', ref } }, needs: ['message'] })
  }
  const state = ctx.v2.state({
    status: committed ? 'succeeded' : writing ? 'running' : ready || status === 'rejected' ? 'needs_you' : 'waiting',
    offers,
    recommended: committed ? 'launch_m1' : ready ? 'commit' : offers.some((o) => o.id === 'repair') ? 'repair' : offers.some((o) => o.id === 'approve') ? 'approve' : null,
    versionFacts: { u: conversation.updated_at, s: body.snapshotUpdatedAt ?? null, n: messages.length, c: committed },
  })
  return { data, state, refs: { blueprint: ref, ...(projectRef ? { project: projectRef } : {}) }, title, writing }
}

const BUILDER_UNTRUSTED = untrusted('/data/title', '/data/reply', '/data/snapshot/*', '/data/snapshot/stack/*', '/data/snapshot/milestones/*', '/data/snapshot/m1/titles/*', '/data/transcript/*/text', '/data/blueprint', '/data/issues/*')

async function readConversation(ctx: V2CallContext, id: string): Promise<Row> {
  return api(ctx, 'GET', `/blueprint/conversations/${encodeURIComponent(id)}`)
}

/** Send one Builder turn and wait (bounded) for its reply. */
async function builderTurnCall(ctx: V2CallContext, args: Record<string, unknown>, id: string, trigger: () => Promise<unknown>): Promise<unknown> {
  const wait = listen(ctx, builderTurn(id), waitMsOf(args))
  try { await trigger() } catch (err) { wait.stop(); throw err }
  const outcome = await wait.promise
  const body = await readConversation(ctx, id)
  const view = builderView(ctx, body, outcome.kind === 'timeout' ? true : false, resolveFields(args, ['conversation', 'blueprint']))
  const summary = outcome.kind === 'error'
    ? ctx.v2.t('blueprint.summary.failed_turn', { error: clip(outcome.msg?.error, 200) ?? '' })
    : outcome.kind === 'timeout' ? ctx.v2.t('blueprint.summary.writing') : ctx.v2.t('blueprint.summary.replied')
  return result(view.data, { summary, refs: view.refs, state: view.state, untrusted: BUILDER_UNTRUSTED })
}

const TURN_TEXT = (ctx: V2CallContext, args: Record<string, unknown>): string => {
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (message) return message
  if (args.intent === 'surprise') return ctx.v2.t('blueprint.prompt.surprise')
  if (args.intent === 'approve') return ctx.v2.t('blueprint.prompt.approve')
  return ''
}

function sendBody(ctx: V2CallContext, args: Record<string, unknown>): Row {
  const options = optionsOf(args)
  const text = TURN_TEXT(ctx, args)
  if (!text) throw new V2ToolError('invalid_input', 'message is required (or intent: surprise|approve).')
  return {
    text,
    ...(args.intent === 'surprise' || args.intent === 'approve' ? { intent: args.intent } : {}),
    ...(str(options.model) ? { model: options.model } : {}),
    ...(str(options.effort) ? { reasoning_effort: options.effort } : {}),
  }
}

async function turnPreview(ctx: V2CallContext, args: Record<string, unknown>, provider: string, version: string): Promise<PreviewInput> {
  const band = builderTurnCost(ctx.desktopDb)
  const approve = args.intent === 'approve'
  const forecast: [number, number] | null = band ? [band[0], Math.round(band[1] * (approve ? MAX_GENERATION_TURNS : 1) * 100) / 100] : null
  const effect = ctx.v2.t(approve ? 'blueprint.preview.approve' : ctx.v2.action === 'start' ? 'blueprint.preview.start' : ctx.v2.action === 'repair' ? 'blueprint.preview.repair' : 'blueprint.preview.send', { provider })
  return { effect, version, cost: { forecastUsd: forecast, runs: 1 } }
}

function commitTrackView(ctx: V2CallContext, commitId: string, track: CommitTrack) {
  const ref = formatRef('blueprint', commitId)
  const projectRef = projectRefOf(ctx, track.projectId)
  const offers: OfferDraft[] = []
  if (track.status === 'done' && projectRef) offers.push({ id: 'launch_m1', labelKey: 'blueprint.offer.launch_m1', call: { tool: 'specrails_blueprint', args: { action: 'chain_launch', project: projectRef, milestone: 1 } } })
  if (track.status === 'failed' && track.conversationId) offers.push({ id: 'retry_commit', labelKey: 'blueprint.offer.retry_commit', call: { tool: 'specrails_blueprint', args: { action: 'commit', ref: conversationRef(track.conversationId) } } })
  const state = ctx.v2.state({
    status: track.status === 'done' ? 'succeeded' : track.status === 'failed' ? 'failed' : 'running',
    ...(track.step ? { phase: track.step } : {}),
    offers,
    recommended: offers[0]?.id ?? null,
    versionFacts: { s: track.status, st: track.step, p: track.projectId },
  })
  const summary = track.status === 'done' ? ctx.v2.t('blueprint.summary.commit_done')
    : track.status === 'failed' ? ctx.v2.t('blueprint.summary.commit_failed', { step: track.step ?? '?', error: track.error ?? '' })
      : ctx.v2.t('blueprint.summary.commit_running', { step: track.step ?? 'create-dir' })
  return result({
    commit: ref, name: track.name, status: track.status, step: track.step, steps: track.steps,
    ...(projectRef ? { project: projectRef } : {}), ...(track.error ? { error: track.error } : {}),
    ...(track.conversationId ? { blueprint: conversationRef(track.conversationId) } : {}),
  }, { summary, state, refs: { commit: ref, ...(projectRef ? { project: projectRef } : {}), ...(track.conversationId ? { blueprint: conversationRef(track.conversationId) } : {}) }, untrusted: untrusted('/data/error', '/data/name') })
}

function slugifyName(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug || 'project'
}

/** The commit input exactly as the Builder's commit form builds it (defaults: product name, ~/projects/<slug>, the conversation's provider). */
async function commitInput(ctx: V2CallContext, args: Record<string, unknown>) {
  const target = ctx.v2.target(args, 'blueprint')
  const body = await readConversation(ctx, target.id)
  const conversation = rec(body.conversation)
  if (str(conversation.committed_project_id)) throw new V2ToolError('conflict', `Already committed as ${projectRefOf(ctx, String(conversation.committed_project_id)) ?? conversation.committed_project_id}.`)
  const raw = body.rawBlueprint ?? body.blueprint
  if (!raw || typeof raw !== 'object') throw new V2ToolError('conflict', ctx.v2.t('blueprint.error.no_snapshot'))
  const options = optionsOf(args)
  const product = rec(rec(body.blueprint).product)
  const name = str(options.name) ?? str(product.name) ?? 'project'
  const location = str(options.location) ?? `~/projects/${slugifyName(name)}`
  const providers = arr(options.providers).filter((p): p is string => typeof p === 'string' && !!p)
  const input = {
    blueprint: raw, name, location,
    providers: providers.length ? providers : [String(conversation.provider ?? 'claude')],
    createGithubRepo: options.githubRepo === true,
    conversationId: target.id,
  }
  const specs = arr(rec(body.blueprint).m1Specs).length
  return { target, body, input, specs }
}

// ── Milestones ──────────────────────────────────────────────────────────────

interface BlueprintRead { blueprint: Blueprint; progress: MilestoneProgress[] }

async function readProgress(ctx: V2CallContext, project: ProjectRow): Promise<BlueprintRead> {
  try {
    const body = await api(ctx, 'GET', `${projectBase(project)}/blueprint`)
    return { blueprint: body.blueprint as Blueprint, progress: arr(body.progress) as MilestoneProgress[] }
  } catch (err) {
    if (err instanceof V2ToolError && err.code === 'not_found') throw new V2ToolError('not_found', ctx.v2.t('blueprint.error.no_blueprint', { project: project.name }))
    throw err
  }
}

function projectDbOf(ctx: V2CallContext, project: ProjectRow): DbInstance | null {
  return (ctx.registry.getContext(project.id) as { db?: DbInstance } | undefined)?.db ?? null
}

function chainsOf(ctx: V2CallContext, project: ProjectRow) {
  return (ctx.registry.getContext(project.id) as { milestoneChains?: { get(id: string): MilestoneChainSnapshot | null; listForProgress(): MilestoneChainSnapshot[] } } | undefined)?.milestoneChains ?? null
}

/** Milestone scope of a call: `milestone:<slug>/m<n>` ref, or project + `milestone`. */
function milestoneScope(ctx: V2CallContext, args: Record<string, unknown>, required = true): { project: ProjectRow; n: number | null } {
  const parsed = parseRef(args.ref)
  if (parsed?.kind === 'milestone') {
    const target = ctx.v2.target(args, 'milestone', ['milestone'])
    const n = Number.parseInt(target.id.replace(/^m/i, ''), 10)
    if (!Number.isInteger(n) || n < 1) throw new V2ToolError('invalid_input', `Bad milestone ref ${target.ref}.`)
    return { project: target.project!, n }
  }
  const project = ctx.v2.project(args)
  const n = num(args.milestone)
  if (required && n === null) throw new V2ToolError('invalid_input', 'milestone (1..n) or a milestone ref is required.')
  return { project, n }
}

const milestoneRef = (project: ProjectRow, n: number) => formatRef('milestone', milestoneId(n), project.slug)
const chainRef = (project: ProjectRow, id: string) => formatRef('chain', id, project.slug)
const runRefOf = (project: ProjectRow) => (runId: string) => formatRef('run', runId, project.slug)

function milestoneOf(ctx: V2CallContext, read: BlueprintRead, n: number): MilestoneProgress {
  const m = read.progress.find((p) => p.n === n)
  if (!m) throw new V2ToolError('not_found', ctx.v2.t('blueprint.error.no_milestone', { n, count: read.progress.length }))
  return m
}

/** First planned milestone after M1 (the popover's "Generate M<next>"). */
const generatableN = (read: BlueprintRead) => read.progress.find((m) => m.n > 1 && m.storedStatus === 'planned' && m.counts.total === 0)?.n ?? null

interface ChatRow { id: string; kind?: string; context_scope?: string | null; updated_at?: string; provider?: string | null; model?: string | null }

/** The newest `kind: milestone` generation conversation for milestone n, if any. */
async function generationConversation(ctx: V2CallContext, project: ProjectRow, n: number): Promise<ChatRow | null> {
  const body = await api(ctx, 'GET', `${projectBase(project)}/chat/conversations`)
  const rows = arr(body.conversations).map((row) => row as ChatRow)
  return rows.find((row) => {
    if (row.kind !== 'milestone' || !row.context_scope) return false
    try { return String(rec(JSON.parse(row.context_scope)).milestone).toLowerCase() === milestoneId(n) } catch { return false }
  }) ?? null
}

interface Generation {
  conversationId: string
  writing: boolean
  specs: Row[]
  raw: Row | null
  quality: BuilderSpecBatchQualityReport | null
  rejected: string | null
  provider: string | null
  model: string | null
}

/** The latest generated batch: the last assistant reply's blueprint-draft block, gated like the popover's commit. */
async function readGeneration(ctx: V2CallContext, project: ProjectRow, n: number, conversation: ChatRow, writingHint: boolean | null): Promise<Generation> {
  const body = await api(ctx, 'GET', `${projectBase(project)}/chat/conversations/${encodeURIComponent(conversation.id)}`)
  const messages = arr(body.messages).map(rec)
  const last = messages[messages.length - 1]
  const reply = [...messages].reverse().find((m) => m.role === 'assistant')
  const busy = (ctx.registry.getContext(project.id) as { chatManager?: { isActive?(id: string): boolean } } | undefined)?.chatManager?.isActive?.(conversation.id)
  const writing = writingHint ?? (typeof busy === 'boolean' ? busy : last?.role === 'user')
  const parsed = reply ? parseBlueprintDraftBlocks(String(reply.content ?? '')) : null
  const raw = parsed?.rawBlueprint ? rec(parsed.rawBlueprint) : null
  const specs = arr(raw?.m1Specs).map(rec)
  const quality = raw ? analyzeBuilderSpecBatch({ specsComplete: raw.specsComplete, specs }, { milestoneLabel: `M${n}`, minSpecs: 1, maxSpecs: 10, requireScaffold: false }) : null
  return {
    conversationId: conversation.id, writing, specs, raw, quality,
    rejected: !raw && parsed?.rejected.length ? parsed.rejected[parsed.rejected.length - 1].reason : null,
    provider: conversation.provider ?? null, model: conversation.model ?? null,
  }
}

function generationData(g: Generation): Row {
  return {
    conversation: g.conversationId, writing: g.writing, engine: { provider: g.provider, model: g.model },
    specs: g.specs.map((spec, index) => ({ index, title: clip(spec.title, 100), kind: spec.kind ?? null, priority: spec.priority ?? null, criteria: arr(spec.acceptanceCriteria).length, ...(typeof spec.dependsOnIndex === 'number' ? { after: spec.dependsOnIndex } : {}) })),
    quality: g.quality ? { valid: g.quality.valid, issues: g.quality.issues.slice(0, 8).map((issue) => clipDeep(issue, 200)) } : null,
    ...(g.rejected ? { rejected: g.rejected } : {}),
  }
}

const GENERATION_UNTRUSTED = ['/data/generation/specs/*/title', '/data/generation/issues/*', '/data/generation/quality/issues/*']

function railRow(ctx: V2CallContext, project: ProjectRow, rail: MilestoneRail, detail: boolean): Row {
  const state = rail.runId ? projectRailState(runRefOf(project)(rail.runId), rail, ctx.v2.t) : null
  return {
    rail: rail.railIndex + 1, name: clip(rail.name, 60), specs: rail.ticketIds.map((id) => formatRef('spec', id, project.slug)),
    active: rail.active, ...(rail.chunkIndex ? { chunk: rail.chunkIndex } : {}),
    ...(rail.runId ? { run: formatRef('run', rail.runId, project.slug) } : {}),
    ...(rail.hold ? { hold: rail.hold.kind } : {}),
    ...(rail.delivery ? { delivery: formatRef('delivery', rail.delivery.id, project.slug), decision: rail.delivery.decision } : {}),
    ...(rail.engine ? { engine: rail.engine } : {}),
    ...(rail.startedAt && detail ? { startedAt: rail.startedAt } : {}),
    ...(state ? { state: ctx.v2.state(state) } : {}),
  }
}

function chainSummary(ctx: V2CallContext, project: ProjectRow, chain: MilestoneChainSnapshot): Row {
  const phase = chainPhase(chain)
  return {
    ref: chainRef(project, chain.id), status: chain.status, autoAdvance: chain.autoAdvance,
    ...(phase ? { phase } : {}), ...(chain.pauseReason ? { pauseReason: chain.pauseReason } : {}),
    ...(chain.nextEngine ? { nextEngine: chain.nextEngine } : {}),
  }
}

/** "Only for M<n>": the milestone's own engine (milestone-engine-preference.ts), or null when it follows the usual one. */
async function ownEngine(ctx: V2CallContext, project: ProjectRow, n: number): Promise<Row | null> {
  const overrides = rec((await maybe(ctx, `${projectBase(project)}/blueprint/milestone-engines`))?.overrides)
  const engine = rec(rec(overrides[milestoneId(n)]).engine)
  return str(engine.provider) ? engine : null
}

async function specsOfMilestone(ctx: V2CallContext, project: ProjectRow, n: number): Promise<Row[]> {
  const body = await maybe(ctx, `${projectBase(project)}/tickets?${new URLSearchParams({ label: `M${n}` })}`)
  return arr(body?.tickets).map(rec)
    .filter((t) => arr(t.labels).some((label) => String(label).toLowerCase() === `m${n}`))
    .sort((a, b) => (num(a.id) ?? 0) - (num(b.id) ?? 0))
    .map((t) => ({ ref: formatRef('spec', String(t.id), project.slug), title: clip(t.title, 100), status: t.status, priority: t.priority ?? null }))
}

async function milestoneDetail(ctx: V2CallContext, args: Record<string, unknown>, project: ProjectRow, read: BlueprintRead, n: number) {
  const m = milestoneOf(ctx, read, n)
  const sections = resolveFields(args, ['milestones', 'specs', 'plan'])
  const planned = read.blueprint.milestones[n - 1]
  const conversation = m.storedStatus === 'planned' && m.counts.total === 0 ? await generationConversation(ctx, project, n) : null
  const generation = conversation ? await readGeneration(ctx, project, n, conversation, null) : null
  const draftReady = !!generation && !generation.writing && generation.quality?.valid === true
  const chain = m.chain && isActiveChain(m.chain) ? m.chain : null
  const refs: Record<string, Ref> = { project: formatRef('project', project.slug), milestone: milestoneRef(project, n), ...(m.chain ? { chain: chainRef(project, m.chain.id) } : {}) }
  const state = ctx.v2.state(projectMilestoneState(m, {
    milestoneRef: refs.milestone, scope: { project: project.slug, milestone: n }, generatable: generatableN(read) === n, draftReady,
    chainRefs: chain ? { chain: chainRef(project, chain.id), run: runRefOf(project) } : null,
  }))
  const own = await ownEngine(ctx, project, n)
  const specs = await specsOfMilestone(ctx, project, n)
  const data: Row = {
    ref: refs.milestone, n, title: clip(m.title, 100), goal: clip(planned?.goal, 400), state: m.state, counts: m.counts,
    planned: m.counts.total === 0 ? arr(planned?.plannedSpecs).map((s) => clip(s, 100)) : undefined,
    specs: specs.slice(0, 25), ...(specs.length > 25 ? { specsMore: specs.length - 25 } : {}),
    rails: m.rails.map((rail) => railRow(ctx, project, rail, sections.includes('plan'))),
    chain: m.chain ? chainSummary(ctx, project, m.chain) : null,
    engine: own ? { ...own, onlyThisMilestone: true } : null,
    ...(generation ? { generation: generationData(generation) } : {}),
  }
  const summary = generation?.writing ? ctx.v2.t('blueprint.summary.generating', { n })
    : ctx.v2.t('blueprint.summary.milestone', { n, title: clip(m.title, 60) ?? `M${n}`, state: ctx.v2.t(`core.status.${state.status}`), done: m.counts.done, total: m.counts.total })
  return result(data, { summary, refs, state, untrusted: untrusted('/data/title', '/data/goal', '/data/planned/*', '/data/specs/*/title', '/data/rails/*/name', ...GENERATION_UNTRUSTED) })
}

function seedText(ctx: V2CallContext, read: BlueprintRead, n: number, message: string | null): string {
  const planned = read.blueprint.milestones[n - 1]
  const titles = arr(planned?.plannedSpecs).filter((s): s is string => typeof s === 'string')
  const vars = { label: `M${n}`, title: planned?.title ?? `M${n}`, planned: titles.join('; ') }
  const seed = ctx.v2.t(titles.length ? 'blueprint.prompt.milestone_seed_planned' : 'blueprint.prompt.milestone_seed', vars)
  return message ? `${seed}\n\n${message}` : seed
}

/** What milestone_generate will do: refine the open batch, or start a (re)generation. */
async function generationPlan(ctx: V2CallContext, args: Record<string, unknown>) {
  const scope = milestoneScope(ctx, args, false)
  const read = await readProgress(ctx, scope.project)
  const n = scope.n ?? generatableN(read)
  if (n === null) throw new V2ToolError('conflict', 'Every milestone already has specs; pass milestone to choose one.')
  const m = milestoneOf(ctx, read, n)
  if (m.storedStatus !== 'planned' || m.counts.total > 0) throw new V2ToolError('conflict', ctx.v2.t('blueprint.error.not_planned', { n, status: m.storedStatus }))
  const options = optionsOf(args)
  const message = typeof args.message === 'string' && args.message.trim() ? args.message.trim() : null
  const existing = await generationConversation(ctx, scope.project, n)
  const refine = !!existing && !!message && options.fresh !== true
  return { project: scope.project, read, n, existing, refine, message, options }
}

// ── Chains ──────────────────────────────────────────────────────────────────

async function chainTarget(ctx: V2CallContext, args: Record<string, unknown>): Promise<{ project: ProjectRow; chain: MilestoneChainSnapshot }> {
  const target = ctx.v2.target(args, 'chain', ['chain', 'milestone'])
  const project = target.project!
  const chains = chainsOf(ctx, project)
  if (!chains) throw new V2ToolError('provider_unavailable', ctx.v2.t('blueprint.error.not_loaded', { project: project.name }), { retryable: true })
  if (target.kind === 'milestone') {
    const n = Number.parseInt(target.id.replace(/^m/i, ''), 10)
    const chain = chains.listForProgress().find((c) => c.milestoneN === n)
    if (!chain) throw new V2ToolError('not_found', ctx.v2.t('blueprint.error.no_chain', { n }))
    return { project, chain }
  }
  const chain = chains.get(target.id)
  if (!chain) throw new V2ToolError('not_found', `Chain ${target.ref} not found.`)
  return { project, chain }
}

async function railsOfChain(ctx: V2CallContext, project: ProjectRow, chain: MilestoneChainSnapshot): Promise<MilestoneRail[]> {
  try { return (await readProgress(ctx, project)).progress.find((m) => m.n === chain.milestoneN)?.rails ?? [] } catch { return [] }
}

function chainStateOf(ctx: V2CallContext, project: ProjectRow, chain: MilestoneChainSnapshot, rails: readonly MilestoneRail[]): DecisionState {
  return ctx.v2.state(projectChainState({ chain: chainRef(project, chain.id), run: runRefOf(project) }, chain, rails))
}

/** A chain; `compact` (write accepts, ≤ 600 tokens): no spec list, only held rails — chain_get has the rest. */
function chainView(ctx: V2CallContext, args: Record<string, unknown>, project: ProjectRow, chain: MilestoneChainSnapshot, rails: readonly MilestoneRail[], summaryKey = 'blueprint.summary.chain', compact = false) {
  const sections = compact ? [] : resolveFields(args, ['plan', 'specs'])
  const ref = chainRef(project, chain.id)
  const state = chainStateOf(ctx, project, chain, rails)
  const plan = chain.plan
  // A write accept (compact) keeps what `state` and `refs` do not already say: the phase, hold reason,
  // engine and milestone live there (the 600-token accept budget).
  const head = compact
    ? { ref, status: chain.status, autoAdvance: chain.autoAdvance }
    : { ...chainSummary(ctx, project, chain), milestone: milestoneRef(project, chain.milestoneN), n: chain.milestoneN, mode: chain.mode, launched: chain.launched.length }
  const data: Row = {
    ...head, total: plan?.total ?? chain.totalChunks, settled: plan?.settled ?? null,
    specs: compact ? undefined : (plan?.specs ?? []).map((spec) => ({
      spec: formatRef('spec', spec.ticketId, project.slug), title: clip(spec.title, 100), state: spec.state,
      ...(spec.runId ? { run: formatRef('run', spec.runId, project.slug) } : {}),
      ...(spec.deliveryId ? { delivery: formatRef('delivery', spec.deliveryId, project.slug) } : {}),
      ...(spec.pauseKind ? { pauseKind: spec.pauseKind } : {}),
      ...(spec.lastAttemptFailed ? { lastAttemptFailed: true } : {}),
    })),
    rails: rails.filter((rail) => compact ? rail.hold : rail.active || rail.delivery).map((rail) => railRow(ctx, project, rail, sections.includes('plan'))),
    ...(sections.includes('plan') && plan ? { plan: { action: plan.action, auto: plan.auto, baseBranch: plan.baseBranch } } : {}),
    ...(compact ? {} : { createdAt: chain.createdAt }), updatedAt: chain.updatedAt,
  }
  const phase = chainPhase(chain)
  return result(data, {
    summary: ctx.v2.t(summaryKey, { n: chain.milestoneN, status: state.label, phase: phase ? ` · ${phase}` : '' }),
    refs: { chain: ref, milestone: milestoneRef(project, chain.milestoneN) },
    state,
    untrusted: compact ? untrusted('/data/rails/*/name') : untrusted('/data/specs/*/title', '/data/rails/*/name', '/data/pauseReason'),
  })
}

/** The plan offer a resume `from` executes (the reconcile plan's own semantics). */
function offerFor(chain: MilestoneChainSnapshot, from: ChainResumeFrom): ChainOffer | null {
  const offers = chain.plan?.offers ?? []
  return from === 'recommended' ? offers[0] ?? null : offers.find((offer) => offer.from === from) ?? null
}

const NO_SPEND: ReadonlySet<string> = new Set(['complete', 'follow_run', 'answer_run'])

function remainingSpecs(chain: MilestoneChainSnapshot): number {
  const plan = chain.plan
  if (!plan) return Math.max(chain.totalChunks - chain.nextChunk + 1, 1)
  return plan.specs.filter((spec) => spec.state === 'pending' || spec.state === 'failed').length
}

function engineBody(options: Row): Row | null {
  if (!str(options.provider) && !str(options.model)) return null
  if (!str(options.provider) || !str(options.model)) throw new V2ToolError('invalid_input', 'options.provider and options.model go together (options.effort optional).')
  return { provider: options.provider, model: options.model, reasoningEffort: str(options.effort) }
}

async function launchPlan(ctx: V2CallContext, args: Record<string, unknown>) {
  const scope = milestoneScope(ctx, args)
  const read = await readProgress(ctx, scope.project)
  const m = milestoneOf(ctx, read, scope.n!)
  const options = optionsOf(args)
  const autoAdvance = options.autoAdvance !== false
  const engine = engineBody(options)
  const settings = engine ? null : await maybe(ctx, `${projectBase(scope.project)}/blueprint/launch-settings`)
  return { project: scope.project, m, autoAdvance, engine, shownEngine: engine ?? rec(settings?.selection) }
}

// ── The tool ────────────────────────────────────────────────────────────────

/** WP6. Project builder conversation, milestones and milestone chains. */
export const blueprintTool = defineTool({
  name: 'specrails_blueprint',
  title: 'Blueprint',
  description: 'Project builder: converse, commit into a project with milestone 1, generate milestones, launch and steer milestone chains.',
  owner: 'WP6',
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(['conversation', 'blueprint', 'milestones', 'specs', 'plan']),
    message: z.string(),
    intent: z.enum(['message', 'surprise', 'approve']),
    from: z.enum(['recommended', 'failed_step', 'start']).describe('chain_resume'),
    enabled: z.boolean().describe('chain_auto_advance'),
    milestone: z.number().int().min(1).max(999),
  },
  actions: {
    sessions: {
      tier: 'read',
      doc: 'Builder conversations to resume (options.all: every one).',
      handler: async (ctx, args) => {
        const all = optionsOf(args).all === true
        const body = await api(ctx, 'GET', `/blueprint/conversations${all ? '' : '?resumable=1'}`)
        const rows = arr(body.conversations).map(rec).map((row) => {
          const committed = projectRefOf(ctx, str(row.committed_project_id))
          return {
            ref: conversationRef(String(row.id)), title: clip(row.title, 80) ?? clip(row.productName, 80),
            provider: row.provider, model: row.model ?? null, updatedAt: row.updated_at,
            ...(row.productName !== undefined ? { product: clip(row.productName, 80), specs: row.specCount, complete: row.specsComplete === true, dimensions: `${row.dimensionsFilled ?? 0}/5`, ...(row.pendingIssue ? { issue: row.pendingIssue } : {}) } : {}),
            ...(committed ? { project: committed } : {}),
          }
        })
        const { items, page } = pageOf(rows, { cursor: args.cursor, limit: args.limit, key: 'blueprint.sessions' })
        return result({ items }, {
          summary: items.length ? ctx.v2.t('blueprint.summary.sessions', { count: page.total }) : ctx.v2.t('blueprint.summary.sessions_none'),
          refs: Object.fromEntries(items.map((item, i) => [`blueprint.${i}`, item.ref])), page,
          untrusted: untrusted('/data/items/*/title', '/data/items/*/product'),
        })
      },
    },
    start: {
      tier: 'ai-spawn', confirm: 'costly', oneOf: ['message', 'intent'],
      doc: 'New Builder conversation + first turn; options: provider, model, effort, waitMs.',
      preview: (ctx, args) => turnPreview(ctx, args, str(optionsOf(args).provider) ?? 'default', `s${shortHash({ m: args.message ?? null, i: args.intent ?? null })}`),
      handler: async (ctx, args) => {
        const options = optionsOf(args)
        const body = sendBody(ctx, args)
        const created = await api(ctx, 'POST', '/blueprint/conversations', { ...(str(options.provider) ? { provider: options.provider } : {}), ...(str(options.model) ? { model: options.model } : {}) })
        const id = String(rec(created.conversation).id)
        return builderTurnCall(ctx, args, id, () => api(ctx, 'POST', `/blueprint/conversations/${encodeURIComponent(id)}/send`, body))
      },
    },
    send: {
      tier: 'ai-spawn', confirm: 'costly', required: ['ref'], oneOf: ['message', 'intent'],
      doc: 'Builder turn (intent surprise|approve sends the app text); options: model, effort, waitMs.',
      preview: async (ctx, args) => {
        const body = await readConversation(ctx, ctx.v2.target(args, 'blueprint').id)
        const conversation = rec(body.conversation)
        return turnPreview(ctx, args, String(conversation.provider ?? ''), `c${shortHash({ u: conversation.updated_at, n: arr(body.messages).length })}`)
      },
      handler: async (ctx, args) => {
        const target = ctx.v2.target(args, 'blueprint')
        const body = sendBody(ctx, args)
        return builderTurnCall(ctx, args, target.id, () => api(ctx, 'POST', `/blueprint/conversations/${encodeURIComponent(target.id)}/send`, body))
      },
    },
    repair: {
      tier: 'ai-spawn', confirm: 'costly', required: ['ref'],
      doc: 'Re-ask a rejected/incomplete blueprint, or continue a halted spec generation.',
      preview: async (ctx, args) => {
        const body = await readConversation(ctx, ctx.v2.target(args, 'blueprint').id)
        const conversation = rec(body.conversation)
        return turnPreview(ctx, args, String(conversation.provider ?? ''), `c${shortHash({ u: conversation.updated_at, n: arr(body.messages).length })}`)
      },
      handler: async (ctx, args) => {
        const target = ctx.v2.target(args, 'blueprint')
        const effort = str(optionsOf(args).effort)
        return builderTurnCall(ctx, args, target.id, () => api(ctx, 'POST', `/blueprint/conversations/${encodeURIComponent(target.id)}/repair-snapshot`, effort ? { reasoningEffort: effort } : {}))
      },
    },
    abort: {
      tier: 'write', required: ['ref'],
      doc: 'Stop the Builder turn (blueprint ref) or a milestone generation (milestone ref).',
      handler: async (ctx, args) => {
        if (parseRef(args.ref)?.kind === 'milestone') {
          const scope = milestoneScope(ctx, args)
          const conversation = await generationConversation(ctx, scope.project, scope.n!)
          if (!conversation) throw new V2ToolError('not_found', ctx.v2.t('blueprint.error.no_generation', { n: scope.n }))
          await api(ctx, 'DELETE', `${projectBase(scope.project)}/chat/conversations/${encodeURIComponent(conversation.id)}/messages/stream`)
          return result({ milestone: milestoneRef(scope.project, scope.n!), aborted: true }, { summary: ctx.v2.t('blueprint.summary.aborted'), refs: { milestone: milestoneRef(scope.project, scope.n!) } })
        }
        const target = ctx.v2.target(args, 'blueprint')
        await api(ctx, 'POST', `/blueprint/conversations/${encodeURIComponent(target.id)}/abort`)
        return result({ ref: target.ref, aborted: true }, { summary: ctx.v2.t('blueprint.summary.aborted'), refs: { blueprint: target.ref } })
      },
    },
    get: {
      tier: 'read', required: ['ref'],
      doc: 'A Builder conversation (fields conversation, blueprint) or a project commit; options.waitMs waits for a reply in progress.',
      handler: async (ctx, args) => {
        trackCommits(ctx)
        const target = ctx.v2.target(args, 'blueprint')
        const track = trackedCommit(target.id)
        if (track) return commitTrackView(ctx, target.id, track)
        let body: Row
        try { body = await readConversation(ctx, target.id) } catch (err) {
          if (err instanceof V2ToolError && err.code === 'not_found') throw new V2ToolError('not_found', ctx.v2.t('blueprint.error.not_conversation', { ref: target.ref }))
          throw err
        }
        let view = builderView(ctx, body, null, resolveFields(args, ['conversation', 'blueprint']))
        const waitMs = waitMsOf(args, 0)
        if (view.writing && waitMs > 0) {
          const outcome = await listen(ctx, builderTurn(target.id), waitMs).promise
          body = await readConversation(ctx, target.id)
          view = builderView(ctx, body, outcome.kind === 'timeout' ? true : null, resolveFields(args, ['conversation', 'blueprint']))
        }
        const summary = view.writing ? ctx.v2.t('blueprint.summary.writing') : ctx.v2.t('blueprint.summary.conversation', { title: view.title, status: view.state.label })
        return result(view.data, { summary, refs: view.refs, state: view.state, untrusted: BUILDER_UNTRUSTED })
      },
    },
    commit: {
      tier: 'ai-spawn', required: ['ref'],
      // Creating a GitHub repository is an external change; otherwise it is costly AI work.
      confirm: (args) => (args.options as Record<string, unknown> | undefined)?.githubRepo ? 'external' : 'costly',
      doc: 'Create the project from the blueprint (202); options: name, location, providers[], githubRepo, waitMs.',
      preview: async (ctx, args) => {
        const { input, body, specs } = await commitInput(ctx, args)
        const sentences = [ctx.v2.t('blueprint.preview.commit', { name: input.name, location: input.location, specs, providers: input.providers.join(', ') })]
        if (input.createGithubRepo) sentences.push(ctx.v2.t('blueprint.preview.commit_github'))
        const conversation = rec(body.conversation)
        // Assembling the project runs no AI turn (offline core init).
        return { effect: sentences.join(' '), refs: [conversationRef(input.conversationId)], version: `b${shortHash({ u: conversation.updated_at, s: body.snapshotUpdatedAt ?? null })}`, cost: { forecastUsd: [0, 0], runs: 0 } }
      },
      handler: async (ctx, args) => {
        const { input } = await commitInput(ctx, args)
        trackCommits(ctx)
        const started = await api(ctx, 'POST', '/blueprint/commit', input)
        const commitId = String(started.commitId)
        rememberCommit(commitId, { conversationId: input.conversationId, name: input.name, status: 'running', step: null, steps: [], projectId: null, error: null, at: Date.now() })
        if (trackedCommit(commitId)!.status === 'running') {
          await listen(ctx, (msg) => msg.commitId === commitId && (msg.type === 'blueprint.commit_done' || msg.type === 'blueprint.commit_failed') ? 'done' : null, waitMsOf(args)).promise
        }
        const track = trackedCommit(commitId)!
        const view = commitTrackView(ctx, commitId, track)
        if (track.status === 'running') view.summary = ctx.v2.t('blueprint.summary.commit_started', { name: input.name, ref: formatRef('blueprint', commitId) })
        return view
      },
    },
    milestones: {
      tier: 'read',
      doc: 'Milestones M1..Mn: state, counts, chain, next step; milestone or ref: one milestone with specs, rails, generation, engine.',
      handler: async (ctx, args) => {
        const scope = milestoneScope(ctx, args, false)
        const read = await readProgress(ctx, scope.project)
        if (scope.n !== null) return milestoneDetail(ctx, args, scope.project, read, scope.n)
        const project = scope.project
        const generatable = generatableN(read)
        const detail = resolveFields(args, ['milestones', 'specs', 'plan']).length > 0
        const refs: Record<string, Ref> = { project: formatRef('project', project.slug) }
        const items = read.progress.map((m) => {
          const ref = milestoneRef(project, m.n)
          refs[`milestone.${m.n}`] = ref
          const chain = m.chain && isActiveChain(m.chain) ? m.chain : null
          if (m.chain) refs[`chain.${m.n}`] = chainRef(project, m.chain.id)
          const state = ctx.v2.state(projectMilestoneState(m, {
            milestoneRef: ref, scope: { project: project.slug, milestone: m.n }, generatable: generatable === m.n,
            chainRefs: chain ? { chain: chainRef(project, chain.id), run: runRefOf(project) } : null,
          }))
          const next = state.offers.find((offer) => offer.id === state.recommended) ?? null
          return {
            ref, n: m.n, title: clip(m.title, 100), state: m.state, status: state.status, counts: m.counts,
            ...(m.chain ? { chain: chainSummary(ctx, project, m.chain) } : {}),
            ...(m.rails.some((rail) => rail.hold) ? { held: m.rails.filter((rail) => rail.hold).map((rail) => ({ rail: rail.railIndex + 1, hold: rail.hold!.kind, ...(rail.runId ? { run: formatRef('run', rail.runId, project.slug) } : {}) })) } : {}),
            ...(state.hold ? { hold: state.hold.reason } : {}),
            ...(next ? { next: { id: next.id, label: next.label, call: next.call, needsConfirm: next.needsConfirm } } : {}),
            ...(detail ? { offers: state.offers.map((offer) => ({ id: offer.id, label: offer.label, call: offer.call })) } : {}),
          }
        })
        const current = items.find((item) => item.state !== 'done') ?? items[items.length - 1]
        return result({ product: clip(read.blueprint.product?.name, 80), items }, {
          summary: ctx.v2.t('blueprint.summary.milestones', { product: clip(read.blueprint.product?.name, 60) ?? project.name, count: items.length, current: current ? `M${current.n} ${current.state}` : '—' }),
          refs, untrusted: untrusted('/data/product', '/data/items/*/title'),
        })
      },
    },
    milestone_generate: {
      tier: 'ai-spawn', confirm: 'costly',
      doc: 'Generate (options.fresh: regenerate) or refine (message) a planned milestone\'s specs; options: provider, model, effort (another than the usual = only this milestone), waitMs.',
      preview: async (ctx, args) => {
        const plan = await generationPlan(ctx, args)
        const engine = engineBody(plan.options) ?? (plan.refine && plan.existing ? { provider: plan.existing.provider, model: plan.existing.model } : rec((await maybe(ctx, `${projectBase(plan.project)}/blueprint/generation-settings`))?.selection))
        const band = generationTurnCost(projectDbOf(ctx, plan.project))
        return {
          effect: ctx.v2.t(plan.refine ? 'blueprint.preview.refine' : 'blueprint.preview.generate', { n: plan.n, engine: engineWord(ctx, engine) }),
          refs: [milestoneRef(plan.project, plan.n)],
          version: `g${shortHash({ n: plan.n, c: plan.existing?.id ?? null, u: plan.existing?.updated_at ?? null, r: plan.refine })}`,
          cost: { forecastUsd: band, runs: 1 },
        }
      },
      handler: async (ctx, args) => {
        const plan = await generationPlan(ctx, args)
        const base = projectBase(plan.project)
        let conversationId: string
        let text: string
        if (plan.refine) {
          conversationId = plan.existing!.id
          text = plan.message!
        } else {
          const engine = engineBody(plan.options)
          const created = await api(ctx, 'POST', `${base}/chat/conversations`, {
            kind: 'milestone', milestone: milestoneId(plan.n),
            ...(engine ? { provider: engine.provider, model: engine.model, reasoningEffort: engine.reasoningEffort } : {}),
          })
          conversationId = String(rec(created.conversation).id)
          text = seedText(ctx, plan.read, plan.n, plan.message)
        }
        const wait = listen(ctx, chatTurn(conversationId), waitMsOf(args))
        try { await api(ctx, 'POST', `${base}/chat/conversations/${encodeURIComponent(conversationId)}/messages`, { text }) } catch (err) { wait.stop(); throw err }
        const outcome = await wait.promise
        if (outcome.kind === 'error') throw new V2ToolError('provider_unavailable', ctx.v2.t('blueprint.summary.failed_turn', { error: clip(outcome.msg?.error, 200) ?? '' }), { retryable: true })
        const conversation = (await generationConversation(ctx, plan.project, plan.n)) ?? { id: conversationId }
        const generation = await readGeneration(ctx, plan.project, plan.n, conversation, outcome.kind === 'timeout' ? true : false)
        const ref = milestoneRef(plan.project, plan.n)
        const own = await ownEngine(ctx, plan.project, plan.n)
        const valid = generation.quality?.valid === true
        const offers = generation.writing ? [] : [
          ...(valid ? [{ id: 'milestone.commit', labelKey: 'blueprint.offer.commit', labelParams: { n: plan.n }, call: { tool: 'specrails_blueprint', args: { action: 'milestone_commit', ref } } }] : []),
          { id: 'milestone.refine', labelKey: 'blueprint.offer.reply', call: { tool: 'specrails_blueprint', args: { action: 'milestone_generate', ref } }, needs: ['message'] },
          ...(!valid && generation.raw === null ? [{ id: 'milestone.repair', labelKey: 'blueprint.offer.repair', call: { tool: 'specrails_blueprint', args: { action: 'milestone_generate', ref, message: ctx.v2.t('blueprint.prompt.repair', { reason: generation.rejected ?? 'no block' }) } } }] : []),
          { id: 'milestone.regenerate', labelKey: 'blueprint.offer.regenerate', labelParams: { n: plan.n }, call: { tool: 'specrails_blueprint', args: { action: 'milestone_generate', ref, options: { fresh: true } } } },
        ]
        const state = ctx.v2.state({
          status: generation.writing ? 'running' : valid ? 'needs_you' : 'waiting', offers,
          recommended: valid ? 'milestone.commit' : null,
          versionFacts: { c: conversationId, n: generation.specs.length, v: valid, w: generation.writing },
        })
        const summary = generation.writing ? ctx.v2.t('blueprint.summary.generating', { n: plan.n })
          : generation.raw ? ctx.v2.t('blueprint.summary.generated', { n: plan.n, count: generation.specs.length, quality: valid ? ctx.v2.t('blueprint.quality.valid') : ctx.v2.t('blueprint.quality.invalid', { count: generation.quality?.issues.length ?? 0 }) })
            : ctx.v2.t('blueprint.summary.generated_none', { reason: generation.rejected ?? 'no block' })
        return result({
          milestone: ref, n: plan.n, generation: generationData(generation),
          engine: own ? { ...own, onlyThisMilestone: true } : { provider: generation.provider, model: generation.model, onlyThisMilestone: false },
        }, { summary, refs: { milestone: ref }, state, untrusted: untrusted(...GENERATION_UNTRUSTED) })
      },
    },
    milestone_commit: {
      tier: 'write', oneOf: ['milestone', 'ref'],
      doc: 'Add the generated milestone specs to the board as todo (options.specs: an edited batch).',
      handler: async (ctx, args) => {
        const scope = milestoneScope(ctx, args)
        const n = scope.n!
        const options = optionsOf(args)
        let specs = arr(options.specs)
        let specsComplete: unknown = options.specsComplete ?? true
        if (!specs.length) {
          const conversation = await generationConversation(ctx, scope.project, n)
          const generation = conversation ? await readGeneration(ctx, scope.project, n, conversation, null) : null
          if (!generation?.raw || generation.writing) throw new V2ToolError('conflict', ctx.v2.t('blueprint.error.no_generation', { n }))
          specs = generation.specs
          specsComplete = generation.raw.specsComplete
        }
        const body = await api(ctx, 'POST', `${projectBase(scope.project)}/blueprint/commit-milestone`, { milestoneId: milestoneId(n), specsComplete, specs })
        const ids = arr(body.insertedIds).map((id) => formatRef('spec', String(id), scope.project.slug))
        const ref = milestoneRef(scope.project, n)
        return result({ milestone: ref, specs: ids }, {
          summary: ctx.v2.t('blueprint.summary.committed', { n, count: ids.length }),
          refs: { milestone: ref, ...Object.fromEntries(ids.map((id) => [`spec.${id.split('/').pop()}`, id])) },
          state: ctx.v2.state({ status: 'waiting', offers: [{ id: 'milestone.launch', labelKey: 'blueprint.offer.launch', labelParams: { n }, call: { tool: 'specrails_blueprint', args: { action: 'chain_launch', project: scope.project.slug, milestone: n } } }], recommended: 'milestone.launch', versionFacts: ids }),
        })
      },
    },
    chain_launch: {
      tier: 'ai-spawn', confirm: 'costly', oneOf: ['milestone', 'ref'],
      doc: 'Launch milestone N one spec per rail; options: autoAdvance (default true), provider, model, effort.',
      preview: async (ctx, args) => {
        const plan = await launchPlan(ctx, args)
        const count = plan.m.counts.todo
        const runs = plan.autoAdvance ? count : Math.min(count, 1)
        return {
          effect: ctx.v2.t('blueprint.preview.launch', { n: plan.m.n, count, engine: engineWord(ctx, plan.shownEngine), advance: ctx.v2.t(plan.autoAdvance ? 'blueprint.preview.advance_on' : 'blueprint.preview.advance_off') }),
          refs: [milestoneRef(plan.project, plan.m.n)],
          version: `m${shortHash({ s: plan.m.state, c: plan.m.counts, ch: plan.m.chain ? [plan.m.chain.id, plan.m.chain.status] : null })}`,
          cost: { forecastUsd: await launchCost(ctx, plan.project, str(plan.shownEngine.provider), runs), runs },
        }
      },
      handler: async (ctx, args) => {
        const plan = await launchPlan(ctx, args)
        const n = plan.m.n
        const options = optionsOf(args)
        let body: Row
        try {
          body = await api(ctx, 'POST', `${projectBase(plan.project)}/blueprint/milestones/${n}/launch`, {
            autoAdvance: plan.autoAdvance, ...(options.mode === 'parallel' ? { mode: 'parallel' } : {}), ...(plan.engine ? { engine: plan.engine } : {}),
          })
        } catch (err) {
          if (err instanceof V2ToolError && err.code === 'conflict' && err.message.startsWith('chain_active')) {
            const active = chainsOf(ctx, plan.project)?.listForProgress().find((c) => c.milestoneN === n)
            throw new V2ToolError('conflict', ctx.v2.t('blueprint.error.chain_active', { n }), active ? { next: [{ tool: 'specrails_blueprint', args: { action: 'chain_get', ref: chainRef(plan.project, active.id) }, why: 'The active chain and its offers.' }] } : {})
          }
          throw err
        }
        const chainId = str(body.chainId)
        const chain = chainId ? chainsOf(ctx, plan.project)?.get(chainId) ?? null : null
        const ref = chainId ? chainRef(plan.project, chainId) : milestoneRef(plan.project, n)
        const summary = ctx.v2.t('blueprint.summary.chain_launched', { n, launched: arr(body.launched).length, pending: arr(body.pending).length, ref })
        if (!chain) return result({ chain: chainId ? ref : null, launched: arr(body.launched).length, pending: arr(body.pending).length }, { summary, refs: { milestone: milestoneRef(plan.project, n), ...(chainId ? { chain: ref } : {}) } })
        const view = chainView(ctx, args, plan.project, chain, await railsOfChain(ctx, plan.project, chain), 'blueprint.summary.chain', true)
        view.summary = summary
        return view
      },
    },
    chain_get: {
      tier: 'read', required: ['ref'],
      doc: 'Chain state: specs, held rails, next engine and the reconcile plan\'s offers (ref: chain or milestone).',
      handler: async (ctx, args) => {
        const { project, chain } = await chainTarget(ctx, args)
        return chainView(ctx, args, project, chain, await railsOfChain(ctx, project, chain))
      },
    },
    chain_resume: {
      tier: 'ai-spawn', confirm: 'costly', required: ['ref'],
      doc: 'Execute the plan: from recommended (default), failed_step or start.',
      preview: async (ctx, args) => {
        const { project, chain } = await chainTarget(ctx, args)
        const rails = await railsOfChain(ctx, project, chain)
        const from = (args.from as ChainResumeFrom | undefined) ?? 'recommended'
        const offer = offerFor(chain, from)
        const spends = !offer || !NO_SPEND.has(offer.kind)
        const runs = !spends ? 0 : offer && ['resume_run', 'resume_failed_step'].includes(offer.kind) ? 1 : chain.autoAdvance ? Math.max(remainingSpecs(chain), 1) : 1
        const label = offer ? ctx.v2.t(`core.offer.chain.${offer.kind}`) : from
        return {
          effect: ctx.v2.t('blueprint.preview.resume', { n: chain.milestoneN, offer: `${label}${offer?.ticketId ? ` (#${offer.ticketId})` : ''}` }),
          refs: [chainRef(project, chain.id)], version: chainStateOf(ctx, project, chain, rails).version,
          cost: { forecastUsd: spends ? await launchCost(ctx, project, chain.nextEngine?.provider ?? null, runs) : [0, 0], runs },
        }
      },
      handler: async (ctx, args) => {
        const { project, chain } = await chainTarget(ctx, args)
        const from = (args.from as ChainResumeFrom | undefined) ?? 'recommended'
        const body = await api(ctx, 'POST', `${projectBase(project)}/blueprint/chains/${encodeURIComponent(chain.id)}/resume`, { from })
        const fresh = chainsOf(ctx, project)?.get(chain.id) ?? (body.chain as MilestoneChainSnapshot)
        return chainView(ctx, args, project, fresh, await railsOfChain(ctx, project, fresh), 'blueprint.summary.chain_updated', true)
      },
    },
    chain_auto_advance: {
      // Turning it on at a checkpoint launches the next rail right away (and the rest after it).
      tier: (args) => args.enabled === true ? 'ai-spawn' : 'write',
      confirm: (args) => args.enabled === true ? 'costly' : null,
      required: ['ref', 'enabled'],
      doc: 'Continue automatically after each integrated rail (true) or stop for your go (false).',
      preview: async (ctx, args) => {
        const { project, chain } = await chainTarget(ctx, args)
        const rails = await railsOfChain(ctx, project, chain)
        const runs = chain.autoAdvance ? 0 : remainingSpecs(chain)
        return {
          effect: ctx.v2.t('blueprint.preview.auto_advance', { n: chain.milestoneN, count: runs }),
          refs: [chainRef(project, chain.id)], version: chainStateOf(ctx, project, chain, rails).version,
          cost: { forecastUsd: await launchCost(ctx, project, chain.nextEngine?.provider ?? null, runs), runs },
        }
      },
      handler: async (ctx, args) => {
        const { project, chain } = await chainTarget(ctx, args)
        const body = await api(ctx, 'PATCH', `${projectBase(project)}/blueprint/chains/${encodeURIComponent(chain.id)}`, { autoAdvance: args.enabled === true })
        const fresh = chainsOf(ctx, project)?.get(chain.id) ?? (body.chain as MilestoneChainSnapshot)
        return chainView(ctx, args, project, fresh, await railsOfChain(ctx, project, fresh), 'blueprint.summary.chain_updated', true)
      },
    },
    chain_cancel: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'],
      doc: 'Stop the chain; running rails keep going.',
      preview: async (ctx, args) => {
        const { project, chain } = await chainTarget(ctx, args)
        const rails = await railsOfChain(ctx, project, chain)
        return { effect: ctx.v2.t('blueprint.preview.cancel', { n: chain.milestoneN }), refs: [chainRef(project, chain.id)], version: chainStateOf(ctx, project, chain, rails).version }
      },
      handler: async (ctx, args) => {
        const { project, chain } = await chainTarget(ctx, args)
        const body = await api(ctx, 'POST', `${projectBase(project)}/blueprint/chains/${encodeURIComponent(chain.id)}/cancel`)
        const fresh = chainsOf(ctx, project)?.get(chain.id) ?? (body.chain as MilestoneChainSnapshot)
        return chainView(ctx, args, project, fresh, await railsOfChain(ctx, project, fresh), 'blueprint.summary.chain_updated', true)
      },
    },
    settings_get: {
      tier: 'read',
      doc: 'Usual configuration (provider, model, effort), the launch default, each milestone\'s own engine and the choices.',
      handler: async (ctx, args) => {
        const project = ctx.v2.project(args)
        const base = projectBase(project)
        const [generation, launch, engines] = await Promise.all([
          api(ctx, 'GET', `${base}/blueprint/generation-settings`),
          maybe(ctx, `${base}/blueprint/launch-settings`),
          maybe(ctx, `${base}/blueprint/milestone-engines`),
        ])
        const detail = ctx.v2.view === 'detail'
        const providers = arr(generation.providers).map(rec).map((entry) => {
          const models = arr(entry.models).map(rec)
          return {
            provider: entry.provider, defaultModel: entry.defaultModel,
            models: models.map((model) => model.value),
            ...(detail ? { efforts: entry.effortsByModel } : {}),
          }
        })
        const overrides = Object.fromEntries(Object.entries(rec(engines?.overrides)).filter(([, value]) => rec(value).engine).map(([id, value]) => [id, rec(value).engine]))
        const selection = rec(generation.selection)
        const efforts = rec(arr(generation.providers).map(rec).find((entry) => entry.provider === selection.provider)?.effortsByModel)[String(selection.model)]
        return result({
          usual: generation.selection ?? null, usualEfforts: efforts ?? [], launch: launch?.selection ?? null,
          onlyForMilestone: overrides, providers,
        }, { summary: ctx.v2.t('blueprint.summary.settings', { engine: engineWord(ctx, generation.selection as Row) }), refs: { project: formatRef('project', project.slug) } })
      },
    },
    settings_set: {
      tier: 'write', required: ['options'],
      doc: 'options: provider, model, effort → the usual configuration; with milestone: only for that milestone (options.clear: follow the usual).',
      handler: async (ctx, args) => {
        const options = optionsOf(args)
        const scope = milestoneScope(ctx, args, false)
        const base = projectBase(scope.project)
        const clear = options.clear === true
        const engine = clear ? null : engineBody(options)
        if (!clear && !engine) throw new V2ToolError('invalid_input', ctx.v2.t('blueprint.error.engine_fields'))
        if (scope.n !== null) {
          await api(ctx, 'PUT', `${base}/blueprint/milestone-engines`, { milestoneId: milestoneId(scope.n), engine })
        } else {
          if (clear) throw new V2ToolError('invalid_input', 'clear needs a milestone.')
          await api(ctx, 'PUT', `${base}/blueprint/generation-settings`, engine)
        }
        const word = engine ? engineWord(ctx, engine) : ctx.v2.t('blueprint.engine.default')
        const target = scope.n !== null ? milestoneRef(scope.project, scope.n) : formatRef('project', scope.project.slug)
        return result({ target, engine, ...(scope.n !== null ? { onlyThisMilestone: !clear } : {}) }, {
          summary: ctx.v2.t('blueprint.summary.settings_saved', { engine: scope.n !== null ? `M${scope.n} · ${word}` : word }),
          refs: { [scope.n !== null ? 'milestone' : 'project']: target },
        })
      },
    },
  },
})

export const __test = { offerFor, remainingSpecs }
