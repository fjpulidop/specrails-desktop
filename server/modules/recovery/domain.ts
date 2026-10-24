/**
 * Failure diagnosis: pure vocabulary and rules. A failed or blocked run is
 * explained by ONE typed record (what stopped it, why when known, which
 * remedies fit). Core classifies on contract 5.8+; for older Core results and
 * for runs Desktop's own loop engine executes, the record is derived from
 * signals Desktop already holds. A cause is never invented: anything not tied
 * to a certain signal is `unknown` with low confidence.
 */
import { classifyProviderLimit } from '../../provider-limit'

export const FAILURE_KINDS = ['tests_failed', 'provider_limit', 'environment', 'blocked', 'timeout', 'tool_inactivity', 'crash', 'unknown'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]
export type FailureConfidence = 'high' | 'low'
export type FailureSource = 'core' | 'desktop'

/** Remedies that map to ACTIONS THAT ALREADY EXIST; the client shows only those its surface can run. */
export const REMEDY_IDS = ['resume', 'retry', 'edit-spec', 'fix-environment', 'open-logs'] as const
export type RemedyId = (typeof REMEDY_IDS)[number]

/** The structured host precondition behind an `environment` failure (Core's HostBlocker, bounded). */
export interface FailureBlocker {
  kind: string
  reason: string
  command: string
  args: string[]
  cwd: string
  requiredAction: string
}

export interface FailureDiagnosis {
  kind: FailureKind
  confidence: FailureConfidence
  /** Step / node that stopped the run (raw id; the client humanizes it). */
  phase: string | null
  /** Correction rounds spent before the run stopped. */
  rounds: number | null
  /** `provider_limit`: the provider's own wording of the reset time. */
  resetAt: string | null
  /** One short sentence from the run's own error; never a log tail. */
  detail: string | null
  /** Step a resume continues from, when resuming can help. */
  resumablePhase: string | null
  /** `environment`: what the host must do, when Core named it. */
  blocker: FailureBlocker | null
  source: FailureSource
}

/** What the API returns: the diagnosis plus its ranked remedies. */
export interface PresentedFailureDiagnosis extends FailureDiagnosis {
  remedies: RemedyId[]
}

const DETAIL_LIMIT = 280

export function oneSentence(value: unknown, max = DETAIL_LIMIT): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function optionalText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

/** Bounded copy of a host blocker; anything malformed is dropped. */
export function parseBlocker(raw: unknown): FailureBlocker | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const reason = optionalText(value.reason, 600)
  const requiredAction = optionalText(value.requiredAction, 600)
  if (!reason || !requiredAction) return null
  const args = Array.isArray(value.args) ? value.args.filter((a): a is string => typeof a === 'string').slice(0, 16).map((a) => a.slice(0, 256)) : []
  return { kind: optionalText(value.kind, 40) ?? 'environment', reason, command: optionalText(value.command, 512) ?? '', args, cwd: optionalText(value.cwd, 512) ?? '', requiredAction }
}

/**
 * Validate the `failure` record of a Core runtime result. Tolerant: a newer
 * Core's unknown kind degrades to `unknown`; a malformed record is rejected.
 */
export function parseCoreFailure(raw: unknown): FailureDiagnosis | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const known = typeof value.kind === 'string' && (FAILURE_KINDS as readonly string[]).includes(value.kind)
  if (typeof value.kind !== 'string') return null
  const kind: FailureKind = known ? (value.kind as FailureKind) : 'unknown'
  const confidence: FailureConfidence = known && value.confidence === 'high' ? 'high' : 'low'
  const rounds = typeof value.rounds === 'number' && Number.isInteger(value.rounds) && value.rounds > 0 ? value.rounds : null
  return {
    // Low confidence is never presented as a cause.
    kind: confidence === 'low' ? 'unknown' : kind,
    confidence,
    phase: optionalText(value.phase, 200),
    rounds,
    resetAt: kind === 'provider_limit' ? optionalText(value.resetAt, 80) : null,
    detail: oneSentence(value.detail),
    resumablePhase: optionalText(value.resumablePhase, 200),
    blocker: parseBlocker(value.blocker),
    source: 'core',
  }
}

export interface DeriveInput {
  /** The run's final outcome (`failed`, `blocked`, `stalled`, …). */
  outcome: string | null
  /** Loop stall reason when the engine stalled the run. */
  stallReason?: string | null
  providerLimit?: { kind?: string; message?: string; resetsAt?: string | null } | null
  /** The run's own terminal error text. */
  errorText?: string | null
  /** Step that failed last. */
  stepId?: string | null
  /** Raw `failure` record of a Core runtime result (contract 5.8+). */
  core?: unknown
  /** Why Core's own acceptance (completion) blocked a run whose execution succeeded. */
  blockedReason?: string | null
  /** Core's structured host blocker (`completion.blocker`): the cause is the environment. */
  hostBlocker?: unknown
}

const BASELINE_CODE = /baseline_characterization_failed|^Baseline blocked:/i
// Core's own sentence for a host precondition (a fixed template, not a guess).
const HOST_PRECONDITION = /Verification cannot run in this environment/i

/**
 * Diagnosis of a terminal run. Core's classification wins; otherwise only
 * certain signals (a stall reason, the provider-limit classifier, Core's fixed
 * blocker sentences) produce a cause. Everything else is `unknown`/low.
 */
export function deriveFailureDiagnosis(input: DeriveInput): FailureDiagnosis {
  const core = parseCoreFailure(input.core)
  if (core) return { ...core, phase: core.phase ?? input.stepId ?? null }
  const make = (kind: FailureKind, confidence: FailureConfidence, extra: Partial<FailureDiagnosis> = {}): FailureDiagnosis => ({
    kind, confidence, phase: input.stepId ?? null, rounds: null, resetAt: null, detail: oneSentence(input.errorText), resumablePhase: null, blocker: null, source: 'desktop', ...extra,
  })
  if (input.providerLimit) {
    return make('provider_limit', 'high', { resetAt: optionalText(input.providerLimit.resetsAt, 80), detail: oneSentence(input.providerLimit.message) })
  }
  if (input.stallReason === 'provider_limit') return make('provider_limit', 'high')
  if (input.stallReason === 'idle_timeout') return make('tool_inactivity', 'high')
  // The loop's own limits (cost cap, iteration cap) are deliberate stops, not failures of the change.
  if (input.outcome === 'max-cost' || input.outcome === 'max-iterations') return make('blocked', 'high', { detail: null })
  if (input.stallReason === 'no_progress') return make('blocked', 'high', { detail: oneSentence(input.errorText) ?? 'no_progress' })
  const blocker = parseBlocker(input.hostBlocker)
  if (blocker) return make('environment', 'high', { blocker, detail: oneSentence(blocker.reason) })
  if (input.outcome === 'blocked' && input.blockedReason) return make('blocked', 'high', { detail: oneSentence(input.blockedReason) })
  const text = input.errorText ?? ''
  const limit = classifyProviderLimit(text)
  if (limit) return make('provider_limit', 'high', { resetAt: limit.resetsAt, detail: oneSentence(limit.message) })
  if (BASELINE_CODE.test(text)) return make('blocked', 'high')
  if (HOST_PRECONDITION.test(text)) return make('environment', 'high')
  return make('unknown', 'low')
}

const RESUMABLE_KINDS: ReadonlySet<FailureKind> = new Set(['provider_limit', 'environment', 'blocked', 'timeout', 'tool_inactivity', 'crash'])

/** Ranked remedies for a diagnosis. Order matters: the client shows the first available ones (at most three). */
export function rankRemedies(diagnosis: Pick<FailureDiagnosis, 'kind' | 'confidence' | 'resumablePhase'>): RemedyId[] {
  // Resuming can help when Core named a phase, and for causes that are outside the change itself.
  // A plain failed verification needs a change, not a resume. The client still shows `resume` only
  // where the surface can actually resume the run.
  const resume: RemedyId[] = diagnosis.resumablePhase || RESUMABLE_KINDS.has(diagnosis.kind) ? ['resume'] : []
  if (diagnosis.confidence === 'low') return ['open-logs', 'retry']
  switch (diagnosis.kind) {
    case 'tests_failed': return [...resume, 'edit-spec', 'open-logs', 'retry']
    case 'provider_limit': return [...resume, 'retry', 'open-logs']
    case 'environment': return ['fix-environment', ...resume, 'open-logs', 'retry']
    case 'blocked': return [...resume, 'edit-spec', 'open-logs', 'retry']
    case 'timeout':
    case 'tool_inactivity':
    case 'crash': return [...resume, 'retry', 'open-logs']
    default: return ['open-logs', 'retry']
  }
}

export function presentFailureDiagnosis(diagnosis: FailureDiagnosis): PresentedFailureDiagnosis {
  return { ...diagnosis, remedies: rankRemedies(diagnosis) }
}

/** Outcomes that deserve a diagnosis. */
export function isDiagnosableOutcome(outcome: string | null | undefined): boolean {
  return outcome === 'failed' || outcome === 'blocked' || outcome === 'stalled' || outcome === 'max-cost' || outcome === 'max-iterations'
}

/** Read a stored record; anything unreadable is treated as absent so the caller re-derives. */
export function parseStoredDiagnosis(raw: string | null | undefined): FailureDiagnosis | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    const parsed = parseCoreFailure(value)
    if (!parsed) return null
    return { ...parsed, source: value.source === 'core' ? 'core' : 'desktop' }
  } catch { return null }
}

export function serializeDiagnosis(diagnosis: FailureDiagnosis): string {
  return JSON.stringify(diagnosis)
}
