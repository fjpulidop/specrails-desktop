import { describe, expect, it } from 'vitest'

import { DEFAULT_SUPERVISION, INITIAL_HOST_STATE, acceptsSessions, canTransition, onDemand, onFailure, onReady, onRestartDue, onRetry, onStop } from '../domain/host-state'
import { initialProjection, liveSubagentCount, reduceEnvelope, type ProjectionOp, type ProjectionState } from '../domain/projection'
import { KNOWN_EVENT_TYPES, checkSessionContract, type SessionEvent, type Usage } from '../domain/protocol'
import { resolveSubagentPolicy } from '../domain/subagent-policy'

const usage = (costUsd: number | null): Usage => ({ inputTokens: null, outputTokens: 10, cacheReadTokens: null, cacheWriteTokens: null, totalTokens: null, costUsd, costEstimated: false, model: 'm' })
const at = '2026-10-07T10:00:00.000Z'

function run(events: Array<Omit<SessionEvent, 'at'>>, from: ProjectionState = initialProjection('s1')) {
  let state = from
  const ops: ProjectionOp[] = []
  events.forEach((event, index) => {
    const result = reduceEnvelope(state, { sessionId: 's1', seq: state.lastSeq + 1, event: { ...event, at } as SessionEvent })
    if (result.status !== 'applied') throw new Error(`unexpected ${result.status} at ${index}`)
    state = result.state
    ops.push(...result.ops)
  })
  return { state, ops }
}

/** Shape of Core's recorded Claude background run (claude-bg-complete). */
const backgroundRun: Array<Omit<SessionEvent, 'at'>> = [
  { type: 'session.opened', driver: 'claude', model: 'haiku', resumed: false, providerSessionRef: null },
  { type: 'input.accepted', inputId: 'u1', delivery: 'queue', text: 'go' },
  { type: 'session.process', state: 'started', generation: 1 },
  { type: 'input.state', inputId: 'u1', state: 'started' },
  { type: 'session.phase', phase: 'turn' },
  { type: 'turn.started', turnId: 't1', origin: 'user', inputIds: ['u1'] },
  { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', agentType: 'general-purpose', description: 'Run bash' },
  { type: 'turn.output', turnId: 't1', channel: 'text', delta: 'LAUNCHED' },
  { type: 'turn.completed', turnId: 't1', status: 'completed', text: 'LAUNCHED', usage: usage(0.027) },
  { type: 'input.state', inputId: 'u1', state: 'completed', turnId: 't1' },
  { type: 'session.phase', phase: 'background' },
  { type: 'subagents.settled', settled: false, live: 1 },
  { type: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
  { type: 'session.phase', phase: 'turn' },
  { type: 'turn.started', turnId: 't2', origin: 'subagent', inputIds: [], trigger: { subagentIds: ['a1'] } },
  { type: 'turn.completed', turnId: 't2', status: 'completed', text: 'waiting', usage: usage(0.041) },
  { type: 'subagent.started', subagentId: 'a1', parentId: null, kind: 'background', description: 'Run bash' },
  { type: 'subagent.output', subagentId: 'a1', channel: 'text', delta: 'SUBDONE' },
  { type: 'subagent.result', subagentId: 'a1', summary: 'SUBDONE' },
  { type: 'subagent.phase', subagentId: 'a1', phase: 'idle' },
  { type: 'subagents.settled', settled: true, live: 0 },
  { type: 'session.phase', phase: 'idle' },
]

describe('surface-neutral projection', () => {
  it('turns a background run into turns, continuation turns and one re-entrant sub-agent', () => {
    const { state, ops } = run(backgroundRun)
    expect(ops.filter((op) => op.kind === 'turn.opened').map((op) => op.kind === 'turn.opened' && [op.origin, op.triggeredBy])).toEqual([['user', []], ['subagent', ['a1']]])
    const closed = ops.filter((op): op is Extract<ProjectionOp, { kind: 'turn.closed' }> => op.kind === 'turn.closed')
    expect(closed.map((op) => [op.origin, op.text, op.usage.costUsd])).toEqual([['user', 'LAUNCHED', 0.027], ['subagent', 'waiting', 0.041]])
    expect(state.subagents.a1).toMatchObject({ phase: 'idle', restarts: 1, resultSummary: 'SUBDONE', launchedInTurnId: 't1' })
    expect(ops.filter((op) => op.kind === 'input.state').map((op) => op.kind === 'input.state' && op.state)).toEqual(['accepted', 'started', 'completed'])
    expect(state).toMatchObject({ phase: 'idle', liveSubagents: 0, processAlive: true, openTurn: null })
    expect(liveSubagentCount(state)).toBe(0)
  })

  it('ignores duplicates, reports gaps and skips unknown event types from newer Cores', () => {
    const { state } = run(backgroundRun.slice(0, 3))
    expect(reduceEnvelope(state, { sessionId: 's1', seq: 2, event: { type: 'session.phase', phase: 'turn', at } }).status).toBe('duplicate')
    expect(reduceEnvelope(state, { sessionId: 's1', seq: 9, event: { type: 'session.phase', phase: 'turn', at } })).toMatchObject({ status: 'gap', expected: 4 })
    const future = reduceEnvelope(state, { sessionId: 's1', seq: 4, event: { type: 'session.hologram', at } as unknown as SessionEvent })
    expect(future).toMatchObject({ status: 'applied', ops: [] })
    expect(future.state.lastSeq).toBe(4)
    expect(() => reduceEnvelope(state, { sessionId: 'other', seq: 4, event: { type: 'session.phase', phase: 'turn', at } })).toThrow()
  })

  it('surfaces warnings and truncation as notices, never info diagnostics', () => {
    const { ops } = run([
      { type: 'provider.diagnostic', level: 'info', code: 'provider_version', message: '2.1' },
      { type: 'provider.diagnostic', level: 'warning', code: 'illegal_transition', message: 'x' },
      { type: 'output.truncated', scope: { turnId: 't' }, droppedEvents: 2, droppedBytes: 10 },
    ])
    expect(ops.map((op) => op.kind === 'notice' && op.code)).toEqual(['illegal_transition', 'output_truncated'])
  })
})

describe('session contract check', () => {
  const block = { version: 1, protocolVersions: [1], capability: 'sessions', cliOperation: 'host', eventTypes: [...KNOWN_EVENT_TYPES] }

  it('accepts the contract Core publishes and tolerates newer event types', () => {
    expect(checkSessionContract(block)).toEqual({ compatible: true, protocolVersion: 1, unknownEventTypes: [], missingEventTypes: [], reasons: [] })
    expect(checkSessionContract({ ...block, protocolVersions: [1, 2], eventTypes: [...KNOWN_EVENT_TYPES, 'session.new'] })).toMatchObject({ compatible: true, protocolVersion: 1, unknownEventTypes: ['session.new'] })
  })

  it('rejects missing blocks, protocol mismatches and dropped event types', () => {
    expect(checkSessionContract(undefined).compatible).toBe(false)
    expect(checkSessionContract({ ...block, protocolVersions: [2] })).toMatchObject({ compatible: false, protocolVersion: null })
    expect(checkSessionContract({ ...block, eventTypes: KNOWN_EVENT_TYPES.filter((type) => type !== 'turn.completed') })).toMatchObject({ compatible: false, missingEventTypes: ['turn.completed'] })
    expect(checkSessionContract({ ...block, cliOperation: 'serve' }).compatible).toBe(false)
  })
})

describe('host supervision policy', () => {
  it('starts on demand and becomes ready', () => {
    const demanded = onDemand(INITIAL_HOST_STATE)
    expect(demanded.decision).toEqual({ action: 'start' })
    expect(onDemand(demanded.state).decision).toEqual({ action: 'none' })
    expect(onReady(demanded.state).status).toBe('ready')
  })

  it('restarts with exponential backoff and degrades after repeated failures in the window', () => {
    let state = onReady(onDemand(INITIAL_HOST_STATE).state)
    const delays: number[] = []
    for (let index = 0; index < DEFAULT_SUPERVISION.maxFailures - 1; index++) {
      const failed = onFailure(state, 1_000 * index)
      expect(failed.decision.action).toBe('restart')
      if (failed.decision.action === 'restart') delays.push(failed.decision.delayMs)
      state = onReady(onRestartDue(failed.state).state)
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000])
    const degraded = onFailure(state, 10_000)
    expect(degraded.decision.action).toBe('degrade')
    expect(acceptsSessions(degraded.state)).toBe(false)
    const retried = onRetry(degraded.state)
    expect(retried).toMatchObject({ decision: { action: 'start' }, state: { status: 'starting', failures: [] } })
  })

  it('forgets failures outside the window and caps the delay', () => {
    const state = { status: 'ready' as const, failures: [0, 1, 2, 3] }
    const later = onFailure(state, DEFAULT_SUPERVISION.failureWindowMs + 10)
    expect(later.decision).toEqual({ action: 'restart', delayMs: 500 })
    const capped = onFailure({ status: 'ready', failures: [] }, 0, { ...DEFAULT_SUPERVISION, baseDelayMs: 40_000 })
    expect(capped.decision).toEqual({ action: 'restart', delayMs: DEFAULT_SUPERVISION.maxDelayMs })
  })

  it('stops terminally and rejects illegal transitions', () => {
    const stopped = onStop(onReady(onDemand(INITIAL_HOST_STATE).state))
    expect(stopped.status).toBe('stopped')
    expect(onFailure(stopped, 0).decision).toEqual({ action: 'none' })
    expect(canTransition('stopped', 'starting')).toBe(false)
    expect(() => onReady(INITIAL_HOST_STATE)).toThrow(/absent → ready/)
  })
})

describe('Core sessions availability', () => {
  it('parses the rollout flag with a safe default', async () => {
    const { parseCoreSessionsFlag } = await import('../domain/availability')
    expect([undefined, '', 'nonsense', 'off', '0', 'false'].map((value) => parseCoreSessionsFlag(value))).toEqual(['off', 'off', 'off', 'off', 'off', 'off'])
    expect([' AUTO ', 'on', '1', 'true'].map((value) => parseCoreSessionsFlag(value))).toEqual(['auto', 'on', 'on', 'on'])
  })

  it('enables sessions only when allowed, advertised and contract-compatible', async () => {
    const { resolveCoreSessionsAvailability } = await import('../domain/availability')
    expect(resolveCoreSessionsAvailability('off', { sessions: 1 }).enabled).toBe(false)
    expect(resolveCoreSessionsAvailability('auto', { engineV2: 1 })).toMatchObject({ enabled: false, reason: expect.stringContaining('does not advertise') })
    expect(resolveCoreSessionsAvailability('on', null).enabled).toBe(false)
    expect(resolveCoreSessionsAvailability('auto', { sessions: 1 }, false)).toMatchObject({ enabled: false, reason: expect.stringContaining('not compatible') })
    expect(resolveCoreSessionsAvailability('auto', { sessions: 1 })).toEqual({ enabled: true, flag: 'auto', reason: 'Core sessions available' })
  })
})

describe('sub-agent policy resolution', () => {
  it.each([
    [false, true, 'disabled'],
    [true, false, 'enabled'],
    [null, true, 'enabled'],
    [null, false, 'disabled'],
  ] as const)('project %s, global %s → %s', (projectAllows, globalAllows, expected) => {
    for (const surface of ['mission', 'explore', 'refinement'] as const) {
      expect(resolveSubagentPolicy({ surface, projectAllows, globalAllows })).toBe(expected)
    }
  })
})

