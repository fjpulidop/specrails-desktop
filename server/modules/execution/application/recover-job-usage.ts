import { sanitizeRecoveredResult, type JobUsage } from '../domain/usage'
import type { UsageRecoveryPorts, NormalizedRecoveryUsage, DurableUsageRow } from '../ports'

/** Rebuild usage from ordered durable evidence without loading a transcript into memory. */
export function recoverJobUsage<Event extends { kind: string }>(
  ports: UsageRecoveryPorts<Event>, fallbackModel: string | null, interactive: boolean,
): { result: JobUsage; estimated: boolean; authoritative: boolean } {
  const parse = (row: DurableUsageRow): readonly Event[] => {
    try { return ports.parse(row.payload) }
    catch (error) { ports.malformedEvent(error); return [] }
  }
  const makeUsageAccumulator = () => {
    const totals = {
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_create: 0,
      total_cost_usd: 0,
      num_turns: 0,
      duration_ms: 0,
      duration_api_ms: 0,
    }
    let model: string | undefined = fallbackModel ?? undefined
    let sessionId: string | undefined
    let estimated = false
    const snapshots = new Map<string, JobUsage>()
    const MAX_SNAPSHOT_KEYS = 4_096
    const add = (event: Event, seq: number): void => {
      const finalised = ports.normalize(event, model)
      const result = sanitizeRecoveredResult(finalised.result)
      const messageId = ports.messageId(event)
      const stableId = messageId ? `message:${messageId}` : `${event.kind}:${seq}`
      const previous = snapshots.get(stableId) ?? {}
      const addDelta = (key: keyof typeof totals): void => {
        const current = result[key]
        if (typeof current !== 'number') return
        const prior = previous[key]
        totals[key] += Math.max(0, current - (typeof prior === 'number' ? prior : 0))
      }
      addDelta('tokens_in')
      addDelta('tokens_out')
      addDelta('tokens_cache_read')
      addDelta('tokens_cache_create')
      addDelta('total_cost_usd')
      addDelta('num_turns')
      addDelta('duration_ms')
      addDelta('duration_api_ms')
      model = result.model ?? model
      sessionId = result.session_id ?? sessionId
      estimated = estimated || finalised.estimated
      if (!snapshots.has(stableId) && snapshots.size >= MAX_SNAPSHOT_KEYS) {
        snapshots.delete(snapshots.keys().next().value as string)
      }
      // Frames for one provider message are contiguous; retain a bounded LRU
      // of recent snapshots for retransmission/delta dedupe without letting a
      // malicious transcript allocate one map entry per event forever.
      snapshots.delete(stableId)
      snapshots.set(stableId, { ...previous, ...result })
    }
    const result = (): { result: JobUsage; estimated: boolean } => {
      const hasUsage = Object.values(totals).some((value) => value > 0)
      return {
        result: hasUsage ? { ...totals, model, session_id: sessionId } : {},
        estimated,
      }
    }
    return { add, result }
  }

  if (!interactive) {
    const accumulator = makeUsageAccumulator()
    let lastValidResult:
      | NormalizedRecoveryUsage
      | null = null
    const events = ports.events('all')
    for (const row of events) {
      for (const event of parse(row)) {
        if (event.kind === 'result') {
          const finalised = ports.normalize(event, fallbackModel ?? undefined)
          lastValidResult = {
            ...finalised,
            result: sanitizeRecoveredResult(finalised.result),
          }
        } else {
          accumulator.add(event, row.seq)
        }
      }
    }
    const fallback = accumulator.result()
    if (lastValidResult) {
      const result: JobUsage = { ...fallback.result }
      for (const [key, value] of Object.entries(lastValidResult.result)) {
        // Provider normalisers intentionally retain optional keys with an
        // undefined value. Only concrete terminal fields are authoritative;
        // an omitted field must not erase recoverable assistant evidence.
        if (value !== undefined) {
          (result as Record<string, unknown>)[key] = value
        }
      }
      return {
        result,
        // A native terminal cost is authoritative. When the terminal frame
        // omits cost, preserve whether the assistant-frame backfill was an
        // estimate instead of silently relabelling it as exact.
        estimated: result.total_cost_usd === lastValidResult.result.total_cost_usd &&
          lastValidResult.result.total_cost_usd !== undefined
          ? lastValidResult.estimated
          : (lastValidResult.estimated || fallback.estimated),
        authoritative: true,
      }
    }
    return { ...fallback, authoritative: false }
  }

  const totals = {
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_create: 0,
    total_cost_usd: 0,
    num_turns: 0,
    duration_ms: 0,
    duration_api_ms: 0,
  }
  let model: string | undefined = fallbackModel ?? undefined
  let sessionId: string | undefined
  let baselineCost = 0
  let baselineTurns = 0
  let estimated = false
  let lastResultSeq = -1
  const resultRows = ports.events('results')
  for (const row of resultRows) {
    for (const event of parse(row)) {
      if (event.kind !== 'result') continue
      const finalised = ports.normalize(event, model)
      const result = sanitizeRecoveredResult(finalised.result)
      totals.tokens_in += result.tokens_in ?? 0
      totals.tokens_out += result.tokens_out ?? 0
      totals.tokens_cache_read += result.tokens_cache_read ?? 0
      totals.tokens_cache_create += result.tokens_cache_create ?? 0
      const cumulativeCost = result.total_cost_usd ?? baselineCost
      totals.total_cost_usd += Math.max(0, cumulativeCost - baselineCost)
      baselineCost = cumulativeCost
      const cumulativeTurns = result.num_turns ?? (baselineTurns + 1)
      totals.num_turns += Math.max(0, cumulativeTurns - baselineTurns)
      baselineTurns = cumulativeTurns
      totals.duration_ms += result.duration_ms ?? 0
      totals.duration_api_ms += result.duration_api_ms ?? 0
      model = result.model ?? model
      sessionId = result.session_id ?? sessionId
      estimated = estimated || finalised.estimated
      lastResultSeq = row.seq
    }
  }

  const tail = makeUsageAccumulator()
  const tailRows = ports.events('tail', lastResultSeq)
  for (const row of tailRows) {
    for (const event of parse(row)) {
      if (event.kind !== 'result') tail.add(event, row.seq)
    }
  }
  const tailUsage = tail.result()
  const tailResult = tailUsage.result
  const hasTailUsage = [
    tailResult.tokens_in,
    tailResult.tokens_out,
    tailResult.tokens_cache_read,
    tailResult.tokens_cache_create,
    tailResult.total_cost_usd,
  ].some((value) => typeof value === 'number' && value > 0)
  if (hasTailUsage) {
    totals.tokens_in += tailResult.tokens_in ?? 0
    totals.tokens_out += tailResult.tokens_out ?? 0
    totals.tokens_cache_read += tailResult.tokens_cache_read ?? 0
    totals.tokens_cache_create += tailResult.tokens_cache_create ?? 0
    totals.total_cost_usd += tailResult.total_cost_usd ?? 0
    totals.num_turns += tailResult.num_turns ?? 1
    totals.duration_ms += tailResult.duration_ms ?? 0
    totals.duration_api_ms += tailResult.duration_api_ms ?? 0
    model = tailResult.model ?? model
    sessionId = tailResult.session_id ?? sessionId
    estimated = estimated || tailUsage.estimated
  }

  const hasRecoveredUsage = Object.values(totals).some((value) => value > 0)
  return {
    result: hasRecoveredUsage
      ? {
          ...totals,
          model,
          session_id: sessionId,
        }
      : {},
    estimated,
    authoritative: false,
  }
}
