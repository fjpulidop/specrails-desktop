import type { DbInstance } from '../../../db'
import {
  deriveFailureDiagnosis, isDiagnosableOutcome, parseStoredDiagnosis, presentFailureDiagnosis,
  type PresentedFailureDiagnosis,
} from '../domain'

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
  return presentFailureDiagnosis(stored ?? deriveFailureDiagnosis({ outcome: run.final_outcome }))
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
