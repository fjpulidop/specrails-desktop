import { z } from 'zod'
import { apiRow, maybe } from '../core/loopback'
import { launchForecast, scaledCost } from '../core/forecast'
import type { ProjectRow } from '../../../desktop-db'
import { extractDisplayText } from '../../../util/stream-display'
import { McpApiError, originConversationDefaults } from '../../tools/types'
import { findFailedStep, splitSteps, type LogStep } from '../../tools/job-logs'
import { shortHash } from '../core/canonical'
import { decodeCursor, encodeCursor } from '../core/cursor'
import { needsPerson, type DecisionState } from '../core/decision-state'
import { V2ToolError, oneLine, relay, result } from '../core/envelope'
import { waitMsOf } from '../core/bus'
import { defineTool, type PreviewInput, type V2CallContext } from '../core/registry'
import { formatRef, parseRef, type Ref, type Target } from '../core/refs'
import { statusFromJob, type CanonicalStatus } from '../core/status-map'
import { approxTokens } from '../core/size-guard'
import { neutralize, untrusted } from '../core/untrusted'
import { choicesFromState, type Choice, type ChoicePoint } from '../core/choices'
import { F, WRITE_FIELDS, optionsOf, resolveFields } from '../core/views'
import { projectRunState, type RunFacts } from '../projectors/run-state'

/**
 * WP3 `specrails_runs`: every run the app shows (rail jobs, loop runs, Intent
 * runs), as the run window shows it. A thin facade over the existing routes:
 *
 * - reads: `GET /jobs`, `/jobs/:id` (+ events), `/loop-runs/:id`, `/attempts`,
 *   `/failure-analysis`, `/agent-runtime/runs/:id` (+ evidence), `/queue`;
 * - launch: `POST /rails/launch-specs` (assign + launch in one call),
 *   `/rails/:i/launch`, `/loop-runs`, `/spawn`, `/templates/:id/run`, with the
 *   launch forecast, preflight and capacity in the confirmation preview;
 * - control: pause / resume / stop / limit / remedy / fork / answer / approve /
 *   reject through the same routes the run window calls.
 *
 * The decision state (holds, offers, recommended) comes from
 * `projectors/run-state.ts`; this file adds no legality rule of its own.
 */

type Row = Record<string, unknown>
const rec = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const arr = (value: unknown): unknown[] => Array.isArray(value) ? value : []

export const projectBase = (project: ProjectRow) => `/projects/${encodeURIComponent(project.id)}`
export const IMPLEMENT_LOOP = 'factory:implement'

/** v1 argument names the colliding v1 `specrails_runs` / `specrails_rails` accepted. */
export function compatArgs(args: Row): Row {
  return args.project === undefined && typeof args.projectId === 'string' ? { ...args, project: args.projectId } : args
}

const api = apiRow

// ── Reading a run ───────────────────────────────────────────────────────────

interface EventRow { event_type: string; payload: string | null; timestamp?: string | null }

export interface LoadedRun {
  target: Target
  project: ProjectRow
  job: Row
  events: EventRow[]
  loopRun: Row | null
  attempts: Row | null
  analysis: Row | null
  runtime: Row | null
  steps: LogStep[]
}

const TERMINAL = new Set(['completed', 'failed', 'canceled', 'skipped', 'zombie_terminated'])
const FAILED = new Set(['failed', 'canceled', 'zombie_terminated'])
const isLoop = (job: Row) => typeof job.command === 'string' && job.command.startsWith('loop:')

function runTarget(ctx: V2CallContext, args: Row, kinds: Array<'run' | 'rail'> = ['run']): Target {
  return ctx.v2.target(compatArgs(args), 'run', kinds)
}

export async function loadRun(ctx: V2CallContext, target: Target, need: { runtime?: boolean } = {}): Promise<LoadedRun> {
  const project = target.project!
  const base = `${projectBase(project)}`
  const id = encodeURIComponent(target.id)
  const detail = await api(ctx, 'GET', `${base}/jobs/${id}`)
  const job = rec(detail.job)
  const events = arr(detail.events).map(rec).map((event) => ({
    event_type: String(event.event_type ?? ''),
    payload: typeof event.payload === 'string' ? event.payload : event.payload == null ? null : JSON.stringify(event.payload),
    timestamp: str(event.timestamp),
  }))
  const status = String(job.status ?? '')
  const loop = isLoop(job)
  const failed = FAILED.has(status)
  const [loopRun, attempts, analysis, runtime] = await Promise.all([
    loop ? maybe(ctx, `${base}/loop-runs/${id}`).then((value) => value ? rec(value.loopRun) : null) : null,
    loop && TERMINAL.has(status) ? maybe(ctx, `${base}/loop-runs/${id}/attempts`) : null,
    failed ? maybe(ctx, `${base}/jobs/${id}/failure-analysis?language=${encodeURIComponent(ctx.v2.lang)}`) : null,
    need.runtime || TERMINAL.has(status) ? maybe(ctx, `${base}/agent-runtime/runs/${id}`).then((value) => value ? rec(arr(value.runs)[0]) : null) : null,
  ])
  return { target, project, job, events, loopRun, attempts, analysis, runtime: runtime && Object.keys(runtime).length ? runtime : null, steps: splitSteps(events) }
}

function readyAnalysis(run: LoadedRun): Row | null {
  return run.analysis?.status === 'ready' ? rec(run.analysis.analysis) : null
}

function phaseOf(run: LoadedRun): string | undefined {
  const real = run.steps.filter((step) => step.index !== null)
  const current = real[real.length - 1]
  const loopName = str(run.loopRun?.loop_name)
  const step = str(rec(run.job.hold).step) ?? current?.title ?? null
  const parts = [loopName?.toLowerCase(), step && current ? `${step} · ${real.length}` : step].filter(Boolean)
  return parts.length ? parts.join(' · ') : undefined
}

export function runFacts(run: LoadedRun): RunFacts {
  const job = run.job
  const limit = rec(job.loopPauseLimit ?? run.loopRun?.limitPause)
  const analysis = readyAnalysis(run)
  const diagnosis = rec(job.failureDiagnosis)
  const providerSwitch = rec(run.attempts?.providerSwitch)
  const facts: RunFacts = {
    jobStatus: String(job.status ?? ''),
    hold: job.hold ? job.hold as RunFacts['hold'] : null,
    pauseControl: (str(job.pauseControl) as RunFacts['pauseControl']) ?? null,
    limit: Object.keys(limit).length ? { switchTargets: arr(limit.switchTargets) as never, switchable: limit.switchable === true } : null,
    remedies: arr(diagnosis.remedies) as never,
    analysis: analysis ? { options: arr(analysis.options) as never, createdAt: str(run.analysis?.createdAt) } : null,
    settledSwitch: arr(providerSwitch.targets).length ? { targets: arr(providerSwitch.targets) as never } : null,
    runtime: run.runtime ? { canSettle: run.runtime.canSettle === true, canDismiss: run.runtime.canDismiss === true && run.runtime.dismissed !== true } : null,
    railIndex: num(run.loopRun?.rail_index),
    spentUsd: num(job.total_cost_usd),
    costEstimated: job.total_cost_usd_estimated === 1 || job.total_cost_usd_estimated === true,
    versionFacts: { f: job.finished_at ?? null, a: run.analysis?.createdAt ?? null, c: run.attempts?.continuable ?? null },
  }
  if (typeof run.attempts?.continuable === 'boolean') facts.continuable = run.attempts.continuable
  const phase = phaseOf(run)
  if (phase) facts.phase = phase
  return facts
}

export function runState(ctx: V2CallContext, run: LoadedRun): DecisionState {
  return ctx.v2.state(projectRunState(run.target.ref, runFacts(run), ctx.v2.t))
}

function specRefs(project: ProjectRow, job: Row): Ref[] {
  const tickets = arr(job.tickets).map(rec)
  const ids = tickets.map((ticket) => num(ticket.id) ?? num(ticket.ticketId)).filter((id): id is number => id !== null)
  if (!ids.length && typeof job.ticketId === 'number') ids.push(job.ticketId)
  return [...new Set(ids)].map((id) => formatRef('spec', id, project.slug))
}

function titleOf(job: Row): string {
  const ticket = rec(arr(job.tickets)[0])
  const title = str(ticket.title) ?? str(job.ticketTitle)
  const id = num(ticket.id) ?? num(job.ticketId)
  if (title) return oneLine(neutralize(id !== null ? `#${id} ${title}` : title), 90)
  return oneLine(neutralize(String(job.command ?? 'run')), 90)
}

function questionView(job: Row): Row | null {
  const question = rec(job.question)
  if (!Object.keys(question).length) return null
  return {
    kind: question.kind, text: oneLine(neutralize(String(question.text ?? '')), 600),
    ...(str(question.why) ? { why: oneLine(neutralize(String(question.why)), 300) } : {}),
    ...(str(question.detail) ? { detail: oneLine(neutralize(String(question.detail)), 400) } : {}),
    options: arr(question.options).map(rec).map((option) => ({ id: option.id, label: oneLine(neutralize(String(option.label ?? '')), 160) })),
    ...(str(question.recommended) ? { recommended: question.recommended } : {}),
    ...(question.canReject === true ? { canReject: true } : {}),
    ...(arr(question.endsRun).length ? { endsRun: question.endsRun } : {}),
  }
}

/** The lean run shape (summary view). */
function runSummary(run: LoadedRun): Row {
  const { job, project } = run
  const loopRun = run.loopRun ?? {}
  const diagnosis = rec(job.failureDiagnosis)
  const limit = rec(job.loopPauseLimit ?? loopRun.limitPause)
  const real = run.steps.filter((step) => step.index !== null)
  const current = real[real.length - 1]
  const rail = num(loopRun.rail_index)
  const attempt = rec(run.attempts?.chain)
  const view: Row = {
    ref: run.target.ref, title: titleOf(job), kind: isLoop(job) ? 'loop' : 'job', jobStatus: job.status,
    ...engineOf(run, job, loopRun),
    startedAt: job.started_at ?? null, finishedAt: job.finished_at ?? null, durationMs: job.duration_ms ?? null,
    costUsd: job.total_cost_usd ?? null,
    specs: specRefs(project, job),
    ...(rail !== null ? { rail: formatRef('rail', rail, project.slug) } : {}),
    ...(current ? { step: { index: current.index, title: current.title, status: current.status, of: real.length } } : {}),
  }
  const question = questionView(job)
  if (question) view.question = question
  if (job.loopPauseBudget) view.budget = job.loopPauseBudget
  if (Object.keys(limit).length) {
    view.limit = { provider: limit.providerId, resumeAt: limit.resumeAt ?? null, autoResume: limit.autoResume === true,
      switchTargets: arr(limit.switchTargets).slice(0, 4) }
  }
  if (Object.keys(diagnosis).length) {
    view.failure = { kind: diagnosis.kind, ...(str(diagnosis.detail) ? { detail: oneLine(neutralize(String(diagnosis.detail)), 400) } : {}),
      ...(str(diagnosis.phase) ? { step: diagnosis.phase } : {}), ...(arr(diagnosis.failingTests).length ? { failingTests: arr(diagnosis.failingTests).slice(0, 5) } : {}) }
  }
  if (typeof attempt.attempt === 'number') view.attempt = { n: attempt.attempt, of: arr(attempt.attempts).length }
  return view
}

const RUN_FIELDS = ['steps', 'graph', 'logs', 'narrated', 'verification', 'cost', 'attempts', 'events'] as const
type RunField = (typeof RUN_FIELDS)[number]
const LOG_BYTES = 10_500

function stepMatches(step: LogStep, selector: unknown): boolean {
  if (typeof selector === 'number') return step.index === selector
  if (typeof selector !== 'string') return false
  return step.title === selector || step.title.endsWith(`/${selector}`) || String(step.index) === selector
}

/**
 * The engine a run works on now. The row keeps its launch provider/model; a switch at a usage limit
 * (`provider_switched`, roles moved for the rest of the run) wins, as on the live board.
 */
function engineOf(run: LoadedRun, job: Row, loopRun: Row): Row {
  const launched: Row = { provider: job.provider ?? loopRun.provider ?? null, model: job.model ?? loopRun.model ?? null, ...(str(loopRun.reasoning_effort) ? { effort: loopRun.reasoning_effort } : {}) }
  const event = [...run.events].reverse().find((entry) => entry.event_type === 'provider_switched')
  if (!event?.payload) return launched
  try {
    const moved = rec(JSON.parse(event.payload))
    if (!str(moved.provider) || (Array.isArray(moved.roles) && moved.roles.length === 0)) return launched
    return { provider: moved.provider, model: str(moved.model), ...(str(moved.effort) ? { effort: moved.effort } : {}), switchedFrom: str(moved.fromProvider) ?? launched.provider }
  } catch { return launched }
}

/** Newest-first page of log lines: the failed step first on a failed run, or one step (`options.step`). */
function logsSection(run: LoadedRun, args: Row, t: V2CallContext['v2']['t']): Row {
  const options = optionsOf(args)
  const failed = FAILED.has(String(run.job.status))
  let selected: LogStep[]
  if (options.step !== undefined) {
    selected = run.steps.filter((step) => stepMatches(step, options.step))
    if (!selected.length) throw new V2ToolError('invalid_input', t('runs.error.unknown_step', { step: String(options.step), steps: run.steps.map((step) => step.title).slice(0, 20).join(', ') }))
  } else if (failed) {
    const failedStep = findFailedStep(run.steps, str(rec(run.job.failureDiagnosis).phase))
    selected = failedStep ? run.steps.slice(run.steps.indexOf(failedStep)) : run.steps
  } else selected = run.steps
  const lines = selected.flatMap((step) => step.lines)
  const cursor = decodeCursor(args.cursor)
  const skip = cursor?.key === 'logs' ? cursor.offset : 0
  const max = Math.min(400, Math.max(1, typeof options.lines === 'number' ? Math.floor(options.lines) : 150))
  const end = Math.max(0, lines.length - skip)
  const page: string[] = []
  let bytes = 0
  for (let index = end - 1; index >= 0 && page.length < max; index--) {
    const line = oneLine(neutralize(lines[index]), 400)
    bytes += line.length + 4
    if (bytes > LOG_BYTES && page.length) break
    page.unshift(line)
  }
  const from = end - page.length
  return {
    steps: selected.map((step) => ({ index: step.index, title: step.title, status: step.status })).slice(0, 12),
    total: lines.length, from, to: end, lines: page,
    next: from > 0 ? encodeCursor({ offset: skip + page.length, path: '/data/logs/lines', key: 'logs' }) : null,
  }
}

/** Per step: what the agent said (its assistant messages), not the tool noise. */
function narratedSection(run: LoadedRun): Row[] {
  const steps: Array<{ index: number | null; title: string; status: string | null; said: string[] }> = []
  let current = { index: null as number | null, title: '(before the first step)', status: null as string | null, said: [] as string[] }
  const parse = (payload: string | null) => { try { return rec(JSON.parse(payload ?? '{}')) } catch { return {} } }
  for (const event of run.events) {
    if (event.event_type === 'loop_step') {
      if (current.said.length || current.index !== null) steps.push(current)
      const payload = parse(event.payload)
      current = { index: num(payload.index), title: str(payload.title) ?? `step ${steps.length + 1}`, status: 'running', said: [] }
    } else if (event.event_type === 'loop_step_end') {
      const status = str(parse(event.payload).status)
      if (status) current.status = status
    } else if (event.event_type === 'assistant') {
      const text = extractDisplayText(parse(event.payload))
      if (text && text.trim()) current.said = [...current.said, oneLine(neutralize(text), 300)].slice(-3)
    }
  }
  if (current.said.length || current.index !== null) steps.push(current)
  return steps.slice(-30)
}

function graphSection(run: LoadedRun): Row {
  const loopRun = run.loopRun ?? {}
  let checkpoint: Row = {}
  try { checkpoint = rec(JSON.parse(String(loopRun.runtime_status_json ?? '{}'))) } catch { checkpoint = {} }
  const nodes = Object.entries(rec(checkpoint.steps)).slice(0, 60).map(([id, value]) => ({ id, status: rec(value).status ?? null, ...(num(rec(value).visits) ? { visits: rec(value).visits } : {}) }))
  return {
    loop: { id: loopRun.loop_id ?? null, name: loopRun.loop_name ?? null }, iteration: loopRun.iteration_count ?? null,
    status: checkpoint.status ?? loopRun.status ?? null, nextStep: checkpoint.nextStep ?? null,
    nodes: nodes.length ? nodes : run.steps.filter((step) => step.index !== null).map((step) => ({ id: step.title, status: step.status })),
    ...(arr(checkpoint.recoverableSteps).length ? { recoverable: arr(checkpoint.recoverableSteps).map((step) => rec(step).nodePath).slice(0, 10) } : {}),
  }
}

async function verificationSection(ctx: V2CallContext, run: LoadedRun): Promise<Row> {
  const diagnosis = rec(run.job.failureDiagnosis)
  const evidence = run.runtime ? await maybe(ctx, `${projectBase(run.project)}/agent-runtime/runs/${encodeURIComponent(run.target.id)}/evidence?limit=10`) : null
  return {
    completion: run.runtime?.completion ?? null,
    ...(arr(diagnosis.failingTests).length ? { failingTests: arr(diagnosis.failingTests).slice(0, 10) } : {}),
    ...(arr(diagnosis.flakyTests).length ? { flakyTests: arr(diagnosis.flakyTests).slice(0, 10) } : {}),
    evidence: evidence ? { items: arr(evidence.items ?? evidence.evidence).slice(0, 10), next: evidence.nextCursor ?? evidence.cursor ?? null } : null,
  }
}

async function costSection(ctx: V2CallContext, run: LoadedRun): Promise<Row> {
  const { job, project } = run
  const base = projectBase(project)
  const chain = arr(rec(run.attempts?.chain).attempts).map(rec).slice(-8)
  const [phases, attemptRuns] = await Promise.all([
    maybe(ctx, `${base}/jobs/${encodeURIComponent(run.target.id)}/phase-breakdown`),
    Promise.all(chain.map((attempt) => attempt.runId === run.target.id ? Promise.resolve(run.loopRun) : maybe(ctx, `${base}/loop-runs/${encodeURIComponent(String(attempt.runId))}`).then((value) => value ? rec(value.loopRun) : null))),
  ])
  const byProvider = new Map<string, { provider: string; model: string | null; costUsd: number; runs: number }>()
  const add = (provider: unknown, model: unknown, cost: unknown) => {
    const key = str(provider) ?? 'unknown'
    const entry = byProvider.get(key) ?? { provider: key, model: str(model), costUsd: 0, runs: 0 }
    entry.costUsd = Math.round((entry.costUsd + (num(cost) ?? 0)) * 10_000) / 10_000
    entry.runs += 1
    byProvider.set(key, entry)
  }
  if (chain.length) chain.forEach((attempt, index) => add(attemptRuns[index]?.provider, attemptRuns[index]?.model, attempt.costUsd))
  else add(job.provider ?? run.loopRun?.provider, job.model ?? run.loopRun?.model, job.total_cost_usd)
  const resolution = rec(run.attempts?.resolution)
  return {
    totalUsd: job.total_cost_usd ?? null, estimated: job.total_cost_usd_estimated === 1 || job.total_cost_usd_estimated === true,
    tokens: { in: job.tokens_in ?? null, out: job.tokens_out ?? null, cacheRead: job.tokens_cache_read ?? null },
    byProvider: [...byProvider.values()],
    ...(num(resolution.costUsd) !== null ? { chainUsd: resolution.costUsd } : {}),
    phases: arr(rec(phases?.breakdown).phases ?? phases?.breakdown).slice(0, 12),
  }
}

function attemptsSection(run: LoadedRun): Row {
  const chain = rec(run.attempts?.chain)
  const slug = run.project.slug
  return {
    attempt: chain.attempt ?? null,
    attempts: arr(chain.attempts).map(rec).slice(-10).map((attempt) => ({
      ref: formatRef('run', String(attempt.runId), slug), n: attempt.attempt, status: attempt.status, outcome: attempt.outcome ?? null,
      startedAt: attempt.startedAt ?? null, finishedAt: attempt.finishedAt ?? null, fromStep: attempt.fromStep ?? null, costUsd: attempt.costUsd ?? null,
    })),
    continuable: run.attempts?.continuable ?? null,
    ...(run.attempts?.resolution ? { resolution: run.attempts.resolution } : {}),
    ...(run.attempts?.providerSwitch ? { providerSwitch: run.attempts.providerSwitch } : {}),
  }
}

function eventsSection(run: LoadedRun, args: Row): Row {
  const cursor = decodeCursor(args.cursor)
  const skip = cursor?.key === 'events' ? cursor.offset : 0
  const end = Math.max(0, run.events.length - skip)
  const start = Math.max(0, end - 25)
  const items = run.events.slice(start, end).map((event) => {
    let text: string | null = null
    try { const payload = rec(JSON.parse(event.payload ?? '{}')); text = extractDisplayText(payload) ?? str(payload.line) ?? str(payload.text) ?? str(payload.title) } catch { text = event.payload }
    return { type: event.event_type, at: event.timestamp ?? null, ...(text ? { text: oneLine(neutralize(text), 240) } : {}) }
  })
  return { total: run.events.length, items, next: start > 0 ? encodeCursor({ offset: skip + items.length, path: '/data/events/items', key: 'events' }) : null }
}

async function detailOf(ctx: V2CallContext, run: LoadedRun, args: Row, fields: RunField[]): Promise<Row> {
  const out: Row = {}
  for (const field of fields) {
    if (field === 'steps') out.steps = run.steps.map((step) => ({ index: step.index, title: step.title, status: step.status, lines: step.lines.length })).slice(-40)
    if (field === 'graph') out.graph = graphSection(run)
    if (field === 'logs') out.logs = logsSection(run, args, ctx.v2.t)
    if (field === 'narrated') out.narrated = narratedSection(run)
    if (field === 'verification') out.verification = await verificationSection(ctx, run)
    if (field === 'cost') out.cost = await costSection(ctx, run)
    if (field === 'attempts') out.attempts = attemptsSection(run)
    if (field === 'events') out.events = eventsSection(run, args)
  }
  return out
}

const RUN_UNTRUSTED = untrusted('/data/title', '/data/question/*', '/data/failure/detail', '/data/logs/lines/*', '/data/narrated/*/said/*',
  '/data/events/items/*/text', '/data/verification/evidence/*', '/state/offers/*/label', '/state/offers/*/why')

function summaryOf(ctx: V2CallContext, title: string, state: DecisionState): string {
  return state.hold ? ctx.v2.t('runs.summary.get_hold', { title, status: state.label, reason: state.hold.reason }) : ctx.v2.t('runs.summary.get', { title, status: state.label })
}

const PAUSE_WAIT_MS = 25_000
const PAUSE_WAIT_MAX_MS = 45_000

/** Re-reads the run (every second, ≤ `waitMs`) until it holds or ends; never throws. */
async function untilHeld(ctx: V2CallContext, target: Target, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline && !ctx.signal?.aborted) {
    const run = await loadRun(ctx, target).catch(() => null)
    if (!run) return
    const state = runState(ctx, run)
    if (state.hold || !['running', 'queued'].includes(state.status)) return
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))))
  }
}

/** A control's answer: the server's own response, plus the run's fresh state when it is cheap to read. */
async function accepted(ctx: V2CallContext, target: Target, label: string, data: Row): Promise<ReturnType<typeof result>> {
  const accept = ctx.v2.t('runs.summary.accepted', { label })
  // The run as it stands right after the control (status, hold, the moves it offers now), so no re-read is needed.
  const fresh = target.kind === 'run' ? await loadRun(ctx, target).catch(() => null) : null
  if (!fresh) return result({ ref: target.ref, ...data }, { summary: accept, refs: { run: target.ref } })
  const state = runState(ctx, fresh)
  return result({ ref: target.ref, ...data, status: state.status }, { summary: `${accept} ${summaryOf(ctx, titleOf(fresh.job), state)}`, refs: { run: target.ref }, state, untrusted: untrusted('/state/offers/*/label', '/state/offers/*/why') })
}

/** Refuses a call the run's current state does not offer (`held`, with the state). */
function requireOffer(ctx: V2CallContext, state: DecisionState, matches: (offer: DecisionState['offers'][number]) => boolean): void {
  if (state.offers.some(matches)) return
  // Name what the run does offer, so the agent picks one instead of guessing another choice.
  const offered = state.offers.map((offer) => {
    const a = offer.call.args as Row
    return `${offer.call.tool.replace(/^specrails_/, '')}(${[a.action, a.choice ?? a.optionId ?? a.decision].filter((part) => typeof part === 'string').join(' ')})`
  })
  const message = [ctx.v2.t('runs.error.not_held', { label: `specrails_runs(${ctx.v2.action})`, status: state.label }), ...(offered.length ? [ctx.v2.t('runs.error.offered', { offers: [...new Set(offered)].join(', ') })] : [])].join(' ')
  throw new V2ToolError('held', message, { state })
}

// ── Decision points (the person picks: core/choices.ts) ────────────────────

/** A run question as a menu (its options, the recommended first) plus a free answer; an approval: approve, or reject with a reason. */
async function answerPoint(ctx: V2CallContext, args: Row): Promise<ChoicePoint | null> {
  const run = await loadRun(ctx, runTarget(ctx, args), { runtime: true })
  const state = runState(ctx, run)
  const ref = run.target.ref
  const question = rec(run.job.question)
  const text = oneLine(neutralize(String(question.text ?? state.hold?.reason ?? state.label)), 300)
  if (state.offers.some((offer) => offer.id === 'answer')) {
    const effect = ctx.v2.t('core.choice.run.answer')
    const choices: Choice[] = arr(question.options).map(rec).filter((option) => option.id !== undefined && option.id !== null).map((option) => ({
      id: String(option.id), label: oneLine(neutralize(String(option.label ?? option.id)), 80), effect,
      ...(question.recommended === option.id ? { recommended: true } : {}),
      call: { tool: 'specrails_runs', args: { action: 'answer', ref, optionId: option.id } },
    }))
    return { question: text, choices, other: { call: { tool: 'specrails_runs', args: { action: 'answer', ref } }, field: 'answer' } }
  }
  const approve = state.offers.find((offer) => offer.id === 'approve')
  if (!approve) return null
  const reject = state.offers.find((offer) => offer.id === 'reject')
  return {
    question: text, choices: choicesFromState(state, (offer) => offer.id === 'approve'),
    ...(reject ? { other: { call: reject.call, field: 'answer', title: ctx.v2.t('core.choose.other_reject') } } : {}),
  }
}

/** A provider-limit pause as a menu: try again, resume at the reset, or continue on each provider it can switch to. */
async function limitPoint(ctx: V2CallContext, args: Row): Promise<ChoicePoint | null> {
  const { target } = await runOrRail(ctx, args)
  const run = await loadRun(ctx, target)
  const state = runState(ctx, run)
  const limits = state.offers.filter((offer) => offer.call.args.action === 'limit')
  if (!limits.length) return null
  const targets = arr(rec(run.job.loopPauseLimit ?? run.loopRun?.limitPause).switchTargets).map(rec).filter((candidate) => str(candidate.provider))
  const choices = choicesFromState(state, (offer) => offer.call.args.action === 'limit' && offer.call.args.choice !== 'switch')
  const switchOffer = limits.find((offer) => offer.call.args.choice === 'switch')
  if (switchOffer) {
    for (const [index, candidate] of targets.entries()) {
      const provider = String(candidate.provider)
      choices.push({
        id: index === 0 ? switchOffer.id : `limit.switch.${provider}`,
        label: ctx.v2.t('runs.offer.continue_on', { provider }), effect: ctx.v2.t('runs.choice.continue_on', { provider }),
        ...(index === 0 && state.recommended === switchOffer.id ? { recommended: true } : {}),
        call: { tool: 'specrails_runs', args: { action: 'limit', ref: target.ref, choice: 'switch', provider, ...(str(candidate.model) ? { model: candidate.model } : {}) } },
      })
    }
  }
  return { question: oneLine(`${titleOf(run.job)} — ${state.hold?.reason ?? state.label}`, 300), choices }
}

// ── Rails helpers (shared with rails.ts) ────────────────────────────────────

export async function railsSnapshot(ctx: V2CallContext, project: ProjectRow): Promise<Row> {
  return api(ctx, 'GET', `${projectBase(project)}/rails`)
}

/** The active run of a rail (job or loop run), or null. */
export function railRunId(snapshot: Row, railIndex: number): string | null {
  const job = rec(rec(snapshot.activeJobs)[String(railIndex)])
  const loop = rec(rec(snapshot.activeLoopRuns)[String(railIndex)])
  return str(loop.loopRunId) ?? str(job.jobId)
}

async function runOrRail(ctx: V2CallContext, args: Row): Promise<{ target: Target; rail: number | null }> {
  const target = runTarget(ctx, args, ['run', 'rail'])
  if (target.kind === 'run') return { target, rail: null }
  const rail = Number(target.id)
  const snapshot = await railsSnapshot(ctx, target.project!)
  const runId = railRunId(snapshot, rail)
  if (!runId) throw new V2ToolError('conflict', ctx.v2.t('runs.error.rail_idle', { rail: rail + 1 }))
  return { target: { kind: 'run', id: runId, project: target.project, ref: formatRef('run', runId, target.project!.slug) }, rail }
}

// ── Launch ──────────────────────────────────────────────────────────────────

/** Launch-time engine choices of a call (and the in-app conversation's defaults, as v1 did). */
export function launchBody(ctx: V2CallContext, args: Row): Row {
  const options = optionsOf(args)
  const body: Row = {}
  if (str(args.provider)) body.aiEngine = args.provider
  if (str(args.model)) body.model = args.model
  if (str(args.effort)) body.reasoning_effort = args.effort
  const pass: Record<string, string> = { profile: 'profileName', runCapUsd: 'runCapUsd', targetPr: 'targetPrNumber', repositoryIds: 'repositoryIds', workspaceSelection: 'workspaceSelection', baseBranch: 'baseBranch', loopId: 'loopId', mode: 'mode', revisionOf: 'revisionOfDeliveryId', revisionNote: 'revisionNote', followUp: 'followUp', runtimeProviderOverride: 'runtimeProviderOverride' }
  for (const [from, to] of Object.entries(pass)) if (options[from] !== undefined) body[to] = options[from]
  if (body.loopId && body.loopId !== IMPLEMENT_LOOP && body.mode === undefined) body.mode = 'loop'
  if (ctx.originConversationId) {
    body.originConversationId = ctx.originConversationId
    body.originSurface = 'agent-chat'
  }
  // The in-app mission's provider/model/effort carry over; an external client's log mission imposes none.
  if (ctx.originConversationId && ctx.firstPartyAgent) {
    const defaults = originConversationDefaults(ctx)
    if (body.aiEngine === undefined && defaults.provider) body.aiEngine = defaults.provider
    if (body.model === undefined && defaults.model && body.aiEngine === defaults.provider) body.model = defaults.model
    if (body.reasoning_effort === undefined && defaults.reasoningEffort && body.aiEngine === defaults.provider && (!defaults.model || body.model === defaults.model)) body.reasoning_effort = defaults.reasoningEffort
  }
  return body
}

function specIdsOf(ctx: V2CallContext, values: unknown): number[] {
  const ids = arr(values).map((value) => {
    if (typeof value === 'number') return value
    const parsed = parseRef(value)
    const id = Number(parsed ? parsed.id : value)
    return Number.isSafeInteger(id) && id > 0 ? id : NaN
  })
  if (!ids.length || ids.some((id) => !Number.isSafeInteger(id))) throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.bad_target'))
  return [...new Set(ids)]
}

interface LaunchPlan {
  kind: 'specs' | 'rail' | 'loop' | 'command' | 'template'
  project: ProjectRow
  groups: number[][]
  rail: number | null
  forecast: { loopId?: string; command?: string } | null
  runs: number
  what: string
}

function launchPlan(ctx: V2CallContext, args: Row): LaunchPlan {
  const target = rec(args.target)
  const options = optionsOf(args)
  const specRef = arr(target.specIds).map(parseRef).find((ref) => ref?.project)
  const project = specRef?.project && !args.project ? ctx.v2.project({ project: specRef.project }) : ctx.v2.project(compatArgs(args))
  const loopId = str(target.loopId) ?? str(options.loopId)
  if (target.specIds !== undefined) {
    const ids = specIdsOf(ctx, target.specIds)
    const railArg = target.rail
    const rail = railArg === undefined || railArg === null ? null : Number(parseRef(railArg)?.id ?? railArg)
    const groups = options.parallel === true && rail === null ? ids.map((id) => [id]) : [ids]
    return { kind: 'specs', project, groups, rail: Number.isSafeInteger(rail) ? rail : null, forecast: { loopId: loopId ?? IMPLEMENT_LOOP }, runs: groups.length, what: ids.map((id) => `#${id}`).join(', ') }
  }
  if (target.rail !== undefined && target.rail !== null) {
    const rail = Number(parseRef(target.rail)?.id ?? target.rail)
    if (!Number.isSafeInteger(rail) || rail < 0) throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.bad_target'))
    return { kind: 'rail', project, groups: [], rail, forecast: { loopId: loopId ?? IMPLEMENT_LOOP }, runs: 1, what: `Rail ${rail + 1}` }
  }
  if (loopId) return { kind: 'loop', project, groups: [], rail: null, forecast: { loopId }, runs: 1, what: loopId }
  if (str(target.command)) return { kind: 'command', project, groups: [], rail: null, forecast: { command: String(target.command) }, runs: 1, what: String(target.command) }
  if (str(target.template)) return { kind: 'template', project, groups: [], rail: null, forecast: null, runs: 1, what: `template ${target.template}` }
  throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.bad_target'))
}

const CHIP_WORD = (chip: Row) => chip.kind === 'provider' ? `${chip.providerId} ${chip.status}` : chip.kind === 'quota' ? `${chip.providerId} quota ${chip.level}` : chip.kind === 'disk' ? 'low disk space' : chip.kind === 'github' ? `GitHub ${chip.status}` : String(chip.id)

/** Forecast, preflight and capacity of a launch: the facts the app's launch dialog shows. */
export async function launchPreview(ctx: V2CallContext, project: ProjectRow, input: { forecast: LaunchPlan['forecast']; provider: string | null; runs: number; effect: string; versionFacts: unknown }): Promise<PreviewInput> {
  const [forecast, preflight, capacity] = await Promise.all([
    input.forecast ? launchForecast(ctx, project, { loopId: input.forecast.loopId, command: input.forecast.command, provider: input.provider }) : null,
    maybe(ctx, `/launch-preflight?${new URLSearchParams({ projectId: project.id, providers: input.provider ?? '' })}`),
    maybe(ctx, '/capacity'),
  ])
  const sentences = [input.effect]
  const time = rec(forecast?.time)
  if (num(time.p25Ms) !== null && num(time.p75Ms) !== null) sentences.push(ctx.v2.t('runs.preview.time', { low: Math.round(Number(time.p25Ms) / 60_000), high: Math.round(Number(time.p75Ms) / 60_000) }))
  const chips = arr(preflight?.chips).map(rec)
  const failing = chips.filter((chip) => chip.state === 'fail').map(CHIP_WORD)
  const warning = chips.filter((chip) => chip.state === 'warn').map(CHIP_WORD)
  if (failing.length) sentences.push(ctx.v2.t('runs.preview.blocking', { chips: failing.join(', ') }))
  if (warning.length) sentences.push(ctx.v2.t('runs.preview.warn', { chips: warning.join(', ') }))
  if (capacity?.enabled === true && arr(capacity.queued).length) sentences.push(ctx.v2.t('runs.preview.queue', { running: arr(capacity.running).length }))
  const range = scaledCost(forecast, input.runs)
  return { effect: sentences.join(' '), refs: [], version: `l${shortHash({ f: input.versionFacts, b: preflight?.blocking === true, n: input.runs })}`, cost: { forecastUsd: range, runs: input.runs } }
}

function launchedRefs(project: ProjectRow, response: Row): Ref[] {
  const ids = [...arr(response.loopRunIds), ...arr(response.jobIds), ...(str(response.jobId) ? [response.jobId] : []), ...(str(response.loopRunId) ? [response.loopRunId] : [])]
  return [...new Set(ids.filter((id): id is string => typeof id === 'string'))].map((id) => formatRef('run', id, project.slug))
}

function launchOutcome(project: ProjectRow, response: Row): Row {
  const rail = num(response.railIndex)
  return {
    runs: launchedRefs(project, response),
    ...(rail !== null ? { rail: formatRef('rail', rail, project.slug), railLabel: `Rail ${rail + 1}` } : {}),
    ...(response.railCreated ? { railCreated: true } : {}),
    ...(typeof response.isolated === 'boolean' ? { isolated: response.isolated } : {}),
    ...(str(response.isolationUnavailable) ? { isolationUnavailable: response.isolationUnavailable } : {}),
    ...(str(response.prDeliveryId) ? { delivery: formatRef('delivery', String(response.prDeliveryId), project.slug) } : {}),
  }
}

async function launch(ctx: V2CallContext, args: Row): Promise<unknown> {
  const plan = launchPlan(ctx, args)
  const base = projectBase(plan.project)
  const body = launchBody(ctx, args)
  const target = rec(args.target)
  const launched: Row[] = []
  const refused: Row[] = []
  const attempt = async (group: number[] | null, call: () => Promise<Row>) => {
    try { launched.push(launchOutcome(plan.project, await call())) } catch (err) {
      if (plan.kind !== 'specs' || plan.groups.length === 1) throw err
      refused.push({ specs: (group ?? []).map((id) => formatRef('spec', id, plan.project.slug)), error: err instanceof McpApiError ? err.code ?? err.message : String(err), ...(err instanceof McpApiError ? { detail: rec(err.data).detail ?? null } : {}) })
    }
  }
  if (plan.kind === 'specs') {
    // One at a time: each assignment must see the rails the previous launch took.
    for (const group of plan.groups) await attempt(group, () => api(ctx, 'POST', `${base}/rails/launch-specs`, { ...body, specIds: group, ...(plan.rail !== null ? { railIndex: plan.rail } : {}) }))
  } else if (plan.kind === 'rail') {
    await attempt(null, async () => ({ railIndex: plan.rail, ...await api(ctx, 'POST', `${base}/rails/${plan.rail}/launch`, body) }))
  } else if (plan.kind === 'loop') {
    await attempt(null, () => api(ctx, 'POST', `${base}/loop-runs`, { loopId: plan.forecast?.loopId, ...(body.aiEngine ? { aiEngine: body.aiEngine } : {}), ...(body.model ? { model: body.model } : {}), ...(body.reasoning_effort ? { reasoning_effort: body.reasoning_effort } : {}), ...(body.runCapUsd !== undefined ? { runCapUsd: body.runCapUsd } : {}) }))
  } else if (plan.kind === 'command') {
    await attempt(null, () => api(ctx, 'POST', `${base}/spawn`, { command: target.command, ...(body.aiEngine ? { aiEngine: body.aiEngine } : {}), ...(body.model ? { model: body.model } : {}), ...(body.profileName !== undefined ? { profileName: body.profileName } : {}) }))
  } else {
    await attempt(null, () => api(ctx, 'POST', `${base}/templates/${encodeURIComponent(String(target.template))}/run`, {}))
  }
  const runs = launched.flatMap((item) => item.runs as Ref[])
  const refs = Object.fromEntries(runs.map((ref, index) => [`run${index + 1}`, ref]))
  if (!launched.length) throw new V2ToolError('conflict', ctx.v2.t('runs.summary.launch_all_none'), { retryable: false })
  return result({ launched, ...(refused.length ? { refused } : {}) }, {
    summary: refused.length ? ctx.v2.t('runs.summary.launched_partial', { count: runs.length, failed: refused.length }) : ctx.v2.t('runs.summary.launched', { count: runs.length }),
    refs,
  })
}

async function launchPreviewOf(ctx: V2CallContext, args: Row): Promise<PreviewInput> {
  const plan = launchPlan(ctx, args)
  const body = launchBody(ctx, args)
  // A rail launch needs specs on the rail: refuse at preview time, before the person is asked to agree.
  let railSpecs: number[] | null = null
  if (plan.kind === 'rail' && plan.rail !== null) {
    const rail = arr(rec(await railsSnapshot(ctx, plan.project)).rails).map(rec).find((row) => Number(row.railIndex) === plan.rail)
    railSpecs = arr(rail?.ticketIds).filter((id): id is number => typeof id === 'number')
    if (!railSpecs.length) throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.rail_empty', { rail: plan.rail + 1 }), { next: [{ tool: 'specrails_rails', args: { action: 'list', project: plan.project.slug }, why: 'The rails and their specs.' }] })
  }
  const sequential = plan.kind === 'specs' && plan.groups.length === 1 && plan.groups[0].length > 1 && plan.rail === null
  const effect = [ctx.v2.t('runs.preview.launch', { count: plan.runs, what: plan.what }), ...(sequential ? [ctx.v2.t('runs.preview.sequential')] : [])].join(' ')
  return launchPreview(ctx, plan.project, {
    forecast: plan.forecast, provider: str(body.aiEngine), runs: plan.runs, effect,
    versionFacts: { k: plan.kind, g: plan.groups, r: plan.rail, ...(railSpecs ? { s: railSpecs } : {}) },
  })
}

/** A draft or published PR covering the rail's specs continues it (v1 launch_all rule, kept identical). */
function deliveryContinuesSpecs(raw: unknown, ticketIds: number[]): boolean {
  const row = rec(raw)
  if (row.decision !== 'pr_draft' && row.decision !== 'pr_ready') return false
  if (!str(row.prUrl) || !str(row.branch) || row.prState !== 'pr-created') return false
  const covered = new Set(arr(row.ticketIds).filter((id): id is number => typeof id === 'number'))
  return ticketIds.length > 0 && ticketIds.every((id) => covered.has(id))
}

function launchAllPlan(snapshot: Row): { eligible: Array<{ index: number; mode?: string; ticketIds: number[] }>; skipped: Row[] } {
  const eligible: Array<{ index: number; mode?: string; ticketIds: number[] }> = []
  const skipped: Row[] = []
  for (const rail of arr(snapshot.rails).map(rec)) {
    const index = Number(rail.railIndex)
    const ticketIds = arr(rail.ticketIds).filter((id): id is number => typeof id === 'number')
    const key = String(index)
    if (!ticketIds.length) skipped.push({ index, reason: 'empty' })
    else if (key in rec(snapshot.activeJobs) || key in rec(snapshot.activeLoopRuns)) skipped.push({ index, reason: 'already-running' })
    else if (key in rec(snapshot.prDeliveries) && !deliveryContinuesSpecs(rec(snapshot.prDeliveries)[key], ticketIds)) skipped.push({ index, reason: 'pr-decision-pending' })
    else eligible.push({ index, ...(str(rail.mode) ? { mode: String(rail.mode) } : {}), ticketIds })
  }
  return { eligible, skipped }
}

// ── Control helpers ─────────────────────────────────────────────────────────

/** Definition (Core) runs answer through `/loop-runs/:id/resume`; older runtime continuations through `/agent-runtime/runs/:id/resume`. */
function resumePath(run: LoadedRun): string {
  const id = encodeURIComponent(run.target.id)
  const definition = run.loopRun !== null || run.runtime?.engineVersion === 2
  return definition ? `${projectBase(run.project)}/loop-runs/${id}/resume` : `${projectBase(run.project)}/agent-runtime/runs/${id}/resume`
}

async function costedPreview(ctx: V2CallContext, args: Row, effectKey: string, extra: Record<string, string> = {}): Promise<PreviewInput> {
  const { target } = await runOrRail(ctx, args)
  const run = await loadRun(ctx, target)
  const state = runState(ctx, run)
  const provider = str(args.provider) ?? str(run.job.provider) ?? str(run.loopRun?.provider)
  const loopId = str(run.loopRun?.loop_id)
  const base = await launchPreview(ctx, run.project, {
    forecast: loopId ? { loopId } : { command: String(run.job.command ?? '') }, provider, runs: 1,
    effect: ctx.v2.t(effectKey, { title: titleOf(run.job), ...extra }), versionFacts: state.version,
  })
  return { ...base, refs: [target.ref], version: state.version }
}

function stepOf(value: unknown): string | null {
  return typeof value === 'number' ? String(value) : str(value)
}

const QUEUE_OPS = ['get', 'pause', 'resume', 'reorder', 'priority'] as const
const queueTier = (args: Row) => !optionsOf(args).op || optionsOf(args).op === 'get' ? 'read' as const : 'write' as const
const LIMIT_SWITCH = (args: Row) => args.choice === 'switch' ? 'costly' as const : null
const generates = (args: Row) => optionsOf(args).generate === true
const remedySpawns = (args: Row) => args.choice !== 'edit_spec'

/** WP3. Every run (jobs, loop and Intent runs): views, launch, control, answers, recovery. */
/**
 * `runs(list)` without a project: the app-wide read model (`GET /runs`) over
 * every loaded project, live runs with their hold first, then history, paged
 * with a keyset cursor. Same item shape and filters as a project's list.
 */
async function crossProjectList(ctx: V2CallContext, args: Row, opts: { limit: number; filter: Row; server: ReadonlySet<string | undefined>; keep: (status: CanonicalStatus, hold: unknown, job: Row) => boolean }) {
  const key = shortHash({ app: 'runs', f: opts.filter })
  const after = decodeCursor(args.cursor, key)?.inner
  const query = new URLSearchParams({ limit: String(opts.limit) })
  // needsYou: only live runs can need the person; reading the running tier keeps the page full of them.
  const server = opts.server.size === 1 ? [...opts.server][0]! : opts.filter.needsYou === true && !opts.server.size ? 'running' : null
  if (server) query.set('status', server)
  if (str(opts.filter.since)) query.set('from', String(opts.filter.since))
  if (after) query.set('after', after)
  const listed = await api(ctx, 'GET', `/runs?${query}`)
  const slugs = new Map(ctx.v2.projects().map((row) => [row.id, row.slug]))
  const items = arr(listed.runs).map(rec).flatMap((job) => {
    const slug = slugs.get(String(job.projectId))
    if (!slug) return []
    const hold = job.hold ? rec(job.hold) : null
    const status = statusFromJob(String(job.status ?? ''), hold as never)
    if (!opts.keep(status, hold, job)) return []
    return [{
      ref: formatRef('run', String(job.id), slug), project: formatRef('project', slug), title: titleOf(job), status,
      ...(hold ? { hold: hold.kind } : {}), provider: job.provider ?? null, model: job.model ?? null,
      costUsd: job.total_cost_usd ?? null, startedAt: job.started_at ?? null, finishedAt: job.finished_at ?? null,
    }]
  })
  const next = str(listed.next)
  const loading = num(rec(listed.projects).notLoaded) ?? 0
  return result({ items }, {
    summary: ctx.v2.t('runs.summary.list', { count: items.length, more: next ? ctx.v2.t('runs.summary.list_more') : '' }),
    page: { cursor: next ? encodeCursor({ offset: 0, path: '/items', key, inner: next }) : null, truncated: next !== null },
    ...(loading ? { warnings: [`${loading} project(s) still loading: their runs are not listed yet.`] } : {}),
    untrusted: untrusted('/data/items/*/title'),
  })
}

export const runsTool = defineTool({
  name: 'specrails_runs',
  title: 'Runs',
  description: 'Runs (jobs, loop and Intent runs): list, get views, launch (assign+launch in one call), pause/resume/stop, answer, limit, remedy, recovery, queue.',
  owner: 'WP3',
  alwaysLoad: true,
  fields: {
    ...WRITE_FIELDS,
    fields: F.fields(RUN_FIELDS),
    target: F.object().describe('launch: {specIds,rail?}|{rail}|{loopId}|{command}|{template}'),
    answer: z.string(),
    optionId: z.string(),
    message: z.string().describe('steer: instruction'),
    choice: z.enum(['resume_now', 'auto', 'switch', 'continue', 'continue_to_review', 'edit_spec', 'change_model', 'start_over']),
    provider: z.string(),
    model: z.string(),
    effort: z.string(),
    filter: F.filter.describe('list: status[], kind[] (loop|job|intent), spec, rail, since, needsYou'),
  },
  actions: {
    list: {
      tier: 'read',
      doc: 'filter: status[] (v2 words), kind[] loop|job (intent: the Intent sessions, as missions(intent_list)), spec, since (ISO), needsYou, q (search the logs); no project = every project: live runs with their hold first, then history, paged',
      handler: async (ctx, raw) => {
        const args = compatArgs(raw)
        const filter = rec(args.filter)
        const query = str(filter.q) ?? str(optionsOf(args).q)
        let project: ProjectRow | null = null
        try { project = ctx.v2.project(args) } catch (err) { if (args.project !== undefined || query) throw err }
        const limit = Math.min(100, Math.max(1, typeof args.limit === 'number' ? args.limit : 25))
        if (query && project) {
          const found = await api(ctx, 'GET', `${projectBase(project)}/search/jobs?${new URLSearchParams({ q: query, limit: String(Math.min(50, limit)) })}`)
          const items = arr(found.results).map(rec).map((hit) => ({
            ref: formatRef('run', String(hit.jobId), project!.slug), title: oneLine(neutralize(String(hit.command ?? '')), 90),
            status: statusFromJob(String(hit.status ?? '')), startedAt: hit.startedAt ?? null, field: hit.field ?? null,
            snippet: oneLine(neutralize(typeof hit.snippet === 'string' ? hit.snippet : String(rec(hit.snippet).text ?? '')), 200),
          }))
          return result({ items }, { summary: ctx.v2.t('runs.summary.search', { count: items.length, query: oneLine(neutralize(query), 60) }), untrusted: untrusted('/data/items/*/title', '/data/items/*/snippet') })
        }
        const wanted = new Set(arr(filter.status).filter((value): value is string => typeof value === 'string'))
        const kinds = new Set(arr(filter.kind).filter((value): value is string => typeof value === 'string'))
        // Intent sessions live with the missions: answer with them instead of an empty run list.
        if (kinds.size && [...kinds].every((kind) => kind === 'intent')) return relay(await ctx.v2.dispatch({ tool: 'specrails_missions', args: { action: 'intent_list', ...(project ? { project: project.slug } : {}), ...(typeof args.lang === 'string' ? { lang: args.lang } : {}) } }))
        const spec = filter.spec === undefined ? null : Number(parseRef(filter.spec)?.id ?? filter.spec)
        const keep = (status: CanonicalStatus, hold: unknown, job: Row) => (!wanted.size || wanted.has(status))
          && (!kinds.size || kinds.has(isLoop(job) ? 'loop' : 'job'))
          && (spec === null || job.ticketId === spec || arr(job.ticketIds).includes(spec))
          && (filter.needsYou !== true || needsPerson({ status, hold: hold ? { kind: rec(hold).kind } as never : undefined }))
        // One server status narrows the page when the v2 words map onto it.
        const JOB_STATUS: Partial<Record<CanonicalStatus, string>> = { queued: 'queued', running: 'running', paused: 'running', blocked: 'running', needs_you: 'running', failed: 'failed', succeeded: 'completed', cancelled: 'canceled' }
        const server = new Set([...wanted].map((status) => JOB_STATUS[status as CanonicalStatus]).filter(Boolean))
        if (!project) return crossProjectList(ctx, args, { limit, filter, server, keep })
        const key = shortHash({ p: project.id, f: filter })
        const offset = decodeCursor(args.cursor, key)?.offset ?? 0
        const query2 = new URLSearchParams({ limit: String(limit), offset: String(offset) })
        if (server.size === 1) query2.set('status', [...server][0]!)
        if (str(filter.since)) query2.set('from', String(filter.since))
        const listed = await api(ctx, 'GET', `${projectBase(project)}/jobs?${query2}`)
        const jobs = arr(listed.jobs).map(rec)
        const items = jobs.flatMap((job) => {
          const hold = job.hold ? rec(job.hold) : null
          const status = statusFromJob(String(job.status ?? ''), hold as never)
          if (!keep(status, hold, job)) return []
          return [{
            ref: formatRef('run', String(job.id), project!.slug), title: titleOf(job), status,
            ...(hold ? { hold: hold.kind } : {}), provider: job.provider ?? null, model: job.model ?? null,
            costUsd: job.total_cost_usd ?? null, startedAt: job.started_at ?? null, finishedAt: job.finished_at ?? null,
            ...(typeof job.ticketId === 'number' ? { spec: formatRef('spec', job.ticketId, project!.slug) } : {}),
            ...(job.attempt ? { attempt: rec(job.attempt).number } : {}),
          }]
        })
        const total = num(listed.total)
        const next = total !== null && offset + jobs.length < total && jobs.length > 0 ? offset + jobs.length : null
        return result({ items }, {
          summary: ctx.v2.t('runs.summary.list', { count: items.length, more: next !== null ? ctx.v2.t('runs.summary.list_more') : '' }),
          page: { cursor: next !== null ? encodeCursor({ offset: next, path: '/items', key }) : null, ...(total !== null ? { total } : {}), truncated: next !== null },
          untrusted: untrusted('/data/items/*/title'),
        })
      },
    },
    get: {
      tier: 'read', required: ['ref'],
      doc: 'view detail + fields: steps, graph, logs (options.step, options.lines, cursor), narrated, verification (only when named), cost, attempts, events',
      handler: async (ctx, args) => {
        // `verification` reads Core's runtime state and evidence (two Core processes): only when named.
        const fields = resolveFields(args, RUN_FIELDS).filter((field) => field !== 'verification' || Array.isArray(args.fields))
        const run = await loadRun(ctx, runTarget(ctx, args), { runtime: fields.includes('verification') })
        const state = runState(ctx, run)
        const data = { ...runSummary(run), ...await detailOf(ctx, run, args, fields) }
        const refs: Record<string, Ref> = { run: run.target.ref }
        // One spec: `spec`; several: `spec.<id>` (docs/internals/mcp-v2.md, refs).
        const specs = data.specs as Ref[]
        if (specs.length === 1) refs.spec = specs[0]
        else for (const ref of specs.slice(0, 10)) refs[`spec.${parseRef(ref)?.id ?? ref}`] = ref
        if (typeof data.rail === 'string') refs.rail = data.rail
        return result(data, { summary: summaryOf(ctx, String(data.title), state), refs, state, untrusted: RUN_UNTRUSTED })
      },
    },
    launch: {
      tier: 'ai-spawn', confirm: 'costly', required: ['target'],
      doc: 'target {specIds[], rail?} | {rail} | {loopId, specIds?} | {command} | {template}; provider/model/effort; options: parallel (each spec on its own new rail, all in this one call; else one rail in order), runCapUsd, loopId, profile, targetPr, repositoryIds, workspaceSelection, baseBranch, revisionOf+revisionNote, followUp',
      preview: launchPreviewOf,
      handler: launch,
    },
    launch_all: {
      tier: 'ai-spawn', confirm: 'costly',
      doc: 'every rail with specs and no active run, each with its own settings',
      preview: async (ctx, args) => {
        const project = ctx.v2.project(compatArgs(args))
        const plan = launchAllPlan(await railsSnapshot(ctx, project))
        return launchPreview(ctx, project, { forecast: { loopId: IMPLEMENT_LOOP }, provider: null, runs: plan.eligible.length, effect: ctx.v2.t('runs.preview.launch_all', { count: plan.eligible.length }), versionFacts: plan.eligible })
      },
      handler: async (ctx, args) => {
        const project = ctx.v2.project(compatArgs(args))
        const base = projectBase(project)
        const plan = launchAllPlan(await railsSnapshot(ctx, project))
        const origin = ctx.originConversationId ? { originConversationId: ctx.originConversationId, originSurface: 'agent-chat' } : {}
        const outcomes = await Promise.all(plan.eligible.map(async (rail) => {
          try {
            return { index: rail.index, outcome: 'launched', ...launchOutcome(project, { railIndex: rail.index, ...await api(ctx, 'POST', `${base}/rails/${rail.index}/launch`, { ...(rail.mode ? { mode: rail.mode } : {}), ...origin }) }) }
          } catch (err) {
            return { index: rail.index, outcome: 'refused', error: err instanceof McpApiError ? err.code ?? err.message : String(err) }
          }
        }))
        const results = [...outcomes as Row[], ...plan.skipped.map((skip): Row => ({ ...skip, outcome: 'skipped' }))].sort((a, b) => Number(a.index) - Number(b.index))
          .map((item) => ({ ...item, rail: formatRef('rail', Number(item.index), project.slug) }))
        const runs = outcomes.flatMap((item) => (item as Row).runs as Ref[] ?? [])
        return result({ results }, {
          summary: runs.length ? ctx.v2.t('runs.summary.launched', { count: runs.length }) : ctx.v2.t('runs.summary.launch_all_none'),
          refs: Object.fromEntries(runs.map((ref, index) => [`run${index + 1}`, ref])),
        })
      },
    },
    pause: {
      tier: 'write', required: ['ref'], doc: 'a run or a rail ref (the rail\'s active run); Core finishes the step, then holds. Answers once it holds (options.waitMs, default 25 s, max 45 s; 0 = at once)',
      handler: async (ctx, args) => {
        const { target } = await runOrRail(ctx, args)
        const response = await api(ctx, 'POST', `${projectBase(target.project!)}/loop-runs/${encodeURIComponent(target.id)}/pause`)
        // The pause lands when the current step ends: answer then (bounded), so no wait call is needed to see it.
        await untilHeld(ctx, target, waitMsOf(optionsOf(args), PAUSE_WAIT_MS, PAUSE_WAIT_MAX_MS))
        return await accepted(ctx, target, 'Pause', response)
      },
    },
    resume: {
      tier: 'ai-spawn', confirm: 'costly', required: ['ref'],
      doc: 'a held run (or rail): options.mode recover (the interrupted steps), options.runCap once|ignore or options.runCapUsd (budget hold)',
      preview: (ctx, args) => costedPreview(ctx, args, 'runs.preview.resume'),
      handler: async (ctx, args) => {
        const { target } = await runOrRail(ctx, args)
        const run = await loadRun(ctx, target, { runtime: optionsOf(args).mode === 'recover' })
        const state = runState(ctx, run)
        requireOffer(ctx, state, (offer) => offer.call.args.action === 'resume')
        const options = optionsOf(args)
        const body: Row = {}
        if (options.runCap === 'once' || options.runCap === 'ignore') body.runCap = options.runCap
        if (num(options.runCapUsd) !== null) body.runCapUsd = options.runCapUsd
        if (options.mode === 'recover') {
          let recover = arr(options.steps).filter((step): step is string => typeof step === 'string')
          if (!recover.length) recover = arr(run.runtime?.recoverableSteps).filter((step): step is string => typeof step === 'string')
          if (recover.length) body.recover = recover
        }
        return await accepted(ctx, target, 'Resume', await api(ctx, 'POST', resumePath(run), body))
      },
    },
    stop: {
      tier: 'write', required: ['ref'], doc: 'a run, or a rail ref (stops every run on it)',
      handler: async (ctx, args) => {
        const target = runTarget(ctx, args, ['run', 'rail'])
        const base = projectBase(target.project!)
        if (target.kind === 'rail') return result(await api(ctx, 'POST', `${base}/rails/${Number(target.id)}/stop`), { summary: ctx.v2.t('runs.summary.accepted', { label: 'Stop' }), refs: { rail: target.ref } })
        return await accepted(ctx, target, 'Stop', await api(ctx, 'POST', `${base}/jobs/${encodeURIComponent(target.id)}/cancel`))
      },
    },
    cancel: {
      tier: 'destructive', confirm: 'irreversible', required: ['ref'],
      doc: 'cancel a runtime continuation or Core run for good (stop is the reversible-looking everyday Stop)',
      preview: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args), { runtime: true })
        return { effect: ctx.v2.t('runs.preview.cancel', { title: titleOf(run.job) }), refs: [run.target.ref], version: runState(ctx, run).version }
      },
      handler: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args), { runtime: true })
        const base = projectBase(run.project)
        const id = encodeURIComponent(run.target.id)
        const path = run.runtime?.canCancel === true ? `${base}/agent-runtime/runs/${id}/cancel`
          : run.loopRun?.engine_version === 2 ? `${base}/loop-runs/${id}/cancel` : `${base}/jobs/${id}/cancel`
        return await accepted(ctx, run.target, 'Cancel', await api(ctx, 'POST', path))
      },
    },
    answer: {
      tier: 'write', required: ['ref'], oneOf: ['answer', 'optionId'],
      doc: 'the pending question: optionId (data.question.options) or a free answer; neither: the person picks',
      choose: { fields: ['answer', 'optionId'], point: answerPoint },
      handler: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args), { runtime: true })
        const state = runState(ctx, run)
        requireOffer(ctx, state, (offer) => offer.id === 'answer')
        const question = rec(run.job.question)
        const options = arr(question.options).map(rec)
        let answer = str(args.answer)
        if (args.optionId !== undefined) {
          const option = options.find((candidate) => candidate.id === args.optionId)
          if (!option) throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.no_option', { option: String(args.optionId), options: options.map((candidate) => String(candidate.id)).join(', ') }))
          answer = answer ?? String(option.label ?? option.id)
        }
        const definition = resumePath(run).includes('/loop-runs/')
        const body = { answer, ...(definition && str(question.interruptId) ? { interruptId: question.interruptId } : {}), ...(definition && args.optionId !== undefined ? { optionId: args.optionId } : {}) }
        return await accepted(ctx, run.target, 'Answer', await api(ctx, 'POST', resumePath(run), body))
      },
    },
    approve: {
      tier: 'write', required: ['ref'],
      handler: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args), { runtime: true })
        requireOffer(ctx, runState(ctx, run), (offer) => offer.id === 'approve')
        const id = str(rec(run.job.question).interruptId) ?? str(rec(run.runtime?.pendingApproval).stepId)
        return await accepted(ctx, run.target, 'Approve', await api(ctx, 'POST', resumePath(run), id ? { approve: [id] } : {}))
      },
    },
    reject: {
      tier: 'write', required: ['ref'], doc: 'answer: the reason (required)',
      handler: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args), { runtime: true })
        requireOffer(ctx, runState(ctx, run), (offer) => offer.id === 'reject')
        const reason = str(args.answer) ?? str(optionsOf(args).reason)
        if (!reason) throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.reject_reason'))
        const id = str(rec(run.job.question).interruptId) ?? str(rec(run.runtime?.pendingApproval).stepId)
        return await accepted(ctx, run.target, 'Reject', await api(ctx, 'POST', resumePath(run), { reject: id, reason }))
      },
    },
    limit: {
      tier: (args) => args.choice === 'switch' ? 'ai-spawn' : 'write', confirm: LIMIT_SWITCH, required: ['ref', 'choice'],
      doc: 'choice resume_now | auto (options.enabled) | switch (provider, model?, effort?, options.remember); no choice: the person picks',
      choose: { fields: ['choice'], point: limitPoint },
      preview: (ctx, args) => costedPreview(ctx, args, 'runs.preview.resume'),
      handler: async (ctx, args) => {
        const { target } = await runOrRail(ctx, args)
        const run = await loadRun(ctx, target)
        const state = runState(ctx, run)
        const choice = String(args.choice)
        requireOffer(ctx, state, (offer) => offer.call.args.action === 'limit' && offer.call.args.choice === choice)
        const options = optionsOf(args)
        let body: Row
        if (choice === 'resume_now') body = { action: 'resume' }
        else if (choice === 'auto') body = { action: 'auto', enabled: options.enabled !== false }
        else if (choice === 'switch') {
          const limit = rec(run.job.loopPauseLimit ?? run.loopRun?.limitPause)
          const targets = arr(limit.switchTargets).map(rec)
          const provider = str(args.provider) ?? str(targets[0]?.provider)
          const match = targets.find((candidate) => candidate.provider === provider)
          body = { action: 'switch', provider, ...(str(args.model) ?? str(match?.model) ? { model: str(args.model) ?? match!.model } : {}),
            ...(str(args.effort) ?? str(match?.effort) ? { effort: str(args.effort) ?? match!.effort } : {}), ...(options.remember === true ? { remember: true } : {}) }
        } else throw new V2ToolError('invalid_input', `limit takes choice resume_now, auto or switch, not ${choice}.`)
        return await accepted(ctx, target, 'Limit', await api(ctx, 'POST', `${projectBase(run.project)}/loop-runs/${encodeURIComponent(target.id)}/limit`, body))
      },
    },
    remedy: {
      tier: (args) => remedySpawns(args) ? 'ai-spawn' : 'read', confirm: (args) => remedySpawns(args) ? 'costly' : null, required: ['ref'], oneOf: ['choice', 'optionId'],
      doc: 'a failed/stopped run: choice continue (options.instruction; provider/model/effort to switch) | continue_to_review | start_over | edit_spec, or optionId of an analysis option; options.copyEnvFiles',
      preview: (ctx, args) => costedPreview(ctx, args, 'runs.preview.resume'),
      handler: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args))
        const state = runState(ctx, run)
        const options = optionsOf(args)
        const base = projectBase(run.project)
        const id = encodeURIComponent(run.target.id)
        const choice = str(args.choice)
        if (choice === 'edit_spec') {
          const spec = specRefs(run.project, run.job)[0]
          return result({ ref: run.target.ref, next: spec ? { tool: 'specrails_specs', args: { action: 'update', ref: spec } } : null }, { summary: ctx.v2.t('runs.summary.edit_spec'), ...(spec ? { refs: { spec } } : {}) })
        }
        if (choice === 'change_model' && !str(args.provider)) throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.change_model'))
        if (choice === 'start_over') {
          const rail = num(run.loopRun?.rail_index)
          if (rail === null) throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.no_rail'))
          requireOffer(ctx, state, (offer) => offer.call.args.choice === 'start_over')
          return result(launchOutcome(run.project, { railIndex: rail, ...await api(ctx, 'POST', `${base}/rails/${rail}/relaunch`, { sourceId: run.target.id, ...(ctx.originConversationId ? { originConversationId: ctx.originConversationId, originSurface: 'agent-chat' } : {}) }) }),
            { summary: ctx.v2.t('runs.summary.launched', { count: 1 }), refs: { run: run.target.ref } })
        }
        const wanted = choice === 'continue_to_review' ? 'continue_to_review' : 'continue'
        requireOffer(ctx, state, (offer) => offer.call.args.action === 'remedy' && (args.optionId !== undefined
          ? offer.call.args.optionId === args.optionId
          : options.copyEnvFiles === true ? offer.id === 'remedy.copy-env-files' : offer.call.args.choice === wanted))
        const body: Row = {}
        if (options.copyEnvFiles === true) body.remedy = 'copy-env-files'
        else if (args.optionId !== undefined) body.optionId = args.optionId
        else if (choice === 'continue_to_review') body.remedy = 'continue-to-review'
        else {
          body.remedy = 'continue'
          if (str(options.instruction)) body.instruction = options.instruction
        }
        if (str(args.provider) && body.remedy !== 'copy-env-files' && body.remedy !== 'continue-to-review') {
          if (body.optionId === undefined) body.remedy = 'continue'
          body.switch = { provider: args.provider, ...(str(args.model) ? { model: args.model } : {}), ...(str(args.effort) ? { effort: args.effort } : {}), ...(options.remember === true ? { remember: true } : {}) }
        }
        let response: Row
        try {
          response = await api(ctx, 'POST', `${base}/loop-runs/${id}/remedy`, body)
        } catch (err) {
          // The run's saved Core state is gone: continuing can never work, so say what still does instead of "retry".
          if (err instanceof McpApiError && (err.code === 'runtime_status_unavailable' || err.code === 'runtime_state_gone')) {
            const specs = specRefs(run.project, run.job)
            throw new V2ToolError('conflict', ctx.v2.t('runs.error.cannot_continue'), {
              retryable: false,
              ...(specs.length ? { next: [{ tool: 'specrails_runs', args: { action: 'launch', project: run.project.slug, target: { specIds: specs } }, why: ctx.v2.t('runs.why.launch_again') }] } : {}),
            })
          }
          throw err
        }
        // A settled run goes on as a NEW attempt (a fork): answer with that attempt, so the agent
        // follows it (waiting on the old ref only sees the old attempt's failure again).
        const child = str(response.loopRunId)
        if (response.mode === 'fork' && child && child !== run.target.id) {
          const next: Target = { ...run.target, id: child, ref: formatRef('run', child, run.project.slug) }
          return await accepted(ctx, next, 'Continue', { ...response, run: next.ref, source: run.target.ref })
        }
        return await accepted(ctx, run.target, 'Continue', response)
      },
    },
    fork: {
      tier: 'ai-spawn', confirm: 'costly', required: ['ref'],
      doc: 'a new attempt from one step: options.fromStep (graph node id), options.scopeId, options.visit',
      preview: (ctx, args) => costedPreview(ctx, args, 'runs.preview.fork', { step: stepOf(optionsOf(args).fromStep) ?? '?' }),
      handler: async (ctx, args) => {
        const target = runTarget(ctx, args)
        const options = optionsOf(args)
        const fromNodePath = stepOf(options.fromStep)
        if (!fromNodePath) throw new V2ToolError('invalid_input', ctx.v2.t('runs.error.fork_step'))
        const body: Row = { requestId: str(options.requestId) ?? `mcp-fork-${shortHash({ r: target.id, s: fromNodePath, v: options.visit ?? null })}`, fromNodePath }
        if (str(options.scopeId)) body.scopeId = options.scopeId
        if (num(options.visit) !== null) body.visit = options.visit
        const response = await api(ctx, 'POST', `${projectBase(target.project!)}/loop-runs/${encodeURIComponent(target.id)}/fork`, body)
        const child = str(response.loopRunId)
        return result({ ...response, ...(child ? { run: formatRef('run', child, target.project!.slug) } : {}) }, {
          summary: ctx.v2.t('runs.summary.launched', { count: child ? 1 : 0 }), refs: { source: target.ref, ...(child ? { run: formatRef('run', child, target.project!.slug) } : {}) },
        })
      },
    },
    steer: {
      tier: 'write', required: ['ref', 'message'], doc: 'a message the running agent reads at its next turn (options.requestId keeps it idempotent)',
      handler: async (ctx, args) => {
        const target = runTarget(ctx, args)
        const base = projectBase(target.project!)
        const id = encodeURIComponent(target.id)
        const text = String(args.message)
        const job = rec((await api(ctx, 'GET', `${base}/jobs/${id}`)).job)
        if (job.interactiveAcceptingTurns === true && !isLoop(job)) return await accepted(ctx, target, 'Steer', await api(ctx, 'POST', `${base}/jobs/${id}/messages`, { text }))
        const requestId = str(optionsOf(args).requestId) ?? `mcp-steer-${shortHash({ r: target.id, t: text })}`
        return await accepted(ctx, target, 'Steer', await api(ctx, 'POST', `${base}/agent-runtime/runs/${id}/steer`, { text, requestId }))
      },
    },
    diagnose: {
      tier: (args) => generates(args) ? 'ai-spawn' : 'read', confirm: (args) => generates(args) ? 'costly' : null, required: ['ref'],
      doc: 'why a failed run stopped: diagnosis + AI analysis; options.generate asks for a fresh analysis, options.runtime adds the runtime recovery assessment',
      preview: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args))
        return { refs: [run.target.ref], version: runState(ctx, run).version, cost: { forecastUsd: null, runs: 1 } }
      },
      handler: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args))
        const base = projectBase(run.project)
        const id = encodeURIComponent(run.target.id)
        const status = String(run.job.status ?? '')
        const title = titleOf(run.job)
        let state = runState(ctx, run)
        if (!FAILED.has(status)) return result({ ref: run.target.ref, jobStatus: status, diagnosis: null, analysis: null }, { summary: ctx.v2.t('runs.summary.diagnose_none', { title, status: state.label }), state, refs: { run: run.target.ref } })
        if (generates(args) && (run.analysis?.status !== 'ready' || run.analysis?.stale === true)) {
          run.analysis = await api(ctx, 'POST', `${base}/jobs/${id}/failure-analysis`, { language: ctx.v2.lang, ...(optionsOf(args).force === true ? { force: true } : {}) })
          state = runState(ctx, run)
        }
        const analysis = readyAnalysis(run)
        const diagnosis = rec(run.job.failureDiagnosis)
        const runtime = optionsOf(args).runtime === true ? await maybe(ctx, `${base}/agent-runtime/runs/${id}/diagnosis`) : null
        const reason = str(analysis?.headline) ?? str(diagnosis.detail) ?? String(diagnosis.kind ?? 'unknown')
        return result({
          ref: run.target.ref, jobStatus: status,
          diagnosis: Object.keys(diagnosis).length ? { kind: diagnosis.kind, detail: diagnosis.detail ?? null, step: diagnosis.phase ?? null, remedies: diagnosis.remedies ?? [], failingTests: arr(diagnosis.failingTests).slice(0, 10), ...(diagnosis.strongerModel ? { strongerModel: diagnosis.strongerModel } : {}) } : null,
          analysis: analysis ? { headline: analysis.headline, cause: analysis.cause, category: analysis.category, failedStep: analysis.failedStep ?? null, evidence: arr(analysis.evidence).slice(0, 6), nextSteps: arr(analysis.nextSteps).slice(0, 6),
            options: arr(analysis.options).map(rec).map((option) => ({ id: option.id, kind: option.kind, label: option.label, does: option.does, consequence: option.consequence, risk: option.risk ?? null, recommended: option.recommended === true })),
            stale: run.analysis?.stale === true, provider: run.analysis?.provider ?? null, createdAt: run.analysis?.createdAt ?? null } : null,
          ...(runtime ? { runtime } : {}),
        }, {
          summary: ctx.v2.t('runs.summary.diagnose', { title, reason: oneLine(neutralize(reason), 200) }), state, refs: { run: run.target.ref },
          untrusted: untrusted('/data/diagnosis/detail', '/data/analysis/*', '/data/runtime/*', '/state/offers/*/label', '/state/offers/*/why'),
        })
      },
    },
    recovery_inspect: {
      tier: 'read', required: ['ref'], doc: 'the original worktree: repositories, checks, recent repairs, plus the loop run\'s recovery options',
      handler: async (ctx, args) => {
        const target = runTarget(ctx, args)
        const base = projectBase(target.project!)
        const id = encodeURIComponent(target.id)
        const [inspect, options] = await Promise.all([api(ctx, 'POST', `${base}/agent-runtime/runs/${id}/recovery`, { action: 'inspect' }), maybe(ctx, `${base}/loop-runs/${id}/recovery`)])
        return result({ ref: target.ref, ...inspect, ...(options ? { options } : {}) }, { summary: ctx.v2.t('runs.summary.recovery', { label: 'Inspect' }), refs: { run: target.ref } })
      },
    },
    recovery_read: {
      tier: 'read', required: ['ref', 'options.path'], doc: 'options: path, repositoryId, startLine, endLine; or options.list true for a directory',
      handler: (ctx, args) => recovery(ctx, args, optionsOf(args).list === true ? 'list_files' : 'read_file', ['repositoryId', 'path', 'startLine', 'endLine']),
    },
    recovery_diff: {
      tier: 'read', required: ['ref'], doc: 'options.repositoryId; options.history true for the repair history (options.offset)',
      handler: (ctx, args) => recovery(ctx, args, optionsOf(args).history === true ? 'history' : 'diff', ['repositoryId', 'offset']),
    },
    recovery_patch: {
      tier: 'write', required: ['ref', 'options.patch'], doc: 'options.patch {repositoryId, path, expectedHash, oldText, newText, operationId (uuid), reason}',
      handler: (ctx, args) => recovery(ctx, { ...args, options: { ...rec(optionsOf(args).patch) } }, 'patch', ['repositoryId', 'path', 'expectedHash', 'oldText', 'newText', 'operationId', 'reason', 'acknowledgeInterrupted']),
    },
    recovery_check: {
      // Runs the project's own commands in the run's worktree: confirmed like v1 (destructive).
      tier: 'destructive', confirm: 'irreversible', required: ['ref'], doc: 'options: kind openspec|verification, checkId, operationId (uuid), reason, changedPrecondition',
      preview: async (ctx, args) => {
        const run = await loadRun(ctx, runTarget(ctx, args))
        const options = optionsOf(args)
        return { effect: ctx.v2.t('runs.preview.check', { kind: String(options.kind ?? 'verification'), title: titleOf(run.job) }), refs: [run.target.ref], version: runState(ctx, run).version }
      },
      handler: (ctx, args) => recovery(ctx, args, 'check', ['kind', 'checkId', 'operationId', 'reason', 'changedPrecondition', 'acknowledgeInterrupted']),
    },
    settle: {
      tier: 'write', required: ['ref'],
      handler: async (ctx, args) => {
        const target = runTarget(ctx, args)
        return await accepted(ctx, target, 'Settle', await api(ctx, 'POST', `${projectBase(target.project!)}/agent-runtime/runs/${encodeURIComponent(target.id)}/settle`))
      },
    },
    dismiss: {
      tier: 'write', required: ['ref'],
      handler: async (ctx, args) => {
        const target = runTarget(ctx, args)
        return await accepted(ctx, target, 'Dismiss', await api(ctx, 'POST', `${projectBase(target.project!)}/agent-runtime/runs/${encodeURIComponent(target.id)}/dismiss`))
      },
    },
    queue: {
      tier: queueTier, doc: 'options.op: get | pause | resume | reorder (options.order: run refs) | priority (ref, options.priority low|normal|high|critical)',
      handler: async (ctx, raw) => {
        const args = compatArgs(raw)
        const options = optionsOf(args)
        const op = (str(options.op) ?? 'get') as (typeof QUEUE_OPS)[number]
        if (!QUEUE_OPS.includes(op)) throw new V2ToolError('invalid_input', `queue takes options.op ${QUEUE_OPS.join(', ')}.`)
        const project = op === 'priority' ? runTarget(ctx, args).project! : ctx.v2.project(args)
        const base = projectBase(project)
        if (op === 'pause' || op === 'resume') await api(ctx, 'POST', `${base}/queue/${op}`)
        if (op === 'reorder') await api(ctx, 'PUT', `${base}/queue/reorder`, { jobIds: arr(options.order).map((value) => parseRef(value)?.id ?? String(value)) })
        if (op === 'priority') await api(ctx, 'PATCH', `${base}/jobs/${encodeURIComponent(runTarget(ctx, args).id)}/priority`, { priority: options.priority })
        const queue = await api(ctx, 'GET', `${base}/queue`)
        const items = arr(queue.jobs).map(rec).slice(0, 50).map((job) => ({ ref: formatRef('run', String(job.id), project.slug), title: oneLine(neutralize(String(job.command ?? '')), 90), status: job.status, position: job.queuePosition ?? null, priority: job.priority ?? null }))
        return result({ paused: queue.paused === true, active: str(queue.activeJobId) ? formatRef('run', String(queue.activeJobId), project.slug) : null, items }, {
          summary: ctx.v2.t('runs.summary.queue', { count: items.length, state: queue.paused === true ? 'paused' : 'running' }), untrusted: untrusted('/data/items/*/title'),
        })
      },
    },
    delete_history: {
      tier: 'destructive', confirm: 'irreversible', oneOf: ['ref', 'filter'], doc: 'one run (ref) or a date range (filter.from, filter.to)',
      preview: async (ctx, args) => {
        if (args.ref !== undefined) {
          const target = runTarget(ctx, args)
          const job = rec((await api(ctx, 'GET', `${projectBase(target.project!)}/jobs/${encodeURIComponent(target.id)}`)).job)
          return { effect: ctx.v2.t('runs.preview.delete', { what: titleOf(job) }), refs: [target.ref], version: `d${shortHash({ s: job.status ?? null, f: job.finished_at ?? null })}` }
        }
        const filter = rec(args.filter)
        return { effect: ctx.v2.t('runs.preview.delete', { what: `${filter.from ?? '…'} – ${filter.to ?? '…'}` }), version: `d${shortHash(filter)}` }
      },
      handler: async (ctx, raw) => {
        const args = compatArgs(raw)
        if (args.ref !== undefined) {
          const target = runTarget(ctx, args)
          return result(await api(ctx, 'DELETE', `${projectBase(target.project!)}/jobs/${encodeURIComponent(target.id)}`), { summary: ctx.v2.t('runs.summary.deleted'), refs: { run: target.ref } })
        }
        const filter = rec(args.filter)
        return result(await api(ctx, 'DELETE', `${projectBase(ctx.v2.project(args))}/jobs`, { from: str(filter.from) ?? undefined, to: str(filter.to) ?? undefined }), { summary: ctx.v2.t('runs.summary.deleted') })
      },
    },
  },
})

async function recovery(ctx: V2CallContext, args: Row, action: string, keys: readonly string[]): Promise<unknown> {
  const target = runTarget(ctx, args)
  const options = optionsOf(args)
  const body: Row = { action }
  for (const key of keys) if (options[key] !== undefined) body[key] = options[key]
  const response = await api(ctx, 'POST', `${projectBase(target.project!)}/agent-runtime/runs/${encodeURIComponent(target.id)}/recovery`, body)
  // A file page can be large: keep it inside the detail cap.
  const text = JSON.stringify(response)
  return result({ ref: target.ref, ...(approxTokens(text) > 8_000 ? { truncated: true, ...Object.fromEntries(Object.entries(response).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 16_000) : value])) } : response) }, {
    summary: ctx.v2.t('runs.summary.recovery', { label: action }), refs: { run: target.ref }, untrusted: untrusted('/data/*'),
  })
}
