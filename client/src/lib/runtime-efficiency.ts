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
