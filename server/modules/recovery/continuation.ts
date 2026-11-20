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
import { EXTERNAL_STOP, type FailureDiagnosis, type FailureKind } from './domain'

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

export function continuationGuidance(diagnosis: Pick<FailureDiagnosis, 'kind' | 'confidence' | 'detail' | 'blocker' | 'port' | 'incompleteTasks'> | null, evidence: { completionReasons?: readonly unknown[] | null; envFilesCopied?: readonly string[] | null; flakyTests?: readonly string[] | null } = {}): string | null {
  if (!diagnosis || diagnosis.confidence !== 'high') return null
  const cause = causeGuidance(diagnosis, evidence)
  // Tests the record shows to be flaky: the next agent turn (the fixer, after a correction budget) makes them deterministic.
  const flaky = evidence.flakyTests?.length ? flakyTestsGuidance(evidence.flakyTests) : null
  return cause && flaky ? `${cause}\n\n${flaky}` : cause ?? flaky
}

const FLAKY_LIMIT = 12

/** The instruction for tests that pass and fail on the same code: make them deterministic, never tune the clock. */
export function flakyTestsGuidance(tests: readonly string[]): string {
  return [
    'These tests look flaky in the recorded verification output (they passed on earlier rounds or on the same code and fail on timing, or the runner reported them flaky):',
    ...tests.slice(0, FLAKY_LIMIT).map((test) => `- ${test.slice(0, 240)}`),
    'Make them deterministic: find the race (a process, page or debugger still attached, an event awaited after it fired, shared state between tests) and wait for an explicit signal or isolate the process. Do not lengthen timeouts, add retries or sleeps, and do not skip or delete them.',
  ].join('\n')
}

/** What the person chose when continuing: one of the AI analysis' options, or their own instruction. */
export type ResolutionChoice =
  | { kind: 'continue-with-guidance' | 'mark-human-check'; label: string; does?: string | null; guidance: string }
  | { kind: 'instruction'; text: string }

const CHOICE_TEXT = 4_000

/** The operator instruction a person's chosen resolution adds to Continue (null when it adds nothing). */
export function resolutionGuidance(choice: ResolutionChoice | null | undefined): string | null {
  if (!choice) return null
  const bounded = (value: string) => (value.length > CHOICE_TEXT ? `${value.slice(0, CHOICE_TEXT)}…` : value)
  if (choice.kind === 'instruction') {
    const text = choice.text.trim()
    return text ? `The person continued this run with their own instruction. Follow it; where it conflicts with earlier guidance, it wins:\n${bounded(text)}` : null
  }
  const guidance = choice.guidance.trim()
  const header = `The person chose how to resolve the failure: "${choice.label.slice(0, 200)}".${choice.does ? ` ${choice.does.slice(0, 400)}` : ''}`
  if (choice.kind === 'mark-human-check') return [
    header,
    guidance ? `Which checks: ${bounded(guidance)}` : null,
    'Move these checks from host verification to the person: for each one add a task `- [ ] N.M [human] <what the person checks by hand after delivery>` to tasks.md (a [human] task is the person\'s check, never required to be ticked), and keep the automated test out of the host verification command (skip it with a comment that names the [human] task, or exclude it in the test configuration). Do not delete the test and keep every other check as it is.',
  ].filter((line): line is string => !!line).join('\n')
  return guidance ? `${header}\nWhat to do: ${bounded(guidance)}\nVerify it against the code; the reviewer's findings stay authoritative.` : `${header}\nGo on with the same approach.`
}

function causeGuidance(diagnosis: Pick<FailureDiagnosis, 'kind' | 'confidence' | 'detail' | 'blocker' | 'port' | 'incompleteTasks'>, evidence: { completionReasons?: readonly unknown[] | null; envFilesCopied?: readonly string[] | null }): string | null {
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
        // The person turned on the project's env-file copy for this Continue.
        evidence.envFilesCopied?.length ? `Specrails copied the project's environment files into this worktree: ${evidence.envFilesCopied.join(', ')}. Use them as they are: do not recreate them from an example, never print their values, and never commit them.` : null,
        // A machine-wide install is the person's: they were asked, and continuing means they ran it.
        blocker?.install ? `The person was asked to run \`${blocker.install}\` themselves. Check that it is available now; never install it machine-wide yourself, and if it is still missing return the structured blocker with the same install.` : INSTALL_RULE,
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

/** Review finding ids (`[capability/requirement]`) a stop's detail names. */
function findingIds(detail: string | null | undefined): string[] {
  return [...(detail ?? '').matchAll(/\[([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\]/g)].map((match) => match[1])
}

/** One attempt's stop as the repeat rules read it: its diagnosis and the tests its latest verification failed. */
export interface AttemptStop {
  diagnosis: Pick<FailureDiagnosis, 'kind' | 'phase' | 'detail' | 'blocker'> | null
  failingTests?: readonly string[] | null
}

/** The checks a stop names: the failing tests of its latest verification and the review findings it cites. */
export function stopChecks(stop: AttemptStop): string[] {
  return [...new Set([...(stop.failingTests ?? []), ...findingIds(stop.diagnosis?.detail)])].sort()
}

/** Two stops have the same cause: the same kind at the same step, with the same words or the same failing checks. */
export function sameCause(a: AttemptStop, b: AttemptStop): boolean {
  if (!a.diagnosis || !b.diagnosis || a.diagnosis.kind === 'unknown' || a.diagnosis.kind !== b.diagnosis.kind || (a.diagnosis.phase ?? '') !== (b.diagnosis.phase ?? '')) return false
  if (failureFingerprint(a.diagnosis) === failureFingerprint(b.diagnosis)) return true
  const checksA = stopChecks(a), checksB = stopChecks(b)
  return checksA.length > 0 && checksA.length === checksB.length && checksA.every((check, index) => check === checksB[index])
}

/** Kinds whose own budget ran out; three such stops in a row at one step are a loop even when the findings change. */
const BUDGET_KINDS: ReadonlySet<FailureKind> = new Set(['blocked'])

/**
 * Whether the latest attempts of a chain keep stopping for the same cause (oldest first, ending with
 * the attempt being read): two consecutive attempts with the same cause, or three in a row whose
 * correction / attempt budget ran out at the same step. `times` is how many trailing attempts that is.
 */
export function repeatedStop(stops: readonly AttemptStop[]): { repeated: boolean; times: number } {
  let same = 1
  for (let index = stops.length - 1; index > 0 && sameCause(stops[index - 1], stops[index]); index--) same++
  if (same >= 2) return { repeated: true, times: same }
  const last = stops[stops.length - 1]?.diagnosis
  let budget = 0
  if (last && BUDGET_KINDS.has(last.kind)) {
    for (let index = stops.length - 1; index >= 0; index--) {
      const diagnosis = stops[index].diagnosis
      if (!diagnosis || diagnosis.kind !== last.kind || (diagnosis.phase ?? '') !== (last.phase ?? '')) break
      budget++
    }
  }
  return budget >= 3 ? { repeated: true, times: budget } : { repeated: false, times: 1 }
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
  /** The chain's latest attempts keep stopping for the same cause (`repeatedStop`). */
  repeated?: boolean
}): AutoContinueVerdict {
  const { diagnosis } = input
  if (!input.enabled) return { continue: false, reason: 'disabled' }
  // A stop the person chose, and the loop's own cost / iteration caps, are never undone automatically.
  if (input.outcome !== 'failed' && input.outcome !== 'blocked' && input.outcome !== 'stalled') return { continue: false, reason: 'not_failed' }
  if (!diagnosis || diagnosis.confidence !== 'high' || diagnosis.kind === 'unknown') return { continue: false, reason: 'unknown_cause' }
  const words = [diagnosis.detail, diagnosis.blocker?.reason, diagnosis.blocker?.requiredAction].filter(Boolean).join(' ')
  if (diagnosis.kind === 'provider_limit' || diagnosis.kind === 'spec_invalid' || PERSON_ONLY.test(words)) return { continue: false, reason: 'person_must_resolve' }
  if (input.chainAlreadyContinued) return { continue: false, reason: 'already_continued' }
  // Someone outside the app stopped the process on purpose: Continue is theirs to press.
  if (diagnosis.detail && EXTERNAL_STOP.test(diagnosis.detail)) return { continue: false, reason: 'not_auto_fixable' }
  if (input.repeated || (input.previous && failureFingerprint(input.previous) === failureFingerprint(diagnosis))) return { continue: false, reason: 'repeated_failure' }
  if (diagnosis.kind === 'incomplete_tasks') return { continue: true, reason: 'unfinished_tasks' }
  if (diagnosis.kind === 'environment') {
    // An unnamed or other kind of host blocker (network, scope, a variable) is the person's to resolve.
    // A machine-wide install the person was asked for and kept for themselves (or the host may not run) is theirs too.
    return diagnosis.blocker && INSTALLABLE_BLOCKERS.has(diagnosis.blocker.kind) && !diagnosis.blocker.install ? { continue: true, reason: 'missing_tool' } : { continue: false, reason: 'person_must_resolve' }
  }
  // The provider's service was down for a moment and Core already retried for about a minute:
  // continuing at once would meet the same outage (the night of 2026-11-19 it did, 15 s later).
  if (diagnosis.kind === 'provider_unavailable') return { continue: true, reason: 'provider_unavailable', delayMs: PROVIDER_OUTAGE_WAIT_MS }
  if (TRANSIENT.has(diagnosis.kind)) return { continue: true, reason: 'transient_error' }
  if (diagnosis.kind === 'blocked' && diagnosis.detail && STALLED.test(diagnosis.detail)) return { continue: true, reason: 'stalled' }
  return { continue: false, reason: 'not_auto_fixable' }
}
