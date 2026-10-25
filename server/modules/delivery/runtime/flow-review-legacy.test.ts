import { afterEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { FLOW_SPEC_LOOP_ID } from '../../loops/runtime/loop-factory'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import type { DeliverySettleEvidence } from './delivery-evidence'
import { healLegacyFlowReviews, listLegacyFlowReviewCandidates, persistLegacyFlowReview } from './flow-review-legacy'
import { returnFlowWorktree } from './flow-worktree-return'
import { createPrDelivery, getPrDelivery, toPrDecisionCardEnvelope, toPrDeliverySnapshot, toRailPrStateMessage, transitionDecision } from './rail-pr-store'
import { createRailWorktree, getRailWorktree } from './rail-worktrees-store'

const dbs: DbInstance[] = []
afterEach(() => { for (const db of dbs.splice(0)) db.close() })

const WORKTREE = '/wt/flow-1/ticket-8'
const LEGACY_DETAIL = 'Core exited without a successful programmatic workflow result'

type Review = { approved: boolean; issues: string[]; score?: number } | null

function evidence(review: Review, commands: Array<{ label: string; exitCode: number }> = [], options: { runtime?: boolean } = {}): DeliverySettleEvidence {
  return {
    schemaVersion: 1, harvest: 'ok', harvestedAt: '2026-10-22T13:52:14.211Z',
    units: [{
      ticketId: 8, runId: 'run-1', sentinel: 'absent', sentinelDetail: null, verifyTail: null, confidence: null,
      ...(options.runtime === false ? {} : { runtime: {
        commands: commands.map((command) => ({ label: command.label, outcome: command.exitCode === 0 ? 'passed' : 'failed', exitCode: command.exitCode, durationMs: null, required: true, hostRun: true, outputTail: null })),
        checks: [], findings: [],
        review: review ? { approved: review.approved, score: review.score ?? null, aspects: {}, issues: review.issues, summary: 'Approval is blocked' } : null,
      } }),
    }],
  } as DeliverySettleEvidence
}

/** A delivery settled BEFORE settlement classified requested changes: generic implementation failure. */
function legacyDelivery(options: { loopId?: string; settleEvidence?: DeliverySettleEvidence | null } = {}) {
  const db = initDb(':memory:')
  dbs.push(db)
  const loopId = options.loopId ?? FLOW_SPEC_LOOP_ID
  const row = createPrDelivery(db, { id: 'delivery-1', railIndex: 0, loopId, railKey: `0-${loopId}`, ticketIds: [8], baseBranch: 'main', loopName: 'Flow → Spec', originSurface: 'agent-chat', originConversationId: 'conv-1' })
  db.prepare('UPDATE rail_pr_deliveries SET run_ids = ? WHERE id = ?').run(JSON.stringify(['run-1']), row.id)
  createRailWorktree(db, { id: 'ledger-1', railIndex: 0, ticketId: 8, runId: 'run-1', branch: 'feat/8-effects', worktreePath: WORKTREE, mergeState: 'needs-review' })
  transitionDecision(db, row.id, 'building', 'implementation_failed', {
    implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'settlement_interrupted', statusDetail: LEGACY_DETAIL,
    worktreeIds: ['ledger-1'],
    branches: [{ ticketId: 8, branch: 'feat/8-effects', succeeded: false, runId: 'run-1', implementationOutcome: 'failed', deliveryOutcome: 'blocked', initialSha: 'a', finalSha: 'a', failureCode: 'settlement_interrupted', failureDetail: LEGACY_DETAIL, branchOwnership: 'adopted', worktreePath: WORKTREE }],
    ...(options.settleEvidence === null ? {} : { settleEvidence: options.settleEvidence ?? evidence({ approved: false, issues: ['Tag the tests', 'Test the Options screen'], score: 58 }) }),
  })
  return db
}

const noProbe = vi.fn(async () => new Map<string, DefinitionRunProbe>())

describe('legacy Flow → Spec delivery: reclassified on read', () => {
  it('presents a rejected review exactly like a newly settled review_changes_requested delivery', () => {
    const db = legacyDelivery()
    const snap = toPrDeliverySnapshot(getPrDelivery(db, 'delivery-1')!)
    expect(snap).toMatchObject({
      decision: 'implementation_failed',
      statusCode: 'review_changes_requested',
      statusDetail: 'The reviewer requested changes (score 58): Tag the tests (+1 more)',
      flowReview: { reason: 'review', score: 58, issues: ['Tag the tests', 'Test the Options screen'] },
    })
    for (const unit of snap.branches) expect(unit.failureCode).toBe('review_changes_requested')
    const envelope = toPrDecisionCardEnvelope('proj-1', snap)
    expect(envelope.flowReview).toEqual(snap.flowReview)
    expect(envelope.runtime?.failure).toMatchObject({ code: 'review_changes_requested' })
    expect(toRailPrStateMessage('proj-1', snap)).toMatchObject({ statusCode: 'review_changes_requested', flowReview: { reason: 'review' } })
  })

  it('presents failing host checks (no rejected review) as the check outcome', () => {
    const db = legacyDelivery({ settleEvidence: evidence({ approved: true, issues: [] }, [{ label: 'npm test', exitCode: 1 }]) })
    expect(toPrDeliverySnapshot(getPrDelivery(db, 'delivery-1')!)).toMatchObject({ statusCode: 'review_changes_requested', flowReview: { reason: 'check', failingChecks: [{ command: 'npm test', exitCode: 1 }] } })
  })

  it('leaves a non-Flow implementation failure untouched even with a rejected review', () => {
    const db = legacyDelivery({ loopId: 'factory:implement' })
    const snap = toPrDeliverySnapshot(getPrDelivery(db, 'delivery-1')!)
    expect(snap).toMatchObject({ statusCode: 'settlement_interrupted', statusDetail: LEGACY_DETAIL })
    expect(snap.flowReview).toBeUndefined()
    expect(snap.branches[0]!.failureCode).toBe('settlement_interrupted')
    expect(listLegacyFlowReviewCandidates(db)).toEqual([])
  })

  it('keeps a Flow failure the evidence does not explain (approved review, passing checks) as implementation failed', () => {
    const db = legacyDelivery({ settleEvidence: evidence({ approved: true, issues: [] }, [{ label: 'npm test', exitCode: 0 }]) })
    const snap = toPrDeliverySnapshot(getPrDelivery(db, 'delivery-1')!)
    expect(snap).toMatchObject({ statusCode: 'settlement_interrupted', statusDetail: LEGACY_DETAIL })
    expect(snap.flowReview).toBeUndefined()
    expect(persistLegacyFlowReview(db, 'delivery-1')).toBe(false)
    expect(getPrDelivery(db, 'delivery-1')!.status_code).toBe('settlement_interrupted')
  })

  it('Back to Flow accepts the reclassified legacy delivery and closes it as returned_to_flow', () => {
    const db = legacyDelivery()
    const commit = vi.fn()
    const closed = returnFlowWorktree(db, { deliveryId: 'delivery-1', worktreePath: WORKTREE, detail: 'Returned to Flow' }, commit)
    expect(commit).toHaveBeenCalledTimes(1)
    expect(closed).toMatchObject({ decision: 'discarded', statusCode: 'returned_to_flow', flowReview: { reason: 'review', score: 58 } })
    expect(getRailWorktree(db, 'ledger-1')).toBeUndefined()
  })
})

describe('healLegacyFlowReviews (one-shot persistence)', () => {
  const deps = (db: DbInstance, probe = noProbe, isDefinitionRun = () => true) => ({ db, pipelineDir: '/nonexistent/pipeline', probe, isDefinitionRun })

  it('persists the reclassification once, transactionally, without probing when the stored evidence suffices', async () => {
    const db = legacyDelivery()
    const probe = vi.fn(async () => new Map<string, DefinitionRunProbe>())
    expect(await healLegacyFlowReviews(deps(db, probe))).toEqual(['delivery-1'])
    expect(probe).not.toHaveBeenCalled()
    const row = getPrDelivery(db, 'delivery-1')!
    expect(row).toMatchObject({ decision: 'implementation_failed', status_code: 'review_changes_requested', status_detail: 'The reviewer requested changes (score 58): Tag the tests (+1 more)' })
    expect(JSON.parse(row.branches)[0].failureCode).toBe('review_changes_requested')
    // Idempotent: nothing left to reclassify.
    expect(await healLegacyFlowReviews(deps(db, probe))).toEqual([])
    expect(listLegacyFlowReviewCandidates(db)).toEqual([])
  })

  it('reads the missing reviewer verdict from the retained run (read-only probe) through the harvest projection', async () => {
    const bare = evidence(null, [], { runtime: false })
    const db = legacyDelivery({ settleEvidence: { ...bare, units: [{ ...bare.units[0]!, reviewerStepId: 'review' }] } })
    expect(toPrDeliverySnapshot(getPrDelivery(db, 'delivery-1')!).statusCode).toBe('settlement_interrupted')
    const probe = vi.fn(async (runIds: string[]) => new Map<string, DefinitionRunProbe>(runIds.map((runId) => [runId, {
      runId, engineVersion: 2, status: 'failed', resumable: false, lease: null, recoverableSteps: [], pendingInterrupts: [], completion: null,
      coreRevision: 3, eventCursor: 9, probedAt: 'now',
      scopes: [{ nodePath: 'review', scopeId: 's-review', kind: 'role-turn', status: 'succeeded', attemptId: 'a-1',
        output: { structured: { approved: false, score: 58, issues: ['Tag the tests'], summary: 'Blocked by missing tests' } } }],
    }])))
    expect(await healLegacyFlowReviews(deps(db, probe))).toEqual(['delivery-1'])
    expect(probe).toHaveBeenCalledWith(['run-1'])
    const row = getPrDelivery(db, 'delivery-1')!
    expect(row.status_code).toBe('review_changes_requested')
    expect(toPrDeliverySnapshot(row).flowReview).toMatchObject({ reason: 'review', score: 58, issues: ['Tag the tests'], summary: 'Blocked by missing tests' })
  })

  it('leaves a failure the retained run does not explain untouched (evidence included)', async () => {
    const db = legacyDelivery({ settleEvidence: evidence(null, [], { runtime: false }) })
    const before = getPrDelivery(db, 'delivery-1')!.settle_evidence
    expect(await healLegacyFlowReviews(deps(db))).toEqual([])
    expect(getPrDelivery(db, 'delivery-1')).toMatchObject({ status_code: 'settlement_interrupted', settle_evidence: before })
  })

  it('skips a busy delivery and never throws', async () => {
    const db = legacyDelivery()
    db.prepare("UPDATE rail_pr_deliveries SET operation = 'discard', operation_token = 't' WHERE id = 'delivery-1'").run()
    expect(await healLegacyFlowReviews(deps(db))).toEqual([])
    const throwing = vi.fn(async () => { throw new Error('core gone') })
    const db2 = legacyDelivery({ settleEvidence: evidence(null, [], { runtime: false }) })
    await expect(healLegacyFlowReviews(deps(db2, throwing))).resolves.toEqual([])
  })
})
