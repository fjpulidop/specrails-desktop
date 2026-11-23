/**
 * Pure judgments over one AI step's prompt and result: review-continuation
 * context, LOOP_BLOCKED / ask-to-proceed detection, zero-work and resume-miss
 * classification, plus the step-detail caps and the fail-fast threshold.
 */
import { isZeroWorkSettle, UNKNOWN_COMMAND_RE } from '../../execution/runtime/interactive-job-session'
import type { LoopSpec } from './loop-graph'
import type { AiStepResult } from './loop-run-contract'

const IMPLEMENT_CMD_TOKEN_RE = /\{\{\s*cmd:(?:implement|batch)\s*\}\}/
const IMPLEMENT_CMD_TEXT_RE = /(?:^|\s)(?:\/(?:specrails:|sr:)?(?:implement|batch-implement)|\$(?:implement|batch-implement))\b/
const LOOP_BLOCKED_LINE_RE = /(?:^|\n)\s*LOOP_BLOCKED:\s*(.+?)(?:\n|$)/i
const HUMAN_PROCEED_QUESTION_RE = /(?:^|\n)\s*(?:\*\*)?How would you like to proceed\??/i
const HUMAN_PROCEED_NO_WORK_RE = /\b(?:no code has changed|I haven't launched any agents|I have not launched any agents|not a fresh feature to build|would duplicate work|sync first|treat this as)\b/i

export function withReviewContinuationContext(base: string, rawTemplate: string, spec?: LoopSpec): string {
  if (spec?.status !== 'on_review') return base
  if (!IMPLEMENT_CMD_TOKEN_RE.test(rawTemplate) && !IMPLEMENT_CMD_TEXT_RE.test(rawTemplate) && !IMPLEMENT_CMD_TEXT_RE.test(base)) return base
  return [
    base,
    '',
    '---',
    'Specrails rail continuation context:',
    '- This ticket is already on_review and this run is fully unattended; the user has already chosen to continue implementation work.',
    '- If the current branch has an existing open PR, or the feature appears already implemented, do NOT pause to ask whether to proceed and do NOT restart from scratch.',
    '- Treat the run as review follow-ups on the current PR/worktree: inspect the ticket description, PR context, current branch, and working diff; implement only the missing requested deltas.',
    '- If the local branch is ahead/behind its remote, do not stop for confirmation. Continue safely on the current worktree; only pull/rebase when it is clearly safe and necessary.',
    '- If truly no code change is needed, state that clearly and leave the tree unchanged; otherwise make the smallest correct change and let the following verify step prove it.',
  ].join('\n')
}

export function aiStepBlockedReason(text: string): string | null {
  const explicit = LOOP_BLOCKED_LINE_RE.exec(text)
  if (explicit?.[1]?.trim()) return explicit[1].trim()
  if (HUMAN_PROCEED_QUESTION_RE.test(text) && HUMAN_PROCEED_NO_WORK_RE.test(text)) {
    return 'The AI step asked how to proceed instead of performing unattended work.'
  }
  return null
}

/** The interactive step's timeout failure reason (matched by isResumeMiss). */
export const AI_STEP_TIMEOUT_ERROR = 'AI step timed out'

/** Whole-step zero-work judgment. The interactive path reports it
 *  authoritatively (`zeroWork` set at session settle); the one-shot path is
 *  derived from the result's accumulated signals — one-shot `text` accumulates
 *  ONLY from assistant text-delta events, so non-empty text ⇒ assistant events
 *  were seen. A hard-failed one-shot (non-zero exit) is a crash, not zero-work. */
export function aiStepZeroWork(res: AiStepResult): boolean {
  if (res.zeroWork !== undefined) return res.zeroWork
  if (res.failed) return false
  return isZeroWorkSettle({
    numTurns: res.numTurns ?? 0,
    tokensIn: res.tokensIn ?? 0,
    tokensOut: res.tokensOut ?? 0,
    tokensCacheRead: res.tokensCacheRead ?? 0,
    tokensCacheCreate: res.tokensCacheCreate ?? 0,
    sawAssistantEvent: res.text.trim().length > 0,
    resultText: res.text.trim() ? res.text : null,
  })
}

/** A RESUMED step whose settle is zero-work for a reason other than an
 *  unresolvable command or the step timeout: the CLI answered with session
 *  bookkeeping (no model call — a transcript the resume could not load, a
 *  session torn down mid-flight) and the prompt never ran. Worth exactly one
 *  fresh retry; an `Unknown command:` would fail again identically. */
export function isResumeMiss(res: AiStepResult): boolean {
  if (res.stalled) return false
  if (!aiStepZeroWork(res)) return false
  if (UNKNOWN_COMMAND_RE.test(res.text.trim())) return false
  if (res.errorText === AI_STEP_TIMEOUT_ERROR) return false
  return true
}

/** Caps for the `loop_step` detail fields (`template` / `command`) — the
 *  payload persists per event, so a runaway prompt must not bloat the events
 *  table. Head-only cut with an ellipsis (unlike `truncate` there is no
 *  trailing verdict to preserve here — the opening of a prompt is the signal). */
export const STEP_TEMPLATE_CAP = 1000
export const STEP_COMMAND_CAP = 2000
export function capText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}
/** Abort the run after this many CONSECUTIVE AI steps hard-fail with no output.
 *  One failure can be transient; N in a row means the provider isn't running at
 *  all (quota, auth, crash) — bail instead of grinding to the iteration cap. */
export const AI_FAILFAST_THRESHOLD = 2
