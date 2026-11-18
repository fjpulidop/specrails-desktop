/**
 * Attempt chains, client model: a run continued from another is the next
 * attempt of one unit of work ("attempt 3 of #14"). Pure: reading the wire
 * shape of `GET /loop-runs/:id/attempts` defensively and the facts the run
 * window's lineage line says.
 */
import type { RunState } from '../../../components/ui/run-state/run-state'

export interface AttemptContinuation {
  remedy: 'continue' | 'continue-to-review' | string
  mode: 'fork' | 'resume'
  fromStep: string | null
  cause: string | null
  guidance: string | null
  automatic: boolean
  createdAt: string
}

export interface ChainAttempt {
  runId: string
  attempt: number
  status: string
  outcome: string | null
  startedAt: string
  finishedAt: string | null
  fromStep: string | null
  continuations: AttemptContinuation[]
}

export interface AttemptChain {
  runId: string
  attempt: number
  attempts: ChainAttempt[]
}

const text = (value: unknown, max = 200): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)

function readContinuation(raw: unknown): AttemptContinuation | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const remedy = text(v.remedy, 40)
  if (!remedy) return null
  return {
    remedy, mode: v.mode === 'resume' ? 'resume' : 'fork', fromStep: text(v.fromStep), cause: text(v.cause, 40),
    guidance: text(v.guidance, 8000), automatic: v.automatic === true, createdAt: text(v.createdAt, 40) ?? '',
  }
}

/** Defensive read of the wire chain; anything malformed is absent. A chain of one is no chain. */
export function readAttemptChain(raw: unknown): AttemptChain | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  const runId = text(v.runId, 128)
  if (!runId || !Array.isArray(v.attempts)) return null
  const attempts = v.attempts.flatMap((item): ChainAttempt[] => {
    if (!item || typeof item !== 'object') return []
    const a = item as Record<string, unknown>
    const id = text(a.runId, 128)
    if (!id || typeof a.attempt !== 'number' || !Number.isInteger(a.attempt) || a.attempt < 1) return []
    return [{
      runId: id, attempt: a.attempt, status: text(a.status, 20) ?? 'completed', outcome: text(a.outcome, 40), startedAt: text(a.startedAt, 40) ?? '',
      finishedAt: text(a.finishedAt, 40), fromStep: text(a.fromStep),
      continuations: (Array.isArray(a.continuations) ? a.continuations : []).map(readContinuation).filter((c): c is AttemptContinuation => !!c),
    }]
  }).sort((a, b) => a.attempt - b.attempt)
  const self = attempts.find((attempt) => attempt.runId === runId)
  if (attempts.length < 2 || !self) return null
  return { runId, attempt: self.attempt, attempts }
}

/** An attempt's lamp, in the one run-state vocabulary (same reading as a loop run's). */
export function attemptRunState(attempt: Pick<ChainAttempt, 'status' | 'outcome'>): RunState {
  if (attempt.status === 'running') return 'working'
  if (attempt.status === 'paused') return 'paused'
  switch (attempt.outcome) {
    case 'success': return 'done'
    case 'failed': return 'failed'
    case 'blocked': return 'blocked'
    case 'stalled': return 'paused'
    default: return 'stopped'
  }
}

/** What the lineage line says about this attempt. */
export function lineageFacts(chain: AttemptChain): {
  self: ChainAttempt
  previous: ChainAttempt | null
  latest: ChainAttempt
  /** How this attempt came to be (the fork that created it), when it was recorded. */
  origin: AttemptContinuation | null
  /** A later attempt took this one's work over. */
  supersededBy: ChainAttempt | null
} {
  const self = chain.attempts.find((attempt) => attempt.runId === chain.runId)!
  const previous = chain.attempts.find((attempt) => attempt.attempt === self.attempt - 1) ?? null
  const latest = chain.attempts[chain.attempts.length - 1]
  const origin = self.continuations.find((continuation) => continuation.mode === 'fork') ?? null
  return { self, previous, latest, origin, supersededBy: latest.runId === self.runId ? null : latest }
}
