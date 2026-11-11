import { describe, expect, it } from 'vitest'
import { actionAllowed, ciFixAllowed, isPrDecisionAction, type DeliveryDecisionState } from '..'

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

describe('ciFixAllowed (pr-ci-loop)', () => {
  const base = { decision: 'pr_draft' as const, delivery_outcome: 'ready' as const, implementation_outcome: 'succeeded' as const, status_code: null, is_continuation: 0,
    pr_url: 'https://github.com/acme/app/pull/7', branch: 'feature', operation: null, multiRepository: false }
  it('allows an attached draft or ready PR with no operation in flight', () => {
    expect(ciFixAllowed(base)).toBe(true)
    expect(ciFixAllowed({ ...base, decision: 'pr_ready' })).toBe(true)
  })
  it.each([
    ['building', { decision: 'building' as const }],
    ['on review (no PR yet)', { decision: 'on_review' as const }],
    ['merged', { decision: 'merged' as const }],
    ['closed', { decision: 'pr_closed' as const }],
    ['no PR url', { pr_url: null }],
    ['no branch', { branch: null }],
    ['an operation in flight', { operation: 'create-pr' }],
    ['a multi-repository delivery', { multiRepository: true }],
  ])('refuses %s', (_label, over) => {
    expect(ciFixAllowed({ ...base, ...over } as Parameters<typeof ciFixAllowed>[0])).toBe(false)
  })
})
