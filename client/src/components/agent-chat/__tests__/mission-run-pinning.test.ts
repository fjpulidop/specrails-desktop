import { describe, it, expect } from 'vitest'
import { derivePrCards, isPrEnvelopePinned, isPrDecisionPinned } from '../agent-pr-pinning'
import type { AgentMessage, AgentPrDecisionEnvelope } from '../../../lib/agent-api'

const env = (over: Partial<AgentPrDecisionEnvelope> = {}): AgentPrDecisionEnvelope => ({
  kind: 'pr_decision', prDeliveryId: 'd1', railIndex: 0, projectId: 'p1', baseBranch: 'main', ticketIds: [1],
  decision: 'completed', prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: ['r1'], ...over,
})
const row = (id: string, over: Partial<AgentPrDecisionEnvelope> = {}): AgentMessage => ({ id, conversation_id: 'c1', role: 'system', content: JSON.stringify(env(over)), created_at: '' })
const failure = { status: 'failed' as const, currentStep: null, canResume: true, recoverableSteps: [], pendingApproval: false, failure: { code: 'implementation_failed', detail: 'x', stepId: null }, at: '' }

describe('isPrEnvelopePinned (mission-rail-cards)', () => {
  it('keeps the legacy decision set', () => {
    expect(isPrEnvelopePinned(env({ decision: 'on_review' }))).toBe(isPrDecisionPinned('on_review'))
    expect(isPrEnvelopePinned(env({ decision: 'completed' }))).toBe(false)
    expect(isPrEnvelopePinned(env({ decision: 'merged' }))).toBe(false)
  })
  it('pins launched/running phases and unacknowledged failures', () => {
    expect(isPrEnvelopePinned(env({ decision: 'completed', phase: 'launched' }))).toBe(true)
    expect(isPrEnvelopePinned(env({ decision: 'completed', phase: 'running' }))).toBe(true)
    expect(isPrEnvelopePinned(env({ decision: 'completed', phase: 'settled' }))).toBe(false)
    expect(isPrEnvelopePinned(env({ decision: 'completed', hasDelivery: false, runtime: failure }))).toBe(true)
    expect(isPrEnvelopePinned(env({ decision: 'discarded', runtime: failure }))).toBe(false)
    expect(isPrEnvelopePinned(env({ decision: 'superseded', runtime: failure }))).toBe(false)
  })
  it('derivePrCards uses the envelope-aware rule', () => {
    const derived = derivePrCards([
      row('a', { prDeliveryId: 'run:r1', decision: 'completed', hasDelivery: false, runtime: failure }),
      row('b', { prDeliveryId: 'd2', railIndex: 1, decision: 'completed' }),
      row('c', { prDeliveryId: 'd3', railIndex: 2, decision: 'completed', phase: 'running' }),
    ])
    expect(derived.pinned.map((p) => p.messageId)).toEqual(['a', 'c'])
    expect(derived.byMessageId.get('a')?.runtime?.failure?.code).toBe('implementation_failed')
  })
})
