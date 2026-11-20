/**
 * Why a loop run that still owns its job row is not working right now.
 *
 * A Core run that stops without settling (an app restart, an interrupted write,
 * a provider usage limit, the budget, a question) keeps `jobs.status='running'`
 * on purpose: the row still owns the run's tickets, worktree and delivery. Every
 * surface that shows the job therefore reads this derived hold instead of the
 * raw row, so a stopped run reads as stopped, with its reason, everywhere.
 *
 * `deriveRunHold` is pure; `readRunHolds` reads the facts from SQLite and the
 * live manager for a page of jobs.
 */
import type { DbInstance } from '../../../db'
import { readRetainedBudgetPause } from './loop-budget-pauses'
import { readLimitPause } from './loop-limit-pauses'
import type { LoopLimitPause } from './loop-run-contract'

export const RUN_HOLD_KINDS = ['restart', 'interrupted', 'provider_limit', 'budget', 'question', 'approval', 'paused', 'queued'] as const
export type RunHoldKind = typeof RUN_HOLD_KINDS[number]

export interface RunHold {
  kind: RunHoldKind
  /** The workflow step that was working when the run stopped (`developer`); null when unknown. */
  step: string | null
  /** When the run stopped doing anything (ISO), the last thing it recorded; null when unknown. */
  since: string | null
  /** `provider_limit`: when the provider accepts requests again (ISO), if it said. */
  resumeAt?: string | null
  /** `queued`: what the run waits for before it starts (capacity `WaitingFor`). */
  waitingFor?: string
  /** `queued`: 1 = next to start. */
  position?: number
}

/** What the live manager knows about a run it holds parked in this process. */
export interface LiveRunPause {
  budget: boolean
  limit: LoopLimitPause | null
  pending: Array<{ kind?: unknown }>
}

export interface RunHoldFacts {
  /** `loop_runs.status`; null when the job has no loop run. */
  loopStatus: string | null
  restartReason: string | null
  /** `loop_runs.runtime_status_json`, parsed (Core's last checkpoint). */
  checkpoint: Record<string, unknown> | null
  /** A usage-limit record retained over a restart (`queue_state`). */
  retainedLimit: LoopLimitPause | null
  /** The run was parked at its budget when a restart retained it (`queue_state`). */
  retainedBudget?: boolean
  /** The manager's parked pause in this process; null when nothing is parked. */
  live: LiveRunPause | null
  /** The run was active when this process started and startup recovery has not reconciled it yet. */
  restartPending: boolean
  /** The last event the job recorded (ISO). */
  lastActivityAt: string | null
  /** The run waits for a machine run slot in this process (capacity admission). */
  queued?: { waitingFor: string; since: string; position: number } | null
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

function interruptKinds(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(item => record(item) && typeof item.kind === 'string' ? [item.kind] : []) : []
}

/** The step Core was working on: the first interrupted write, else its next step. */
function stoppedStep(checkpoint: Record<string, unknown> | null): string | null {
  if (!checkpoint) return null
  const steps = Array.isArray(checkpoint.recoverableSteps) ? checkpoint.recoverableSteps : []
  for (const step of steps) if (record(step) && typeof step.nodePath === 'string' && step.nodePath) return step.nodePath
  for (const interrupt of Array.isArray(checkpoint.pendingInterrupts) ? checkpoint.pendingInterrupts : []) {
    if (record(interrupt) && typeof interrupt.nodePath === 'string' && interrupt.nodePath) return interrupt.nodePath
  }
  return typeof checkpoint.nextStep === 'string' && checkpoint.nextStep ? checkpoint.nextStep : null
}

/** A person-facing pause from interrupt kinds; host tasks are the host's work, not a hold. */
function interruptHold(kinds: string[]): RunHoldKind | null {
  if (kinds.includes('question')) return 'question'
  if (kinds.includes('approval') || kinds.includes('gate')) return 'approval'
  return null
}

/**
 * Null while the run genuinely works (or when it is not a loop run). Order:
 * what the live process parked, then what a retained (restart-surviving) pause
 * recorded, then a run startup recovery has not reached yet.
 */
export function deriveRunHold(facts: RunHoldFacts): RunHold | null {
  const step = stoppedStep(facts.checkpoint)
  const at = (kind: RunHoldKind, since: string | null = facts.lastActivityAt, extra: Partial<RunHold> = {}): RunHold => ({ kind, step, since, ...extra })
  if (facts.queued && facts.loopStatus === 'running') return at('queued', facts.queued.since, { waitingFor: facts.queued.waitingFor, position: facts.queued.position })
  if (facts.live) {
    if (facts.live.limit) return at('provider_limit', facts.live.limit.pausedAt, { resumeAt: facts.live.limit.resumeAt })
    if (facts.live.budget) return at('budget')
    return at(interruptHold(interruptKinds(facts.live.pending)) ?? 'question')
  }
  if (facts.loopStatus === 'paused') {
    if (facts.retainedLimit) return at('provider_limit', facts.retainedLimit.pausedAt, { resumeAt: facts.retainedLimit.resumeAt })
    if (facts.restartReason === 'budget_paused' || facts.retainedBudget) return at('budget')
    const asked = interruptHold(interruptKinds(facts.checkpoint?.pendingInterrupts))
    if (asked) return at(asked)
    if (facts.restartReason === 'restart') return at('restart')
    const core = [facts.checkpoint?.status, facts.checkpoint?.coreStatus]
    if (core.includes('interrupted')) return at('interrupted')
    return at('paused')
  }
  if (facts.loopStatus === 'running' && facts.restartPending) return at('restart')
  return null
}

/** `2026-11-19 14:51:45` (SQLite UTC) → ISO; ISO passes through. */
function isoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

export interface RunHoldSources {
  /** The manager's parked pause for a run, or null (`LoopRunManager`). */
  livePause?: (runId: string) => LiveRunPause | null
  /** Runs active at startup that recovery has not reconciled yet. */
  restartPending?: ReadonlySet<string>
  /** Why a launched run has not started yet (`LoopRunManager.queuedFor`). */
  queued?: (runId: string) => RunHoldFacts['queued']
}

/** What the project's live loop engine and startup recovery know about held runs. */
export function runHoldSources(c: { loopRunManager?: { isPaused?(id: string): boolean; budgetPause?(id: string): unknown; limitPause?(id: string): LiveRunPause['limit']; pendingInterrupts?(id: string): Array<{ kind?: unknown }>; queuedFor?(id: string): RunHoldFacts['queued'] }; restartPendingRunIds?: ReadonlySet<string> }): RunHoldSources {
  const manager = c.loopRunManager
  return {
    livePause: (runId) => manager?.isPaused?.(runId)
      ? { budget: !!manager.budgetPause?.(runId), limit: manager.limitPause?.(runId) ?? null, pending: manager.pendingInterrupts?.(runId) ?? [] }
      : null,
    restartPending: c.restartPendingRunIds,
    queued: (runId) => manager?.queuedFor?.(runId) ?? null,
  }
}

interface HoldRow { id: string; status: string; restart_reason: string | null; runtime_status_json: string | null; last_event_at: string | null }

/**
 * Holds of the given jobs that the job row says are running. Jobs without a
 * loop run, and loop runs that genuinely work, are absent from the map.
 */
export function readRunHolds(db: DbInstance, jobIds: readonly string[], sources: RunHoldSources = {}): Map<string, RunHold> {
  const holds = new Map<string, RunHold>()
  const ids = [...new Set(jobIds)]
  for (let offset = 0; offset < ids.length; offset += 200) {
    const chunk = ids.slice(offset, offset + 200)
    const rows = db.prepare(`
      SELECT r.id, r.status, r.restart_reason, r.runtime_status_json,
             (SELECT MAX(e.timestamp) FROM events e WHERE e.job_id = r.id) AS last_event_at
        FROM loop_runs r
       WHERE r.id IN (${chunk.map(() => '?').join(',')}) AND r.status IN ('running', 'paused')
    `).all(...chunk) as HoldRow[]
    for (const row of rows) {
      let checkpoint: Record<string, unknown> | null = null
      try { const parsed: unknown = row.runtime_status_json ? JSON.parse(row.runtime_status_json) : null; checkpoint = record(parsed) ? parsed : null } catch { checkpoint = null }
      let live: LiveRunPause | null = null
      try { live = sources.livePause?.(row.id) ?? null } catch { live = null }
      const hold = deriveRunHold({
        loopStatus: row.status, restartReason: row.restart_reason, checkpoint,
        retainedLimit: row.status === 'paused' && !live ? readLimitPause(db, row.id) : null,
        retainedBudget: row.status === 'paused' && !live ? readRetainedBudgetPause(db, row.id) : false,
        live, restartPending: sources.restartPending?.has(row.id) ?? false, lastActivityAt: isoTimestamp(row.last_event_at),
        queued: (() => { try { return sources.queued?.(row.id) ?? null } catch { return null } })(),
      })
      if (hold) holds.set(row.id, hold)
    }
  }
  return holds
}

/** `readRunHolds` for one job. */
export function readRunHold(db: DbInstance, jobId: string, sources: RunHoldSources = {}): RunHold | null {
  return readRunHolds(db, [jobId], sources).get(jobId) ?? null
}
