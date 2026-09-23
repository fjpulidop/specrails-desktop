import { describe, expect, it } from 'vitest'
import { actionAllowed, isPrDecisionAction, type DeliveryDecisionState } from '..'

const review: DeliveryDecisionState = {
  decision: 'on_review', delivery_outcome: 'ready', implementation_outcome: 'succeeded',
  status_code: null, is_continuation: 0, pr_url: null, branch: 'feature',
}

describe('delivery action policy without Git or persistence', () => {
  it('keeps remote PRs authoritative over local acceptance', () => {
    expect(actionAllowed('merge-local', review)).toBe(true)
    expect(actionAllowed('merge-local', { ...review, pr_url: 'https://example.test/pr/1' })).toBe(false)
  })
  it('offers retry, but never publish or polling, for degraded drafts', () => {
    const draft = { ...review, decision: 'pr_draft' as const }
    expect(actionAllowed('create-pr', draft)).toBe(true)
    expect(actionAllowed('publish', draft)).toBe(false)
    expect(actionAllowed('poll-merge', draft)).toBe(false)
  })
  it('requires recoverable continuation evidence before recovery', () => {
    const recovery: DeliveryDecisionState = {
      ...review, decision: 'pr_failed', delivery_outcome: 'blocked',
      status_code: 'settlement_interrupted', is_continuation: 1, pr_url: 'https://example.test/pr/1',
    }
    expect(actionAllowed('recover-and-retry', recovery)).toBe(true)
    for (const patch of [{ branch: null }, { pr_url: null }, { is_continuation: 0 },
      { status_code: null }, { implementation_outcome: 'failed' as const }]) {
      expect(actionAllowed('recover-and-retry', { ...recovery, ...patch })).toBe(false)
    }
  })
  it('rejects unrecognized external actions', () => {
    for (const value of [null, {}, 'checkout', 'merge', 1]) expect(isPrDecisionAction(value)).toBe(false)
    expect(isPrDecisionAction('create-pr')).toBe(true)
  })
})
