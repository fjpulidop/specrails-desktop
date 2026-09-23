import { distributeIntEvenly } from '../../../util/distribute-int'
import type { JobAccountingInput } from '../domain/job-accounting'
import type { JobAccountingPorts } from '../ports'

/** Preserve total integer usage and stable replay references across ticket attribution. */
export function recordJobInvocations(projectId: string, params: JobAccountingInput, ports: JobAccountingPorts): string[] {
  const { jobId, provider, status, startedAt, finishedAt, ticketIds, estimated, result } = params

  // Single-ticket / no-ticket: one row, plain jobId (byte-compatible).
  if (ticketIds.length <= 1) {
    ports.write({
      id: ports.newId(),
      project_id: projectId,
      provider,
      surface: 'job',
      surface_ref_id: jobId,
      ticket_id: ticketIds[0] ?? null,
      conversation_id: params.conversationId ?? null,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      total_cost_usd_estimated: estimated,
      ...result,
    })
    return [jobId]
  }

  // Multi-ticket: split across one row per ticket. Cost & duration split evenly
  // as floats; token & turn totals via largest-remainder (sum exactly to total).
  const n = ticketIds.length
  const evenSplit = (v: number | undefined): number | undefined =>
    v === undefined ? undefined : v / n
  const tokensIn = distributeIntEvenly(result.tokens_in, n)
  const tokensOut = distributeIntEvenly(result.tokens_out, n)
  const cacheRead = distributeIntEvenly(result.tokens_cache_read, n)
  const cacheCreate = distributeIntEvenly(result.tokens_cache_create, n)
  const numTurns = distributeIntEvenly(result.num_turns, n)
  const refIds: string[] = []
  ticketIds.forEach((ticketId, i) => {
    const refId = `${jobId}#t${ticketId}`
    refIds.push(refId)
    ports.write({
      id: ports.newId(),
      project_id: projectId,
      provider,
      surface: 'job',
      surface_ref_id: refId,
      ticket_id: ticketId,
      conversation_id: params.conversationId ?? null,
      status,
      started_at: startedAt,
      finished_at: finishedAt,
      total_cost_usd_estimated: estimated,
      tokens_in: tokensIn[i],
      tokens_out: tokensOut[i],
      tokens_cache_read: cacheRead[i],
      tokens_cache_create: cacheCreate[i],
      total_cost_usd: evenSplit(result.total_cost_usd),
      num_turns: numTurns[i],
      model: result.model,
      session_id: result.session_id,
      duration_ms: evenSplit(result.duration_ms),
      duration_api_ms: evenSplit(result.duration_api_ms),
    })
  })
  return refIds
}
