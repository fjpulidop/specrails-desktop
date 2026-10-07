/**
 * Supervision policy for one Core session host (one per scope). Pure: the
 * runtime registry feeds it facts and a clock and executes the decisions.
 */
export type HostStatus = 'absent' | 'starting' | 'ready' | 'restarting' | 'degraded' | 'stopped'

export interface HostSupervisionPolicy {
  /** First restart delay; doubles per consecutive failure. */
  baseDelayMs: number
  maxDelayMs: number
  /** Failures within `failureWindowMs` that turn the scope degraded. */
  maxFailures: number
  failureWindowMs: number
}

export const DEFAULT_SUPERVISION: HostSupervisionPolicy = Object.freeze({
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  maxFailures: 5,
  failureWindowMs: 5 * 60_000,
})

export interface HostState {
  status: HostStatus
  /** Epoch-ms timestamps of recent unexpected exits or failed starts. */
  failures: number[]
}

export const INITIAL_HOST_STATE: HostState = Object.freeze({ status: 'absent', failures: [] })

export type HostDecision =
  | { action: 'start' }
  | { action: 'restart'; delayMs: number }
  | { action: 'degrade'; reason: string }
  | { action: 'none' }

const TRANSITIONS: Readonly<Record<HostStatus, readonly HostStatus[]>> = Object.freeze({
  absent: ['starting', 'stopped'],
  starting: ['ready', 'restarting', 'degraded', 'stopped'],
  ready: ['restarting', 'degraded', 'stopped'],
  restarting: ['starting', 'degraded', 'stopped'],
  degraded: ['starting', 'stopped'],
  stopped: [],
})

export function canTransition(from: HostStatus, to: HostStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to)
}

function transition(state: HostState, to: HostStatus, failures = state.failures): HostState {
  if (!canTransition(state.status, to)) throw new Error(`Session host: ${state.status} → ${to} is not allowed`)
  return { status: to, failures }
}

/** A session is needed in this scope. */
export function onDemand(state: HostState): { state: HostState; decision: HostDecision } {
  if (state.status === 'absent') return { state: transition(state, 'starting'), decision: { action: 'start' } }
  return { state, decision: { action: 'none' } }
}

export function onReady(state: HostState): HostState {
  return transition(state, 'ready')
}

/** The host exited unexpectedly or failed to start. */
export function onFailure(state: HostState, now: number, policy: HostSupervisionPolicy = DEFAULT_SUPERVISION): { state: HostState; decision: HostDecision } {
  if (state.status === 'stopped') return { state, decision: { action: 'none' } }
  const failures = [...state.failures.filter((at) => now - at < policy.failureWindowMs), now]
  if (failures.length >= policy.maxFailures) {
    return { state: transition(state, 'degraded', failures), decision: { action: 'degrade', reason: `${failures.length} host failures within ${Math.round(policy.failureWindowMs / 1000)}s` } }
  }
  const delayMs = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (failures.length - 1))
  return { state: transition(state, 'restarting', failures), decision: { action: 'restart', delayMs } }
}

/** A failure no restart can fix (e.g. another host owns the scope's journal): degrade at once. */
export function onFatal(state: HostState, reason: string): { state: HostState; decision: HostDecision } {
  if (state.status === 'stopped' || state.status === 'degraded') return { state, decision: { action: 'none' } }
  return { state: transition(state, 'degraded'), decision: { action: 'degrade', reason } }
}

/** The restart delay elapsed. */
export function onRestartDue(state: HostState): { state: HostState; decision: HostDecision } {
  if (state.status !== 'restarting') return { state, decision: { action: 'none' } }
  return { state: transition(state, 'starting'), decision: { action: 'start' } }
}

/** A user explicitly retries a degraded scope (e.g. after fixing Core). */
export function onRetry(state: HostState): { state: HostState; decision: HostDecision } {
  if (state.status !== 'degraded') return { state, decision: { action: 'none' } }
  return { state: transition(state, 'starting', []), decision: { action: 'start' } }
}

export function onStop(state: HostState): HostState {
  return state.status === 'stopped' ? state : transition(state, 'stopped')
}

/** Whether new turns in this scope should use Core sessions right now. */
export function acceptsSessions(state: HostState): boolean {
  return state.status !== 'degraded' && state.status !== 'stopped'
}
