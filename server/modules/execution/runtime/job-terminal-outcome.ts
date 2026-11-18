// Terminal outcome of a one-shot queue job exit (settle stage of the
// QueueManager lifecycle): final status precedence, wall-clock duration,
// adapter-driven usage finalisation and the ai_invocations status. Pure apart
// from the clock: the caller stages the durable terminal intent with it.
import type { Job } from '../../../types'
import type { JobResult } from '../../../db'
import type { ProviderAdapter, AdapterEvent } from '../../../providers'
import type { InvocationStatus } from '../../accounting/runtime/ai-invocations'
import { finaliseInvocationResult } from '../../accounting/runtime/result-event'

export type JobTerminalStatus = Exclude<Job['status'], 'queued' | 'running'>

export interface OneShotExitInput {
  /** Manager-owned termination flags, read before staging. */
  wasPersistenceFailed: boolean
  wasZombie: boolean
  wasCanceling: boolean
  code: number | null
  startedAt: string | null
  lastResultEvent: Record<string, unknown> | null
  adapterEvents: readonly AdapterEvent[]
  adapter: ProviderAdapter
  spawnedModel?: string
}

export interface OneShotExitOutcome {
  finalStatus: JobTerminalStatus
  finishedAt: string
  normalised: ReturnType<typeof finaliseInvocationResult>['result']
  estimated: boolean
  tokenData: Partial<JobResult>
  invStatus: InvocationStatus
}

export function deriveOneShotExitOutcome(input: OneShotExitInput): OneShotExitOutcome {
  const { code, adapterEvents, adapter } = input
  // A provider may report a semantic turn failure while its CLI still exits
  // successfully (code 0). AdapterEvent is the provider-neutral contract for
  // that condition, so do not let the process exit code relabel it completed.
  // Cancellation/zombie outcomes retain precedence because they describe the
  // user/manager-owned termination of the whole job.
  const providerReportedError = adapterEvents.some((event) => event.kind === 'error')

  let finalStatus: JobTerminalStatus
  if (input.wasPersistenceFailed) {
    finalStatus = 'failed'
  } else if (input.wasZombie) {
    finalStatus = 'zombie_terminated'
  } else if (input.wasCanceling) {
    finalStatus = 'canceled'
  } else if (providerReportedError) {
    finalStatus = 'failed'
  } else if (code === 0) {
    finalStatus = 'completed'
  } else {
    finalStatus = 'failed'
  }

  const finishedAt = new Date().toISOString()
  const startedAtMs = input.startedAt ? new Date(input.startedAt).getTime() : Number.NaN
  const finishedAtMs = new Date(finishedAt).getTime()
  const wallDurationMs = Number.isFinite(startedAtMs)
    ? Math.max(0, finishedAtMs - startedAtMs)
    : undefined

  // Adapter-driven finalisation must happen before staging so the immutable
  // intent owns the same usage that lands on jobs and ai_invocations. The
  // manager wall clock fills providers such as Kimi that emit no duration;
  // a provider-native duration retains precedence inside the finaliser.
  const { result: normalised, estimated } = finaliseInvocationResult(
    adapter,
    adapterEvents,
    { fallbackModel: input.spawnedModel, durationMs: wallDurationMs },
  )
  const tokenData: Partial<JobResult> = input.lastResultEvent || adapterEvents.length > 0
    ? {
        tokens_in: normalised.tokens_in,
        tokens_out: normalised.tokens_out,
        tokens_cache_read: normalised.tokens_cache_read,
        tokens_cache_create: normalised.tokens_cache_create,
        total_cost_usd: normalised.total_cost_usd,
        total_cost_usd_estimated: estimated,
        num_turns: normalised.num_turns,
        model: normalised.model,
        duration_ms: normalised.duration_ms,
        duration_api_ms: normalised.duration_api_ms,
        session_id: normalised.session_id,
      }
    : {}
  const invStatus: InvocationStatus = finalStatus === 'completed'
    ? 'success'
    : (finalStatus === 'canceled' || finalStatus === 'zombie_terminated')
      ? 'aborted'
      : 'failed'

  return { finalStatus, finishedAt, normalised, estimated, tokenData, invStatus }
}
