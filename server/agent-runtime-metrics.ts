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
const PHASES = ['architect', 'developer', 'fixer', 'verify', 'reviewer', 'archive']
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


export function readRuntimeEfficiencySummary(value: unknown): RuntimeEfficiencySummary | undefined {
  const input = object(value), invocations = object(input?.invocations), checks = object(input?.checks)
  if (!input || input.schemaVersion !== 1 || typeof input.runId !== 'string' || input.runId.length > 128 || typeof input.workflowVersion !== 'string' || input.workflowVersion.length > 16 || !['pending', 'validated', 'with-exceptions', 'blocked'].includes(String(input.technicalAcceptance)) || !invocations || !checks || !Array.isArray(input.roles) || input.roles.length > 3) return undefined
  if (typeof input.archive !== 'string' || input.archive.length > 32 || typeof input.delivery !== 'string' || input.delivery.length > 32 || typeof invocations.complete !== 'boolean' || typeof checks.available !== 'boolean') return undefined
  const count = (value: unknown, nullable = true) => (nullable && value === null) || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  for (const key of ['total', 'fullContexts', 'incrementalContexts']) if (!count(invocations[key], false)) return undefined
  for (const key of ['promptBytes', 'contextBytes', 'handoffBytes']) if (!count(invocations[key])) return undefined
  if (checks.complete !== undefined && typeof checks.complete !== 'boolean' || checks.invalidated !== undefined && !count(checks.invalidated)) return undefined
  for (const key of ['executed', 'reused', 'notRun']) if (!count(checks[key])) return undefined
  if (checks.durationMs !== null && (typeof checks.durationMs !== 'number' || !Number.isFinite(checks.durationMs) || checks.durationMs < 0)) return undefined
  for (const key of ['planHash', 'candidateHash']) if (input[key] !== null && (typeof input[key] !== 'string' || !/^[a-f0-9]{64}$/.test(input[key]))) return undefined
  if (!Array.isArray(input.currentEvidenceIds) || input.currentEvidenceIds.length > 100 || !input.currentEvidenceIds.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))) return undefined
  const kinds = object(invocations.byKind)
  if (!kinds || Object.keys(kinds).length !== 5 || !['initial', 'correction', 'repair', 'deepen', 'session-fallback'].every(key => count(kinds[key], false))) return undefined
  const roles: RuntimeEfficiencySummary['roles'] = []
  for (const raw of input.roles) {
    const role = object(raw)
    if (!role || !['architect', 'developer', 'reviewer'].includes(String(role.role)) || roles.some(item => item.role === role.role)) return undefined
    const row: Record<string, string | null> = { role: String(role.role) }
    for (const key of ['provider', 'model', 'effort', 'observedModel', 'observedEffort', 'origin', 'tier']) {
      if (role[key] !== null && (typeof role[key] !== 'string' || role[key].length > 256)) return undefined
      row[key] = role[key] as string | null
    }
    if (!['base', 'escalation'].includes(String(row.tier)) || typeof row.origin !== 'string') return undefined
    roles.push(row as unknown as RuntimeEfficiencySummary['roles'][number])
  }
  let escalations: RuntimeEfficiencySummary['escalations']
  if (input.escalations !== undefined) {
    if (!Array.isArray(input.escalations) || input.escalations.length > 16 || typeof input.escalationsTruncated !== 'boolean') return undefined
    escalations = []
    for (const item of input.escalations) {
      const raw = object(item)
      if (!raw || !['architect', 'developer', 'reviewer'].includes(String(raw.role))) return undefined
      const row: Record<string, string | null> = { role: String(raw.role) }
      for (const key of ['attemptId', 'provider', 'model', 'effort', 'reason']) {
        if (raw[key] !== null && (typeof raw[key] !== 'string' || raw[key].length > 256) || ['attemptId', 'provider'].includes(key) && typeof raw[key] !== 'string') return undefined
        row[key] = raw[key] as string | null
      }
      escalations.push(row as NonNullable<RuntimeEfficiencySummary['escalations']>[number])
    }
  }
  return { ...(escalations ? { escalations, escalationsTruncated: input.escalationsTruncated as boolean } : {}), schemaVersion: 1, currentEvidenceIds: [...input.currentEvidenceIds] as string[], planHash: input.planHash as string | null, candidateHash: input.candidateHash as string | null, runId: input.runId, workflowVersion: input.workflowVersion, technicalAcceptance: input.technicalAcceptance as RuntimeEfficiencySummary['technicalAcceptance'], archive: input.archive, delivery: input.delivery, roles,
    invocations: { total: invocations.total as number, complete: invocations.complete, byKind: { ...kinds } as Record<string, number>, promptBytes: invocations.promptBytes as number | null, contextBytes: invocations.contextBytes as number | null, handoffBytes: invocations.handoffBytes as number | null, fullContexts: invocations.fullContexts as number, incrementalContexts: invocations.incrementalContexts as number },
    checks: { ...(checks.complete === undefined ? {} : { complete: checks.complete as boolean }), ...(checks.invalidated === undefined ? {} : { invalidated: checks.invalidated as number | null }), available: checks.available, executed: checks.executed as number | null, reused: checks.reused as number | null, notRun: checks.notRun as number | null, durationMs: checks.durationMs as number | null } }
}

/** Provenance is host-owned; it never changes Core's frozen provider selection. */
export function applyRuntimeSelectionOrigins(summary: RuntimeEfficiencySummary | undefined, selection: unknown, runId: string): RuntimeEfficiencySummary | undefined {
  const record = object(selection), origins = object(record?.origins)
  if (!summary || record?.schemaVersion !== 1 || record.runId !== runId || !origins) return summary
  if (!['architect', 'developer', 'reviewer'].every(role => ['project-role', 'default', ...(role === 'developer' ? ['explicit-launch-override'] : [])].includes(String(origins[role])))) return summary
  return { ...summary, roles: summary.roles.map(role => ({ ...role, origin: String(origins[role.role]) })) }
}
