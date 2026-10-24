/**
 * Failure recovery: client model. The server explains a failed or blocked run
 * with ONE typed record (`failureDiagnosis` on a job / loop run / inbox item);
 * everything here is pure: reading the wire shape defensively, composing the
 * plain-language headline key, choosing which of the ranked remedies a surface
 * can actually run, and finding the failure in the log.
 */
import type { EventRow } from '../../../types'

export const FAILURE_KINDS = ['tests_failed', 'provider_limit', 'environment', 'blocked', 'timeout', 'tool_inactivity', 'crash', 'unknown'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

export const REMEDY_IDS = ['resume', 'retry', 'edit-spec', 'fix-environment', 'open-logs'] as const
export type RemedyId = (typeof REMEDY_IDS)[number]

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
  confidence: 'high' | 'low'
  phase: string | null
  rounds: number | null
  resetAt: string | null
  detail: string | null
  resumablePhase: string | null
  blocker: FailureBlocker | null
  source: 'core' | 'desktop'
  /** Ranked by the server; a surface shows the first ones it can run. */
  remedies: RemedyId[]
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
  return {
    kind: text(v.kind, 40) ?? 'environment',
    reason,
    command: text(v.command, 512) ?? '',
    args: Array.isArray(v.args) ? v.args.filter((a): a is string => typeof a === 'string').slice(0, 16) : [],
    cwd: text(v.cwd, 512) ?? '',
    requiredAction,
  }
}

/** Defensive read of the wire record: anything malformed is absent, never thrown. */
export function readFailureDiagnosis(raw: unknown): FailureDiagnosis | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (typeof v.kind !== 'string') return null
  const known = (FAILURE_KINDS as readonly string[]).includes(v.kind)
  const confident = known && v.confidence === 'high'
  const remedies = (Array.isArray(v.remedies) ? v.remedies : []).filter((r): r is RemedyId => (REMEDY_IDS as readonly string[]).includes(String(r)))
  return {
    // A low-confidence record is never presented as a cause.
    kind: confident ? (v.kind as FailureKind) : 'unknown',
    confidence: confident ? 'high' : 'low',
    phase: text(v.phase, 200),
    rounds: typeof v.rounds === 'number' && Number.isInteger(v.rounds) && v.rounds > 0 ? v.rounds : null,
    resetAt: text(v.resetAt, 80),
    detail: text(v.detail, 300),
    resumablePhase: text(v.resumablePhase, 200),
    blocker: readBlocker(v.blocker),
    source: v.source === 'core' ? 'core' : 'desktop',
    // An uncertain record is offered the same two safe remedies whatever the wire said.
    remedies: confident ? remedies : ['open-logs', 'retry'],
  }
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
 * what the host must do); the others need the surface's real action.
 */
export function availableRemedies(diagnosis: FailureDiagnosis, handlers: RemedyHandlers): RemedyId[] {
  return diagnosis.remedies
    .filter((id, index, all) => all.indexOf(id) === index)
    .filter((id) => (id === 'fix-environment' ? diagnosis.kind === 'environment' : !!handlers[id]))
    .slice(0, MAX_REMEDIES)
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
    case 'blocked': return { key: `headline.${diagnosis.kind}.${phaseLabel ? 'phase' : 'plain'}`, params }
    default: return { key: `headline.${diagnosis.kind}`, params }
  }
}

/** The "why" line key and params, when the kind has one. */
export function whyKey(diagnosis: FailureDiagnosis): { key: string; params: Record<string, string | number> } | null {
  switch (diagnosis.kind) {
    case 'provider_limit': return diagnosis.resetAt ? { key: 'why.provider_limit.reset', params: { resetAt: diagnosis.resetAt } } : { key: 'why.provider_limit.noReset', params: {} }
    case 'environment': return { key: 'why.environment', params: {} }
    case 'tests_failed': return { key: 'why.tests_failed', params: {} }
    case 'blocked': return { key: 'why.blocked', params: {} }
    case 'timeout': return { key: 'why.timeout', params: {} }
    case 'tool_inactivity': return { key: 'why.tool_inactivity', params: {} }
    case 'crash': return { key: 'why.crash', params: {} }
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
  try { smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches } catch { /* default */ }
  target.scrollIntoView?.({ block: failed ? 'center' : 'start', behavior: smooth ? 'smooth' : 'auto' })
  target.focus({ preventScroll: true })
  return true
}
