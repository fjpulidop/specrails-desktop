// Durable pre-start queue projection for QueueManager: the `queued_jobs`
// record of one unstarted admission, the restart read of every restorable
// queued row and the paused flag. Transactions stay owned by QueueManager.
import type { Job, JobPriority } from '../../../types'
import { VALID_PRIORITIES } from '../../../types'
import type { DbInstance, QueuedJobRecord } from '../../../db'
import type { ProviderId } from '../../../providers'

/** Restart-durable per-job spawn selections (map presence is meaningful). */
export interface QueuedJobSelections {
  provider: ReadonlyMap<string, ProviderId>
  model: ReadonlyMap<string, string>
  profile: ReadonlyMap<string, string | null>
  interactive: ReadonlyMap<string, boolean>
}

/** Materialise the exact restart semantics for one unstarted admission.
 * Map presence matters for profile and interactive: null/false are explicit
 * choices and must never collapse into the absent/default state. */
export function toQueuedJobRecord(job: Job, selections: QueuedJobSelections): QueuedJobRecord {
  const hasProfileSelection = selections.profile.has(job.id)
  const hasInteractiveSelection = selections.interactive.has(job.id)
  return {
    id: job.id,
    command: job.command,
    queue_position: job.queuePosition,
    priority: job.priority,
    depends_on_job_id: job.dependsOnJobId,
    pipeline_id: job.pipelineId,
    provider: selections.provider.get(job.id) ?? null,
    model: selections.model.get(job.id) ?? null,
    profile_name: hasProfileSelection
      ? (selections.profile.get(job.id) ?? null)
      : null,
    profile_selection_set: hasProfileSelection,
    interactive: hasInteractiveSelection
      ? selections.interactive.get(job.id)!
      : null,
    causal_ownership: job.causalOwnership === true,
  }
}

export interface RestorableQueuedRow {
  id: string
  command: string
  queue_position: number | null
  priority: string | null
  depends_on_job_id: string | null
  pipeline_id: string | null
  provider: string | null
  model: string | null
  profile_name: string | null
  profile_selection_set: number
  interactive: number | null
  causal_ownership: number
}

/** Queued jobs by their durable positions (`queued_jobs`, plus legacy
 *  `jobs.status = 'queued'` rows not yet mirrored there). */
export function readRestorableQueuedRows(db: DbInstance): RestorableQueuedRow[] {
  return db.prepare(
    `SELECT id, command, queue_position, priority, depends_on_job_id, pipeline_id,
            provider, model, profile_name, profile_selection_set, interactive,
            causal_ownership
       FROM queued_jobs
     UNION ALL
     SELECT id, command, queue_position, priority, depends_on_job_id, pipeline_id,
            NULL AS provider, NULL AS model, NULL AS profile_name,
            0 AS profile_selection_set, NULL AS interactive,
            causal_ownership
       FROM jobs
      WHERE status = 'queued'
        AND NOT EXISTS (SELECT 1 FROM queued_jobs WHERE queued_jobs.id = jobs.id)
     ORDER BY queue_position ASC, id ASC`
  ).all() as RestorableQueuedRow[]
}

/** In-memory queued job for one restored row (unknown priority ⇒ normal). */
export function restoredQueuedJob(row: RestorableQueuedRow): Job {
  const priority = (VALID_PRIORITIES.has(row.priority ?? '') ? row.priority : 'normal') as JobPriority
  return {
    id: row.id,
    command: row.command,
    status: 'queued',
    queuePosition: row.queue_position,
    priority,
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    dependsOnJobId: row.depends_on_job_id ?? null,
    pipelineId: row.pipeline_id ?? null,
    skipReason: null,
    resultText: null,
    causalOwnership: row.causal_ownership === 1,
  }
}
