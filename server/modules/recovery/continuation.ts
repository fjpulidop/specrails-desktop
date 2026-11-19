/**
 * Continuing a failed or stopped run: pure rules.
 *
 * "Continue" is the one primary remedy. It keeps every piece of work and goes on
 * from the step that failed or stopped. The cause decides what goes with it: the
 * guidance sent to the next agent turn as an operator instruction (unfinished
 * tasks → the browser and install rule with the exact tasks; a host blocker →
 * what is missing and how to install it; a transient provider error → nothing).
 *
 * The same rules decide whether Specrails continues ONCE by itself. It never
 * does for a cause a person must resolve (credentials and secrets, policy,
 * spend caps, a usage limit, a spec to edit), for a stop the person chose, for a
 * cause it cannot name, or when the attempt failed exactly like the one before.
 */
import type { FailureDiagnosis, FailureKind } from './domain'

const TASK_TEXT = 600

/** The guidance for an attempt that left approved tasks unticked: the browser tool, the install rule and the exact tasks. */
export function unfinishedTasksGuidance(incompleteTasks: readonly string[]): string {
  const tasks = incompleteTasks.length
    ? incompleteTasks.map((task) => `- ${task.length > TASK_TEXT ? `${task.slice(0, TASK_TEXT)}…` : task}`).join('\n')
    : '- (the unticked tasks in tasks.md)'
  return [
    'Specrails continued this run because these approved tasks were left unticked:',
    tasks,
    '',
    'You CAN do them yourself in this run. A headless browser tool is available as `$SPECRAILS_BROWSE` (run `"$SPECRAILS_BROWSE" --help`).',
    'Start the app on this run\'s port (`$PORT`) with `--start "<the command that serves the app>"` or point `--url` at a file or `http://127.0.0.1:$PORT/`, set the state you need with `--eval` / `--click` / `--type` actions, and take screenshots at the viewports that matter (for example `--viewport 1440x900 --viewport 390x844`).',
    'Read the PNGs it prints, check the console errors in report.json, then write what you observed where the task asks (for example the README note) and tick the task.',
    'If a tool you need is missing, install it (project-local or the Specrails cache). Never leave a task undone because a tool is missing, and never hand a check to a person that the browser tool can do.',
  ].join('\n')
}

const INSTALL_RULE = 'If a tool, package or runtime is missing, install it yourself (project-local or the Specrails cache) and go on. Never stop for a missing tool and never hand its installation to a person. If what is missing is a credential, a secret or an account login, do not invent one: say exactly what is missing and stop.'

// Fixed end reasons of the Implement recipe for an attempt that ran out of ideas (domain.ts RECIPE_STALLED).
const STALLED = /Implementation attempt limit reached|Automatic correction made no candidate changes|Automatic correction limit reached/i

/**
 * The operator instruction that goes with a continuation, or null when the cause
 * needs none (a crash, a timeout, a usage limit: the same step simply runs again).
 */
/** How much of a stall's full end reason the next attempt reads (the diagnosis detail is a one-line summary). */
const STALL_REASON_LIMIT = 2_000

export function continuationGuidance(diagnosis: Pick<FailureDiagnosis, 'kind' | 'confidence' | 'detail' | 'blocker' | 'port' | 'incompleteTasks'> | null, evidence: { completionReasons?: readonly unknown[] | null } = {}): string | null {
  if (!diagnosis || diagnosis.confidence !== 'high') return null
  switch (diagnosis.kind) {
    case 'incomplete_tasks': return unfinishedTasksGuidance(diagnosis.incompleteTasks ?? [])
    case 'environment': {
      const blocker = diagnosis.blocker
      const command = blocker ? [blocker.command, ...blocker.args].filter(Boolean).join(' ') : ''
      return [
        'Specrails continued this run after the host environment stopped it.',
        blocker ? `What was missing: ${blocker.reason}` : diagnosis.detail ? `What stopped it: ${diagnosis.detail}` : null,
        command ? `It failed running \`${command}\`${blocker?.cwd ? ` in ${blocker.cwd}` : ''}.` : null,
        blocker?.requiredAction ? `What it needs: ${blocker.requiredAction}` : null,
        INSTALL_RULE,
      ].filter((line): line is string => !!line).join('\n')
    }
    case 'port_in_use': return [
      `Specrails continued this run because a port${diagnosis.port ? ` (${diagnosis.port})` : ''} was already taken by another process.`,
      'Serve and check the app on this run\'s own port (`$PORT`), never on a fixed port, and stop any server you start when you are done.',
    ].join('\n')
    case 'blocked': return diagnosis.detail && STALLED.test(diagnosis.detail) ? [
      // The full end reason carries the reviewer's findings and the fixer's diagnosis that the
      // one-line detail cuts ("Latest r…"); the next attempt needs them to change approach.
      `Specrails continued this run after the previous attempt stalled: ${stallReason(diagnosis.detail, evidence.completionReasons)}`,
      'Re-read the approved tasks and the last failing output, and change approach instead of repeating the last edit.',
      'Checks that need a browser can use `$SPECRAILS_BROWSE` (run `"$SPECRAILS_BROWSE" --help`).',
      INSTALL_RULE,
    ].join('\n') : null
    default: return null
  }
}

function stallReason(detail: string, reasons: readonly unknown[] | null | undefined): string {
  const full = (reasons ?? []).find((reason): reason is string => typeof reason === 'string' && STALLED.test(reason))
  if (!full) return detail
  return full.length > STALL_REASON_LIMIT ? `${full.slice(0, STALL_REASON_LIMIT)}…` : full
}

/** Every remaining task reads as a check only a person can make (a `[human]` tag or manual wording). Pure, conservative. */
export function remainingAreHumanChecks(tasks: readonly string[] | null | undefined): boolean {
  if (!tasks?.length) return false
  return tasks.every((task) => /\[human\]|\bmanual(ly)?\b|\bby hand\b|\b(person|human|stakeholder|product owner|customer)\b|\bsign[- ]?off\b|\breal device\b|\bphysical device\b|\bin production\b|\blive (charge|payment|account)\b/i.test(task))
}

/** Host blocker kinds a continuation can resolve by installing what is missing (Core's HostBlocker vocabulary). */
const INSTALLABLE_BLOCKERS: ReadonlySet<string> = new Set(['toolchain', 'setup'])
/** Words that mark a cause a person must resolve, whatever its kind. */
const PERSON_ONLY = /credential|secret|token|api[ _-]?key|password|log ?in\b|sign(ed)? ?(in|out)|auth(entication|orization)?\b|permission denied|not permitted|denied by (the )?policy|policy (denied|blocked|forbids)|budget|spend cap|cost cap|usage limit|quota/i

export type AutoContinueVerdict =
  | { continue: true; reason: AutoContinueReason; /** Wait this long first (a provider outage clears by itself). */ delayMs?: number }
  | { continue: false; reason: AutoContinueRefusal }
export type AutoContinueReason = 'unfinished_tasks' | 'missing_tool' | 'transient_error' | 'provider_unavailable' | 'stalled'
export type AutoContinueRefusal = 'disabled' | 'not_failed' | 'unknown_cause' | 'person_must_resolve' | 'already_continued' | 'repeated_failure' | 'not_auto_fixable'

const TRANSIENT: ReadonlySet<FailureKind> = new Set(['crash', 'timeout', 'tool_inactivity'])
/** How long an automatic continuation waits after a provider outage before it runs the step again. */
export const PROVIDER_OUTAGE_WAIT_MS = 2 * 60_000

/** Fingerprint of a failure: the same cause at the same step with the same words is the same failure. */
export function failureFingerprint(diagnosis: Pick<FailureDiagnosis, 'kind' | 'phase' | 'detail' | 'blocker'> | null): string | null {
  if (!diagnosis) return null
  return JSON.stringify([diagnosis.kind, diagnosis.phase ?? '', (diagnosis.detail ?? '').replace(/\d+/g, '#'), diagnosis.blocker?.reason ?? ''])
}

/**
 * Whether Specrails continues a run on its own. Bounded to one automatic
 * continuation per run chain; the person's Continue is always available.
 */
export function autoContinueVerdict(input: {
  enabled: boolean
  /** The run's final outcome. */
  outcome: string | null
  diagnosis: FailureDiagnosis | null
  /** The diagnosis of the attempt this one continued, when it is a continuation. */
  previous?: FailureDiagnosis | null
  /** Specrails already continued an attempt of this chain by itself. */
  chainAlreadyContinued: boolean
}): AutoContinueVerdict {
  const { diagnosis } = input
  if (!input.enabled) return { continue: false, reason: 'disabled' }
  // A stop the person chose, and the loop's own cost / iteration caps, are never undone automatically.
  if (input.outcome !== 'failed' && input.outcome !== 'blocked' && input.outcome !== 'stalled') return { continue: false, reason: 'not_failed' }
  if (!diagnosis || diagnosis.confidence !== 'high' || diagnosis.kind === 'unknown') return { continue: false, reason: 'unknown_cause' }
  const words = [diagnosis.detail, diagnosis.blocker?.reason, diagnosis.blocker?.requiredAction].filter(Boolean).join(' ')
  if (diagnosis.kind === 'provider_limit' || diagnosis.kind === 'spec_invalid' || PERSON_ONLY.test(words)) return { continue: false, reason: 'person_must_resolve' }
  if (input.chainAlreadyContinued) return { continue: false, reason: 'already_continued' }
  if (input.previous && failureFingerprint(input.previous) === failureFingerprint(diagnosis)) return { continue: false, reason: 'repeated_failure' }
  if (diagnosis.kind === 'incomplete_tasks') return { continue: true, reason: 'unfinished_tasks' }
  if (diagnosis.kind === 'environment') {
    // An unnamed or other kind of host blocker (network, scope, a variable) is the person's to resolve.
    return diagnosis.blocker && INSTALLABLE_BLOCKERS.has(diagnosis.blocker.kind) ? { continue: true, reason: 'missing_tool' } : { continue: false, reason: 'person_must_resolve' }
  }
  // The provider's service was down for a moment and Core already retried for about a minute:
  // continuing at once would meet the same outage (the night of 2026-11-19 it did, 15 s later).
  if (diagnosis.kind === 'provider_unavailable') return { continue: true, reason: 'provider_unavailable', delayMs: PROVIDER_OUTAGE_WAIT_MS }
  if (TRANSIENT.has(diagnosis.kind)) return { continue: true, reason: 'transient_error' }
  if (diagnosis.kind === 'blocked' && diagnosis.detail && STALLED.test(diagnosis.detail)) return { continue: true, reason: 'stalled' }
  return { continue: false, reason: 'not_auto_fixable' }
}
