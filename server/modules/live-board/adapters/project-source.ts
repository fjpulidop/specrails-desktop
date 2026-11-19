import type { DbInstance } from '../../../db'
import { runQuestionFromStatus } from '../../../shared/run-question'
import { readSpecSnapshot } from '../../delivery/runtime/rail-pr-store'
import { readAttemptChainRunIds, readRunAttempts, supersededAttemptSql } from '../../loops/runtime/run-attempts'
import { toIso, type DayWindow, type LiveRunFacts, type LiveSteps } from '../domain'
import type { ProjectLiveBoardSource } from '../ports'

/** Rows read per table and project: a live board, not a history. */
const ROW_CAP = 200
/** `IN (…)` lists are chunked well under SQLite's variable limit. */
const CHUNK = 400

export interface LiveBoardProjectHandle {
  project: { id: string; name: string }
  db: DbInstance
  /**
   * Missions of live shared-checkout rail runs. Those runs have no delivery
   * row, so the launching mission is only known to the running project
   * (`ProjectContext.railLoopRuns`); isolated runs keep it on the delivery.
   */
  liveRunMissions?: () => ReadonlyMap<string, { originConversationId?: string }>
}

interface LoopRunRow {
  id: string
  loop_name: string | null
  rail_index: number | null
  ticket_ids_json: string | null
  provider: string | null
  model: string | null
  status: 'running' | 'paused' | 'completed'
  final_outcome: string | null
  restart_reason: string | null
  total_cost_usd: number | null
  started_at: string
  finished_at: string | null
  runtime_status_json: string | null
  cost_estimated: number | null
}

interface DeliveryRow {
  id: string
  rail_index: number
  loop_name: string
  rail_key: string
  ticket_ids: string
  decision: string
  status_code: string | null
  run_ids: string
  spec_snapshot: string | null
  origin_conversation_id: string | null
  created_at: string
  settled_at: string | null
}

interface JobRow {
  id: string
  command: string
  status: string
  started_at: string | null
  finished_at: string | null
  total_cost_usd: number | null
  total_cost_usd_estimated: number | null
  provider: string | null
  model: string | null
}

interface IntentRow {
  id: string
  conversation_id: string
  ticket_id: number | null
  state: string
  rail_index: number | null
  step: string | null
  created_at: string
  updated_at: string
}

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += CHUNK) out.push(values.slice(i, i + CHUNK))
  return out
}

const marks = (n: number): string => Array.from({ length: n }, () => '?').join(',')

function jsonArray(raw: string | null | undefined): unknown[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function ticketIds(raw: string | null | undefined): number[] {
  return jsonArray(raw).filter((v): v is number => typeof v === 'number')
}

function runTitle(loopName: string | null, ids: readonly number[]): string {
  const label = ids.length === 0 ? '' : ` · ${ids.slice(0, 3).map((id) => `#${id}`).join(', ')}${ids.length > 3 ? ` +${ids.length - 3}` : ''}`
  return `${loopName || 'Run'}${label}`
}

function deliveryTitle(row: DeliveryRow): string {
  const specs = readSpecSnapshot(row.spec_snapshot) ?? []
  const first = specs.find((s) => s.title)?.title
  if (first) return specs.length > 1 ? `${first} +${specs.length - 1}` : first
  return row.loop_name || row.rail_key
}

interface RunCostRow { id: string; total_cost_usd: number | null; cost_estimated: number | null }

/** Recorded cost of runs the board lists no card for (the earlier attempts of a chain). */
function runCosts(db: DbInstance, projectId: string, runIds: readonly string[]): Map<string, RunCostRow> {
  const out = new Map<string, RunCostRow>()
  for (const ids of chunks(runIds)) {
    const rows = db.prepare(`
      SELECT r.id, r.total_cost_usd, j.total_cost_usd_estimated AS cost_estimated
      FROM loop_runs r LEFT JOIN jobs j ON j.id = r.id
      WHERE r.project_id = ? AND r.id IN (${marks(ids.length)})
    `).all(projectId, ...ids) as RunCostRow[]
    for (const row of rows) out.set(row.id, row)
  }
  return out
}

/** Costs recorded today, per run (loop runs by `loop_run_id`, queue jobs by their `job` invocations). */
function todayCosts(db: DbInstance, day: DayWindow): Map<string, number> {
  const rows = db.prepare(`
    SELECT COALESCE(loop_run_id, surface_ref_id) AS ref, SUM(total_cost_usd) AS cost
    FROM ai_invocations
    WHERE started_at >= ? AND started_at < ? AND total_cost_usd IS NOT NULL
      AND (loop_run_id IS NOT NULL OR (surface = 'job' AND surface_ref_id IS NOT NULL))
    GROUP BY ref
  `).all(day.from, day.to) as Array<{ ref: string | null; cost: number | null }>
  const out = new Map<string, number>()
  for (const row of rows) if (row.ref && typeof row.cost === 'number') out.set(row.ref, row.cost)
  return out
}

/** The step each running loop run is on: its latest `loop_step` event, one statement for all of them. */
function currentSteps(db: DbInstance, runIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const ids of chunks(runIds)) {
    const rows = db.prepare(`
      SELECT e.job_id AS id, json_extract(e.payload, '$.title') AS title
      FROM events e
      WHERE e.event_type = 'loop_step' AND e.job_id IN (${marks(ids.length)})
        AND e.seq = (SELECT MAX(x.seq) FROM events x WHERE x.job_id = e.job_id AND x.event_type = 'loop_step')
    `).all(...ids) as Array<{ id: string; title: unknown }>
    for (const row of rows) if (typeof row.title === 'string' && row.title.trim()) out.set(row.id, row.title.trim())
  }
  return out
}

/** Pipeline phases of running queue jobs: which phase runs and how many are done. */
function jobPhases(db: DbInstance, jobIds: readonly string[]): Map<string, { phase: string | null; steps: LiveSteps }> {
  const out = new Map<string, { phase: string | null; steps: LiveSteps }>()
  for (const ids of chunks(jobIds)) {
    const rows = db.prepare(`SELECT job_id, phase, state FROM job_phases WHERE job_id IN (${marks(ids.length)})`).all(...ids) as Array<{ job_id: string; phase: string; state: string }>
    for (const row of rows) {
      const entry = out.get(row.job_id) ?? { phase: null, steps: { done: 0, total: 0 } }
      entry.steps.total += 1
      if (row.state === 'done') entry.steps.done += 1
      if (row.state === 'running') entry.phase = row.phase
      out.set(row.job_id, entry)
    }
  }
  return out
}

/** CI-fix runs started from a mission keep their mission on the admission row. */
function ciRunMissions(db: DbInstance, projectId: string, runIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const ids of chunks(runIds)) {
    const rows = db.prepare(`SELECT run_id, origin_conversation_id FROM pr_ci_admissions WHERE project_id = ? AND run_id IN (${marks(ids.length)}) AND origin_conversation_id IS NOT NULL`)
      .all(projectId, ...ids) as Array<{ run_id: string; origin_conversation_id: string }>
    for (const row of rows) out.set(row.run_id, row.origin_conversation_id)
  }
  return out
}

function guard<T>(projectId: string, label: string, fallback: T, read: () => T): T {
  try { return read() } catch (err) {
    console.warn(`[live-board] ${projectId} ${label} unavailable:`, err instanceof Error ? err.message : err)
    return fallback
  }
}

/**
 * Bind the live board's reads to ONE project's own database. Each read is
 * isolated: a missing table or a corrupt row costs that read, not the rest.
 * Every statement is parameterized and runs once per refresh (no per-card
 * query): live runs plus the ones that settled inside the local day.
 */
export function createProjectLiveBoardSource(handle: LiveBoardProjectHandle): ProjectLiveBoardSource {
  const { id: projectId, name: projectName } = handle.project
  return {
    projectId,
    projectName,
    collect(day) {
      const db = handle.db
      const runs: LiveRunFacts[] = []
      const costs = guard(projectId, 'today costs', new Map<string, number>(), () => todayCosts(db, day))
      const cost = (...ids: string[]): number | null => {
        let total: number | null = null
        for (const id of ids) { const value = costs.get(id); if (value !== undefined) total = (total ?? 0) + value }
        return total
      }

      // ── Deliveries (isolated rail launches): the delivery is the card; its runs are not repeated.
      const deliveries = guard(projectId, 'deliveries', [] as DeliveryRow[], () => db.prepare(`
        SELECT id, rail_index, loop_name, rail_key, ticket_ids, decision, status_code, run_ids, spec_snapshot, origin_conversation_id, created_at,
               COALESCE(merged_at, decided_at, updated_at) AS settled_at
        FROM rail_pr_deliveries
        WHERE parent_delivery_id IS NULL AND (
          decision NOT IN ('completed','merged','discarded','superseded','no_changes','pr_closed')
          OR (julianday(COALESCE(merged_at, decided_at, updated_at)) >= julianday(?) AND julianday(COALESCE(merged_at, decided_at, updated_at)) < julianday(?))
        )
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${ROW_CAP}
      `).all(day.from, day.to) as DeliveryRow[])
      const represented = new Set<string>()
      guard(projectId, 'represented runs', undefined, () => {
        const rows = db.prepare(`SELECT run_ids FROM rail_pr_deliveries WHERE run_ids != '[]' ORDER BY created_at DESC LIMIT 500`).all() as Array<{ run_ids: string }>
        for (const row of rows) for (const id of jsonArray(row.run_ids)) if (typeof id === 'string') represented.add(id)
      })
      const deliveryRunIds = deliveries.flatMap((row) => jsonArray(row.run_ids).filter((v): v is string => typeof v === 'string'))

      // ── Loop runs: live ones and the ones settled today, plus every run a listed delivery owns.
      const loopRuns = guard(projectId, 'loop runs', [] as LoopRunRow[], () => {
        const rows = db.prepare(`
          SELECT r.id, r.loop_name, r.rail_index, r.ticket_ids_json, r.provider, r.model, r.status, r.final_outcome, r.restart_reason,
                 r.total_cost_usd, r.started_at, r.finished_at, r.runtime_status_json, j.total_cost_usd_estimated AS cost_estimated
          FROM loop_runs r LEFT JOIN jobs j ON j.id = r.id
          WHERE r.project_id = ? AND (r.status IN ('running','paused')
            OR (julianday(r.finished_at) >= julianday(?) AND julianday(r.finished_at) < julianday(?)))
            -- One card per attempt chain: an attempt a later one continued is history.
            AND NOT ${supersededAttemptSql('r')}
          ORDER BY r.started_at DESC
          LIMIT ${ROW_CAP}
        `).all(projectId, day.from, day.to) as LoopRunRow[]
        const known = new Set(rows.map((row) => row.id))
        const missing = deliveryRunIds.filter((id) => !known.has(id))
        for (const ids of chunks(missing)) {
          rows.push(...db.prepare(`
            SELECT r.id, r.loop_name, r.rail_index, r.ticket_ids_json, r.provider, r.model, r.status, r.final_outcome, r.restart_reason,
                   r.total_cost_usd, r.started_at, r.finished_at, r.runtime_status_json, j.total_cost_usd_estimated AS cost_estimated
            FROM loop_runs r LEFT JOIN jobs j ON j.id = r.id
            WHERE r.project_id = ? AND r.id IN (${marks(ids.length)})
          `).all(projectId, ...ids) as LoopRunRow[])
        }
        return rows
      })
      const runById = new Map(loopRuns.map((row) => [row.id, row]))
      const running = loopRuns.filter((row) => row.status === 'running').map((row) => row.id)
      const steps = guard(projectId, 'loop steps', new Map<string, string>(), () => currentSteps(db, running))
      const ciMissions = guard(projectId, 'CI missions', new Map<string, string>(), () => ciRunMissions(db, projectId, loopRuns.map((row) => row.id)))
      const attempts = guard(projectId, 'attempt chains', new Map() as ReturnType<typeof readRunAttempts>, () => readRunAttempts(db, [...loopRuns.map((row) => row.id), ...deliveryRunIds]))
      // One card per attempt chain: the card's cost is the chain's (every
      // attempt added up, as analytics counts it). An earlier attempt has no
      // card of its own, so its cost is counted once, on its chain's card.
      const chains = guard(projectId, 'attempt chain runs', new Map<string, string[]>(), () => readAttemptChainRunIds(db, [...loopRuns.map((row) => row.id), ...deliveryRunIds]))
      const loopCardRows = loopRuns.filter((row) => !represented.has(row.id) && !(row.status === 'paused' && row.restart_reason === 'fork'))
      const ownCardRuns = new Set([...deliveryRunIds, ...loopCardRows.map((row) => row.id)])
      const earlier = [...new Set([...chains.values()].flat())].filter((id) => !runById.has(id))
      const earlierCosts = guard(projectId, 'attempt costs', new Map<string, RunCostRow>(), () => runCosts(db, projectId, earlier))
      const costRow = (id: string): RunCostRow | undefined => runById.get(id) ?? earlierCosts.get(id)
      const counted = new Set<string>()
      const chainCost = (ids: readonly string[]) => {
        const members = [...new Set(ids)]
        for (const id of ids) {
          for (const member of chains.get(id) ?? []) {
            if (members.includes(member) || ownCardRuns.has(member) || counted.has(member)) continue
            members.push(member)
          }
        }
        for (const member of members) counted.add(member)
        let total: number | null = null
        let estimatedUsd: number | null = null
        let estimated = false
        for (const member of members) {
          const row = costRow(member)
          if (row?.cost_estimated === 1) estimated = true
          if (typeof row?.total_cost_usd !== 'number') continue
          total = (total ?? 0) + row.total_cost_usd
          if (row.cost_estimated === 1) estimatedUsd = (estimatedUsd ?? 0) + row.total_cost_usd
        }
        return { total, estimatedUsd, estimated, todayUsd: cost(...members) }
      }
      const attemptOf = (id: string | null | undefined) => {
        const position = id ? attempts.get(id) : undefined
        if (!id || !position) return null
        const row = costRow(id)
        const own = typeof row?.total_cost_usd === 'number' ? row.total_cost_usd : null
        return { number: position.attempt, of: position.attempts, costUsd: own, costEstimated: own !== null && row?.cost_estimated === 1 }
      }
      const liveMissions = guard(projectId, 'live run missions', new Map() as ReadonlyMap<string, { originConversationId?: string }>, () => handle.liveRunMissions?.() ?? new Map())

      for (const row of deliveries) {
        const ids = jsonArray(row.run_ids).filter((v): v is string => typeof v === 'string')
        const own = ids.map((id) => runById.get(id)).filter((r): r is LoopRunRow => !!r)
        const live = own.find((r) => r.status === 'running') ?? null
        // A delivery still building whose run is paused (a restart, a question, a provider limit)
        // is not working: the card wears the paused run's state, so the board never says
        // "Running" with a growing timer while nothing moves.
        const paused = !live && row.decision === 'building' ? own.find((r) => r.status === 'paused') ?? null : null
        const pausedQuestion = paused ? runQuestionFromStatus(paused.runtime_status_json) : null
        const starts = own.map((r) => toIso(r.started_at)).filter((v): v is string => !!v).sort()
        const terminal = !['building', 'on_review', 'pr_draft', 'pr_ready'].includes(row.decision)
        const chain = chainCost(ids)
        runs.push({
          sourceId: row.id, kind: 'rail',
          status: { source: 'delivery', decision: row.decision, statusCode: row.status_code, ...(paused ? { paused: true } : {}) },
          title: deliveryTitle(row),
          phase: live ? steps.get(live.id) ?? null : null,
          question: pausedQuestion, steps: null,
          provider: own.find((r) => r.provider)?.provider ?? null,
          model: own.find((r) => r.model)?.model ?? null,
          startedAt: starts[0] ?? toIso(row.created_at),
          finishedAt: terminal ? toIso(row.settled_at) : null,
          costUsd: chain.total,
          costEstimated: chain.estimated,
          costEstimatedUsd: chain.estimatedUsd,
          costTodayUsd: chain.todayUsd,
          railIndex: Number.isInteger(row.rail_index) ? row.rail_index : null,
          ticketIds: ticketIds(row.ticket_ids),
          conversationId: row.origin_conversation_id,
          jobId: ids.length > 0 ? ids[ids.length - 1] : null,
          deliveryId: row.id,
          // A paused run's question is the inbox's item: it lands on this card, so the board says it once.
          subjectIds: paused && pausedQuestion ? [row.id, paused.id] : [row.id],
          attempt: attemptOf(ids[ids.length - 1]),
        })
      }

      // Forked-away and adopted runs are the inbox's call (it skips them); a fork pause is not news.
      for (const row of loopCardRows) {
        const ids = ticketIds(row.ticket_ids_json)
        const chain = chainCost([row.id])
        runs.push({
          sourceId: row.id,
          kind: typeof row.rail_index === 'number' ? 'rail' : 'loop',
          status: { source: 'loop-run', status: row.status, outcome: row.final_outcome, restartReason: row.restart_reason },
          title: runTitle(row.loop_name, ids),
          phase: row.status === 'running' ? steps.get(row.id) ?? null : null,
          question: row.status === 'paused' ? runQuestionFromStatus(row.runtime_status_json) : null,
          steps: null,
          provider: row.provider, model: row.model,
          startedAt: toIso(row.started_at), finishedAt: toIso(row.finished_at),
          costUsd: chain.total !== null && chain.total > 0 ? chain.total : null,
          costEstimated: chain.estimated,
          costEstimatedUsd: chain.total !== null && chain.total > 0 ? chain.estimatedUsd : null,
          costTodayUsd: chain.todayUsd,
          railIndex: typeof row.rail_index === 'number' ? row.rail_index : null,
          ticketIds: ids,
          conversationId: liveMissions.get(row.id)?.originConversationId ?? ciMissions.get(row.id) ?? null,
          jobId: row.id, deliveryId: null,
          subjectIds: [row.id],
          attempt: attemptOf(row.id),
        })
      }

      // ── Intent sessions (a handed-off one continues as its delivery's card).
      const intents = guard(projectId, 'Intent sessions', [] as IntentRow[], () => db.prepare(`
        SELECT id, conversation_id, ticket_id, state, rail_index, step, created_at, updated_at
        FROM flow_sessions
        WHERE state IN ('active','paused','needs-review')
          OR (state IN ('delivered','discarded','closed') AND julianday(updated_at) >= julianday(?) AND julianday(updated_at) < julianday(?))
        ORDER BY created_at DESC
        LIMIT ${ROW_CAP}
      `).all(day.from, day.to) as IntentRow[])
      for (const row of intents) {
        const open = row.state === 'active' || row.state === 'paused' || row.state === 'needs-review'
        runs.push({
          sourceId: row.id, kind: 'intent',
          status: { source: 'intent', state: row.state },
          title: null, phase: null, question: null, steps: null,
          provider: null, model: null,
          startedAt: toIso(row.created_at), finishedAt: open ? null : toIso(row.updated_at),
          costUsd: null, costEstimated: false, costEstimatedUsd: null, costTodayUsd: null,
          railIndex: typeof row.rail_index === 'number' ? row.rail_index : null,
          ticketIds: typeof row.ticket_id === 'number' ? [row.ticket_id] : [],
          conversationId: row.conversation_id,
          jobId: null, deliveryId: null,
          subjectIds: [row.id],
        })
      }

      // ── Queue jobs (the board's own runs; a loop run's backing job is the loop run above).
      const jobs = guard(projectId, 'jobs', [] as JobRow[], () => {
        const rows = db.prepare(`
          SELECT id, command, status, started_at, finished_at, total_cost_usd, total_cost_usd_estimated, provider, model
          FROM jobs
          WHERE owner = 'queue' AND (status IN ('queued','running')
            OR (julianday(finished_at) >= julianday(?) AND julianday(finished_at) < julianday(?)))
          ORDER BY started_at DESC
          LIMIT ${ROW_CAP}
        `).all(day.from, day.to) as JobRow[]
        const known = new Set(rows.map((row) => row.id))
        const queued = guard(projectId, 'queued admissions', [] as Array<{ id: string; command: string; enqueued_at: string }>, () =>
          db.prepare(`SELECT id, command, enqueued_at FROM queued_jobs ORDER BY queue_position ASC LIMIT ${ROW_CAP}`).all() as Array<{ id: string; command: string; enqueued_at: string }>)
        for (const q of queued) {
          if (known.has(q.id)) continue
          rows.push({ id: q.id, command: q.command, status: 'queued', started_at: q.enqueued_at, finished_at: null, total_cost_usd: null, total_cost_usd_estimated: null, provider: null, model: null })
        }
        return rows
      })
      const phases = guard(projectId, 'job phases', new Map<string, { phase: string | null; steps: LiveSteps }>(), () =>
        jobPhases(db, jobs.filter((row) => row.status === 'running').map((row) => row.id)))
      for (const row of jobs) {
        const phase = phases.get(row.id)
        runs.push({
          sourceId: row.id, kind: 'job',
          status: { source: 'job', status: row.status },
          title: row.command,
          phase: phase?.phase ?? null, question: null,
          steps: phase && phase.steps.total > 0 ? phase.steps : null,
          provider: row.provider, model: row.model,
          startedAt: toIso(row.started_at), finishedAt: toIso(row.finished_at),
          costUsd: typeof row.total_cost_usd === 'number' ? row.total_cost_usd : null,
          costEstimated: row.total_cost_usd_estimated === 1,
          costEstimatedUsd: row.total_cost_usd_estimated === 1 && typeof row.total_cost_usd === 'number' ? row.total_cost_usd : null,
          costTodayUsd: cost(row.id),
          railIndex: null, ticketIds: [], conversationId: null,
          jobId: row.id, deliveryId: null,
          subjectIds: [row.id],
          attempt: attemptOf(row.id),
        })
      }
      return runs
    },
  }
}
