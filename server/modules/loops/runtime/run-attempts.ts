/**
 * Attempt chains: every run continued from another (a Core fork, `loop_runs.fork_of`)
 * is the next attempt of ONE unit of work. "Implement #14 · attempt 3" is the
 * chain; its earlier attempts are history, not separate failures.
 *
 * The one rule every surface shares (inbox, live board, jobs lists, ⌘K recents,
 * rail cards): an attempt that a later attempt took over (an adopted fork of it)
 * is superseded. It never counts or shows as pending on its own; the chain shows
 * its latest attempt's state.
 */
import type { DbInstance } from '../../../db'

/** SQL condition: the run aliased `alias` has an adopted continuation (a later attempt owns its work). */
export function supersededAttemptSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error('invalid SQL alias')
  return `EXISTS (SELECT 1 FROM definition_fork_operations sa WHERE sa.source_run_id = ${alias}.id AND sa.adopted = 1)`
}

export interface AttemptRow {
  id: string
  fork_of: string | null
  started_at: string
}

/** Where one run stands in its chain. `attempt` is 1-based in start order. */
export interface RunAttempt {
  runId: string
  rootRunId: string
  attempt: number
  attempts: number
  latestRunId: string
  previousRunId: string | null
}

/**
 * Group runs into chains by fork lineage. Pure. A run whose parent is not in
 * `rows` starts its own chain; cycles (never written, defensively) stop the walk.
 */
export function buildAttemptChains(rows: readonly AttemptRow[]): Map<string, RunAttempt> {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const rootOf = (id: string): string => {
    const seen = new Set<string>()
    let current = id
    for (;;) {
      const parent = byId.get(current)?.fork_of
      if (!parent || !byId.has(parent) || seen.has(parent)) return current
      seen.add(current)
      current = parent
    }
  }
  const chains = new Map<string, AttemptRow[]>()
  for (const row of rows) {
    const root = rootOf(row.id)
    const chain = chains.get(root) ?? []
    chain.push(row)
    chains.set(root, chain)
  }
  const out = new Map<string, RunAttempt>()
  for (const [root, chain] of chains) {
    chain.sort((a, b) => (a.id === root ? -1 : b.id === root ? 1 : a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : a.id < b.id ? -1 : 1))
    const latest = chain[chain.length - 1].id
    chain.forEach((row, index) => out.set(row.id, {
      runId: row.id, rootRunId: root, attempt: index + 1, attempts: chain.length, latestRunId: latest,
      previousRunId: row.fork_of && byId.has(row.fork_of) ? row.fork_of : null,
    }))
  }
  return out
}

/** The lineage rows connected to `runIds` (their ancestors and descendants), read from one project's database. */
function lineageRows(db: DbInstance, runIds: readonly string[]): AttemptRow[] {
  const parentOf = db.prepare('SELECT id, fork_of, started_at FROM loop_runs WHERE id = ?')
  const childrenOf = db.prepare('SELECT id, fork_of, started_at FROM loop_runs WHERE fork_of = ?')
  const rows = new Map<string, AttemptRow>()
  const queue = [...runIds]
  while (queue.length && rows.size < 2000) {
    const id = queue.shift()!
    if (rows.has(id)) continue
    const row = parentOf.get(id) as AttemptRow | undefined
    if (!row) continue
    rows.set(id, row)
    if (row.fork_of && !rows.has(row.fork_of)) queue.push(row.fork_of)
    for (const child of childrenOf.all(id) as AttemptRow[]) if (!rows.has(child.id)) queue.push(child.id)
  }
  return [...rows.values()]
}

/**
 * Attempt positions for the given runs. Only runs that belong to a chain of
 * more than one attempt are returned: a single run is not "attempt 1 of 1".
 */
export function readRunAttempts(db: DbInstance, runIds: readonly string[]): Map<string, RunAttempt> {
  const wanted = [...new Set(runIds)].filter(Boolean)
  if (!wanted.length) return new Map()
  // Most runs have no lineage: one indexed probe avoids walking them.
  const linked = wanted.filter((id) => db.prepare('SELECT 1 FROM loop_runs WHERE (id = ? AND fork_of IS NOT NULL) OR fork_of = ? LIMIT 1').get(id, id))
  if (!linked.length) return new Map()
  const chains = buildAttemptChains(lineageRows(db, linked))
  const out = new Map<string, RunAttempt>()
  for (const id of wanted) {
    const attempt = chains.get(id)
    if (attempt && attempt.attempts > 1) out.set(id, attempt)
  }
  return out
}

/**
 * Every run of each given run's chain, oldest attempt first. Only runs that
 * belong to a chain of more than one attempt are returned. A chain card adds
 * its attempts' costs up from this (the earlier attempts have no card).
 */
export function readAttemptChainRunIds(db: DbInstance, runIds: readonly string[]): Map<string, string[]> {
  const positions = readRunAttempts(db, runIds)
  if (!positions.size) return new Map()
  const chains = buildAttemptChains(lineageRows(db, [...positions.keys()]))
  const byRoot = new Map<string, RunAttempt[]>()
  for (const item of chains.values()) {
    const list = byRoot.get(item.rootRunId) ?? []
    list.push(item)
    byRoot.set(item.rootRunId, list)
  }
  const out = new Map<string, string[]>()
  for (const [runId, position] of positions) {
    out.set(runId, (byRoot.get(position.rootRunId) ?? []).sort((a, b) => a.attempt - b.attempt).map((item) => item.runId))
  }
  return out
}

/** How a continued attempt came to be (migration 96). */
export interface RunContinuation {
  runId: string
  sourceRunId: string
  /** `continue` or `continue-to-review`. */
  remedy: string
  /** `fork` (a new attempt from a step) or `resume` (the same run picked up in place). */
  mode: 'fork' | 'resume'
  fromStep: string | null
  /** The diagnosis kind it answered, when there was one. */
  cause: string | null
  /** The operator instruction sent with it, when there was one. */
  guidance: string | null
  automatic: boolean
  createdAt: string
}

interface ContinuationRow { run_id: string; source_run_id: string; remedy: string; mode: string; from_step: string | null; cause: string | null; guidance: string | null; automatic: number; created_at: string }

const fromRow = (row: ContinuationRow): RunContinuation => ({
  runId: row.run_id, sourceRunId: row.source_run_id, remedy: row.remedy, mode: row.mode === 'resume' ? 'resume' : 'fork',
  fromStep: row.from_step, cause: row.cause, guidance: row.guidance, automatic: row.automatic === 1, createdAt: row.created_at,
})

/** Record a continuation. A fork records the new attempt; a resume in place records the same run (source = run). */
export function recordRunContinuation(db: DbInstance, input: Omit<RunContinuation, 'createdAt'> & { createdAt?: string }): void {
  db.prepare(`INSERT INTO run_continuations (run_id, source_run_id, remedy, mode, from_step, cause, guidance, automatic, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.runId, input.sourceRunId, input.remedy, input.mode, input.fromStep, input.cause,
    input.guidance ? input.guidance.slice(0, 8000) : null, input.automatic ? 1 : 0, input.createdAt ?? new Date().toISOString())
}

/** Every continuation recorded for each run, oldest first. */
export function readRunContinuations(db: DbInstance, runIds: readonly string[]): Map<string, RunContinuation[]> {
  const out = new Map<string, RunContinuation[]>()
  const read = db.prepare('SELECT * FROM run_continuations WHERE run_id = ? ORDER BY id')
  for (const id of runIds) {
    const rows = read.all(id) as ContinuationRow[]
    if (rows.length) out.set(id, rows.map(fromRow))
  }
  return out
}

/** Whether Specrails already continued any attempt of this run's chain on its own (the bound is one per chain). */
export function chainHasAutomaticContinuation(db: DbInstance, runId: string): boolean {
  const ids = lineageRows(db, [runId]).map((row) => row.id)
  if (!ids.includes(runId)) ids.push(runId)
  const read = db.prepare('SELECT 1 FROM run_continuations WHERE (run_id = ? OR source_run_id = ?) AND automatic = 1 LIMIT 1')
  return ids.some((id) => !!read.get(id, id))
}

export interface ChainAttemptView {
  runId: string
  attempt: number
  status: string
  outcome: string | null
  startedAt: string
  finishedAt: string | null
  /** The step this attempt continued from (its fork cut), when it is a continuation. */
  fromStep: string | null
  /** How it was continued (the fork that created it first, then any resume in place). */
  continuations: RunContinuation[]
  /** This attempt's own recorded cost (null when unknown); `costEstimated` marks a rate-card estimate. */
  costUsd: number | null
  costEstimated: boolean
}

/** The whole chain a run belongs to, oldest attempt first (the run window's lineage). Null for a run without lineage. */
export function readAttemptChain(db: DbInstance, runId: string): { runId: string; attempt: number; attempts: ChainAttemptView[] } | null {
  const position = readRunAttempts(db, [runId]).get(runId)
  if (!position) return null
  const chains = buildAttemptChains(lineageRows(db, [runId]))
  const members = [...chains.values()].filter((item) => item.rootRunId === position.rootRunId).sort((a, b) => a.attempt - b.attempt)
  const continuations = readRunContinuations(db, members.map((member) => member.runId))
  const read = db.prepare(`SELECT r.status, r.final_outcome, r.started_at, r.finished_at, r.fork_cut_json, r.total_cost_usd, j.total_cost_usd_estimated AS cost_estimated
    FROM loop_runs r LEFT JOIN jobs j ON j.id = r.id WHERE r.id = ?`)
  const attempts = members.map((member): ChainAttemptView => {
    const row = read.get(member.runId) as { status: string; final_outcome: string | null; started_at: string; finished_at: string | null; fork_cut_json: string | null; total_cost_usd: number | null; cost_estimated: number | null }
    let fromStep: string | null = null
    try { const cut = row.fork_cut_json ? JSON.parse(row.fork_cut_json) as { fromNodePath?: unknown } : null; fromStep = typeof cut?.fromNodePath === 'string' ? cut.fromNodePath : null } catch { fromStep = null }
    return { runId: member.runId, attempt: member.attempt, status: row.status, outcome: row.final_outcome, startedAt: row.started_at, finishedAt: row.finished_at,
      fromStep, continuations: continuations.get(member.runId) ?? [],
      costUsd: typeof row.total_cost_usd === 'number' ? row.total_cost_usd : null,
      costEstimated: typeof row.total_cost_usd === 'number' && row.cost_estimated === 1 }
  })
  return { runId, attempt: position.attempt, attempts }
}
