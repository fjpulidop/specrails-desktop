/**
 * Failure diagnosis: pure vocabulary and rules. A failed or blocked run is
 * explained by ONE typed record (what stopped it, why when known, which
 * remedies fit). Core classifies on contract 5.8+; for older Core results and
 * for runs Desktop's own loop engine executes, the record is derived from
 * signals Desktop already holds. A cause is never invented: anything not tied
 * to a certain signal is `unknown` with low confidence.
 */
import { classifyProviderLimit } from '../../provider-limit'
import { remainingAreHumanChecks } from './continuation'

export const FAILURE_KINDS = ['tests_failed', 'provider_limit', 'provider_unavailable', 'environment', 'port_in_use', 'blocked', 'timeout', 'tool_inactivity', 'crash', 'incomplete_tasks', 'spec_invalid', 'workflow_protocol', 'unknown'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]
export type FailureConfidence = 'high' | 'low'
export type FailureSource = 'core' | 'desktop'

/**
 * Remedies that map to ACTIONS THAT ALREADY EXIST; the client shows only those its surface can run.
 * `continue` is the one primary remedy for a run that can go on (it keeps the work and attaches the
 * cause's guidance); `retry` is "Start over" from the base. `resume` and `retry-with-browser` are the
 * older ids of `continue`: still read, never ranked.
 */
export const REMEDY_IDS = ['continue', 'resume', 'retry', 'edit-spec', 'fix-environment', 'open-logs', 'continue-to-review', 'retry-with-browser'] as const
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
  /** `provider_limit`: the exact reset (ISO) when the provider reported it typed (Core 5.14) or the words pin it. */
  resetsAt?: string | null
  /** One short sentence from the run's own error; never a log tail. */
  detail: string | null
  /** Step a resume continues from, when resuming can help. */
  resumablePhase: string | null
  /** `environment`: what the host must do, when Core named it. */
  blocker: FailureBlocker | null
  /** `port_in_use`: the contested port, when the message named it. */
  port?: number | null
  /** `incomplete_tasks`: the approved tasks still unticked, as the run named them. */
  incompleteTasks?: string[] | null
  /** `workflow_protocol`: the role whose model skipped the required OpenSpec steps, what it ran on, and the steps. */
  role?: string | null
  provider?: string | null
  model?: string | null
  missingSteps?: string[] | null
  source: FailureSource
}

/** A stronger model of the same provider to run the role on (from the provider's own catalog). */
export interface StrongerModel {
  provider: string
  model: string
  label: string
}

/** What the API returns: the diagnosis plus its ranked remedies. */
export interface PresentedFailureDiagnosis extends FailureDiagnosis {
  remedies: RemedyId[]
  /** `workflow_protocol` on a small model: the provider's default model to suggest for that role. */
  strongerModel?: StrongerModel | null
}

/** A provider's model catalog as its adapter lists it (`small` marks a smaller size class). */
export type ModelCatalogLookup = (provider: string) => readonly { value: string; label: string; default?: boolean; small?: boolean }[] | null

/**
 * The model to suggest when a small model skipped the workflow: the provider's
 * default, when the model that ran is one the catalog marks small. Pure; null
 * when the catalog says nothing certain (unknown provider or model, not small).
 */
export function strongerModelFor(provider: string | null | undefined, model: string | null | undefined, catalog: ModelCatalogLookup): StrongerModel | null {
  if (!provider || !model) return null
  const models = catalog(provider)
  if (!models) return null
  // Catalog aliases (`haiku`) or a pinned id that names them (`claude-haiku-5-5`).
  const ran = models.find((entry) => entry.value === model) ?? models.find((entry) => entry.small && model.split(/[-_/.:]/).includes(entry.value))
  const recommended = models.find((entry) => entry.default && !entry.small)
  if (!ran?.small || !recommended || recommended.value === ran.value) return null
  return { provider, model: recommended.value, label: recommended.label }
}

const DETAIL_LIMIT = 280

export function oneSentence(value: unknown, max = DETAIL_LIMIT): string | null {
  if (typeof value !== 'string') return null
  const flat = value.replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function validPort(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null
}

function optionalText(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

const TASK_LIMIT = 20, TASK_TEXT_LIMIT = 300
function taskList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const tasks = value.filter((item): item is string => typeof item === 'string' && !!item.trim()).slice(0, TASK_LIMIT).map((item) => item.trim().slice(0, TASK_TEXT_LIMIT))
  return tasks.length ? tasks : null
}

/** The `Incomplete: [...]` JSON list an Implement end reason carries (a task text may itself contain "]"). */
export function incompleteTasksOf(message: string): string[] | null {
  const start = message.indexOf('Incomplete: [')
  if (start < 0) return null
  const from = start + 'Incomplete: '.length
  for (let end = message.indexOf(']', from); end >= 0; end = message.indexOf(']', end + 1)) {
    let value: unknown
    try { value = JSON.parse(message.slice(from, end + 1)) } catch { continue }
    return taskList(value)
  }
  return null
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
    ...(kind === 'provider_limit' ? { resetsAt: typeof value.resetsAt === 'string' && Number.isFinite(Date.parse(value.resetsAt)) ? new Date(value.resetsAt).toISOString() : null } : {}),
    detail: oneSentence(value.detail),
    resumablePhase: optionalText(value.resumablePhase, 200),
    blocker: parseBlocker(value.blocker),
    ...(kind === 'port_in_use' ? { port: validPort(value.port) } : {}),
    ...(kind === 'incomplete_tasks' ? { incompleteTasks: taskList(value.incompleteTasks) } : {}),
    ...(kind === 'workflow_protocol' ? {
      role: optionalText(value.role, 64), provider: optionalText(value.provider, 64), model: optionalText(value.model, 128),
      missingSteps: Array.isArray(value.missingSteps) ? value.missingSteps.filter((step): step is string => typeof step === 'string' && !!step.trim()).slice(0, 4).map((step) => step.trim().slice(0, 64)) : null,
    } : {}),
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
  /** A port collision (`EADDRINUSE`, "address already in use") seen in the run's own output,
   *  with the step that printed it. */
  portConflict?: { port: number | null; line: string; stepId: string | null } | null
}

const BASELINE_CODE = /baseline_characterization_failed|^Baseline blocked:/i
// The Implement recipe's own end reasons (Desktop data, fixed templates): known causes even when
// an older Core sends no classification, or a low-confidence one.
const INCOMPLETE_TASKS = /approved tasks (?:are )?still incomplete/i
const INTERRUPTED_WRITE = /interrupted write requires explicit recovery/i
// Desktop's own sentence (loops `unrequestedStopText`) for a Core stopped by a signal it did not send.
export const EXTERNAL_STOP = /a stop Specrails did not request/
const SPEC_INVALID = /Not implemented: the person declined this ticket|still fails OpenSpec validation|OpenSpec could not archive change/i
const RECIPE_HOST_BLOCKER = /\b(?:Developer|Fixer|Unblock) reported a host blocker\b|^Host blocker \(/im
const RECIPE_STALLED = /Implementation attempt limit reached|Automatic correction made no candidate changes|Automatic correction limit reached/i
// Core's own sentence for a host precondition (a fixed template, not a guess).
const HOST_PRECONDITION = /Verification cannot run in this environment/i
// Core's fixed sentence for a role that ended without its required OpenSpec steps; a Core
// before contract 5.16 sends it with no classification (or `unknown`).
const WORKFLOW_PROTOCOL = /Required OpenSpec role workflow was not executed: (\S+) must execute \S+ \(missing ([^)]*)\)/
// A provider CLI's own sentence for a brief outage of its service (Core's PROVIDER_UNAVAILABLE_TEXT,
// contract 5.17). A Core before 5.17 classifies it `crash`; it is a certain signal either way.
export const PROVIDER_UNAVAILABLE = /\bworkspace routing discovery (?:failed|timed out|cancelled)\b|\bstream disconnected before completion\b|\berror sending request for url\b|\bexceeded retry limit, last status: 5\d\d\b|\b(?:500 Internal Server Error|502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b|\boverloaded_error\b|\bAPI Error: 5\d\d\b|\bConnection (?:reset|closed) by (?:peer|remote)\b|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/i
const PROVIDER_EXECUTION = /\b(claude|codex|gemini|kimi) execution failed\b/i
/** The provider's words for an outage, when the text is a provider CLI's failure (never verification output). */
function providerOutage(text: string | null | undefined): string | null {
  if (!text) return null
  const provider = PROVIDER_EXECUTION.exec(text)?.[1]?.toLowerCase()
  const match = provider ? PROVIDER_UNAVAILABLE.exec(text) : null
  return match ? `${provider}: ${match[0]}` : null
}
const outageDetail = (cause: string): string => `The provider's service was unavailable for a moment (${cause}); nothing about the work is wrong, and continuing re-runs the same step.`

/**
 * Diagnosis of a terminal run. Core's classification wins; otherwise only
 * certain signals (a stall reason, the provider-limit classifier, Core's fixed
 * blocker sentences) produce a cause. Everything else is `unknown`/low.
 */
export function deriveFailureDiagnosis(input: DeriveInput): FailureDiagnosis {
  const core = parseCoreFailure(input.core)
  const conflict = portConflictOf(input)
  const portInUse = (base: FailureDiagnosis | null): FailureDiagnosis => ({
    kind: 'port_in_use', confidence: 'high', phase: base?.phase ?? input.stepId ?? null, rounds: base?.rounds ?? null, resetAt: null,
    detail: conflict!.line, resumablePhase: base?.resumablePhase ?? null, blocker: null, port: conflict!.port, source: base ? base.source : 'desktop',
  })
  // A check whose own step could not bind its port did not fail on the change: the collision is
  // the certain cause, whatever the checks' exit code made Core call it. Core's other causes win.
  if (core && conflict && (core.kind === 'tests_failed' || core.kind === 'unknown')) return portInUse(core)
  // A Core before contract 5.17 calls a provider outage a crash; its own words say what it was.
  const limited = !!input.providerLimit || input.stallReason === 'provider_limit' || !!classifyProviderLimit(input.errorText ?? '')
  const outage = !limited && (core?.kind === 'crash' || !core || core.kind === 'unknown') ? providerOutage(core?.detail ?? input.errorText) ?? providerOutage(input.errorText) : null
  if (outage) return { ...(core ?? { rounds: null, resetAt: null, blocker: null, source: 'desktop' as const }), kind: 'provider_unavailable', confidence: 'high', phase: core?.phase ?? input.stepId ?? null,
    detail: outageDetail(outage), resumablePhase: core?.resumablePhase ?? core?.phase ?? input.stepId ?? null }
  // A low-confidence Core record is not a cause: Desktop's own certain signals may still name one.
  if (core && core.confidence === 'high') return { ...core, phase: core.phase ?? input.stepId ?? null }
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
  const ended = input.blockedReason ?? ''
  if (INCOMPLETE_TASKS.test(ended)) return make('incomplete_tasks', 'high', { detail: oneSentence(ended), incompleteTasks: incompleteTasksOf(ended), ...(core?.phase ? { phase: core.phase } : {}) })
  if (SPEC_INVALID.test(ended)) return make('spec_invalid', 'high', { detail: oneSentence(ended) })
  if (RECIPE_HOST_BLOCKER.test(ended)) return make('environment', 'high', { detail: oneSentence(ended) })
  if (RECIPE_STALLED.test(ended)) return make('blocked', 'high', { detail: oneSentence(ended) })
  if (input.outcome === 'blocked' && input.blockedReason) return make('blocked', 'high', { detail: oneSentence(input.blockedReason) })
  if (conflict) return portInUse(null)
  const text = input.errorText ?? ''
  const limit = classifyProviderLimit(text)
  if (limit) return make('provider_limit', 'high', { resetAt: limit.resetsAt, detail: oneSentence(limit.message) })
  if (BASELINE_CODE.test(text)) return make('blocked', 'high')
  if (HOST_PRECONDITION.test(text)) return make('environment', 'high')
  // Core refused to re-run a step that writes files because a restart cut it off and the
  // resume did not authorize recovering it. Nothing about the work failed: Continue re-runs it.
  if (EXTERNAL_STOP.test(text)) return make('crash', 'high', { detail: oneSentence(text), resumablePhase: input.stepId ?? null })
  if (INTERRUPTED_WRITE.test(text)) return make('crash', 'high', { detail: 'A restart cut off a step that writes files, and the resume did not re-run it. Continue re-runs that step from its saved state.' })
  const skipped = WORKFLOW_PROTOCOL.exec(text)
  if (skipped) {
    const missingSteps = skipped[2]!.split(',').map((step) => step.trim()).filter(Boolean).slice(0, 4)
    return make('workflow_protocol', 'high', { role: skipped[1]!, provider: null, model: null, missingSteps, resumablePhase: input.stepId ?? null, phase: core?.phase ?? input.stepId ?? null })
  }
  return core ? { ...core, phase: core.phase ?? input.stepId ?? null } : make('unknown', 'low')
}

/** The conflict counts only for a run that failed in the very step that printed it. */
function portConflictOf(input: DeriveInput): { port: number | null; line: string } | null {
  const conflict = input.portConflict
  if (!conflict || input.outcome !== 'failed') return null
  if (conflict.stepId && input.stepId && conflict.stepId !== input.stepId) return null
  return { port: conflict.port, line: oneSentence(conflict.line) ?? conflict.line }
}

const CONTINUABLE_KINDS: ReadonlySet<FailureKind> = new Set(['provider_limit', 'provider_unavailable', 'environment', 'port_in_use', 'blocked', 'timeout', 'tool_inactivity', 'crash', 'incomplete_tasks', 'workflow_protocol'])

/** Ranked remedies for a diagnosis. Order matters: the client shows the first available ones; `retry` (Start over) sits apart. */
export function rankRemedies(diagnosis: Pick<FailureDiagnosis, 'kind' | 'confidence' | 'resumablePhase'> & Partial<Pick<FailureDiagnosis, 'incompleteTasks'>>): RemedyId[] {
  // Continuing helps when Core named a phase, and for causes that are outside the change itself
  // or that more work in the same run can finish. A plain failed verification needs a change first.
  const go: RemedyId[] = diagnosis.resumablePhase || CONTINUABLE_KINDS.has(diagnosis.kind) ? ['continue'] : []
  if (diagnosis.confidence === 'low') return ['open-logs', 'retry']
  switch (diagnosis.kind) {
    case 'tests_failed': return [...go, 'edit-spec', 'open-logs', 'retry']
    // Continue first: its guidance says what is missing and how to install it; the panel shows the host's part.
    case 'environment': return [...go, 'fix-environment', 'open-logs', 'retry']
    case 'blocked': return [...go, 'edit-spec', 'open-logs', 'retry']
    case 'provider_limit':
    case 'provider_unavailable':
    case 'port_in_use':
    case 'timeout':
    case 'tool_inactivity':
    case 'crash': return [...go, 'open-logs', 'retry']
    // The run can finish what is left with its tools; only checks a person must make go to review.
    case 'incomplete_tasks': return [...go, ...(remainingAreHumanChecks(diagnosis.incompleteTasks) ? ['continue-to-review' as const] : []), 'open-logs', 'retry']
    case 'spec_invalid': return ['edit-spec', 'open-logs', 'retry']
    // The work before the step is fine: continue from it (Core reruns the role with a
    // fresh corrective budget); a person may also run it again on a stronger model.
    case 'workflow_protocol': return [...go, 'open-logs', 'retry']
    default: return ['open-logs', 'retry']
  }
}

export function presentFailureDiagnosis(diagnosis: FailureDiagnosis, catalog?: ModelCatalogLookup): PresentedFailureDiagnosis {
  const strongerModel = diagnosis.kind === 'workflow_protocol' && catalog ? strongerModelFor(diagnosis.provider, diagnosis.model, catalog) : null
  return { ...diagnosis, remedies: rankRemedies(diagnosis), ...(diagnosis.kind === 'workflow_protocol' ? { strongerModel } : {}) }
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
