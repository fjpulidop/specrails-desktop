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
