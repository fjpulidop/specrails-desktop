import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { FLOW_SPEC_LOOP_ID } from '../../loops/runtime/loop-factory'
import { FLOW_SPEC_DELIVERY_LOOP_ID, flowReviewOutcome, flowReviewStatusDetail, readFlowReviewOutcome } from './flow-review-outcome'
import { FlowReturnRejectedError, announceReturnedDelivery, returnFlowWorktree } from './flow-worktree-return'
import { createPrDelivery, getPrDelivery, toPrDecisionCardEnvelope, toPrDeliverySnapshot, transitionDecision } from './rail-pr-store'
import { createRailWorktree, getRailWorktree } from './rail-worktrees-store'
import type { DeliverySettleEvidence } from './delivery-evidence'
import { refreshRepositoryDeliveryGroup } from './multi-repo-execution'

const dbs: DbInstance[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

const WORKTREE = '/wt/flow-1/ticket-8'

function evidence(review: { approved: boolean; issues: string[]; score?: number } | null, commands: Array<{ label: string; exitCode: number }> = []): DeliverySettleEvidence {
  return {
    schemaVersion: 1, harvest: 'ok', harvestedAt: '2026-10-22T13:52:14.211Z',
    units: [{
      ticketId: 8, runId: 'run-1', sentinel: 'absent', sentinelDetail: null, verifyTail: null, confidence: null,
      runtime: {
        commands: commands.map((command) => ({ label: command.label, outcome: command.exitCode === 0 ? 'passed' : 'failed', exitCode: command.exitCode, durationMs: null, required: true, hostRun: true, outputTail: null })),
        checks: [], findings: [],
        review: review ? { approved: review.approved, score: review.score ?? null, aspects: {}, issues: review.issues, summary: 'Approval is blocked by four problems' } : null,
      },
    }],
  } as DeliverySettleEvidence
}

/** A Flow → Spec delivery that settled `implementation_failed` with its adopted worktree in the ledger. */
function stoppedFlowDelivery(options: { loopId?: string; decision?: 'implementation_failed' | 'on_review' } = {}) {
  const db = initDb(':memory:')
  dbs.push(db)
  const row = createPrDelivery(db, { id: 'delivery-1', railIndex: 0, loopId: options.loopId ?? FLOW_SPEC_LOOP_ID, railKey: `0-${FLOW_SPEC_LOOP_ID}`, ticketIds: [8], baseBranch: 'main', loopName: 'Flow → Spec', originSurface: 'agent-chat', originConversationId: 'conv-1' })
  db.prepare("UPDATE rail_pr_deliveries SET run_ids = ? WHERE id = ?").run(JSON.stringify(['run-1']), row.id)
  createRailWorktree(db, { id: 'ledger-1', railIndex: 0, ticketId: 8, runId: 'run-1', branch: 'feat/8-effects', worktreePath: WORKTREE, mergeState: 'needs-review' })
  createRailWorktree(db, { id: 'ledger-other', railIndex: 1, ticketId: 9, runId: 'run-9', branch: 'feat/9', worktreePath: '/wt/other' })
  transitionDecision(db, row.id, 'building', options.decision ?? 'implementation_failed', {
    implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'review_changes_requested', statusDetail: 'The reviewer requested changes',
    worktreeIds: ['ledger-1'],
    branches: [{ ticketId: 8, branch: 'feat/8-effects', succeeded: false, runId: 'run-1', implementationOutcome: 'failed', deliveryOutcome: 'blocked', initialSha: 'a', finalSha: 'a', failureCode: 'review_changes_requested', branchOwnership: 'adopted', worktreePath: WORKTREE }],
    settleEvidence: evidence({ approved: false, issues: ['Tag the tests'], score: 58 }),
  })
  return db
}

describe('flowReviewOutcome', () => {
  it('pins the store-level loop id to the loop catalog', () => {
    expect(FLOW_SPEC_DELIVERY_LOOP_ID).toBe(FLOW_SPEC_LOOP_ID)
  })

  it('reads the latest rejected review (bounded) and the failing host checks of a failed Flow → Spec run', () => {
    const issues = Array.from({ length: 25 }, (_, index) => `issue ${index} ${'x'.repeat(700)}`)
    const outcome = flowReviewOutcome({ loopId: FLOW_SPEC_LOOP_ID, implementationOutcome: 'failed', evidence: evidence({ approved: false, issues, score: 58 }, [{ label: 'npm test', exitCode: 1 }, { label: 'npm run typecheck', exitCode: 0 }]) })!
    expect(outcome).toMatchObject({ reason: 'review', score: 58, issuesOmitted: 5, failingChecks: [{ command: 'npm test', exitCode: 1 }], summary: 'Approval is blocked by four problems' })
    expect(outcome.issues).toHaveLength(20)
    expect(outcome.issues[0]!.length).toBeLessThanOrEqual(601)
    expect(flowReviewStatusDetail(outcome)).toMatch(/^The reviewer requested changes \(score 58\): issue 0 .*\(\+24 more\)$/)
  })

  it('names failing checks when the review passed (or never ran)', () => {
    const outcome = flowReviewOutcome({ loopId: FLOW_SPEC_LOOP_ID, implementationOutcome: 'failed', evidence: evidence(null, [{ label: 'npm test', exitCode: 2 }]) })!
    expect(outcome).toMatchObject({ reason: 'check', issues: [], score: null })
    expect(flowReviewStatusDetail(outcome)).toContain('the checks still fail after the automatic correction rounds — npm test (exit 2)')
  })

  it('stays null for other loops, succeeded runs and failures the evidence does not explain', () => {
    const rejected = evidence({ approved: false, issues: ['x'] })
    expect(flowReviewOutcome({ loopId: 'factory:implement', implementationOutcome: 'failed', evidence: rejected })).toBeNull()
    expect(flowReviewOutcome({ loopId: FLOW_SPEC_LOOP_ID, implementationOutcome: 'succeeded', evidence: rejected })).toBeNull()
    expect(flowReviewOutcome({ loopId: FLOW_SPEC_LOOP_ID, implementationOutcome: 'failed', evidence: evidence({ approved: true, issues: [] }) })).toBeNull()
    expect(flowReviewOutcome({ loopId: FLOW_SPEC_LOOP_ID, implementationOutcome: 'failed', evidence: undefined })).toBeNull()
    expect(readFlowReviewOutcome({ loop_id: FLOW_SPEC_LOOP_ID, implementation_outcome: 'failed', status_code: 'review_changes_requested', settle_evidence: '{not json' })).toBeNull()
  })

  it('rides the delivery snapshot and the mission card envelope', () => {
    const db = stoppedFlowDelivery()
    const snap = toPrDeliverySnapshot(getPrDelivery(db, 'delivery-1')!)
    expect(snap.flowReview).toMatchObject({ reason: 'review', issues: ['Tag the tests'], score: 58 })
    const envelope = toPrDecisionCardEnvelope('proj-1', snap)
    expect(envelope.flowReview).toEqual(snap.flowReview)
    expect(envelope.runtime?.failure).toMatchObject({ code: 'review_changes_requested', detail: 'The reviewer requested changes' })
  })
})

describe('returnFlowWorktree (Back to Flow ownership transfer)', () => {
  it('removes only the adopted ledger row, closes the delivery as returned_to_flow and commits the Flow inside the transaction', () => {
    const db = stoppedFlowDelivery()
    const commit = vi.fn(() => {
      // Inside the transaction the ledger row is already gone.
      expect(getRailWorktree(db, 'ledger-1')).toBeUndefined()
    })
    const closed = returnFlowWorktree(db, { deliveryId: 'delivery-1', worktreePath: WORKTREE, detail: 'Returned to Flow' }, commit)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(closed).toMatchObject({ decision: 'discarded', statusCode: 'returned_to_flow', statusDetail: 'Returned to Flow', worktreeIds: [] })
    expect(getRailWorktree(db, 'ledger-other')).toBeDefined()
    // The closed delivery keeps the review for the record and frees the rail.
    expect(closed.flowReview).toMatchObject({ reason: 'review' })
    // Idempotent: a second return neither commits again nor fails.
    expect(returnFlowWorktree(db, { deliveryId: 'delivery-1', worktreePath: WORKTREE, detail: 'again' }, commit).statusCode).toBe('returned_to_flow')
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('rolls the ledger and the delivery back when the Flow commit fails', () => {
    const db = stoppedFlowDelivery()
    expect(() => returnFlowWorktree(db, { deliveryId: 'delivery-1', worktreePath: WORKTREE, detail: 'x' }, () => { throw new Error('flow row gone') })).toThrow('flow row gone')
    expect(getRailWorktree(db, 'ledger-1')).toBeDefined()
    expect(getPrDelivery(db, 'delivery-1')).toMatchObject({ decision: 'implementation_failed', status_code: 'review_changes_requested' })
  })

  it('refuses a delivery that is not a stopped Flow → Spec run, a busy one and a foreign worktree', () => {
    const reject = (db: DbInstance, path = WORKTREE) => () => returnFlowWorktree(db, { deliveryId: 'delivery-1', worktreePath: path, detail: 'x' }, () => {})
    expect(reject(stoppedFlowDelivery({ loopId: 'factory:implement' }))).toThrow(expect.objectContaining({ code: 'flow_return_not_found' }))
    expect(reject(stoppedFlowDelivery({ decision: 'on_review' }))).toThrow(expect.objectContaining({ code: 'flow_return_not_allowed' }))
    const busy = stoppedFlowDelivery()
    busy.prepare("UPDATE rail_pr_deliveries SET operation = 'discard', operation_token = 't' WHERE id = 'delivery-1'").run()
    expect(reject(busy)).toThrow(expect.objectContaining({ code: 'flow_return_busy' }))
    const foreign = stoppedFlowDelivery()
    expect(reject(foreign, '/wt/other')).toThrow(FlowReturnRejectedError)
    expect(getRailWorktree(foreign, 'ledger-1')).toBeDefined()
  })

  it('announces the closed delivery to the rail strip without throwing', () => {
    const db = stoppedFlowDelivery()
    const closed = returnFlowWorktree(db, { deliveryId: 'delivery-1', worktreePath: WORKTREE, detail: 'x' }, () => {})
    const broadcast = vi.fn(() => { throw new Error('socket closed') })
    expect(() => announceReturnedDelivery('proj-1', closed, broadcast)).not.toThrow()
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'rail.pr_state', prDeliveryId: 'delivery-1', decision: 'discarded', statusCode: 'returned_to_flow' }))
  })
})

/** A Flow → Spec run of a Flow in a non-primary repository: a one-repository
 * group (parent + child) whose child stopped with requested changes. */
function stoppedFlowGroup() {
  const db = initDb(':memory:')
  dbs.push(db)
  const base = { railIndex: 0, loopId: FLOW_SPEC_LOOP_ID, railKey: `0-${FLOW_SPEC_LOOP_ID}`, ticketIds: [8], baseBranch: 'main', loopName: 'Flow → Spec', originSurface: 'agent-chat' as const, originConversationId: 'conv-1' }
  createPrDelivery(db, { ...base, id: 'group-1' })
  createPrDelivery(db, { ...base, id: 'child-1', parentDeliveryId: 'group-1', repositoryId: 'api', repositoryPath: '/ws/api', originConversationId: null })
  createRailWorktree(db, { id: 'ledger-1', railIndex: 0, ticketId: 8, runId: 'run-1', repositoryId: 'api', repositoryPath: '/ws/api', branch: 'feat/8-effects', worktreePath: WORKTREE, mergeState: 'needs-review' })
  transitionDecision(db, 'group-1', 'building', 'building', {
    runIds: ['run-1'],
    executionManifest: { version: 1, groupId: 'group-1', projectId: 'proj-1', primaryRepositoryId: 'ws', artifactRepositoryId: 'api', selectedRepositoryIds: ['api'], repositories: [] },
  })
  transitionDecision(db, 'child-1', 'building', 'implementation_failed', {
    runIds: ['run-1'], implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'review_changes_requested', statusDetail: 'The reviewer requested changes',
    worktreeIds: ['ledger-1'],
    branches: [{ ticketId: 8, branch: 'feat/8-effects', succeeded: false, runId: 'run-1', implementationOutcome: 'failed', deliveryOutcome: 'blocked', initialSha: 'a', finalSha: 'a', failureCode: 'review_changes_requested', branchOwnership: 'adopted', worktreePath: WORKTREE }],
    settleEvidence: evidence({ approved: false, issues: ['Tag the tests'], score: 58 }),
  })
  refreshRepositoryDeliveryGroup(db, 'group-1')
  return db
}

describe('a Flow in a non-primary repository (one-repository group)', () => {
  it('the group carries the child\'s "changes requested" outcome, so the card and the Flow read its findings', () => {
    const db = stoppedFlowGroup()
    const parent = getPrDelivery(db, 'group-1')!
    expect(parent).toMatchObject({ decision: 'implementation_failed', status_code: 'review_changes_requested', implementation_outcome: 'failed' })
    const snap = toPrDeliverySnapshot(parent)
    expect(snap.flowReview).toMatchObject({ reason: 'review', issues: ['Tag the tests'], score: 58 })
    expect(snap.branches).toEqual([expect.objectContaining({ worktreePath: WORKTREE, repositoryId: 'api' })])
  })

  it('Back to Flow on the group closes parent and child together and releases the adopted ledger row', () => {
    const db = stoppedFlowGroup()
    const commit = vi.fn()
    returnFlowWorktree(db, { deliveryId: 'group-1', worktreePath: WORKTREE, detail: 'Returned to Flow' }, commit)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(getRailWorktree(db, 'ledger-1')).toBeUndefined()
    expect(getPrDelivery(db, 'group-1')).toMatchObject({ decision: 'discarded', status_code: 'returned_to_flow' })
    expect(getPrDelivery(db, 'child-1')).toMatchObject({ decision: 'discarded', status_code: 'returned_to_flow' })
    // A later projection never re-settles the returned group.
    refreshRepositoryDeliveryGroup(db, 'group-1')
    expect(getPrDelivery(db, 'group-1')).toMatchObject({ decision: 'discarded', status_code: 'returned_to_flow' })
    // Idempotent.
    returnFlowWorktree(db, { deliveryId: 'group-1', worktreePath: WORKTREE, detail: 'Returned to Flow' }, commit)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('a failing Flow commit rolls back both rows and the ledger', () => {
    const db = stoppedFlowGroup()
    expect(() => returnFlowWorktree(db, { deliveryId: 'group-1', worktreePath: WORKTREE, detail: 'x' }, () => { throw new Error('flow write failed') })).toThrow('flow write failed')
    expect(getRailWorktree(db, 'ledger-1')).toBeDefined()
    expect(getPrDelivery(db, 'group-1')?.decision).toBe('implementation_failed')
    expect(getPrDelivery(db, 'child-1')?.decision).toBe('implementation_failed')
  })
})

