import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setAgentChatManager } from './agent-chat-registry'
import type { AgentChatManager } from './agent-chat-manager'
import {
  buildRunCardEnvelope, failureForLoopOutcome, runtimeFromSummary, runCardId, isRunCardId,
  postRunCard, settleRunCard, notifyMissionRunFailure,
} from './mission-run-notify'
import type { RuntimeRunSummary } from '../../agent-runtime/runtime/agent-runtime-controls'

const id = { projectId: 'p1', runId: 'run-1', railIndex: 2, railName: 'Auth', ticketIds: [3, 4] }

function fakeManager() {
  const postPrDecisionCard = vi.fn()
  const updatePrDecisionCard = vi.fn()
  const postRunFailureRow = vi.fn().mockReturnValue('row-1')
  const startSystemTurn = vi.fn().mockResolvedValue('started')
  setAgentChatManager({ postPrDecisionCard, updatePrDecisionCard, postRunFailureRow, startSystemTurn } as unknown as AgentChatManager)
  return { postPrDecisionCard, updatePrDecisionCard, postRunFailureRow, startSystemTurn }
}

beforeEach(() => { delete process.env.SPECRAILS_MISSION_RAIL_CARDS })
afterEach(() => { setAgentChatManager(null); delete process.env.SPECRAILS_MISSION_RAIL_CARDS })

describe('run card envelope (shared-cwd launches)', () => {
  it('builds a delivery-less envelope keyed on the run id', () => {
    const env = buildRunCardEnvelope(id, { phase: 'running', decision: 'building' })
    expect(env).toMatchObject({
      kind: 'pr_decision', prDeliveryId: 'run:run-1', hasDelivery: false, phase: 'running', decision: 'building',
      implementationOutcome: 'running', deliveryOutcome: 'not_started', railIndex: 2, railName: 'Auth', ticketIds: [3, 4], runIds: ['run-1'], prState: 'none', baseBranch: '',
    })
    expect(env.units).toEqual([{ ticketId: 3, branch: '', succeeded: false, runId: 'run-1' }, { ticketId: 4, branch: '', succeeded: false, runId: 'run-1' }])
    expect(buildRunCardEnvelope(id, { phase: 'settled', decision: 'completed' })).toMatchObject({ implementationOutcome: 'succeeded', statusCode: null, units: [expect.objectContaining({ succeeded: true }), expect.anything()] })
    expect(buildRunCardEnvelope(id, { phase: 'settled', decision: 'implementation_failed', statusDetail: 'boom' })).toMatchObject({ implementationOutcome: 'failed', statusCode: 'implementation_failed', statusDetail: 'boom' })
    expect(buildRunCardEnvelope(id, { phase: 'settled', decision: 'discarded' })).toMatchObject({ implementationOutcome: 'unknown', statusCode: 'cancelled' })
    expect(runCardId('x')).toBe('run:x')
    expect(isRunCardId('run:x')).toBe(true)
    expect(isRunCardId('abc')).toBe(false)
  })

  it('maps loop outcomes to failures', () => {
    expect(failureForLoopOutcome('success')).toBeNull()
    expect(failureForLoopOutcome('failed', 'provider_limit')).toEqual({ code: 'provider_limit', detail: null, stepId: null })
    expect(failureForLoopOutcome('stalled', 'idle_timeout')).toEqual({ code: 'stalled', detail: 'reason: idle_timeout', stepId: null })
    expect(failureForLoopOutcome('stopped')).toEqual({ code: 'cancelled', detail: null, stepId: null })
    expect(failureForLoopOutcome('blocked', 'needs-approval')).toEqual({ code: 'blocked', detail: 'needs-approval', stepId: null })
    expect(failureForLoopOutcome('failed', null, 'crash')).toEqual({ code: 'implementation_failed', detail: 'crash', stepId: null })
  })

  it('derives the runtime snapshot from a summary (live data wins) or from the failure alone', () => {
    const summary = { runId: 'run-1', status: 'interrupted', nextStep: 'verify', active: false, canResume: true, canCancel: false, recoverableSteps: ['developer'], pendingApproval: { stepId: 'reviewer' } } as RuntimeRunSummary
    const rt = runtimeFromSummary(summary, { code: 'implementation_failed', detail: null, stepId: null })
    expect(rt).toMatchObject({ status: 'failed', currentStep: 'verify', canResume: true, recoverableSteps: ['developer'], pendingApproval: true, failure: { code: 'implementation_failed', stepId: 'reviewer' } })
    expect(runtimeFromSummary({ ...summary, active: true }, null).status).toBe('running')
    expect(runtimeFromSummary({ ...summary, status: 'succeeded' }, null).status).toBe('succeeded')
    expect(runtimeFromSummary({ ...summary, status: 'cancelled' }, null).status).toBe('cancelled')
    expect(runtimeFromSummary(null, { code: 'stalled', detail: null, stepId: null })).toMatchObject({ status: 'stalled', canResume: false, recoverableSteps: [], pendingApproval: false })
    expect(runtimeFromSummary(null, { code: 'cancelled', detail: null, stepId: null }).status).toBe('cancelled')
    expect(runtimeFromSummary(null, null).status).toBe('unknown')
    expect(runtimeFromSummary({ ...summary, status: 'failed', nextStep: 'archive', pendingApproval: undefined, error: 'OpenSpec aborted: missing Purpose' },
      { code: 'implementation_failed', detail: 'Resume in Settings', stepId: null })).toMatchObject({
      failure: { stepId: 'archive', detail: 'OpenSpec aborted: missing Purpose' },
    })
  })
})

describe('postRunCard / settleRunCard', () => {
  it('posts at launch and updates at settle for a tagged run; no-op without origin, manager or flag', () => {
    const m = fakeManager()
    postRunCard('conv-1', id)
    expect(m.postPrDecisionCard).toHaveBeenCalledWith('conv-1', expect.objectContaining({ prDeliveryId: 'run:run-1', decision: 'building', hasDelivery: false }))
    settleRunCard('conv-1', id, 'success')
    expect(m.updatePrDecisionCard).toHaveBeenLastCalledWith('conv-1', expect.objectContaining({ decision: 'completed', phase: 'settled', runtime: expect.objectContaining({ status: 'succeeded' }) }))
    settleRunCard('conv-1', id, 'stopped')
    expect(m.updatePrDecisionCard).toHaveBeenLastCalledWith('conv-1', expect.objectContaining({ decision: 'discarded' }))
    postRunCard(null, id)
    settleRunCard(undefined, id, 'success')
    expect(m.postPrDecisionCard).toHaveBeenCalledTimes(1)
    expect(m.updatePrDecisionCard).toHaveBeenCalledTimes(2)
    process.env.SPECRAILS_MISSION_RAIL_CARDS = 'false'
    postRunCard('conv-1', id)
    expect(m.postPrDecisionCard).toHaveBeenCalledTimes(1)
    delete process.env.SPECRAILS_MISSION_RAIL_CARDS
    setAgentChatManager(null)
    expect(() => postRunCard('conv-1', id)).not.toThrow()
  })

  it('never throws when the manager throws', () => {
    setAgentChatManager({ postPrDecisionCard: () => { throw new Error('x') }, updatePrDecisionCard: () => { throw new Error('x') } } as unknown as AgentChatManager)
    expect(() => postRunCard('c', id)).not.toThrow()
    expect(() => settleRunCard('c', id, 'success')).not.toThrow()
  })
})

describe('notifyMissionRunFailure', () => {
  it('updates the card with the failure as text, posts the row and starts ONE briefing turn', async () => {
    const m = fakeManager()
    const r = await notifyMissionRunFailure({ ...id, originConversationId: 'conv-1', failure: { code: 'stalled', detail: 'idle 30m', stepId: null }, hasDelivery: false, tickets: [{ id: 3, title: 'Login' }] })
    expect(r).toEqual({ card: true, row: 'row-1', turn: 'started' })
    expect(m.updatePrDecisionCard).toHaveBeenCalledWith('conv-1', expect.objectContaining({
      prDeliveryId: 'run:run-1', decision: 'implementation_failed', phase: 'settled', hasDelivery: false, statusDetail: 'idle 30m',
      runtime: expect.objectContaining({ status: 'stalled', failure: { code: 'stalled', detail: 'idle 30m', stepId: null } }),
    }))
    expect(m.postRunFailureRow).toHaveBeenCalledWith('conv-1', expect.objectContaining({ kind: 'run-failure', runId: 'run-1', railIndex: 2, projectId: 'p1', prDeliveryId: 'run:run-1', ticketIds: [3, 4], code: 'stalled', detail: 'idle 30m' }))
    const [conv, briefing, opts] = m.startSystemTurn.mock.calls[0]
    expect(conv).toBe('conv-1')
    expect(briefing).toContain('Rail 3 (Auth) · run run-1 stopped: the run stalled')
    expect(briefing).toContain('#3 — Login, #4')
    expect(briefing).toContain('no git isolation')
    expect(opts).toMatchObject({ runId: 'run-1', ref: { kind: 'system-briefing', id: 'run-1', metadata: { railIndex: 2, code: 'stalled' } } })
  })

  it('passes a delivery envelope through, enriching it with the runtime snapshot', async () => {
    const m = fakeManager()
    const envelope = buildRunCardEnvelope(id, { phase: 'settled', decision: 'implementation_failed' })
    const summary = { runId: 'run-1', status: 'failed', nextStep: null, active: false, canResume: true, canCancel: false, recoverableSteps: ['verify'], pendingQuestion: { stepId: 'a', requestedAt: '', question: 'Which?' } } as RuntimeRunSummary
    const r = await notifyMissionRunFailure({ ...id, originConversationId: 'conv-1', failure: { code: 'implementation_failed', detail: 'tests red', stepId: 'verify' }, envelope: { ...envelope, hasDelivery: true, prDeliveryId: 'd1' }, summary, hasDelivery: true, prDeliveryId: 'd1' })
    expect(r.turn).toBe('started')
    expect(m.updatePrDecisionCard).toHaveBeenCalledWith('conv-1', expect.objectContaining({ prDeliveryId: 'd1', runtime: expect.objectContaining({ canResume: true, recoverableSteps: ['verify'], failure: expect.objectContaining({ stepId: 'verify' }) }) }))
    expect(m.postRunFailureRow.mock.calls[0][1]).toMatchObject({ prDeliveryId: 'd1', stepId: 'verify' })
    expect(m.startSystemTurn.mock.calls[0][1]).toContain('Delivery id: d1.')
    expect(m.startSystemTurn.mock.calls[0][1]).toContain('waiting for an answer: "Which?"')
    expect(m.startSystemTurn.mock.calls[0][1]).toContain('Recover & retry the interrupted step(s): verify')
  })

  it('a building envelope keeps the running phase', async () => {
    const m = fakeManager()
    const envelope = buildRunCardEnvelope(id, { phase: 'running', decision: 'building' })
    await notifyMissionRunFailure({ ...id, originConversationId: 'conv-1', failure: { code: 'stuck', detail: null, stepId: null }, envelope })
    expect(m.updatePrDecisionCard.mock.calls[0][1]).toMatchObject({ phase: 'running', runtime: { failure: { code: 'stuck' } } })
  })

  it('a cancelled run updates the card + row but never starts a turn', async () => {
    const m = fakeManager()
    const r = await notifyMissionRunFailure({ ...id, originConversationId: 'conv-1', failure: { code: 'cancelled', detail: null, stepId: null } })
    expect(r).toEqual({ card: true, row: 'row-1', turn: 'skipped' })
    expect(m.updatePrDecisionCard.mock.calls[0][1]).toMatchObject({ decision: 'discarded' })
    expect(m.startSystemTurn).not.toHaveBeenCalled()
  })

  it('is a no-op without an origin, without a manager, or with the feature off', async () => {
    const m = fakeManager()
    expect(await notifyMissionRunFailure({ ...id, originConversationId: null, failure: { code: 'x', detail: null, stepId: null } })).toEqual({ card: false, row: null, turn: 'skipped' })
    process.env.SPECRAILS_MISSION_RAIL_CARDS = 'false'
    expect(await notifyMissionRunFailure({ ...id, originConversationId: 'conv-1', failure: { code: 'x', detail: null, stepId: null } })).toEqual({ card: false, row: null, turn: 'skipped' })
    delete process.env.SPECRAILS_MISSION_RAIL_CARDS
    setAgentChatManager(null)
    expect(await notifyMissionRunFailure({ ...id, originConversationId: 'conv-1', failure: { code: 'x', detail: null, stepId: null } })).toEqual({ card: false, row: null, turn: 'skipped' })
    expect(m.updatePrDecisionCard).not.toHaveBeenCalled()
  })

  it('reports a failed card update honestly and still posts the row', async () => {
    const m = fakeManager()
    m.updatePrDecisionCard.mockImplementation(() => { throw new Error('db gone') })
    m.postRunFailureRow.mockReturnValue(null)
    m.startSystemTurn.mockResolvedValue('skipped')
    const r = await notifyMissionRunFailure({ ...id, originConversationId: 'conv-1', failure: { code: 'implementation_failed', detail: null, stepId: null } })
    expect(r).toEqual({ card: false, row: null, turn: 'skipped' })
  })
})
