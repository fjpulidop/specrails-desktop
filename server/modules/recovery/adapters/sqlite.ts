import type { DbInstance } from '../../../db'
import {
  deriveFailureDiagnosis, isDiagnosableOutcome, parseStoredDiagnosis, presentFailureDiagnosis,
  type FailureDiagnosis, type PresentedFailureDiagnosis,
} from '../domain'
import type { FailureAnalysis } from '../analysis'
import { repeatedStop, type AttemptStop } from '../continuation'
import { classifyVerificationTests, type VerificationTests } from '../verification-tests'
import { getAdapter, hasAdapter } from '../../../providers'

/** The provider catalogs a `workflow_protocol` diagnosis reads its stronger-model suggestion from. */
const providerCatalog = (provider: string) => (hasAdapter(provider) ? getAdapter(provider).modelCatalog() : null)

interface RunRow {
  status: string
  final_outcome: string | null
  failure_diagnosis: string | null
}

/**
 * The diagnosis of one loop run in THIS project's database: the record stored
 * when the run ended, or, for a run that finished before diagnosis existed, the
 * one derivable from its outcome alone (`unknown`/low: nothing else was kept).
 * Null for a run that did not fail or block.
 */
export function readRunDiagnosis(db: DbInstance, runId: string): PresentedFailureDiagnosis | null {
  const run = db.prepare('SELECT status, final_outcome, failure_diagnosis FROM loop_runs WHERE id = ?').get(runId) as RunRow | undefined
  if (!run || run.status !== 'completed' || !isDiagnosableOutcome(run.final_outcome)) return null
  const stored = parseStoredDiagnosis(run.failure_diagnosis)
  const presented = presentFailureDiagnosis(stored ?? deriveFailureDiagnosis({ outcome: run.final_outcome }), providerCatalog, { envFilesEnabled: readEnvFilesSetting(db) })
  if (presented.kind !== 'tests_failed' && presented.kind !== 'blocked' && presented.kind !== 'unknown') return presented
  let tests: VerificationTests | null = null
  try { tests = readVerificationTests(db, runId) } catch { tests = null }
  return tests?.failingTests.length ? { ...presented, failingTests: tests.failingTests, ...(tests.flakyTests.length ? { flakyTests: tests.flakyTests } : {}) } : presented
}

/** How many attempts back a chain is read (a chain this long is already a loop). */
const CHAIN_LIMIT = 20

/** The run and the attempts it continued, oldest first (`loop_runs.fork_of`), in THIS project's database. */
export function readChainAncestors(db: DbInstance, runId: string): string[] {
  const parent = db.prepare('SELECT fork_of FROM loop_runs WHERE id = ?')
  const chain = [runId]
  for (let current = runId; chain.length < CHAIN_LIMIT;) {
    const row = parent.get(current) as { fork_of: string | null } | undefined
    if (!row?.fork_of || chain.includes(row.fork_of)) break
    chain.unshift(row.fork_of)
    current = row.fork_of
  }
  return chain
}

/** Settled runs never change: their test reading is kept per database (bounded). */
const testsCache = new WeakMap<DbInstance, Map<string, VerificationTests>>()
const TESTS_CACHE_LIMIT = 256
const ROUND_LINE_LIMIT = 20_000

/**
 * The failing and flaky tests of a run's latest host verification, from the verification output
 * recorded by it and by the attempts it continued (one round per visit of the verification step).
 * Read-only; nothing is re-run.
 */
export function readVerificationTests(db: DbInstance, runId: string): VerificationTests {
  const settled = (db.prepare('SELECT status FROM loop_runs WHERE id = ?').get(runId) as { status: string } | undefined)?.status === 'completed'
  const cache = testsCache.get(db) ?? new Map<string, VerificationTests>()
  testsCache.set(db, cache)
  const hit = settled ? cache.get(runId) : undefined
  if (hit) return hit
  const read = db.prepare("SELECT payload FROM events WHERE job_id = ? AND event_type = 'verification-output' ORDER BY seq")
  const rounds: Array<{ lines: string[] }> = []
  for (const id of readChainAncestors(db, runId)) {
    const byVisit = new Map<string, string[]>()
    for (const row of read.iterate(id) as Iterable<{ payload: string | null }>) {
      let payload: { text?: unknown; visit?: unknown } = {}
      try { payload = JSON.parse(row.payload ?? '{}') as typeof payload } catch { continue }
      if (typeof payload.text !== 'string') continue
      const key = String(payload.visit ?? '')
      const lines = byVisit.get(key) ?? []
      if (lines.length < ROUND_LINE_LIMIT) lines.push(...payload.text.split('\n'))
      byVisit.set(key, lines)
    }
    for (const lines of byVisit.values()) rounds.push({ lines })
  }
  const tests = classifyVerificationTests(rounds)
  if (settled) {
    if (cache.size >= TESTS_CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
    cache.set(runId, tests)
  }
  return tests
}

export interface ChainResolution {
  /** Attempts of the chain up to and including this run. */
  attempts: number
  /** Their recorded cost (null when none is known); `costEstimated` when any part is a rate-card estimate. */
  costUsd: number | null
  costEstimated: boolean
  /** The latest attempts keep stopping for the same cause (`repeatedStop`). */
  repeated: boolean
  times: number
}

/** A chain's spend and whether it keeps stopping the same way, up to this run. Null for a run that continued nothing. */
export function readChainResolution(db: DbInstance, runId: string): ChainResolution | null {
  const chain = readChainAncestors(db, runId)
  if (chain.length < 2) return null
  const read = db.prepare(`SELECT r.status, r.final_outcome, r.failure_diagnosis, r.total_cost_usd, j.total_cost_usd_estimated AS estimated
    FROM loop_runs r LEFT JOIN jobs j ON j.id = r.id WHERE r.id = ?`)
  let cost = 0, known = false, estimated = false
  const stops: AttemptStop[] = []
  for (const id of chain) {
    const row = read.get(id) as { status: string; final_outcome: string | null; failure_diagnosis: string | null; total_cost_usd: number | null; estimated: number | null } | undefined
    if (!row) continue
    if (typeof row.total_cost_usd === 'number') { cost += row.total_cost_usd; known = true; if (row.estimated === 1) estimated = true }
    const diagnosis: FailureDiagnosis | null = row.status === 'completed' && isDiagnosableOutcome(row.final_outcome) ? parseStoredDiagnosis(row.failure_diagnosis) : null
    let failingTests: string[] = []
    if (diagnosis && (diagnosis.kind === 'tests_failed' || diagnosis.kind === 'blocked')) { try { failingTests = readVerificationTests(db, id).failingTests } catch { failingTests = [] } }
    stops.push({ diagnosis, failingTests })
  }
  const repeat = repeatedStop(stops)
  return { attempts: chain.length, costUsd: known ? Math.round(cost * 100) / 100 : null, costEstimated: estimated, repeated: repeat.repeated, times: repeat.times }
}

/** The project's `worktreeEnvFiles` setting (row present only while on; see project-settings). */
function readEnvFilesSetting(db: DbInstance): boolean {
  try {
    const row = db.prepare("SELECT value FROM queue_state WHERE key = 'config.worktree_env_files'").get() as { value: string } | undefined
    return row?.value === 'true'
  } catch {
    return true // unknown: offer nothing extra
  }
}

/**
 * A job's diagnosis: its loop run's when it has one; a queue job that failed
 * has only an exit code, so it is an honest `unknown`.
 */
export function readJobDiagnosis(db: DbInstance, jobId: string, jobStatus: string | null | undefined): PresentedFailureDiagnosis | null {
  const run = db.prepare('SELECT 1 FROM loop_runs WHERE id = ?').get(jobId)
  if (run) return readRunDiagnosis(db, jobId)
  return jobStatus === 'failed' ? presentFailureDiagnosis(deriveFailureDiagnosis({ outcome: 'failed' })) : null
}

export interface StoredFailureAnalysis {
  inputHash: string
  language: string
  provider: string
  model: string | null
  analysis: FailureAnalysis
  createdAt: string
}

export function readFailureAnalysis(db: DbInstance, jobId: string): StoredFailureAnalysis | null {
  const row = db.prepare('SELECT input_hash, language, provider, model, analysis, created_at FROM job_failure_analyses WHERE job_id = ?')
    .get(jobId) as { input_hash: string; language: string; provider: string; model: string | null; analysis: string; created_at: string } | undefined
  if (!row) return null
  try {
    return { inputHash: row.input_hash, language: row.language, provider: row.provider, model: row.model, analysis: JSON.parse(row.analysis) as FailureAnalysis, createdAt: row.created_at }
  } catch { return null }
}

export function writeFailureAnalysis(db: DbInstance, jobId: string, stored: StoredFailureAnalysis): void {
  db.prepare(`
    INSERT INTO job_failure_analyses (job_id, input_hash, language, provider, model, analysis, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET input_hash = excluded.input_hash, language = excluded.language,
      provider = excluded.provider, model = excluded.model, analysis = excluded.analysis, created_at = excluded.created_at
  `).run(jobId, stored.inputHash, stored.language, stored.provider, stored.model, JSON.stringify(stored.analysis), stored.createdAt)
}
