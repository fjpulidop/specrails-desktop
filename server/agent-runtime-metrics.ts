/** Additive Core runtime metrics v1 wire contract. Unknown measurements are null. */
export interface EfficiencyTotals {
  attempts: number
  measuredAttempts: number
  /** Completed phase wall time; null while an attempt has no end timestamp. */
  durationMs: number | null
  agentDurationMs: number | null
  providerCalls: number | null
  toolCalls: number | null
  inputTokens: number | null
  outputTokens: number | null
  costUsd: number | null
  uncachedInputTokens: number | null
  cacheReadInputTokens: number | null
  cacheWriteInputTokens: number | null
}
export interface RuntimeEfficiency {
  schemaVersion: 1
  total: EfficiencyTotals
  phases: Array<EfficiencyTotals & { stepId: string; providers: string[]; models: string[] }>
}

const COUNTS = ['attempts', 'measuredAttempts', 'providerCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'uncachedInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens'] as const
const KEYS = [...COUNTS, 'durationMs', 'agentDurationMs', 'costUsd'] as const
const PHASES = ['architect', 'developer', 'verify', 'reviewer', 'archive']
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function counters(value: unknown): EfficiencyTotals | null {
  const input = object(value)
  if (!input) return null
  const output: Record<string, number | null> = {}
  for (const key of KEYS) {
    const number = input[key]
    if (number === null && key !== 'attempts' && key !== 'measuredAttempts') { output[key] = null; continue }
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || ((COUNTS as readonly string[]).includes(key) && !Number.isSafeInteger(number))) return null
    output[key] = number
  }
  if (output.measuredAttempts! > output.attempts!) return null
  return output as unknown as EfficiencyTotals
}
/** Older Core versions omit metrics; malformed/unknown versions do not break run controls. */
export function readRuntimeEfficiency(value: unknown): RuntimeEfficiency | undefined {
  const input = object(value)
  if (input?.schemaVersion !== 1 || !Array.isArray(input.phases) || input.phases.length > PHASES.length) return undefined
  const total = counters(input.total)
  if (!total) return undefined
  const phases: RuntimeEfficiency['phases'] = []
  for (const raw of input.phases) {
    const phase = object(raw), count = counters(phase)
    if (!phase || !count || typeof phase.stepId !== 'string' || !PHASES.includes(phase.stepId) || phases.some(item => item.stepId === phase.stepId)) return undefined
    for (const key of ['providers', 'models']) if (!Array.isArray(phase[key]) || phase[key].length > 50 || !phase[key].every((item: unknown) => typeof item === 'string' && item.length > 0 && item.length <= 256)) return undefined
    phases.push({ ...count, stepId: phase.stepId, providers: [...phase.providers as string[]], models: [...phase.models as string[]] })
  }
  return { schemaVersion: 1, total, phases }
}
