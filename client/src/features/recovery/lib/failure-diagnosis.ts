/**
 * Failure recovery: client model. The server explains a failed or blocked run
 * with ONE typed record (`failureDiagnosis` on a job / loop run / inbox item);
 * everything here is pure: reading the wire shape defensively, composing the
 * plain-language headline key, choosing which of the ranked remedies a surface
 * can actually run, and finding the failure in the log.
 */
import type { EventRow } from '../../../types'
import { prefersReducedMotion } from '../../../lib/a11y-prefs'

export const FAILURE_KINDS = ['tests_failed', 'provider_limit', 'provider_unavailable', 'environment', 'port_in_use', 'blocked', 'timeout', 'tool_inactivity', 'crash', 'incomplete_tasks', 'spec_invalid', 'workflow_protocol', 'unknown'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

/**
 * `continue` is the one primary remedy of a run that can go on (it keeps the work and sends the
 * cause's guidance). `retry` is "Start over" from the base, offered apart with its warning.
 * `resume` and `retry-with-browser` are older wire ids of `continue`: read as `continue`.
 * `copy-env-files` (an environment blocker about a missing `.env`, project setting off) turns the
 * project's env-file copy on and continues.
 */
export const REMEDY_IDS = ['continue', 'retry', 'edit-spec', 'fix-environment', 'open-logs', 'continue-to-review', 'copy-env-files'] as const
export type RemedyId = (typeof REMEDY_IDS)[number]
const LEGACY_REMEDIES: Readonly<Record<string, RemedyId>> = { resume: 'continue', 'retry-with-browser': 'continue' }

export interface FailureBlocker {
  kind: string
  reason: string
  command: string
  args: string[]
  cwd: string
  requiredAction: string
  /** The exact machine-wide install the run asked the person for: the command they run themselves. */
  install?: string | null
}

export interface FailureDiagnosis {
  kind: FailureKind
  confidence: 'high' | 'low'
  phase: string | null
  rounds: number | null
  resetAt: string | null
  /** `provider_limit`: the exact reset (ISO), when the provider reported it typed. */
  resetsAt?: string | null
  detail: string | null
  resumablePhase: string | null
  blocker: FailureBlocker | null
  /** `port_in_use`: the contested port, when the run's output named it. */
  port?: number | null
  /** `incomplete_tasks`: the approved tasks still unticked, as the run named them. */
  incompleteTasks?: string[] | null
  /** `workflow_protocol`: the role whose model skipped the required OpenSpec steps, and what it ran on. */
  role?: string | null
  model?: string | null
  /** `workflow_protocol` on a small model: the provider's default model to run that role on instead. */
  strongerModel?: { provider: string; model: string; label: string } | null
  source: 'core' | 'desktop'
  /** Ranked by the server; a surface shows the first ones it can run. */
  remedies: RemedyId[]
  /** Tests the latest host verification failed (`file › title`), from the recorded output. */
  failingTests?: string[]
  /** Those of them the recorded rounds show to be flaky. */
  flakyTests?: string[]
}

/** Remedies a card shows at once: a ranked short list, never a menu. */
export const MAX_REMEDIES = 3

const text = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null

function readBlocker(raw: unknown): FailureBlocker | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const reason = text(v.reason, 600), requiredAction = text(v.requiredAction, 600)
  if (!reason || !requiredAction) return null
  const install = typeof v.install === 'string' && !/[\r\n]/.test(v.install) ? text(v.install, 300) : null
  return {
    kind: text(v.kind, 40) ?? 'environment',
    reason,
    command: text(v.command, 512) ?? '',
    args: Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string').slice(0, 16) : [],
    cwd: text(v.cwd, 512) ?? '',
    requiredAction,
    ...(install ? { install } : {}),
  }
}

function readStrongerModel(raw: unknown): FailureDiagnosis['strongerModel'] {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const provider = text(v.provider, 64), model = text(v.model, 128), label = text(v.label, 120)
  return provider && model && label ? { provider, model, label } : null
}

/** Defensive read of the wire record: anything malformed is absent, never thrown. */
export function readFailureDiagnosis(raw: unknown): FailureDiagnosis | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (typeof v.kind !== 'string') return null
  const known = (FAILURE_KINDS as readonly string[]).includes(v.kind)
  const confident = known && v.confidence === 'high'
  const remedies = normalizedRemedies((Array.isArray(v.remedies) ? v.remedies : []).map(String))
  return {
    // A low-confidence record is never presented as a cause.
    kind: confident ? (v.kind as FailureKind) : 'unknown',
    confidence: confident ? 'high' : 'low',
    phase: text(v.phase, 200),
    rounds: typeof v.rounds === 'number' && Number.isInteger(v.rounds) && v.rounds > 0 ? v.rounds : null,
    resetAt: text(v.resetAt, 80),
    resetsAt: typeof v.resetsAt === 'string' && Number.isFinite(Date.parse(v.resetsAt)) ? v.resetsAt : null,
    detail: text(v.detail, 300),
    resumablePhase: text(v.resumablePhase, 200),
    blocker: readBlocker(v.blocker),
    port: typeof v.port === 'number' && Number.isInteger(v.port) && v.port >= 1 && v.port <= 65535 ? v.port : null,
    incompleteTasks: Array.isArray(v.incompleteTasks) ? v.incompleteTasks.filter((task): task is string => typeof task === 'string' && !!task.trim()).slice(0, 20).map((task) => task.slice(0, 300)) : null,
    role: text(v.role, 64),
    model: text(v.model, 128),
    strongerModel: readStrongerModel(v.strongerModel),
    source: v.source === 'core' ? 'core' : 'desktop',
    // An uncertain record is offered the same two safe remedies whatever the wire said.
    remedies: confident ? remedies : ['open-logs', 'retry'],
    ...testList('failingTests', v.failingTests, 20),
    ...testList('flakyTests', v.flakyTests, 12),
  }
}

function testList<K extends 'failingTests' | 'flakyTests'>(key: K, raw: unknown, max: number): Partial<Record<K, string[]>> {
  const tests = Array.isArray(raw) ? raw.filter((test): test is string => typeof test === 'string' && !!test.trim()).slice(0, max).map((test) => test.slice(0, 240)) : []
  return tests.length ? { [key]: tests } as Partial<Record<K, string[]>> : {}
}

/** A surface's way to run one remedy. Only remedies a surface can truly run are offered. */
export interface RemedyHandler {
  run(): void
  busy?: boolean
  disabled?: boolean
}
export type RemedyHandlers = Partial<Record<RemedyId, RemedyHandler>>

/**
 * The remedies to show: the server's ranking, filtered to what this surface can
 * run, at most three. Fixing the environment needs no handler (the card shows
 * what the host must do); the others need the surface's real action. "Start
 * over" (`retry`) is not among them: it sits apart, behind its warning
 * (`offersStartOver`).
 */
export function availableRemedies(diagnosis: FailureDiagnosis, handlers: RemedyHandlers): RemedyId[] {
  return normalizedRemedies(diagnosis.remedies)
    .filter((id) => id !== 'retry')
    .filter((id) => (id === 'fix-environment' ? diagnosis.kind === 'environment' : !!handlers[id]))
    .slice(0, MAX_REMEDIES)
}

/** Known remedy ids in rank order, older ids read as `continue`, each once. */
function normalizedRemedies(remedies: readonly string[]): RemedyId[] {
  return remedies.map((id) => LEGACY_REMEDIES[id] ?? id)
    .filter((id, index, all): id is RemedyId => (REMEDY_IDS as readonly string[]).includes(id) && all.indexOf(id) === index)
}

/** Whether the card offers "Start over" (in its secondary menu). */
export function offersStartOver(diagnosis: FailureDiagnosis, handlers: RemedyHandlers): boolean {
  return diagnosis.remedies.includes('retry') && !!handlers.retry
}

/** The automatic correction budget ran out while the reviewer still asked for a change. */
export function correctionsExhausted(diagnosis: Pick<FailureDiagnosis, 'kind' | 'phase'> | null | undefined): boolean {
  return diagnosis?.kind === 'blocked' && diagnosis.phase === 'correction-exhausted'
}

/** The one-line consequence key under each remedy (recovery namespace). */
export function consequenceKey(id: RemedyId, diagnosis: Pick<FailureDiagnosis, 'kind'> & Partial<Pick<FailureDiagnosis, 'phase'>> | null): string {
  if (id === 'continue') {
    if (correctionsExhausted(diagnosis as Pick<FailureDiagnosis, 'kind' | 'phase'> | null)) return 'consequence.continueCorrections'
    switch (diagnosis?.kind) {
      case 'incomplete_tasks': return 'consequence.continueTasks'
      case 'environment': return 'consequence.continueEnvironment'
      case 'provider_limit': return 'consequence.continueLimit'
      case 'crash':
      case 'provider_unavailable':
      case 'timeout':
      case 'tool_inactivity': return 'consequence.continueTransient'
      case undefined: return 'consequence.continueStopped'
      default: return 'consequence.continue'
    }
  }
  return `consequence.${id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`
}

/** Plain-language headline: the i18n key (recovery namespace) and its params. */
export function headlineKey(diagnosis: FailureDiagnosis, phaseLabel: string | null): { key: string; params: Record<string, string | number> } {
  const params: Record<string, string | number> = { phase: phaseLabel ?? '', count: diagnosis.rounds ?? 0 }
  const variant = phaseLabel && diagnosis.rounds ? 'phaseRounds' : phaseLabel ? 'phase' : diagnosis.rounds ? 'rounds' : 'plain'
  switch (diagnosis.kind) {
    case 'tests_failed': return { key: `headline.tests_failed.${variant}`, params }
    case 'timeout':
    case 'tool_inactivity':
    case 'crash':
    case 'provider_unavailable':
    case 'blocked': return correctionsExhausted(diagnosis) ? { key: 'headline.blocked.corrections', params } : { key: `headline.${diagnosis.kind}.${phaseLabel ? 'phase' : 'plain'}`, params }
    // The role names who skipped the steps (`plan`); the phase id is only the node it ran in.
    case 'workflow_protocol': return diagnosis.role ? { key: 'headline.workflow_protocol.role', params: { ...params, role: diagnosis.role } } : { key: 'headline.workflow_protocol.plain', params }
    case 'port_in_use': return diagnosis.port ? { key: 'headline.port_in_use.port', params: { ...params, port: diagnosis.port } } : { key: 'headline.port_in_use.plain', params }
    default: return { key: `headline.${diagnosis.kind}`, params }
  }
}

/** The "why" line key and params, when the kind has one. */
export function whyKey(diagnosis: FailureDiagnosis): { key: string; params: Record<string, string | number> } | null {
  switch (diagnosis.kind) {
    // The typed reset is a real instant (the card formats it in the person's clock); the words are the fallback.
    case 'provider_limit': return diagnosis.resetsAt ? { key: 'why.provider_limit.resetsAt', params: { resetsAt: diagnosis.resetsAt } }
      : diagnosis.resetAt ? { key: 'why.provider_limit.reset', params: { resetAt: diagnosis.resetAt } } : { key: 'why.provider_limit.noReset', params: {} }
    case 'environment': return { key: 'why.environment', params: {} }
    case 'port_in_use': return { key: 'why.port_in_use', params: {} }
    case 'tests_failed': return { key: 'why.tests_failed', params: {} }
    case 'blocked': return correctionsExhausted(diagnosis) ? { key: 'why.correctionsExhausted', params: { count: diagnosis.rounds ?? 3 } } : { key: 'why.blocked', params: {} }
    case 'timeout': return { key: 'why.timeout', params: {} }
    case 'tool_inactivity': return { key: 'why.tool_inactivity', params: {} }
    case 'crash': return { key: 'why.crash', params: {} }
    case 'provider_unavailable': return { key: 'why.provider_unavailable', params: {} }
    case 'incomplete_tasks': return { key: 'why.incomplete_tasks', params: {} }
    case 'spec_invalid': return { key: 'why.spec_invalid', params: {} }
    case 'workflow_protocol': return diagnosis.strongerModel
      ? { key: 'why.workflow_protocol.stronger', params: { model: diagnosis.model ?? '', stronger: diagnosis.strongerModel.label } }
      : { key: 'why.workflow_protocol.plain', params: {} }
    default: return null
  }
}

/** "Verify" → "Verify"; `implement/fix` → "implement fix": a raw id made readable when nothing better is known. */
export function humanizePhase(phase: string | null): string | null {
  if (!phase) return null
  const flat = phase.replace(/^.*[/:]/, '').replace(/[-_.]+/g, ' ').trim()
  return flat ? flat.charAt(0).toUpperCase() + flat.slice(1) : null
}

/** The last non-empty log lines of a job (the raw tail shown for an unknown cause). */
export function logTailLines(events: readonly Pick<EventRow, 'event_type' | 'payload'>[], max = 12): string[] {
  const lines: string[] = []
  for (let i = events.length - 1; i >= 0 && lines.length < max; i--) {
    const event = events[i]
    if (event.event_type !== 'log') continue
    try {
      const line = (JSON.parse(event.payload) as { line?: unknown }).line
      if (typeof line === 'string') for (const part of line.split('\n').reverse()) {
        const trimmed = part.trimEnd()
        if (trimmed.trim() && lines.length < max) lines.push(trimmed.slice(0, 400))
      }
    } catch { /* an unreadable event is not part of the tail */ }
  }
  return lines.reverse()
}

/**
 * Bring the failure into view: the last failed step of the loop log, else the
 * log itself. Returns whether anything was found, so a caller can say so.
 */
export function openLogsAtFailure(root: ParentNode | null = typeof document === 'undefined' ? null : document): boolean {
  if (!root) return false
  const failed = [...root.querySelectorAll<HTMLElement>('[data-testid="loop-step-section"][data-status="failed"], [data-testid="loop-step-section"][data-status="stalled"]')].pop()
  const target = failed ?? root.querySelector<HTMLElement>('[data-testid="loop-step-explorer"], [data-testid="log-viewer"]')
  if (!target) return false
  target.setAttribute('tabindex', '-1')
  let smooth = true
  try { smooth = !prefersReducedMotion() } catch { /* default */ }
  target.scrollIntoView?.({ block: failed ? 'center' : 'start', behavior: smooth ? 'smooth' : 'auto' })
  target.focus({ preventScroll: true })
  return true
}

/**
 * The runtime's own record of the step that failed (`step_failed: <step> — <reason>`),
 * newest first. Not a guess: the words are the runtime's, only placed in view.
 */
export function recordedStepError(lines: readonly string[]): { step: string; reason: string } | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /step_failed:\s*([^\s—–-][^—–]*?)\s+[—–-]{1,2}\s+(.+)$/.exec(lines[index])
    if (match) return { step: match[1].trim(), reason: match[2].trim() }
  }
  return null
}
