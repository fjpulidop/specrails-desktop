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

export interface RuntimeEfficiencySummary {
  escalations?: Array<{ role: string; attemptId: string; provider: string; model: string | null; effort: string | null; reason: string | null }>
  escalationsTruncated?: boolean
  currentEvidenceIds: string[]
  planHash: string | null
  candidateHash: string | null
  schemaVersion: 1
  runId: string
  workflowVersion: string
  technicalAcceptance: 'pending' | 'validated' | 'with-exceptions' | 'blocked'
  archive: string
  delivery: string
  roles: Array<{ role: string; provider: string | null; model: string | null; effort: string | null; observedModel: string | null; observedEffort: string | null; origin: string; tier: string }>
  invocations: { total: number; complete: boolean; byKind: Record<string, number>; promptBytes: number | null; contextBytes: number | null; handoffBytes: number | null; fullContexts: number; incrementalContexts: number }
  checks: { complete?: boolean; invalidated?: number | null; available: boolean; executed: number | null; reused: number | null; notRun: number | null; durationMs: number | null }
}
