import type { DbInstance } from '../../../db'
import {
  deriveFailureDiagnosis, isDiagnosableOutcome, parseStoredDiagnosis, presentFailureDiagnosis,
  type PresentedFailureDiagnosis,
} from '../domain'
import type { FailureAnalysis } from '../analysis'
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
  return presentFailureDiagnosis(stored ?? deriveFailureDiagnosis({ outcome: run.final_outcome }), providerCatalog, { envFilesEnabled: readEnvFilesSetting(db) })
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
