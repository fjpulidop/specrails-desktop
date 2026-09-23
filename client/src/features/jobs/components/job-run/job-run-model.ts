import { useEffect, useReducer, useRef } from 'react'
import { ARG_ACTIONS, deriveFrameActivity } from '../../../browser/lib/frame-activity'
import { parseJobTimestamp } from '../../lib/job-time'
import type { EventRow, JobSummary } from '../../../../types'

// ─── Pure model behind JobRunHeader ──────────────────────────────────────────
//
// Extracted from the former JobStatusPanel so BOTH job surfaces (the routed
// Job Detail page and the mission-mode JobDetailModal) derive their header from
// ONE source. Honest-metrics contract: everything here is either a real clock
// reading, a count of observed frames, or a figure the provider actually
// reported — never an estimate.

/** Wall-clock elapsed between the job start and `finishedAt` (ISO string or a
 *  `Date.now()` reading for the live ticker). `—` when either side is unknown. */
export function formatWallClock(startedAt: string | null | undefined, finishedAt: string | number | null | undefined): string {
  const start = parseJobTimestamp(startedAt ?? null)
  const endMs = typeof finishedAt === 'number'
    ? finishedAt
    : (parseJobTimestamp(finishedAt ?? null)?.getTime() ?? Number.NaN)
  const ms = endMs - (start?.getTime() ?? Number.NaN)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  if (mins < 60) return `${mins}m ${s}s`
  const hrs = Math.floor(mins / 60)
  const m = mins % 60
  return `${hrs}h ${m}m`
}

/** Files the log claims to have written/edited (best-effort regex over `log`
 *  frames, capped at 20). Terminal-only decoration. */
export function extractModifiedFiles(events: EventRow[]): string[] {
  const files = new Set<string>()
  for (const ev of events) {
    if (ev.event_type !== 'log') continue
    try {
      const payload = JSON.parse(ev.payload) as { line?: string }
      const line = payload.line ?? ''
      const match = line.match(/(?:Writing|Editing|Created?|Updated?)\s+(?:file:\s*)?([\w./\-]+\.\w+)/i)
      if (match) files.add(match[1])
    } catch {
      // skip unparseable events
    }
  }
  return Array.from(files).slice(0, 20)
}

// ─── Incremental activity aggregator ─────────────────────────────────────────

export interface ActivityState {
  /** Concrete observed actions (tool calls / text turns) — the "pasos" counter. */
  steps: number
  actionKey: string
  actionArg: string
  /** Assistant frames that carried a real `usage` object. Only these count as
   *  reported turns; frames without usage are still steps but never a turn. */
  turns: number
  /** Sum of the provider-reported usage on those frames (input + output +
   *  cache read + cache create). 0 until the stream reports any. */
  tokens: number
  lastSeenIdx: number
}

export const INITIAL_ACTIVITY: ActivityState = { steps: 0, actionKey: '', actionArg: '', turns: 0, tokens: 0, lastSeenIdx: 0 }

export type ActivityAction = { type: 'reset' } | { type: 'consume'; events: EventRow[] }

function readUsage(ev: EventRow): number | null {
  if (ev.event_type !== 'assistant') return null
  try {
    const parsed = JSON.parse(ev.payload) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const message = (parsed as { message?: unknown }).message
    const holder = message && typeof message === 'object' && !Array.isArray(message) ? message : parsed
    const usage = (holder as { usage?: unknown }).usage
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null
    const u = usage as Record<string, unknown>
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return n(u.input_tokens) + n(u.output_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens)
  } catch {
    return null
  }
}

export function activityReducer(state: ActivityState, action: ActivityAction): ActivityState {
  if (action.type === 'reset') return INITIAL_ACTIVITY
  if (action.type === 'consume') {
    const { events } = action
    // Re-anchor when the surface front-truncates events[] (the 10000→8000
    // cap reindexes the array). A stale absolute lastSeenIdx would otherwise
    // permanently freeze the counters and the action label.
    const start = state.lastSeenIdx > events.length ? events.length : state.lastSeenIdx
    if (events.length <= start) {
      return start === state.lastSeenIdx ? state : { ...state, lastSeenIdx: start }
    }
    let { steps, actionKey, actionArg, turns, tokens } = state
    for (let i = start; i < events.length; i++) {
      const d = deriveFrameActivity(events[i])
      if (d.step) steps += d.stepCount ?? 1
      if (d.actionKey) {
        actionKey = d.actionKey
        actionArg = d.actionArg ?? ''
      }
      const usage = readUsage(events[i])
      if (usage != null) {
        turns += 1
        tokens += usage
      }
    }
    return { steps, actionKey, actionArg, turns, tokens, lastSeenIdx: events.length }
  }
  return state
}

/** Incremental accumulator over the streamed events; resets when the job id
 *  changes so a route reuse never carries the previous job's counters. */
export function useJobActivity(jobId: string, events: EventRow[]): ActivityState {
  const [activity, dispatch] = useReducer(activityReducer, INITIAL_ACTIVITY)
  const lastJobIdRef = useRef<string>(jobId)
  useEffect(() => {
    if (lastJobIdRef.current !== jobId) {
      lastJobIdRef.current = jobId
      dispatch({ type: 'reset' })
    }
    dispatch({ type: 'consume', events })
  }, [jobId, events])
  return activity
}

/** Which i18n key (under `jobs:statusPanel.activity`) describes the current
 *  action, and whether it carries an argument. */
export function resolveActivityLabel(activity: ActivityState, isRunning: boolean): { key: string; arg: string | null } {
  const effectiveKey = isRunning && activity.steps === 0 ? 'connecting' : activity.actionKey || 'thinking'
  const argActions = effectiveKey === 'delegating' || ARG_ACTIONS.has(effectiveKey)
  const hasArg = argActions && activity.actionArg !== ''
  // An ARG action with an empty arg (e.g. Bash with no command) would render a
  // dangling "Running: " / "Searching “”"; fall back to the no-arg "working".
  const key = argActions && !hasArg ? 'working' : effectiveKey
  return { key, arg: hasArg ? activity.actionArg : null }
}

// ─── Authoritative (exit-time) figures ───────────────────────────────────────

export interface FinalMetrics {
  /** `$0.0123` / `~$0.0123` (estimated) — null when the provider reported none. */
  cost: string | null
  turns: string | null
  tokens: string | null
}

export function formatTokens(total: number): string {
  return `${(total / 1000).toFixed(1)}k`
}

export function finalMetricsFor(job: JobSummary): FinalMetrics {
  const costEstimated = !!job.total_cost_usd_estimated
  const cost = job.total_cost_usd != null ? `${costEstimated ? '~' : ''}$${job.total_cost_usd.toFixed(4)}` : null
  const turns = job.num_turns != null ? String(job.num_turns) : null
  const tokensTotal = job.tokens_in != null
    ? (job.tokens_in ?? 0) + (job.tokens_out ?? 0) + (job.tokens_cache_read ?? 0) + (job.tokens_cache_create ?? 0)
    : null
  return { cost, turns, tokens: tokensTotal != null ? formatTokens(tokensTotal) : null }
}

// ─── Pipeline totals (sibling jobs of a multi-phase pipeline) ────────────────

export interface PipelineTotals {
  totalCostUsd: number
  /** True when at least one phase reports a null cost — the sum is a lower
   *  bound, rendered with a "≥" prefix + a partial hint (HIGH-10). */
  hasNullCost?: boolean
  /** True when at least one phase's cost is a pricing-table estimate. */
  costEstimated?: boolean
  nullCostCount?: number
  /** True when no phase has any cost telemetry. */
  costUnavailable?: boolean
  totalTokensIn: number
  totalTokensOut: number
  totalTokensCacheRead: number
  totalTokensCacheCreate: number
  nullTokenCount?: number
  tokensUnavailable?: boolean
  jobCount: number
}

export function computePipelineTotals(pipelineJobs: JobSummary[]): PipelineTotals | null {
  if (pipelineJobs.length <= 1) return null
  const noTokens = (j: JobSummary) =>
    j.tokens_in == null && j.tokens_out == null && j.tokens_cache_read == null && j.tokens_cache_create == null
  return {
    totalCostUsd: pipelineJobs.reduce((s, j) => s + (j.total_cost_usd ?? 0), 0),
    hasNullCost: pipelineJobs.some((j) => j.total_cost_usd == null),
    costEstimated: pipelineJobs.some((j) => !!j.total_cost_usd_estimated),
    nullCostCount: pipelineJobs.filter((j) => j.total_cost_usd == null).length,
    costUnavailable: pipelineJobs.every((j) => j.total_cost_usd == null),
    totalTokensIn: pipelineJobs.reduce((s, j) => s + (j.tokens_in ?? 0), 0),
    totalTokensOut: pipelineJobs.reduce((s, j) => s + (j.tokens_out ?? 0), 0),
    totalTokensCacheRead: pipelineJobs.reduce((s, j) => s + (j.tokens_cache_read ?? 0), 0),
    totalTokensCacheCreate: pipelineJobs.reduce((s, j) => s + (j.tokens_cache_create ?? 0), 0),
    nullTokenCount: pipelineJobs.filter(noTokens).length,
    tokensUnavailable: pipelineJobs.every(noTokens),
    jobCount: pipelineJobs.length,
  }
}

export function formatPipelineCost(p: PipelineTotals): string {
  if (p.costUnavailable) return '—'
  return `${p.costEstimated ? '~' : ''}${p.hasNullCost ? '≥' : ''}$${p.totalCostUsd.toFixed(4)}`
}

export function formatPipelineTokens(p: PipelineTotals): string {
  if (p.tokensUnavailable) return '—'
  const total = p.totalTokensIn + p.totalTokensOut + p.totalTokensCacheRead + p.totalTokensCacheCreate
  return `${(p.nullTokenCount ?? 0) > 0 ? '≥' : ''}${formatTokens(total)}`
}

// ─── Details disclosure memory (per surface) ─────────────────────────────────

export const JOB_RUN_DETAILS_KEY = 'specrails-desktop:job-run-details'
export type JobRunSurface = 'page' | 'glass'

export function loadJobRunDetailsOpen(surface: JobRunSurface): boolean {
  try {
    const raw = localStorage.getItem(JOB_RUN_DETAILS_KEY)
    if (!raw) return false
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return parsed?.[surface] === true
  } catch {
    return false
  }
}

export function saveJobRunDetailsOpen(surface: JobRunSurface, open: boolean): void {
  try {
    const raw = localStorage.getItem(JOB_RUN_DETAILS_KEY)
    let parsed: Record<string, unknown> = {}
    if (raw) {
      try { const p = JSON.parse(raw); if (p && typeof p === 'object') parsed = p } catch { /* reset */ }
    }
    parsed[surface] = open
    localStorage.setItem(JOB_RUN_DETAILS_KEY, JSON.stringify(parsed))
  } catch {
    /* storage unavailable — the session-local choice still applies */
  }
}
