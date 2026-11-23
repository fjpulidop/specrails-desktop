import { createHash } from 'crypto'
import { z } from 'zod'
import type { McpToolContext, McpToolSpec } from './types'
import { apiCall, McpApiError } from './types'
import { toolResponse, type NextCall } from './envelope'
import { usd } from './summaries'
import { readFailureAnalysis, readJobDiagnosis } from '../../modules/recovery/adapters/sqlite'
import { getPrDelivery } from '../../modules/delivery/runtime/rail-pr-store'

/**
 * `specrails_status`: ONE cheap, app-wide glance — what is running, what needs
 * the person, what failed recently, today's spend and machine load — for a
 * lightweight client (a desktop mascot, a status bar) or any model that needs
 * orientation before acting.
 *
 * Every source is an independent loopback read with a short timeout, fanned out
 * with bounded concurrency. A failing source marks the answer `partial` and
 * names itself in `sources`; it never fails the whole call. The `etag` covers
 * meaningful state only (not CPU/memory gauges or the capture time), so a
 * poller passing `ifNoneMatch` gets `{ unchanged: true }` until something the
 * person would care about changes.
 */

export const STATUS_SOURCE_TIMEOUT_MS = 2_500
export const STATUS_CONCURRENCY = 4
export const STATUS_MAX_PROJECTS = 12
const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000
const MAX_LIST = 10
const MAX_FAILURES = 5

export type Mood = 'idle' | 'working' | 'needs_you' | 'failing'

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : []
const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Run `tasks` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

type SourceResult<T> = { ok: true; value: T } | { ok: false; error: string }

async function read(ctx: McpToolContext, path: string, timeoutMs: number): Promise<SourceResult<unknown>> {
  try {
    return { ok: true, value: await apiCall(ctx, 'GET', path, undefined, { timeoutMs }) }
  } catch (err) {
    if (err instanceof McpApiError) return { ok: false, error: `HTTP ${err.status}` }
    const name = err instanceof Error ? err.name : ''
    return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : err instanceof Error ? err.message.slice(0, 120) : 'failed' }
  }
}

/** Today on this machine (the person's clock), as exact UTC instants: the same
 *  "today" as the spend caps and the app's own spend-today figure. */
function localDay(now: Date): { from: string; to: string } {
  return {
    from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(),
    to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).toISOString(),
  }
}

function shortReason(diagnosis: Row): string | null {
  const detail = str(diagnosis.detail)
  if (detail) return detail.length > 160 ? `${detail.slice(0, 159)}…` : detail
  const kind = str(diagnosis.kind)
  return kind && kind !== 'unknown' ? kind.replace(/_/g, ' ') : null
}

export interface StatusSnapshot {
  headline: string
  mood: Mood
  active: { missions: Row[]; rails: Row[]; jobs: Row[] }
  needsYou: Row[]
  needsYouTotal: number
  failures: Row[]
  spendToday: { usd: number | null; estimated: boolean; estimatedUsd: number | null; byCategory: Record<string, number> } | null
  resources: { cpuPercent: number | null; memoryBytes: number | null; processCount: number | null } | null
  next: NextCall[]
  capturedAt: string
  etag: string
  partial: boolean
  sources: Record<string, string>
}

/** Collect the snapshot. Exported for tests and for future surfaces (e.g. a mascot route). */
export async function collectStatus(ctx: McpToolContext, options: { now?: Date; timeoutMs?: number } = {}): Promise<StatusSnapshot> {
  const now = options.now ?? new Date()
  const timeoutMs = options.timeoutMs ?? STATUS_SOURCE_TIMEOUT_MS
  const day = localDay(now)
  const projects = (ctx.registry.listContexts?.() ?? []).slice(0, STATUS_MAX_PROJECTS)
  const projectName = (id: unknown): string | null => {
    if (typeof id !== 'string') return null
    try { return ctx.registry.getProjectRow?.(id)?.name ?? ctx.registry.getContext(id)?.project.name ?? null } catch { return null }
  }

  const fixed: Array<[string, string]> = [
    ['inbox', '/inbox'],
    ['jobs', '/recent-jobs?limit=30'],
    ['missions', '/agent/active-turns'],
    ['spend', `/analytics?period=custom&from=${encodeURIComponent(day.from)}&to=${encodeURIComponent(day.to)}`],
    ['resources', '/resources'],
  ]
  const tasks = [
    ...fixed.map(([name, path]) => ({ name, path })),
    ...projects.map((project) => ({ name: `rails:${project.project.id}`, path: `/projects/${encodeURIComponent(project.project.id)}/rails` })),
  ]
  const results = await mapLimit(tasks, STATUS_CONCURRENCY, (task) => read(ctx, task.path, timeoutMs))
  const byName = new Map(tasks.map((task, index) => [task.name, results[index]]))
  const sources: Record<string, string> = {}
  let partial = false
  const take = (name: string, optionalOn404 = false): unknown => {
    const result = byName.get(name)
    if (!result) return undefined
    if (result.ok) { sources[name] = 'ok'; return result.value }
    // The agent surface 404s when Agent chat is disabled: that is "no missions", not a failure.
    if (optionalOn404 && result.error === 'HTTP 404') { sources[name] = 'disabled'; return undefined }
    sources[name] = result.error
    partial = true
    return undefined
  }

  // ── Missions (running agent turns), titled from the conversation list ──
  const turnsData = record(take('missions', true))
  const runningTurns = rows(turnsData.turns)
  const background = rows(turnsData.sessions).filter((session) => !runningTurns.some((turn) => turn.conversationId === session.conversationId))
  let conversations: Row[] = []
  if (runningTurns.length || background.length) {
    const listed = await read(ctx, '/agent/conversations', timeoutMs)
    if (listed.ok) { conversations = rows(record(listed.value).conversations); sources.missionTitles = 'ok' } else { sources.missionTitles = listed.error; partial = true }
  }
  const conversation = (id: unknown) => conversations.find((row) => row.id === id) ?? {}
  const missions = [...runningTurns.map((turn) => ({ turn, background: false })), ...background.map((turn) => ({ turn, background: true }))]
    .slice(0, MAX_LIST).map(({ turn, background: isBackground }) => {
      const row = conversation(turn.conversationId)
      const usage = record(row.contextUsage)
      return {
        conversationId: turn.conversationId, title: str(row.title) ?? 'Untitled mission',
        projectId: row.pinned_project_id ?? null, projectName: projectName(row.pinned_project_id),
        provider: row.provider ?? null, model: row.model ?? null,
        running: !isBackground, backgroundWork: isBackground,
        startedAt: turn.startedAt ?? null, contextUsagePercent: num(usage.percent),
      }
    })

  // ── Rails with running work ──
  const rails: Row[] = []
  for (const project of projects) {
    const data = record(take(`rails:${project.project.id}`))
    const names = new Map(rows(data.rails).map((rail) => [rail.railIndex, str(rail.name)]))
    for (const [index, job] of Object.entries(record(data.activeJobs))) {
      const entry = record(job)
      rails.push({ projectId: project.project.id, projectName: project.project.name, railIndex: Number(index), name: names.get(Number(index)) ?? null, jobId: entry.jobId ?? null, mode: entry.mode ?? null })
    }
    for (const [index, run] of Object.entries(record(data.activeLoopRuns))) {
      const entry = record(run)
      rails.push({ projectId: project.project.id, projectName: project.project.name, railIndex: Number(index), name: names.get(Number(index)) ?? null, jobId: entry.loopRunId ?? null, loop: entry.loopName ?? entry.loopId ?? null, provider: entry.provider ?? null, model: entry.model ?? null, startedAt: entry.startedAt ?? null })
    }
  }
  const railJobIds = new Set(rails.map((rail) => rail.jobId).filter(Boolean))

  // ── Jobs: running ones not already shown on a rail, and recent failures ──
  const recentJobs = rows(record(take('jobs')).jobs)
  const jobs = recentJobs
    .filter((job) => (job.status === 'running' || job.status === 'queued') && !railJobIds.has(job.id))
    .slice(0, MAX_LIST)
    .map((job) => ({ projectId: job.projectId ?? null, projectName: job.projectName ?? null, jobId: job.id, command: job.command ?? null, status: job.status, startedAt: job.started_at ?? null }))

  // ── Needs you (inbox) and failures ──
  const inbox = record(take('inbox'))
  const items = rows(inbox.items)
  const needsYou = items.slice(0, MAX_LIST).map((item) => ({
    id: item.id, projectId: item.projectId, projectName: item.projectName, kind: item.kind, title: item.title,
    detail: item.detail ?? null, at: item.at, action: item.action, subjectId: item.subjectId,
    ...(typeof item.railIndex === 'number' ? { railIndex: item.railIndex } : {}), version: item.version,
  }))

  const failures: Row[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if ((item.kind !== 'failed' && item.kind !== 'blocked') || failures.length >= MAX_FAILURES) continue
    const subjectId = str(item.subjectId)
    if (!subjectId || seen.has(subjectId)) continue
    seen.add(subjectId)
    // A failed delivery is addressed by its delivery id; its last run is the job to diagnose.
    const delivery = item.action === 'open-review'
    const jobId = delivery ? lastDeliveryRun(ctx, item.projectId, subjectId) : subjectId
    if (jobId) seen.add(jobId)
    failures.push({ projectId: item.projectId, projectName: item.projectName, jobId, ...(delivery ? { prDeliveryId: subjectId } : {}),
      title: item.title, kind: item.kind, at: item.at,
      reason: shortReason(record(item.diagnosis)) ?? str(item.detail), diagnosisKind: record(item.diagnosis).kind ?? null })
  }
  for (const job of recentJobs) {
    if (failures.length >= MAX_FAILURES) break
    if (job.status !== 'failed') continue
    const at = Date.parse(String(job.finished_at ?? job.started_at ?? ''))
    if (!Number.isFinite(at) || now.getTime() - at > RECENT_FAILURE_MS) continue
    const jobId = str(job.id)
    if (!jobId || seen.has(jobId)) continue
    seen.add(jobId)
    failures.push({ projectId: job.projectId, projectName: job.projectName, jobId, title: job.command ?? jobId, kind: 'failed', at: job.finished_at ?? job.started_at, reason: null, diagnosisKind: null })
  }
  // Diagnosis and "has an AI analysis" are cheap reads of the job's own project database.
  for (const failure of failures) {
    const db = typeof failure.projectId === 'string' ? ctx.registry.getContext(failure.projectId)?.db : undefined
    if (!db || !failure.jobId) { failure.hasAnalysis = null; continue }
    try {
      if (!failure.diagnosisKind) {
        const diagnosis = readJobDiagnosis(db, String(failure.jobId), 'failed')
        if (diagnosis) { failure.reason = shortReason(diagnosis as unknown as Row) ?? failure.reason; failure.diagnosisKind = diagnosis.kind }
      }
      failure.hasAnalysis = readFailureAnalysis(db, String(failure.jobId)) !== null
    } catch { failure.hasAnalysis = null }
  }

  // ── Spend today (app-wide analytics for the local day) ──
  const spendData = take('spend')
  const kpi = record(record(spendData).kpi)
  const round4 = (value: number) => Math.round(value * 10_000) / 10_000
  const spendToday = spendData === undefined ? null : {
    usd: num(kpi.totalCostUsd) === null ? null : round4(kpi.totalCostUsd as number),
    estimated: kpi.includesEstimated === true || (num(kpi.estimatedCostUsd) ?? 0) > 0,
    estimatedUsd: num(kpi.estimatedCostUsd) === null ? null : round4(kpi.estimatedCostUsd as number),
    byCategory: Object.fromEntries(rows(record(spendData).byCategory)
      .filter((entry) => typeof entry.category === 'string' && (num(entry.costUsd) ?? 0) > 0)
      .map((entry) => [entry.category as string, round4(entry.costUsd as number)])),
  }

  // ── Machine load of everything Specrails launched ──
  const resourcesData = take('resources')
  const totals = record(record(resourcesData).totals)
  const resources = resourcesData === undefined ? null : { cpuPercent: num(totals.cpuPercent), memoryBytes: num(totals.memoryBytes), processCount: num(totals.processCount) }

  // ── Mood, headline, next ──
  const asksForPerson = needsYou.some((item) => item.kind !== 'failed' && item.kind !== 'blocked')
  const running = missions.filter((mission) => mission.running).length + rails.length + jobs.length
  const mood: Mood = asksForPerson ? 'needs_you' : failures.length ? 'failing' : running || missions.length ? 'working' : 'idle'
  const needsYouTotal = items.length
  const parts = [
    running ? `${running} running` : null,
    needsYouTotal ? `${needsYouTotal} waiting for you` : null,
    failures.length ? `${failures.length} recent failure${failures.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  const spendText = spendToday?.usd !== null && spendToday?.usd !== undefined ? `${usd(spendToday.usd)} spent today${spendToday.estimated ? ' (partly estimated)' : ''}` : null
  const headline = `${parts.length ? parts.join(', ') : 'All quiet: nothing running and nothing waiting for you'}${spendText ? `; ${spendText}` : ''}.`
  const next = suggestNext({ needsYou, failures, missions, jobs, rails })

  const etag = createHash('sha256').update(JSON.stringify({
    mood,
    missions: missions.map((mission) => [mission.conversationId, mission.running]),
    rails: rails.map((rail) => [rail.projectId, rail.railIndex, rail.jobId]),
    jobs: jobs.map((job) => [job.jobId, job.status]),
    needsYou: items.map((item) => [item.id, item.version]),
    failures: failures.map((failure) => [failure.jobId, failure.hasAnalysis]),
    spend: spendToday?.usd === null || spendToday?.usd === undefined ? null : Math.round(spendToday.usd * 100),
  })).digest('hex').slice(0, 20)

  return {
    headline, mood, active: { missions, rails, jobs }, needsYou, needsYouTotal, failures, spendToday, resources, next,
    capturedAt: now.toISOString(), etag, partial, sources,
  }
}

/** The last run of a delivery (its `run_ids`), read from the delivery's own project database. */
function lastDeliveryRun(ctx: McpToolContext, projectId: unknown, deliveryId: string): string | null {
  try {
    const db = typeof projectId === 'string' ? ctx.registry.getContext(projectId)?.db : undefined
    const row = db ? getPrDelivery(db, deliveryId) : undefined
    const runs = row ? JSON.parse(String(row.run_ids ?? '[]')) as unknown : []
    const last = Array.isArray(runs) ? runs.filter((id): id is string => typeof id === 'string').pop() : undefined
    return last ?? null
  } catch {
    return null
  }
}

function suggestNext(state: { needsYou: Row[]; failures: Row[]; missions: Row[]; jobs: Row[]; rails: Row[] }): NextCall[] {
  const next: NextCall[] = []
  const question = state.needsYou.find((item) => item.kind === 'question')
  if (question) next.push({ tool: 'specrails_inbox', args: { action: 'question', projectId: question.projectId, runId: question.subjectId }, why: 'An agent is waiting for an answer; read its question.' })
  const review = state.needsYou.find((item) => item.kind === 'review')
  if (review) next.push({ tool: 'specrails_rails', args: { action: 'review_packet', projectId: review.projectId, prDeliveryId: review.subjectId }, why: 'A delivery is ready for review; read its evidence.' })
  const failure = state.failures[0]
  if (failure?.jobId) next.push({ tool: 'specrails_jobs', args: { action: 'diagnose_failure', projectId: failure.projectId, jobId: failure.jobId }, why: 'Explain why the latest failure stopped.' })
  else if (failure?.prDeliveryId) next.push({ tool: 'specrails_rails', args: { action: 'review_packet', projectId: failure.projectId, prDeliveryId: failure.prDeliveryId }, why: 'Read the evidence of the failed delivery.' })
  if (state.needsYou.length && !question && !review) next.push({ tool: 'specrails_inbox', args: { action: 'list' }, why: 'See everything waiting for the person.' })
  const mission = state.missions[0]
  if (mission && next.length < 3) next.push({ tool: 'specrails_missions', args: { action: 'get', conversationId: mission.conversationId }, why: 'See what the running mission is doing.' })
  const work = state.rails[0] ?? state.jobs[0]
  if (work && next.length < 3) next.push({ tool: 'specrails_watch', args: { ref: work.jobId, projectId: work.projectId }, why: 'Wait for the running work to settle.' })
  if (!next.length) next.push({ tool: 'specrails_projects', args: { action: 'list' }, why: 'Nothing is happening; pick a project to work on.' })
  return next.slice(0, 3)
}

export function statusTools(): McpToolSpec[] {
  return [{
    name: 'specrails_status',
    title: 'App status at a glance',
    description:
      'One cheap app-wide glance across all projects: headline, mood (idle|working|needs_you|failing), active missions/rails/jobs, what needs the person (the "Needs you" inbox), recent failures with a one-line reason and whether an AI analysis exists, today\'s spend by category, and CPU/memory of everything Specrails launched. ' +
      'Start here to orient yourself, or poll it from a lightweight client: pass the previous etag as ifNoneMatch to get {unchanged:true} while nothing meaningful changed. Sources fail independently (partial:true). Read-only.',
    tier: 'read',
    inputSchema: {
      ifNoneMatch: z.string().max(100).optional().describe('The etag of a previous specrails_status answer; returns {unchanged:true} when nothing meaningful changed'),
    },
    async handler(ctx, args) {
      const snapshot = await collectStatus(ctx)
      if (typeof args.ifNoneMatch === 'string' && args.ifNoneMatch === snapshot.etag) {
        return toolResponse({ unchanged: true, etag: snapshot.etag, capturedAt: snapshot.capturedAt, mood: snapshot.mood }, {
          status: 'unchanged', summary: 'Nothing changed since the last check.', ...(snapshot.partial ? { partial: true } : {}),
        })
      }
      return toolResponse(snapshot, {
        status: snapshot.mood,
        summary: snapshot.headline,
        next: snapshot.next,
        ...(snapshot.partial ? { partial: true } : {}),
      })
    },
  }]
}
