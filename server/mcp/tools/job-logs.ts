import { logLinesFromEvents } from '../../modules/recovery'

/**
 * Bounded, failure-focused job log for MCP clients (`specrails_jobs(logs)`).
 * Pure: splits a job's persisted events into steps (a `loop_step` opens one,
 * its `loop_step_end` closes it), finds the failed step and returns its lines
 * first, then the end of the log, within a line and character budget. Lines
 * come from the recovery module's `logLinesFromEvents`, the same reading the
 * AI failure analysis uses.
 */

interface EventLike { event_type: string; payload: string | null }

export interface LogStep {
  index: number | null
  title: string
  status: string | null
  lines: string[]
}

export interface FocusedLog {
  totalLines: number
  failedStep: { index: number | null; title: string; status: string | null; lines: string[]; omittedLines: number } | null
  tail: string[]
  omittedLines: number
  truncated: boolean
}

export const DEFAULT_LOG_LINES = 200
export const MAX_LOG_LINES = 1000
const MAX_CHARS = 40_000
const FAILED = new Set(['failed', 'error', 'interrupted', 'timeout', 'timed_out'])

function parse(payload: string | null): Record<string, unknown> {
  try { const value = JSON.parse(payload ?? '{}'); return value && typeof value === 'object' ? value as Record<string, unknown> : {} } catch { return {} }
}

/** Steps in order; lines before the first step land in a leading untitled step. */
export function splitSteps(events: readonly EventLike[]): LogStep[] {
  const steps: LogStep[] = []
  let current: LogStep = { index: null, title: '(before the first step)', status: null, lines: [] }
  for (const event of events) {
    if (event.event_type === 'loop_step') {
      if (current.lines.length || current.index !== null) steps.push(current)
      const payload = parse(event.payload)
      current = {
        index: typeof payload.index === 'number' ? payload.index : null,
        title: typeof payload.title === 'string' && payload.title ? payload.title : `step ${String(payload.index ?? steps.length + 1)}`,
        status: 'running',
        lines: [],
      }
    }
    const lines = logLinesFromEvents([event])
    current.lines.push(...lines)
    if (event.event_type === 'loop_step_end') {
      const payload = parse(event.payload)
      if (typeof payload.status === 'string') current.status = payload.status
    }
  }
  if (current.lines.length || current.index !== null) steps.push(current)
  return steps
}

/** The failed step: the last step that ended failed, or the step named by the diagnosis/analysis. */
export function findFailedStep(steps: readonly LogStep[], hint?: string | null): LogStep | null {
  const named = hint ? [...steps].reverse().find((step) => step.title === hint || step.title.endsWith(`/${hint}`)) : undefined
  if (named) return named
  return [...steps].reverse().find((step) => step.status !== null && FAILED.has(step.status)) ?? null
}

function takeLast(lines: readonly string[], maxLines: number, maxChars: number): string[] {
  const out: string[] = []
  let size = 0
  for (let index = lines.length - 1; index >= 0 && out.length < maxLines; index--) {
    size += lines[index].length + 1
    if (size > maxChars) break
    out.unshift(lines[index])
  }
  return out
}

/**
 * Failed step lines first (up to the whole budget when the job failed), then the
 * tail of everything after that step, in the budget that remains.
 */
export function focusedLog(events: readonly EventLike[], options: { limit?: number; failedStepHint?: string | null; failed?: boolean } = {}): FocusedLog {
  const limit = Math.min(MAX_LOG_LINES, Math.max(1, Math.floor(options.limit ?? DEFAULT_LOG_LINES)))
  const steps = splitSteps(events)
  const all = steps.flatMap((step) => step.lines)
  const failed = options.failed === false ? null : findFailedStep(steps, options.failedStepHint)
  let failedStep: FocusedLog['failedStep'] = null
  let remainingLines = limit
  let remainingChars = MAX_CHARS
  if (failed) {
    // Keep at least a fifth of the budget for the very end of the log.
    const share = steps[steps.length - 1] === failed ? limit : Math.max(1, Math.ceil(limit * 0.8))
    const lines = takeLast(failed.lines, share, Math.floor(MAX_CHARS * 0.8))
    failedStep = { index: failed.index, title: failed.title, status: failed.status, lines, omittedLines: failed.lines.length - lines.length }
    remainingLines -= lines.length
    remainingChars -= lines.reduce((sum, line) => sum + line.length + 1, 0)
  }
  const after = failed ? steps.slice(steps.indexOf(failed) + 1).flatMap((step) => step.lines) : all
  const tail = remainingLines > 0 ? takeLast(after, remainingLines, Math.max(0, remainingChars)) : []
  const shown = (failedStep?.lines.length ?? 0) + tail.length
  return { totalLines: all.length, failedStep, tail, omittedLines: Math.max(0, all.length - shown), truncated: shown < all.length }
}
