import { describe, expect, it } from 'vitest'
import {
  coerceRailPrStateSnapshot,
  comparePrSnapshotUpdatedAt,
  derivePrDeliveryPresentation,
  isInterruptedPrDeliveryOperation,
} from '../pr-delivery'

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

  it('lets recovered retryable delivery outrank its legacy settlement-interrupted status', () => {
    const result = derivePrDeliveryPresentation({
      decision: 'pr_failed',
      ticketIds: [1],
      prUrl: 'https://github.com/o/r/pull/7',
      prState: 'local-only',
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'retryable_failure',
      statusCode: 'settlement_interrupted',
      isContinuation: true,
      runIds: ['run-1'],
    })

    expect(result).toMatchObject({
      implementationFailed: false,
      deliveryBlocked: false,
      retryablePush: true,
      retryablePrCreation: false,
    })
  })

  it('derives explicit legacy recovery and only exposes worktree paths carried by durable unit evidence', () => {
    const result = derivePrDeliveryPresentation({
      decision: 'pr_failed',
      ticketIds: [1, 2],
      prUrl: 'https://github.com/o/r/pull/548',
      branch: 'feat/review',
      prState: 'pr-created',
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted',
      isContinuation: true,
      runIds: ['run-1'],
      units: [
        {
          ticketId: 1, runId: 'run-1', branch: 'feat/review', succeeded: true,
          implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
          initialSha: 'a', finalSha: null, worktreePath: '/tmp/worktree-1',
        },
        {
          ticketId: 2, runId: 'run-1', branch: 'feat/review', succeeded: true,
          implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
          initialSha: 'a', finalSha: null, worktreePath: '/tmp/worktree-1',
        },
      ],
    })

    expect(result.manualRecovery).toBe(true)
    expect(result.recoveryWorktreePaths).toEqual(['/tmp/worktree-1'])
  })

  it('turns an unavailable local recovery into a truthful recheck path, never the commit recovery loop', () => {
    const result = derivePrDeliveryPresentation({
      decision: 'pr_failed',
      ticketIds: [1],
      prUrl: 'https://github.com/o/r/pull/548',
      branch: 'feat/review',
      prState: 'pr-created',
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'blocked',
      statusCode: 'recovery_unavailable',
      isContinuation: true,
      runIds: ['run-1'],
      units: [{
        ticketId: 1, runId: 'run-1', branch: 'feat/review', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'a', finalSha: null, failureCode: 'recovery_unavailable',
      }],
    })

    expect(result).toMatchObject({
      implementationFailed: false,
      deliveryBlocked: true,
      manualRecovery: false,
      recoveryUnavailable: true,
      recoveryRecheck: true,
      hasDiscardableRecoveryResult: false,
      recoveryWorktreePaths: [],
    })
  })

  it('marks a durable unavailable-recovery SHA as explicitly discardable without inventing a worktree', () => {
    const result = derivePrDeliveryPresentation({
      decision: 'pr_failed',
      ticketIds: [1],
      prUrl: 'https://github.com/o/r/pull/548',
      branch: 'feat/review',
      prState: 'pr-created',
      deliverySha: 'b'.repeat(40),
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'blocked',
      statusCode: 'recovery_unavailable',
      isContinuation: true,
      runIds: ['run-1'],
      units: [{
        ticketId: 1, runId: 'run-1', branch: 'feat/review', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        initialSha: 'a', finalSha: 'b'.repeat(40), failureCode: 'recovery_unavailable',
      }],
    })

    expect(result).toMatchObject({
      recoveryUnavailable: true,
      recoveryRecheck: true,
      hasDiscardableRecoveryResult: true,
      recoveryWorktreePaths: [],
    })
  })

  it('does not offer recheck without exact run-and-branch evidence', () => {
    const base = {
      decision: 'pr_failed' as const,
      ticketIds: [1],
      prUrl: 'https://github.com/o/r/pull/548',
      branch: 'feat/review',
      prState: 'pr-created' as const,
      implementationOutcome: 'succeeded' as const,
      deliveryOutcome: 'blocked' as const,
      statusCode: 'recovery_unavailable',
      isContinuation: true,
      runIds: ['run-1'],
      units: [{
        ticketId: 1, runId: 'run-1', branch: 'feat/review', succeeded: true,
        implementationOutcome: 'succeeded' as const, deliveryOutcome: 'blocked' as const,
        initialSha: 'a', finalSha: null,
      }],
    }

    expect(derivePrDeliveryPresentation({ ...base, prUrl: null }).recoveryRecheck).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, branch: null }).recoveryRecheck).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, runIds: [] }).recoveryRecheck).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, units: [] }).recoveryRecheck).toBe(false)
    expect(derivePrDeliveryPresentation({
      ...base,
      units: [{ ...base.units[0], runId: 'another-run' }],
    }).recoveryRecheck).toBe(false)
  })

  it('does not offer manual recovery outside the exact interrupted existing-PR continuation state', () => {
    const base = {
      decision: 'pr_failed' as const,
      ticketIds: [1],
      prUrl: 'https://github.com/o/r/pull/548',
      branch: 'feat/review',
      prState: 'pr-created' as const,
      implementationOutcome: 'succeeded' as const,
      deliveryOutcome: 'blocked' as const,
      statusCode: 'settlement_interrupted',
      isContinuation: true,
      runIds: ['run-1'],
      units: [{
        ticketId: 1, runId: 'run-1', branch: 'feat/review', succeeded: true,
        implementationOutcome: 'succeeded' as const, deliveryOutcome: 'blocked' as const,
        initialSha: null, finalSha: null,
      }],
    }

    expect(derivePrDeliveryPresentation({ ...base, prUrl: null }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, branch: null }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, runIds: [] }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, runIds: ['run-1', 'run-2'] }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({
      ...base,
      units: [
        { ticketId: 1, runId: 'run-1', branch: 'feat/review', succeeded: true, initialSha: null, finalSha: null, worktreePath: '/tmp/one' },
        { ticketId: 1, runId: 'run-1', branch: 'feat/review', succeeded: true, initialSha: null, finalSha: null, worktreePath: '/tmp/two' },
      ],
    }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, units: [] }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({
      ...base,
      units: [{ ...base.units[0], runId: 'another-run' }],
    }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({
      ...base,
      units: [{ ...base.units[0], branch: 'feat/another-branch' }],
    }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, isContinuation: false }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, decision: 'pr_draft' }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, deliveryOutcome: 'partial' }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, statusCode: 'commit_failed' }).manualRecovery).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, implementationOutcome: 'failed' }).manualRecovery).toBe(false)
  })

  it('lets implementation failure outrank contradictory delivery diagnostics', () => {
    const result = derivePrDeliveryPresentation({
      decision: 'implementation_failed',
      ticketIds: [1],
      prUrl: null,
      prState: 'local-only',
      implementationOutcome: 'failed',
      deliveryOutcome: 'blocked',
      statusCode: 'commit_failed',
    })

    expect(result).toMatchObject({
      implementationFailed: true,
      deliveryBlocked: false,
      retryablePush: false,
      retryablePrCreation: false,
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

  it('derives continuation only from the durable generation bit, never branch ownership or failures', () => {
    const base = {
      decision: 'pr_ready' as const,
      ticketIds: [1],
      prUrl: 'https://github.com/o/r/pull/7',
      prState: 'pr-created' as const,
    }
    const unit = {
      ticketId: 1, branch: 'feat/review', succeeded: true,
      implementationOutcome: 'succeeded' as const, deliveryOutcome: 'ready' as const,
      initialSha: null, finalSha: 'abc', failureCode: 'settlement_interrupted',
    }

    expect(derivePrDeliveryPresentation({
      ...base, isContinuation: false, units: [{ ...unit, branchOwnership: 'created' }],
    }).continuation).toBe(false)
    expect(derivePrDeliveryPresentation({
      ...base, isContinuation: false, units: [{ ...unit, branchOwnership: 'borrowed-pr' }],
    }).continuation).toBe(false)
    expect(derivePrDeliveryPresentation({ ...base, isContinuation: true, units: [unit] }).continuation).toBe(true)
  })
})

describe('authoritative PR snapshot coercion', () => {
  it('compares ISO and SQLite durable timestamps while preserving ties', () => {
    expect(comparePrSnapshotUpdatedAt('2026-07-10 12:00:01', '2026-07-10T12:00:02Z')).toBe(1)
    expect(comparePrSnapshotUpdatedAt('2026-07-10 12:00:02', '2026-07-10T12:00:01Z')).toBe(-1)
    expect(comparePrSnapshotUpdatedAt('2026-07-10 12:00:02', '2026-07-10T12:00:02Z')).toBe(0)
    expect(comparePrSnapshotUpdatedAt(undefined, '2026-07-10T12:00:02Z')).toBeNull()
  })

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
      restoredFromDeliveryId: 'failed-replacement',
      operation: 'publish',
      cleanupWarnings: ['worktree retained'],
      safetyArchives: ['/tmp/ticket-8.specrails-overlay-quarantine-a/.mcp.json'],
      branches: [{
        ticketId: 8, runId: 'run-8', branch: 'feat/8', succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', initialSha: 'a', finalSha: 'b', changed: true,
        failureCode: 'branch_verification_failed', worktreePath: '/tmp/worktree-8',
      }],
    })).toMatchObject({
      prDeliveryId: 'delivery-1', railIndex: 2, implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'branch_verification_failed', isContinuation: true, cleanupWarnings: ['worktree retained'],
      safetyArchives: ['/tmp/ticket-8.specrails-overlay-quarantine-a/.mcp.json'],
      restoredFromDeliveryId: 'failed-replacement',
      operation: 'publish',
      runIds: ['run-8'], units: [{
        ticketId: 8, runId: 'run-8', finalSha: 'b', changed: true, worktreePath: '/tmp/worktree-8',
      }],
    })
  })
})
