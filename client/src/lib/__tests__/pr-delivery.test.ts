import { describe, expect, it } from 'vitest'
import { coerceRailPrStateSnapshot, derivePrDeliveryPresentation, isInterruptedPrDeliveryOperation } from '../pr-delivery'

describe('PR delivery semantic derivation', () => {
  it('never converts a successful implementation into an implementation failure when delivery is blocked', () => {
    const result = derivePrDeliveryPresentation({
      decision: 'implementation_failed',
      ticketIds: [1],
      prUrl: null,
      prState: 'local-only',
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'blocked',
      statusCode: 'commit_failed',
    })
    expect(result.implementationFailed).toBe(false)
    expect(result.deliveryBlocked).toBe(true)
    expect(result.localOnly).toBe(true)
  })

  it('derives no-change, partial counts, and retryable push independently', () => {
    const partial = derivePrDeliveryPresentation({
      decision: 'on_review', ticketIds: [1, 2], prUrl: null, prState: 'none',
      units: [
        { ticketId: 1, branch: 'feat/1', succeeded: true, implementationOutcome: 'succeeded', deliveryOutcome: 'ready', initialSha: null, finalSha: 'abc' },
        { ticketId: 2, branch: 'feat/2', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null },
      ],
    })
    expect(partial).toMatchObject({ partial: true, succeededCount: 1, failedCount: 1, totalCount: 2 })

    const undeliverable = derivePrDeliveryPresentation({
      decision: 'pr_failed', ticketIds: [1, 2], prUrl: null, prState: 'local-only',
      implementationOutcome: 'partially_succeeded', deliveryOutcome: 'partial',
      units: [
        { ticketId: 1, branch: 'feat/1', succeeded: false, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', initialSha: null, finalSha: null },
        { ticketId: 2, branch: 'feat/2', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null },
      ],
    })
    expect(undeliverable).toMatchObject({ partial: true, partialUndeliverable: true, deliverableCount: 0, deliveryBlocked: true })

    const noChanges = derivePrDeliveryPresentation({
      decision: 'completed', ticketIds: [1], prUrl: null, prState: 'none', deliveryOutcome: 'no_changes',
    })
    expect(noChanges.noChanges).toBe(true)
    expect(noChanges.terminal).toBe(true)

    const retryable = derivePrDeliveryPresentation({
      decision: 'pr_failed', ticketIds: [1], prUrl: null, prState: 'local-only',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', statusCode: 'push_failed',
    })
    expect(retryable).toMatchObject({ retryablePush: true, implementationFailed: false, deliveryBlocked: false })
  })

  it('keeps retryable PR creation separate from blocked delivery and push retry', () => {
    const result = derivePrDeliveryPresentation({
      decision: 'pr_draft',
      ticketIds: [1],
      prUrl: null,
      prState: 'pushed',
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'retryable_failure',
      statusCode: 'delivery_failed',
    })

    expect(result).toMatchObject({
      deliveryBlocked: false,
      retryablePush: false,
      retryablePrCreation: true,
    })
  })

  it('prioritizes a retryable partial PR creation over zero currently deliverable units', () => {
    const result = derivePrDeliveryPresentation({
      decision: 'pr_failed',
      ticketIds: [1, 2],
      prUrl: null,
      prState: 'local-only',
      implementationOutcome: 'partially_succeeded',
      deliveryOutcome: 'retryable_failure',
      statusCode: 'delivery_failed',
      units: [
        { ticketId: 1, branch: 'feat/1', succeeded: false, implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure', initialSha: null, finalSha: 'abc' },
        { ticketId: 2, branch: 'feat/2', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', initialSha: null, finalSha: null },
      ],
    })

    expect(result).toMatchObject({
      partial: true,
      partialUndeliverable: true,
      deliveryBlocked: false,
      retryablePrCreation: true,
    })
  })
})

describe('authoritative PR snapshot coercion', () => {
  it('recognizes stable and legacy restart-interrupted action evidence', () => {
    expect(isInterruptedPrDeliveryOperation('operation_interrupted', null)).toBe(true)
    expect(isInterruptedPrDeliveryOperation(
      'ready_for_review',
      'A previous delivery action was interrupted by restart. Its durable evidence was preserved; review the current state and retry.',
    )).toBe(true)
    expect(isInterruptedPrDeliveryOperation('ready_for_review', 'ordinary detail')).toBe(false)
  })

  it('accepts server id/branches aliases and preserves all durable outcome evidence', () => {
    expect(coerceRailPrStateSnapshot({
      id: 'delivery-1', railIndex: 2, decision: 'pr_failed', ticketIds: [8], baseBranch: 'main',
      prState: 'local-only', implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'branch_verification_failed', statusDetail: 'head moved', isContinuation: true,
      operation: 'publish',
      cleanupWarnings: ['worktree retained'],
      branches: [{
        ticketId: 8, runId: 'run-8', branch: 'feat/8', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', initialSha: 'a', finalSha: 'b', changed: true,
        failureCode: 'branch_verification_failed',
      }],
    })).toMatchObject({
      prDeliveryId: 'delivery-1', railIndex: 2, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'branch_verification_failed', isContinuation: true, cleanupWarnings: ['worktree retained'],
      operation: 'publish',
      runIds: ['run-8'], units: [{ ticketId: 8, runId: 'run-8', finalSha: 'b', changed: true }],
    })
  })
})
