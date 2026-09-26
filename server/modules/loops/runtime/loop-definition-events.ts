import { appendEvent, type DbInstance } from '../../../db'
import { recordInvocation } from '../../accounting/runtime/ai-invocations'
import { distributeIntEvenly } from '../../../util/distribute-int'
import { completeLoopStepRecovery, readLoopJobUsage, setLoopStepSettledResult, stageLoopStepRecovery, type LoopStepRecoveryPayload } from './loop-runs-store'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const timestamp = (value: unknown): string | undefined => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined

export interface DefinitionProjectedEvent { eventType: string; payload: string; seq: number; timestamp: string }
export interface DefinitionUsage {
  present: boolean; cost: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheCreate: number; duration: number; turns: number
  costUnknown: boolean; tokensInUnknown: boolean; tokensOutUnknown: boolean; cacheReadUnknown: boolean; cacheCreateUnknown: boolean; turnsUnknown: boolean
}
export function readDefinitionUsage(db: DbInstance, runId: string): DefinitionUsage {
  const row = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(total_cost_usd),0) AS cost,
    COALESCE(SUM(tokens_in),0) AS tokensIn, COALESCE(SUM(tokens_out),0) AS tokensOut,
    COALESCE(SUM(tokens_cache_read),0) AS cacheRead, COALESCE(SUM(tokens_cache_create),0) AS cacheCreate,
    COALESCE(SUM(duration_ms),0) AS duration, COALESCE(SUM(num_turns),0) AS turns,
    MAX(total_cost_usd IS NULL) AS costUnknown, MAX(tokens_in IS NULL) AS tokensInUnknown, MAX(tokens_out IS NULL) AS tokensOutUnknown,
    MAX(tokens_cache_read IS NULL) AS cacheReadUnknown, MAX(tokens_cache_create IS NULL) AS cacheCreateUnknown, MAX(num_turns IS NULL) AS turnsUnknown
    FROM ai_invocations WHERE surface='loop' AND loop_run_id=?`).get(runId) as DefinitionUsage & { count: number }
  return { ...row, present: row.count > 0, costUnknown: Boolean(row.costUnknown), tokensInUnknown: Boolean(row.tokensInUnknown), tokensOutUnknown: Boolean(row.tokensOutUnknown), cacheReadUnknown: Boolean(row.cacheReadUnknown), cacheCreateUnknown: Boolean(row.cacheCreateUnknown), turnsUnknown: Boolean(row.turnsUnknown) }
}

/** Project committed Core events. The event marker and physical usage share one Desktop transaction. */
export function createDefinitionEventProjection(input: {
  db: DbInstance; runId: string; projectId: string; ticketIds: number[]
  nextSequence(): number; broadcast(event: DefinitionProjectedEvent): void; onProgress?(steps: number, usage: DefinitionUsage): void
}) {
  const { db, runId } = input
  let count = Number((db.prepare("SELECT COALESCE(MAX(json_extract(payload,'$.index')),0) AS count FROM events WHERE job_id=? AND event_type='loop_step'").get(runId) as { count: number }).count)
  return (event: Record<string, unknown>): void => {
    const workflow = event.type === 'workflow-event' && object(event.event) ? event.event : undefined
    const durableId = workflow ? text(workflow.id) : text(event.eventId)
    const owner = workflow?.runId ?? event.runId
    if (owner !== undefined && owner !== runId) throw new Error('Core event belongs to another run')
    const encoded = JSON.stringify(event)
    const at = timestamp(workflow?.timestamp ?? event.timestamp) ?? new Date().toISOString()
    const outgoing: DefinitionProjectedEvent[] = []
    let nextCount = count
    const persist = (eventType: string, payload: unknown) => {
      const seq = input.nextSequence(), json = JSON.stringify(payload)
      appendEvent(db, runId, seq, { event_type: eventType, source: 'stdout', payload: json })
      outgoing.push({ eventType, payload: json, seq, timestamp: at })
    }
    db.transaction(() => {
      if (durableId) {
        if (owner !== runId || !Number.isSafeInteger(workflow?.sequence ?? event.sequence)) throw new Error('Malformed durable Core event identity')
        const prior = db.prepare("SELECT payload FROM events WHERE job_id=? AND event_type=? AND COALESCE(json_extract(payload,'$.event.id'),json_extract(payload,'$.eventId'))=? LIMIT 1")
          .get(runId, event.type, durableId) as { payload: string } | undefined
        if (prior) {
          if (prior.payload !== encoded) throw new Error('A replayed Core event changed its committed content')
          return
        }
      }
      if (typeof event.type !== 'string') throw new Error('Core event has no type')
      if (event.type === 'runtime-efficiency-event' && event.kind === 'role-context' && object(event.payload) && object(event.payload.usage)) {
        if (!durableId) throw new Error('Physical usage requires a durable event identity')
        const p = event.payload, usage = p.usage as Record<string, unknown>
        const invocationId = text(p.invocationId), attemptId = text(event.attemptId), provider = text(p.provider)
        const startedAt = timestamp(p.startedAt), finishedAt = timestamp(p.finishedAt)
        if (!invocationId || !attemptId || !provider || !startedAt || !finishedAt || !['succeeded','failed','interrupted'].includes(String(p.status))) throw new Error('Incomplete physical invocation evidence')
        const identity = `core:${runId}:${invocationId}`
        const targets: Array<number | null> = [...new Set(input.ticketIds)].sort((a,b) => a-b)
        if (!targets.length) targets.push(null)
        const prior = db.prepare('SELECT id FROM ai_invocations WHERE id=?').get(identity + (targets.length > 1 ? `:t${targets[0]}` : ''))
        if (!prior) {
          const payload: LoopStepRecoveryPayload = { version: 1, runId, stepKey: identity, invocationId: identity, projectId: input.projectId, provider,
            model: text(p.model) ?? null, surfaceRefId: text(event.nodePath) ?? attemptId, ticketIds: input.ticketIds,
            startedAt, baseline: readLoopJobUsage(db, runId), completedEventSeq: -1, providerCostBaseline: 0, providerTurnsBaseline: 0, loopDurationBaseline: 0, completedDurationMs: number(p.durationMs) ?? 0 }
          stageLoopStepRecovery(db, payload)
          setLoopStepSettledResult(db, runId, identity, { provider, cost: number(usage.costUsd), tokensIn: number(usage.inputTokens), tokensOut: number(usage.outputTokens), durationMs: number(p.durationMs), failed: p.status !== 'succeeded' })
          completeLoopStepRecovery(db, runId, identity, () => {
            const inTokens = distributeIntEvenly(number(usage.inputTokens), targets.length), outTokens = distributeIntEvenly(number(usage.outputTokens), targets.length)
            const readTokens = distributeIntEvenly(number(usage.cacheReadInputTokens), targets.length), writeTokens = distributeIntEvenly(number(usage.cacheWriteInputTokens), targets.length)
            targets.forEach((ticketId,index) => recordInvocation(db, { id: identity + (targets.length > 1 ? `:t${ticketId}` : ''), project_id: input.projectId, provider,
              model: text(p.model), surface: 'loop', surface_ref_id: `${attemptId}:${invocationId}`, loop_run_id: runId, ticket_id: ticketId,
              status: p.status === 'succeeded' ? 'success' : p.status === 'interrupted' ? 'aborted' : 'failed', started_at: startedAt, finished_at: finishedAt,
              total_cost_usd: number(usage.costUsd) === undefined ? undefined : Number(usage.costUsd)/targets.length, total_cost_usd_estimated: false,
              tokens_in: inTokens[index], tokens_out: outTokens[index], tokens_cache_read: readTokens[index], tokens_cache_create: writeTokens[index],
              duration_ms: number(p.durationMs) === undefined ? undefined : Number(p.durationMs)/targets.length,
            }))
          })
        }
      }
      const totals = readDefinitionUsage(db, runId)
      db.prepare(`UPDATE jobs SET total_cost_usd=?,tokens_in=?,tokens_out=?,tokens_cache_read=?,tokens_cache_create=?,num_turns=? WHERE id=? AND owner='loop'`).run(
        totals.present && !totals.costUnknown ? totals.cost : null, totals.present && !totals.tokensInUnknown ? totals.tokensIn : null,
        totals.present && !totals.tokensOutUnknown ? totals.tokensOut : null, totals.present && !totals.cacheReadUnknown ? totals.cacheRead : null,
        totals.present && !totals.cacheCreateUnknown ? totals.cacheCreate : null, totals.present && !totals.turnsUnknown ? totals.turns : null, runId)
      db.prepare('UPDATE loop_runs SET total_cost_usd=?,total_tokens=? WHERE id=?').run(totals.cost,totals.tokensIn+totals.tokensOut,runId)
      persist(event.type, event)
      if (workflow && text(workflow.attemptId)) {
        const attemptId = String(workflow.attemptId)
        const prior = db.prepare("SELECT payload FROM events WHERE job_id=? AND event_type='loop_step' AND json_extract(payload,'$.attemptId')=? ORDER BY seq DESC LIMIT 1").get(runId, attemptId) as { payload: string } | undefined
        const opening = prior ? JSON.parse(prior.payload) as Record<string, unknown> : undefined
        const correlation = { nodeId: workflow.nodePath, nodePath: workflow.nodePath, scopeId: workflow.scopeId, branch: workflow.branch, visit: workflow.visit, attempt: workflow.attempt, attemptId, coreEventId: durableId }
        if (workflow.type === 'step_started' && !opening) {
          nextCount += 1
          persist('loop_step', { index: nextCount, kind: 'core', title: workflow.nodePath, iteration: workflow.visit, startedAtMs: Date.parse(at), ...correlation })
        } else if (opening && ['step_succeeded','step_failed','step_blocked','step_interrupted','step_retrying','step_paused'].includes(String(workflow.type))) {
          persist('loop_step_end', { index: opening.index, status: workflow.type === 'step_succeeded' ? 'ok' : workflow.type === 'step_paused' ? 'paused' : workflow.type === 'step_interrupted' ? 'interrupted' : 'failed',
            runtimeStatus: String(workflow.type).slice(5), outcome: workflow.outcome, exitCode: null,
            durationMs: Math.max(0,Date.parse(at)-Number(opening.startedAtMs)), ...correlation })
        }
      }
    })()
    count = nextCount
    for (const projected of outgoing) input.broadcast(projected)
    if (outgoing.length) input.onProgress?.(count, readDefinitionUsage(db,runId))
  }
}
