export const HOST_BLOCKER_KINDS = ['network', 'credential', 'environment-variable', 'toolchain', 'setup', 'environment', 'scope'] as const
export type HostBlockerKind = typeof HOST_BLOCKER_KINDS[number]
/** Core `HostBlocker` copied into the completion by an `end` node with `blockerFrom`; absent on older runs. */
export interface LoopHostBlocker { kind: HostBlockerKind; reason: string; command: string; args: string[]; cwd: string; requiredAction: string; evidenceId?: string }
/** Additive, durable terminal event; absent for historical runs. */
export interface LoopCompletion {
  engineVersion?: 2
  completion?: {ok: boolean; verified: boolean; reasons: string[]; blocker?: LoopHostBlocker}
  version: 1
  execution: string
  steps: number
  deciderEvaluations: number
  turns: number | null
  costUsd: number | null
  costUncertain: boolean
  core: {
    change: string
    recordedAt: string
    completion: { implementation: string; validation: string; archive: string; delivery: string; reasons: string[] }
    exceptions: Array<{ requirement: string; reason: string; impact: string; acceptedBy: string; approvalEvidence: string }>
    checks: Array<{ name: string; status: string; required: boolean; scope: string; limitations: string; evidence: string[] }>
    findings: string[]
    phases: Array<{ name: string; status: string; durationMs: number | null; attempts: number | null }>
  } | null
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0
const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string')
/** Lenient: a malformed blocker is dropped rather than hiding the whole completion. */
function parseHostBlocker(value: unknown): LoopHostBlocker | undefined {
  if (!object(value) || !(HOST_BLOCKER_KINDS as readonly string[]).includes(String(value.kind)) || typeof value.requiredAction !== 'string') return undefined
  const text = (field: unknown): string => typeof field === 'string' ? field : ''
  return { kind: value.kind as HostBlockerKind, reason: text(value.reason), command: text(value.command), args: strings(value.args) ? value.args as string[] : [], cwd: text(value.cwd), requiredAction: value.requiredAction, ...(typeof value.evidenceId === 'string' ? { evidenceId: value.evidenceId } : {}) }
}
/** The suggested shell line for a blocker, or an empty string when Core reported no command. */
export const blockerCommandLine = (blocker: LoopHostBlocker): string => [blocker.command, ...blocker.args].filter(Boolean).join(' ')
export function parseLoopCompletion(value: unknown): LoopCompletion | null {
  if (!object(value) || value.version !== 1 || typeof value.execution !== 'string' || !count(value.steps) || !count(value.deciderEvaluations)
    || !(value.turns === null || count(value.turns)) || !(value.costUsd === null || count(value.costUsd)) || typeof value.costUncertain !== 'boolean') return null
  if (value.engineVersion === 2 && value.completion !== undefined && (!object(value.completion) || typeof value.completion.ok !== 'boolean' || typeof value.completion.verified !== 'boolean' || !strings(value.completion.reasons))) return null
  if (value.engineVersion === 2 && object(value.completion) && value.completion.blocker !== undefined) {
    const { blocker: raw, ...completion } = value.completion
    const blocker = parseHostBlocker(raw)
    return { ...value, completion: { ...completion, ...(blocker ? { blocker } : {}) } } as unknown as LoopCompletion
  }
  if (value.core !== null) {
    const core = value.core
    if (!object(core) || typeof core.change !== 'string' || typeof core.recordedAt !== 'string' || !object(core.completion)) return null
    if (!['implementation', 'validation', 'archive', 'delivery'].every(key => typeof core.completion === 'object' && typeof (core.completion as Record<string, unknown>)[key] === 'string') || !strings(core.completion.reasons)) return null
    if (!strings(core.findings) || !Array.isArray(core.exceptions) || !Array.isArray(core.checks) || !Array.isArray(core.phases)) return null
    if (!core.exceptions.every(row => object(row) && ['requirement', 'reason', 'impact', 'acceptedBy', 'approvalEvidence'].every(key => typeof row[key] === 'string'))) return null
    if (!core.checks.every(row => object(row) && ['name', 'status', 'scope', 'limitations'].every(key => typeof row[key] === 'string') && typeof row.required === 'boolean' && strings(row.evidence))) return null
    if (!core.phases.every(row => object(row) && typeof row.name === 'string' && typeof row.status === 'string' && (row.durationMs === null || count(row.durationMs)) && (row.attempts === null || count(row.attempts)))) return null
  }
  return value as unknown as LoopCompletion
}
