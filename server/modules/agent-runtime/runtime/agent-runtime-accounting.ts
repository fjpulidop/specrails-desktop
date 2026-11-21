/** Structural subset of LoopRecordedResult. No provider adapter or rate card is
 * involved: these figures come only from Core's persisted event protocol. */
export interface ProgrammaticRecordedResult {
  provider: 'agent-runtime'
  model: 'per-role'
  cost?: number
  tokensIn?: number
  tokensOut?: number
  tokens?: number
  estimated: boolean
  failed: boolean
}

type Usage = { costUsd?: unknown; inputTokens?: unknown; outputTokens?: unknown }
const SETTLED_STEPS = new Set(['step_succeeded', 'step_failed', 'step_blocked', 'step_paused', 'step_interrupted'])
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const known = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined

/** Recover one Core invocation's accounting from raw stdout event payloads.
 * A terminal invocation total already includes its phase events and wins over
 * them. Without that frame, an unfinished attempt makes inclusive totals
 * unknown: costs from completed phases alone would be misleadingly precise. */
export function parseProgrammaticUsage(rawRows: readonly string[]): ProgrammaticRecordedResult | undefined {
  let recognized = false
  let terminal: Record<string, unknown> | undefined
  const seen = new Set<string>()
  const started = new Set<string>()
  const settled = new Set<string>()
  const usages: Usage[] = []
  for (const row of rawRows) {
    let frame: unknown
    try { frame = JSON.parse(row) } catch { continue }
    if (!object(frame)) continue
    if (frame.type === 'runtime-result') {
      recognized = true
      terminal = frame
      continue
    }
    if (frame.type === 'agent-event') { recognized = true; continue }
    if (frame.type !== 'workflow-event' || !object(frame.event)) continue
    const event = frame.event
    if (typeof event.id !== 'string' || typeof event.type !== 'string') continue
    recognized = true
    if (seen.has(event.id)) continue
    seen.add(event.id)
    const attempt = typeof event.attemptId === 'string' ? event.attemptId : typeof event.stepId === 'string' ? event.stepId : event.id
    if (event.type === 'step_started') started.add(attempt)
    if (SETTLED_STEPS.has(event.type)) {
      settled.add(attempt)
      usages.push(object(event.usage) ? event.usage : {})
    }
  }
  if (!recognized) return undefined

  let usage: Usage = {}
  if (object(terminal?.invocationUsage)) {
    usage = terminal.invocationUsage
  } else if (usages.length > 0 && [...started].every((attempt) => settled.has(attempt))) {
    for (const key of ['costUsd', 'inputTokens', 'outputTokens'] as const) {
      const values = usages.map((item) => known(item[key]))
      if (values.every((value) => value !== undefined)) usage[key] = values.reduce((sum, value) => sum + value!, 0)
    }
  }
  const cost = known(usage.costUsd), tokensIn = known(usage.inputTokens), tokensOut = known(usage.outputTokens)
  return {
    provider: 'agent-runtime', model: 'per-role', cost, tokensIn, tokensOut,
    tokens: tokensIn === undefined || tokensOut === undefined ? undefined : known(tokensIn + tokensOut),
    estimated: cost === undefined, failed: terminal?.status !== 'succeeded',
  }
}

// ─── Per-phase attribution of a Core v1 invocation ──────────────────────────
//
// A v1 programmatic invocation reports ONE inclusive total (provider
// 'agent-runtime', model 'per-role'). Core's stream also says who spent it:
// every settled step attempt carries that attempt's usage, and every provider
// call inside it is a `runtime-efficiency-event` (kind 'role-context') naming
// the provider and model (newer recordings keep that call's usage too). Those
// facts split the total into one share per phase × provider × model so engine
// filters, the provider breakdown, pricing and plan-billing detection see the
// real engine. Nothing is guessed: an attempt whose calls disagree on the
// provider and do not carry their own usage stays 'agent-runtime'.

/** One phase × provider × model share of a v1 invocation. */
export interface ProgrammaticShare {
  /** Core phase (step id); null for the unattributed remainder. */
  stepId: string | null
  provider: string
  model: string | null
  cost?: number
  tokensIn?: number
  tokensOut?: number
  /** Provider-call wall time Core measured for this share (a weight, not a total). */
  durationMs?: number
}

type Measure = { cost?: number; tokensIn?: number; tokensOut?: number }
const METRICS = ['cost', 'tokensIn', 'tokensOut'] as const
const nullable = (value: unknown): number | null | undefined => value === null ? null : known(value)
const usageOf = (value: unknown): { cost: number | null | undefined; tokensIn: number | null | undefined; tokensOut: number | null | undefined } | undefined =>
  object(value) ? { cost: nullable(value.costUsd), tokensIn: nullable(value.inputTokens), tokensOut: nullable(value.outputTokens) } : undefined
const text = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined
const UNATTRIBUTED = { provider: 'agent-runtime', model: 'per-role' } as const
/** Float sums of the same figures may differ in the last bits. */
const EPSILON = 1e-9

/**
 * Split one v1 invocation's inclusive `total` over the phases and engines its
 * event stream names. Returns undefined when nothing better than the single
 * 'agent-runtime' row is known, or when the shares do not reconcile with the
 * total (the caller then keeps the single aggregate row: never double count).
 *
 * Reconciliation per metric: a known total is split exactly — the known shares
 * keep their figure, a positive remainder becomes an 'agent-runtime' share and
 * an unknown share makes the split unusable. An unknown total stays unknown on
 * every share (completed phases alone would be misleadingly precise).
 */
export function attributeProgrammaticUsage(rawRows: readonly string[], total: Measure): ProgrammaticShare[] | undefined {
  const attempts = new Map<string, { stepId: string | null; usage?: ReturnType<typeof usageOf> }>()
  const calls = new Map<string, Array<{ provider: string; model: string | null; usage?: ReturnType<typeof usageOf>; durationMs?: number }>>()
  const seen = new Set<string>()
  for (const row of rawRows) {
    let frame: unknown
    try { frame = JSON.parse(row) } catch { continue }
    if (!object(frame)) continue
    if (frame.type === 'workflow-event' && object(frame.event)) {
      const event = frame.event
      if (typeof event.id !== 'string' || seen.has(event.id) || !SETTLED_STEPS.has(String(event.type))) continue
      seen.add(event.id)
      const attempt = text(event.attemptId) ?? text(event.stepId) ?? event.id
      attempts.set(attempt, { stepId: text(event.stepId) ?? null, usage: usageOf(event.usage) })
    } else if (frame.type === 'runtime-efficiency-event' && frame.kind === 'role-context' && object(frame.payload)) {
      const id = text(frame.eventId)
      if (!id || seen.has(id)) continue
      seen.add(id)
      const attempt = text(frame.attemptId), provider = text(frame.payload.provider)
      if (!attempt || !provider) continue
      const list = calls.get(attempt) ?? []
      list.push({ provider, model: text(frame.payload.model) ?? null, usage: usageOf(frame.payload.usage), durationMs: known(frame.payload.durationMs) })
      calls.set(attempt, list)
    }
  }

  // One share per attempt (or per call when every call reports its own usage).
  const shares: Array<ProgrammaticShare & { unknown: Set<string> }> = []
  const push = (stepId: string | null, provider: string, model: string | null, usage: ReturnType<typeof usageOf>, durationMs?: number): void => {
    const unknown = new Set<string>()
    const share: ProgrammaticShare & { unknown: Set<string> } = { stepId, provider, model, unknown, ...(durationMs === undefined ? {} : { durationMs }) }
    for (const metric of METRICS) {
      const value = usage?.[metric]
      if (value === null || value === undefined) unknown.add(metric)
      else share[metric] = value
    }
    shares.push(share)
  }
  for (const [attempt, { stepId, usage }] of attempts) {
    const list = calls.get(attempt) ?? []
    const providers = new Set(list.map((call) => call.provider))
    const models = new Set(list.map((call) => call.model))
    const sumDuration = list.every((call) => call.durationMs !== undefined) && list.length > 0 ? list.reduce((sum, call) => sum + call.durationMs!, 0) : undefined
    if (list.length > 0 && list.every((call) => call.usage)) {
      for (const call of list) push(stepId, call.provider, call.model, call.usage, call.durationMs)
    } else if (providers.size === 1) {
      push(stepId, [...providers][0], models.size === 1 ? [...models][0] : null, usage, sumDuration)
    } else {
      push(stepId, UNATTRIBUTED.provider, UNATTRIBUTED.model, usage, sumDuration)
    }
  }
  if (!shares.some((share) => share.provider !== UNATTRIBUTED.provider)) return undefined

  // Merge identical phase × provider × model shares.
  const merged = new Map<string, ProgrammaticShare & { unknown: Set<string> }>()
  for (const share of shares) {
    const key = JSON.stringify([share.stepId, share.provider, share.model])
    const into = merged.get(key)
    if (!into) { merged.set(key, { ...share, unknown: new Set(share.unknown) }); continue }
    for (const metric of METRICS) {
      if (share.unknown.has(metric)) into.unknown.add(metric)
      else into[metric] = (into[metric] ?? 0) + share[metric]!
    }
    into.durationMs = into.durationMs === undefined || share.durationMs === undefined ? undefined : into.durationMs + share.durationMs
  }
  const out = [...merged.values()]

  // Reconcile every metric with the authoritative total.
  let remainder: ProgrammaticShare | undefined
  for (const metric of METRICS) {
    const expected = total[metric]
    if (expected === undefined) {
      for (const share of out) delete share[metric]
      continue
    }
    if (out.some((share) => share.unknown.has(metric))) return undefined
    const sum = out.reduce((acc, share) => acc + (share[metric] ?? 0), 0)
    const rest = expected - sum
    if (rest < -EPSILON * Math.max(1, expected)) return undefined
    if (rest > EPSILON * Math.max(1, expected)) {
      remainder ??= { stepId: null, provider: UNATTRIBUTED.provider, model: UNATTRIBUTED.model }
      remainder[metric] = metric === 'cost' ? rest : Math.round(rest)
    } else if (out.length > 0) {
      // Land the float residue on the largest share so the rows sum to the total.
      const largest = out.reduce((best, share) => (share[metric] ?? 0) > (best[metric] ?? 0) ? share : best)
      largest[metric] = (largest[metric] ?? 0) + rest
    }
  }
  const result: ProgrammaticShare[] = out.map(({ unknown: _unknown, ...share }) => share)
  if (remainder) result.push({ ...remainder, ...Object.fromEntries(METRICS.filter((metric) => total[metric] !== undefined && remainder![metric] === undefined).map((metric) => [metric, 0])) })
  return result
}
