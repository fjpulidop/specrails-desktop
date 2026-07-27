import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  appendPrDeliverySafetyArchive,
  createPrDelivery,
  createPrDeliveryGeneration,
  clearOrphanedPrDeliveryOperations,
  failPrDeliveryAndRestoreSuperseded,
  getPrDelivery,
  getLatestTerminalPrDeliveryTouchingTicketSet,
  getActivePrDeliveryByRail,
  listActivePrDeliveries,
  transitionDecision,
  transitionClaimedDecision,
  reconcileFailedBuildingPrDeliveries,
  toPrDeliverySnapshot,
  toRailPrStateMessage,
  toPrDecisionCardEnvelope,
  isTerminalPrDecision,
  TERMINAL_PR_DECISIONS,
  ACTIVE_PR_DECISIONS,
  claimPrDeliveryOperation,
  releasePrDeliveryOperation,
  readSpecSnapshot,
  type CreatePrDeliveryInput,
} from './rail-pr-store'
import { harvestDeliveryEvidence, readSettleEvidence } from './delivery-evidence'
import { createLoopRun, finishLoopRun } from './loop-runs-store'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

const mk = (id: string, railIndex: number, extra: Partial<CreatePrDeliveryInput> = {}) =>
  createPrDelivery(db, {
    id,
    railIndex,
    loopId: 'loop-1',
    railKey: `${railIndex}-loop-1`,
    ticketIds: [1, 2],
    baseBranch: 'main',
    loopName: 'Implement',
    originSurface: 'dashboard',
    ...extra,
  })

describe('rail_pr_deliveries ledger', () => {
  it('creates and reads a row with defaults (building / none / empty JSON arrays)', () => {
    const row = mk('a', 0)
    expect(row).toMatchObject({
      id: 'a',
      rail_index: 0,
      loop_id: 'loop-1',
      rail_key: '0-loop-1',
      ticket_ids: '[1,2]',
      base_branch: 'main',
      branch: null,
      pr_url: null,
      pr_number: null,
      pr_state: 'none',
      decision: 'building',
      implementation_outcome: 'running',
      delivery_outcome: 'pending',
      status_code: 'implementation_running',
      is_continuation: 0,
      supersedes_delivery_id: null,
      restored_from_delivery_id: null,
      cleanup_warnings: '[]',
      safety_archives: '[]',
      branches: '[]',
      loop_name: 'Implement',
      worktree_ids: '[]',
      run_ids: '[]',
      origin_surface: 'dashboard',
      origin_conversation_id: null,
    })
    expect(row.created_at).toBeTruthy()
    expect(row.updated_at).toBeTruthy()
    expect(getPrDelivery(db, 'a')?.decision).toBe('building')
  })

  it('generates a uuid when id is omitted', () => {
    const row = createPrDelivery(db, {
      railIndex: 1,
      railKey: '1-null',
      ticketIds: [7],
      baseBranch: 'develop',
      loopName: 'Fix',
      originSurface: 'agent-chat',
      originConversationId: 'conv-9',
    })
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.loop_id).toBeNull()
    expect(row.origin_surface).toBe('agent-chat')
    expect(row.origin_conversation_id).toBe('conv-9')
  })

  it('returns undefined for an unknown id', () => {
    expect(getPrDelivery(db, 'nope')).toBeUndefined()
  })
})

describe('transitionDecision (compare-and-set)', () => {
  it('transitions when expected matches and bumps updated_at', () => {
    mk('a', 0)
    db.prepare(`UPDATE rail_pr_deliveries SET updated_at = '2000-01-01 00:00:00' WHERE id = 'a'`).run()
    expect(transitionDecision(db, 'a', 'building', 'on_review')).toBe(true)
    const row = getPrDelivery(db, 'a')!
    expect(row.decision).toBe('on_review')
    expect(row.updated_at).not.toBe('2000-01-01 00:00:00')
  })

  it('keeps updated_at strictly monotonic across same-instant claim, transition, and release writes', () => {
    mk('a', 0)
    const logicalFuture = '2099-01-01T00:00:00.000Z'
    db.prepare('UPDATE rail_pr_deliveries SET updated_at = ? WHERE id = ?').run(logicalFuture, 'a')

    expect(claimPrDeliveryOperation(db, 'a', 'building', 'create-pr', 'token')).toBe(true)
    const claimedAt = getPrDelivery(db, 'a')!.updated_at
    expect(Date.parse(claimedAt)).toBeGreaterThan(Date.parse(logicalFuture))

    expect(transitionClaimedDecision(db, 'a', 'building', 'on_review', 'token')).toBe(true)
    const transitionedAt = getPrDelivery(db, 'a')!.updated_at
    expect(Date.parse(transitionedAt)).toBeGreaterThan(Date.parse(claimedAt))

    expect(releasePrDeliveryOperation(db, 'a', 'token')).toBe(true)
    const releasedAt = getPrDelivery(db, 'a')!.updated_at
    expect(Date.parse(releasedAt)).toBeGreaterThan(Date.parse(transitionedAt))
  })

  it('returns false on a stale expected and leaves the row untouched', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'on_review')
    // A second surface still believing decision='building' must lose the race.
    expect(transitionDecision(db, 'a', 'building', 'discarded', { prState: 'pushed' })).toBe(false)
    const row = getPrDelivery(db, 'a')!
    expect(row.decision).toBe('on_review')
    expect(row.pr_state).toBe('none')
  })

  it('returns false for an unknown id', () => {
    expect(transitionDecision(db, 'ghost', 'building', 'on_review')).toBe(false)
  })

  it('applies a full patch alongside the transition', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'on_review', {
      branches: [{ ticketId: 1, branch: 'sr/p/ticket-1', succeeded: true }],
      worktreeIds: ['wt-1', 'wt-2'],
    })
    const ok = transitionDecision(db, 'a', 'on_review', 'pr_draft', {
      branch: 'sr/p/batch-0-loop-1',
      prUrl: 'https://github.com/o/r/pull/12',
      prNumber: 12,
      prState: 'pr-created',
    })
    expect(ok).toBe(true)
    const row = getPrDelivery(db, 'a')!
    expect(row).toMatchObject({
      decision: 'pr_draft',
      branch: 'sr/p/batch-0-loop-1',
      pr_url: 'https://github.com/o/r/pull/12',
      pr_number: 12,
      pr_state: 'pr-created',
      branches: '[{"ticketId":1,"branch":"sr/p/ticket-1","succeeded":true}]',
      worktree_ids: '["wt-1","wt-2"]',
    })
  })

  it('run_ids: the allocation patch (building→building CAS) persists them; the settle patch leaves them untouched', () => {
    mk('a', 0)
    // Allocation: same-state CAS carries ONLY the run ids (rail-isolated-launch).
    expect(transitionDecision(db, 'a', 'building', 'building', { runIds: ['run-1', 'run-2'] })).toBe(true)
    expect(getPrDelivery(db, 'a')?.run_ids).toBe('["run-1","run-2"]')
    // Settle patches branches/worktreeIds WITHOUT runIds → column untouched.
    transitionDecision(db, 'a', 'building', 'on_review', {
      branches: [{ ticketId: 1, branch: 'sr/p/ticket-1', succeeded: true }],
      worktreeIds: ['wt-1'],
    })
    const row = getPrDelivery(db, 'a')!
    expect(row.decision).toBe('on_review')
    expect(row.run_ids).toBe('["run-1","run-2"]')
    expect(toPrDeliverySnapshot(row).runIds).toEqual(['run-1', 'run-2'])
  })

  it('a patch key set to undefined is skipped (column untouched)', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'on_review', { branch: 'kept' })
    expect(transitionDecision(db, 'a', 'on_review', 'pr_failed', { branch: undefined })).toBe(true)
    expect(getPrDelivery(db, 'a')?.branch).toBe('kept')
  })

  it('allows patch to null out a column explicitly', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'on_review', { branch: 'stale' })
    transitionDecision(db, 'a', 'on_review', 'pr_failed', { branch: null })
    expect(getPrDelivery(db, 'a')?.branch).toBeNull()
  })
})

describe('active queries', () => {
  it('getActivePrDeliveryByRail excludes terminal decisions', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'on_review')
    transitionDecision(db, 'a', 'on_review', 'discarded')
    expect(getActivePrDeliveryByRail(db, 0)).toBeUndefined()

    mk('b', 0)
    transitionDecision(db, 'b', 'building', 'on_review')
    transitionDecision(db, 'b', 'on_review', 'pr_draft')
    transitionDecision(db, 'b', 'pr_draft', 'merged')
    expect(getActivePrDeliveryByRail(db, 0)).toBeUndefined()
  })

  it('getActivePrDeliveryByRail returns the newest non-terminal row for the rail', () => {
    mk('old', 0)
    transitionDecision(db, 'old', 'building', 'pr_ready', {
      branch: 'feat/1-work', prUrl: 'https://github.com/o/r/pull/1', prState: 'pr-created',
    })
    const created = createPrDeliveryGeneration(db, {
      id: 'new', railIndex: 0, loopId: 'loop-1', railKey: '0-loop-1', ticketIds: [1, 2],
      baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
    }, { id: 'old', decision: 'pr_ready' })
    mk('other-rail', 1)
    expect(created.superseded?.id).toBe('old')
    expect(getPrDelivery(db, 'old')?.decision).toBe('superseded')
    expect(getActivePrDeliveryByRail(db, 0)?.id).toBe('new')
    expect(getActivePrDeliveryByRail(db, 1)?.id).toBe('other-rail')
    expect(getActivePrDeliveryByRail(db, 2)).toBeUndefined()
  })

  it('pr_failed counts as active (retryable)', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'on_review')
    transitionDecision(db, 'a', 'on_review', 'pr_failed')
    expect(getActivePrDeliveryByRail(db, 0)?.id).toBe('a')
  })

  it('implementation_failed counts as active (needs discard)', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'implementation_failed')
    expect(getActivePrDeliveryByRail(db, 0)?.id).toBe('a')
  })

  it('listActivePrDeliveries returns every non-terminal row ordered by rail', () => {
    mk('r1', 1)
    mk('r0-done', 0)
    transitionDecision(db, 'r0-done', 'building', 'on_review')
    transitionDecision(db, 'r0-done', 'on_review', 'discarded')
    mk('r0', 0)
    mk('r2', 2)
    transitionDecision(db, 'r2', 'building', 'on_review')
    expect(listActivePrDeliveries(db).map((r) => r.id)).toEqual(['r0', 'r1', 'r2'])
  })

  it('listActivePrDeliveries is empty when everything is terminal', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'completed')
    expect(listActivePrDeliveries(db)).toEqual([])
  })
})

describe('terminal history authority by ticket lineage', () => {
  it('returns the newest overlapping generation instead of resurrecting older exact history', () => {
    const older = mk('older-exact', 0, { ticketIds: [1, 2] })
    transitionDecision(db, older.id, 'building', 'discarded')
    const newer = mk('newer-exact', 1, { ticketIds: [2, 1] })
    transitionDecision(db, newer.id, 'building', 'discarded')
    const unrelated = mk('newer-subset', 2, { ticketIds: [1] })
    transitionDecision(db, unrelated.id, 'building', 'discarded')

    expect(getLatestTerminalPrDeliveryTouchingTicketSet(db, [1, 2])?.id).toBe('newer-subset')
  })

  it('lets a newer superset shadow older exact history', () => {
    const older = mk('older-single', 0, { ticketIds: [1] })
    transitionDecision(db, older.id, 'building', 'discarded')
    const newer = mk('newer-batch', 1, { ticketIds: [2, 1] })
    transitionDecision(db, newer.id, 'building', 'discarded')

    expect(getLatestTerminalPrDeliveryTouchingTicketSet(db, [1])?.id).toBe('newer-batch')
  })

  it('lets malformed newest target ownership shadow older valid history', () => {
    const older = mk('older-valid', 0, { ticketIds: [1] })
    transitionDecision(db, older.id, 'building', 'discarded')
    const newer = mk('newer-malformed', 1, { ticketIds: [1] })
    transitionDecision(db, newer.id, 'building', 'discarded')
    db.prepare(`UPDATE rail_pr_deliveries SET ticket_ids = '[1,1]' WHERE id = ?`).run(newer.id)

    expect(getLatestTerminalPrDeliveryTouchingTicketSet(db, [1])?.id).toBe('newer-malformed')
  })

  it('rejects empty and duplicate requested targets, and returns overlap authority otherwise', () => {
    const row = mk('batch', 0, { ticketIds: [1, 2] })
    transitionDecision(db, row.id, 'building', 'discarded')

    expect(getLatestTerminalPrDeliveryTouchingTicketSet(db, [])).toBeUndefined()
    expect(getLatestTerminalPrDeliveryTouchingTicketSet(db, [1, 1])).toBeUndefined()
    expect(getLatestTerminalPrDeliveryTouchingTicketSet(db, [1])?.id).toBe('batch')
    expect(getLatestTerminalPrDeliveryTouchingTicketSet(db, [1, 2, 3])?.id).toBe('batch')
  })
})

describe('decision sets', () => {
  it('classifies terminal decisions', () => {
    expect(isTerminalPrDecision('completed')).toBe(true)
    expect(isTerminalPrDecision('merged')).toBe(true)
    expect(isTerminalPrDecision('discarded')).toBe(true)
    expect(isTerminalPrDecision('superseded')).toBe(true)
    expect(isTerminalPrDecision('building')).toBe(false)
    expect(isTerminalPrDecision('on_review')).toBe(false)
    expect(isTerminalPrDecision('pr_draft')).toBe(false)
    expect(isTerminalPrDecision('pr_ready')).toBe(false)
    expect(isTerminalPrDecision('pr_closed')).toBe(false)
    expect(isTerminalPrDecision('no_changes')).toBe(false)
    expect(isTerminalPrDecision('implementation_failed')).toBe(false)
    expect(isTerminalPrDecision('pr_failed')).toBe(false)
  })

  it('ACTIVE and TERMINAL sets partition the decision space', () => {
    for (const d of ACTIVE_PR_DECISIONS) expect(TERMINAL_PR_DECISIONS.has(d)).toBe(false)
    expect(ACTIVE_PR_DECISIONS.size + TERMINAL_PR_DECISIONS.size).toBe(12)
  })
})

describe('reconcileFailedBuildingPrDeliveries', () => {
  it('turns a stranded building row with only failed settled runs into implementation_failed', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'building', { runIds: ['run-1'] })
    createLoopRun(db, {
      id: 'run-1',
      projectId: 'proj',
      loopId: 'factory:implement',
      loopName: 'Implement',
      railIndex: 0,
      ticketId: 1,
      iterationLimit: 1,
      startedAt: '2026-07-07T00:00:00.000Z',
    })
    finishLoopRun(db, 'run-1', { outcome: 'failed', finishedAt: '2026-07-07T00:01:00.000Z' })

    const reconciled = reconcileFailedBuildingPrDeliveries(db)

    expect(reconciled.map((row) => row.id)).toEqual(['a'])
    expect(getPrDelivery(db, 'a')?.decision).toBe('implementation_failed')
  })

  it('leaves running rows alone and makes a successfully-run but unproven settle actionable', () => {
    mk('running', 0)
    transitionDecision(db, 'running', 'building', 'building', { runIds: ['run-running'] })
    createLoopRun(db, {
      id: 'run-running',
      projectId: 'proj',
      loopId: 'factory:implement',
      railIndex: 0,
      ticketId: 1,
      iterationLimit: 1,
      startedAt: '2026-07-07T00:00:00.000Z',
    })

    mk('success', 1)
    transitionDecision(db, 'success', 'building', 'building', { runIds: ['run-success'] })
    createLoopRun(db, {
      id: 'run-success',
      projectId: 'proj',
      loopId: 'factory:implement',
      railIndex: 1,
      ticketId: 2,
      iterationLimit: 1,
      startedAt: '2026-07-07T00:00:00.000Z',
    })
    finishLoopRun(db, 'run-success', { outcome: 'success', finishedAt: '2026-07-07T00:01:00.000Z' })

    expect(reconcileFailedBuildingPrDeliveries(db).map((row) => row.id)).toEqual(['success'])
    expect(getPrDelivery(db, 'running')?.decision).toBe('building')
    expect(getPrDelivery(db, 'success')).toMatchObject({
      decision: 'pr_failed',
      implementation_outcome: 'succeeded',
      delivery_outcome: 'blocked',
      status_code: 'settlement_interrupted',
    })
  })

  it('makes a prior-process building row with no run ids actionable without inventing a run failure', () => {
    mk('empty', 0)
    expect(reconcileFailedBuildingPrDeliveries(db, { startup: true }).map((row) => row.id)).toEqual(['empty'])
    expect(getPrDelivery(db, 'empty')).toMatchObject({
      decision: 'pr_failed', implementation_outcome: 'unknown', delivery_outcome: 'blocked',
      status_code: 'settlement_interrupted',
    })
  })
})

describe('generation and operation ownership', () => {
  it('enforces one active generation and restores the predecessor when allocation fails', () => {
    mk('old', 0)
    transitionDecision(db, 'old', 'building', 'pr_draft')
    const { delivery, superseded } = createPrDeliveryGeneration(db, {
      id: 'new', railIndex: 0, loopId: 'loop-1', railKey: '0-loop-1', ticketIds: [1],
      baseBranch: 'main', loopName: 'Follow-up', originSurface: 'dashboard',
    }, { id: 'old', decision: 'pr_draft' })
    expect(delivery).toMatchObject({ id: 'new', is_continuation: 1, supersedes_delivery_id: 'old' })
    expect(() => mk('raced', 0)).toThrow()
    expect(failPrDeliveryAndRestoreSuperseded(db, 'new', superseded!)).toBe(true)
    expect(getPrDelivery(db, 'new')?.decision).toBe('discarded')
    expect(getActivePrDeliveryByRail(db, 0)?.id).toBe('old')
    expect(getPrDelivery(db, 'old')).toMatchObject({
      decision: 'pr_draft', restored_from_delivery_id: 'new',
    })
    expect(toPrDeliverySnapshot(getPrDelivery(db, 'old')!)).toMatchObject({
      id: 'old', restoredFromDeliveryId: 'new',
    })

    // A later replacement clears the old rollback marker while A is terminal,
    // then records only that exact replacement if allocation also fails.
    const second = createPrDeliveryGeneration(db, {
      id: 'newer', railIndex: 0, loopId: 'loop-1', railKey: '0-loop-1', ticketIds: [1],
      baseBranch: 'main', loopName: 'Follow-up 2', originSurface: 'dashboard',
    }, { id: 'old', decision: 'pr_draft' })
    expect(getPrDelivery(db, 'old')).toMatchObject({
      decision: 'superseded', restored_from_delivery_id: null,
    })
    expect(failPrDeliveryAndRestoreSuperseded(db, 'newer', second.superseded!)).toBe(true)
    expect(getPrDelivery(db, 'old')).toMatchObject({
      decision: 'pr_draft', restored_from_delivery_id: 'newer',
    })
  })

  it('atomically records a stale-PR replacement as a fresh generation', () => {
    mk('stale', 0)
    transitionDecision(db, 'stale', 'building', 'pr_draft')

    const { delivery, superseded } = createPrDeliveryGeneration(db, {
      id: 'fresh', railIndex: 0, loopId: 'loop-2', railKey: '0-loop-2', ticketIds: [1],
      baseBranch: 'main', loopName: 'Fresh follow-up', originSurface: 'dashboard',
      isContinuation: false,
    }, { id: 'stale', decision: 'pr_draft' })

    expect(delivery).toMatchObject({
      id: 'fresh',
      is_continuation: 0,
      supersedes_delivery_id: 'stale',
    })
    expect(superseded?.id).toBe('stale')
    expect(getPrDelivery(db, 'stale')?.decision).toBe('superseded')
  })

  it('claims effects before work, rejects a live rival, and permits only the owner to release', () => {
    mk('a', 0)
    expect(claimPrDeliveryOperation(db, 'a', 'building', 'discard', 'owner', 10_000, 1_000)).toBe(true)
    expect(claimPrDeliveryOperation(db, 'a', 'building', 'publish', 'rival', 10_500, 1_000)).toBe(false)
    expect(releasePrDeliveryOperation(db, 'a', 'rival')).toBe(false)
    expect(releasePrDeliveryOperation(db, 'a', 'owner')).toBe(true)
    expect(getPrDelivery(db, 'a')).toMatchObject({ operation: null, operation_token: null })
  })

  it('clears prior-process operation leases before cards are reprojected', () => {
    mk('restart-lease', 0)
    transitionDecision(db, 'restart-lease', 'building', 'on_review')
    expect(claimPrDeliveryOperation(db, 'restart-lease', 'on_review', 'create-pr', 'dead-process')).toBe(true)

    expect(clearOrphanedPrDeliveryOperations(db)).toBe(1)
    expect(getPrDelivery(db, 'restart-lease')).toMatchObject({
      decision: 'on_review', operation: null, operation_token: null, operation_started_at_ms: null,
      status_code: 'operation_interrupted',
      status_detail: expect.stringContaining('interrupted by restart'),
    })
    expect(claimPrDeliveryOperation(db, 'restart-lease', 'on_review', 'create-pr', 'new-process')).toBe(true)
  })

  it.each(['settlement_interrupted', 'recovery_unavailable'] as const)(
    'clears an orphaned recovery lease without erasing the causal %s status',
    (statusCode) => {
      const id = `restart-recovery-${statusCode}`
      mk(id, 0, { isContinuation: true })
      transitionDecision(db, id, 'building', 'pr_failed', {
        implementationOutcome: 'succeeded',
        deliveryOutcome: 'blocked',
        statusCode,
        statusDetail: `causal detail for ${statusCode}`,
        branch: 'feat/existing-pr',
        prUrl: 'https://github.com/o/r/pull/1',
        isContinuation: true,
      })
      expect(claimPrDeliveryOperation(
        db,
        id,
        'pr_failed',
        'recover-and-retry',
        'dead-recovery-process',
      )).toBe(true)

      expect(clearOrphanedPrDeliveryOperations(db)).toBe(1)
      expect(getPrDelivery(db, id)).toMatchObject({
        decision: 'pr_failed',
        delivery_outcome: 'blocked',
        operation: null,
        operation_token: null,
        operation_started_at_ms: null,
        status_code: statusCode,
        status_detail: `causal detail for ${statusCode}`,
      })
    },
  )

  it('clears a lease left after a durable terminal CAS without calling the completed action interrupted', () => {
    mk('terminal-lease', 0)
    transitionDecision(db, 'terminal-lease', 'building', 'on_review')
    expect(claimPrDeliveryOperation(db, 'terminal-lease', 'on_review', 'discard', 'dead-process')).toBe(true)
    expect(transitionClaimedDecision(db, 'terminal-lease', 'on_review', 'discarded', 'dead-process')).toBe(true)

    expect(clearOrphanedPrDeliveryOperations(db)).toBe(1)
    expect(getPrDelivery(db, 'terminal-lease')).toMatchObject({
      decision: 'discarded', operation: null, operation_token: null, status_detail: null,
    })
  })

  it('allows a dead operation lease to be reclaimed', () => {
    mk('a', 0)
    expect(claimPrDeliveryOperation(db, 'a', 'building', 'discard', 'dead', 10_000, 1_000)).toBe(true)
    expect(claimPrDeliveryOperation(db, 'a', 'building', 'publish', 'next', 11_001, 1_000)).toBe(true)
    expect(getPrDelivery(db, 'a')).toMatchObject({ operation: 'publish', operation_token: 'next' })
  })

  it('lets only the current lease owner commit the post-effect transition', () => {
    mk('a', 0)
    expect(claimPrDeliveryOperation(db, 'a', 'building', 'publish', 'old', 10_000, 1_000)).toBe(true)
    expect(claimPrDeliveryOperation(db, 'a', 'building', 'discard', 'new', 11_001, 1_000)).toBe(true)
    expect(transitionClaimedDecision(db, 'a', 'building', 'pr_ready', 'old')).toBe(false)
    expect(transitionClaimedDecision(db, 'a', 'building', 'discarded', 'new')).toBe(true)
    expect(getPrDelivery(db, 'a')?.decision).toBe('discarded')
  })
})

describe('JSON round-trips + snapshot mapper', () => {
  it('round-trips ticket_ids, branches, worktree_ids and run_ids through the snapshot', () => {
    mk('a', 2, { ticketIds: [3, 5, 8], originConversationId: 'conv-1', originSurface: 'agent-chat' })
    transitionDecision(db, 'a', 'building', 'on_review', {
      branches: [
        { ticketId: 3, branch: 'sr/p/ticket-3', succeeded: true },
        { ticketId: 5, branch: 'sr/p/ticket-5', succeeded: false },
      ],
      worktreeIds: ['wt-3', 'wt-5'],
      runIds: ['run-3', 'run-5'],
    })
    const snap = toPrDeliverySnapshot(getPrDelivery(db, 'a')!)
    expect(snap).toMatchObject({
      id: 'a',
      railIndex: 2,
      loopId: 'loop-1',
      railKey: '2-loop-1',
      ticketIds: [3, 5, 8],
      baseBranch: 'main',
      branch: null,
      prUrl: null,
      prNumber: null,
      prState: 'none',
      decision: 'on_review',
      implementationOutcome: 'running',
      deliveryOutcome: 'pending',
      statusCode: 'implementation_running',
      statusDetail: null,
      deliverySha: null,
      isContinuation: false,
      supersedesDeliveryId: null,
      restoredFromDeliveryId: null,
      operation: null,
      cleanupWarnings: [],
      safetyArchives: [],
      branches: [
        { ticketId: 3, branch: 'sr/p/ticket-3', succeeded: true },
        { ticketId: 5, branch: 'sr/p/ticket-5', succeeded: false },
      ],
      units: [
        { ticketId: 3, branch: 'sr/p/ticket-3', succeeded: true },
        { ticketId: 5, branch: 'sr/p/ticket-5', succeeded: false },
      ],
      loopName: 'Implement',
      worktreeIds: ['wt-3', 'wt-5'],
      runIds: ['run-3', 'run-5'],
      originSurface: 'agent-chat',
      originConversationId: 'conv-1',
      createdAt: snap.createdAt,
      updatedAt: snap.updatedAt,
    })
    expect(snap.createdAt).toBeTruthy()
    expect(snap.updatedAt).toBeTruthy()
  })

  it('snapshot tolerates corrupt JSON columns (falls back to [])', () => {
    mk('a', 0)
    db.prepare(`UPDATE rail_pr_deliveries SET ticket_ids = 'not-json', branches = '{"x":1}', run_ids = 'nope' WHERE id = 'a'`).run()
    const snap = toPrDeliverySnapshot(getPrDelivery(db, 'a')!)
    expect(snap.ticketIds).toEqual([])
    expect(snap.branches).toEqual([])
    expect(snap.worktreeIds).toEqual([])
    expect(snap.runIds).toEqual([])
    expect(snap.safetyArchives).toEqual([])
  })

  it('coerces and deduplicates every exact safety archive path without dropping older pointers', () => {
    mk('a', 0)
    const paths = Array.from({ length: 10 }, (_, index) => `/archive/${index} `)
    transitionDecision(db, 'a', 'building', 'building', {
      safetyArchives: [...paths, paths[9]],
    })

    const snap = toPrDeliverySnapshot(getPrDelivery(db, 'a')!)
    expect(snap.safetyArchives).toEqual(paths)
    expect(JSON.parse(getPrDelivery(db, 'a')!.safety_archives)).toEqual(paths)

    db.prepare(`UPDATE rail_pr_deliveries SET safety_archives = '["/safe",42,"","/safe"]' WHERE id = 'a'`).run()
    expect(toPrDeliverySnapshot(getPrDelivery(db, 'a')!).safetyArchives).toEqual(['/safe'])
  })

  it('atomically appends safety archives without depending on lifecycle state', () => {
    mk('a', 0)
    expect(appendPrDeliverySafetyArchive(db, 'a', '/archive/one')).toEqual(['/archive/one'])
    transitionDecision(db, 'a', 'building', 'on_review')
    expect(appendPrDeliverySafetyArchive(db, 'a', '/archive/two')).toEqual([
      '/archive/one', '/archive/two',
    ])
    expect(appendPrDeliverySafetyArchive(db, 'a', '/archive/one')).toEqual([
      '/archive/two', '/archive/one',
    ])
    expect(appendPrDeliverySafetyArchive(db, 'missing', '/archive/lost')).toBeNull()
  })

  it('toRailPrStateMessage builds the exact rail.pr_state wire payload from a snapshot', () => {
    mk('a', 1, { ticketIds: [4, 6], originSurface: 'agent-chat', originConversationId: 'conv-7' })
    transitionDecision(db, 'a', 'building', 'on_review', {
      branches: [{ ticketId: 4, branch: 'sr/p/ticket-4', succeeded: true }],
      worktreeIds: ['wt-4'],
      runIds: ['run-4', 'run-6'],
    })
    const msg = toRailPrStateMessage('proj-1', toPrDeliverySnapshot(getPrDelivery(db, 'a')!))
    expect(msg).toMatchObject({
      type: 'rail.pr_state',
      projectId: 'proj-1',
      railIndex: 1,
      prDeliveryId: 'a',
      railKey: '1-loop-1',
      ticketIds: [4, 6],
      baseBranch: 'main',
      branch: null,
      prUrl: null,
      prNumber: null,
      prState: 'none',
      decision: 'on_review',
      implementationOutcome: 'running',
      deliveryOutcome: 'pending',
      statusCode: 'implementation_running',
      restoredFromDeliveryId: null,
      safetyArchives: [],
      units: [{ ticketId: 4, branch: 'sr/p/ticket-4', succeeded: true }],
      runIds: ['run-4', 'run-6'],
      originConversationId: 'conv-7',
    })
  })

  it('toPrDecisionCardEnvelope builds the exact agent-chat card envelope (incl. runIds) from a snapshot', () => {
    mk('a', 3, { ticketIds: [9], originSurface: 'agent-chat', originConversationId: 'conv-2' })
    transitionDecision(db, 'a', 'building', 'building', { runIds: ['run-9'] })
    const envelope = toPrDecisionCardEnvelope('proj-1', toPrDeliverySnapshot(getPrDelivery(db, 'a')!))
    expect(envelope).toMatchObject({
      kind: 'pr_decision',
      prDeliveryId: 'a',
      railIndex: 3,
      projectId: 'proj-1',
      baseBranch: 'main',
      ticketIds: [9],
      decision: 'building',
      implementationOutcome: 'running',
      deliveryOutcome: 'pending',
      statusCode: 'implementation_running',
      restoredFromDeliveryId: null,
      safetyArchives: [],
      units: [],
      prUrl: null,
      prNumber: null,
      prState: 'none',
      branch: null,
      runIds: ['run-9'],
    })
  })
})

describe('launch spec snapshot + settle evidence (migration 56)', () => {
  const snapshot = [
    { ticketId: 1, title: 'Add login', description: 'The user needs to sign in.', labels: ['auth'] },
    { ticketId: 2, title: null, description: null, labels: [] },
  ]

  it('freezes the covered tickets at INSERT and reads them back', () => {
    const row = mk('a', 0, { specSnapshot: snapshot })
    expect(readSpecSnapshot(row.spec_snapshot)).toEqual(snapshot)
  })

  it('stores NULL when no snapshot is supplied (legacy launches)', () => {
    const row = mk('a', 0)
    expect(row.spec_snapshot).toBeNull()
    expect(readSpecSnapshot(row.spec_snapshot)).toBeNull()
  })

  it('stores NULL for an empty snapshot rather than an empty array', () => {
    expect(mk('a', 0, { specSnapshot: [] }).spec_snapshot).toBeNull()
  })

  it('is immune to a later edit of the live spec (the row is the frozen copy)', () => {
    const row = mk('a', 0, { specSnapshot: snapshot })
    // Mutating the caller's array must not reach the persisted row.
    snapshot[0].title = 'Renamed after launch'
    expect(readSpecSnapshot(row.spec_snapshot)?.[0].title).toBe('Add login')
    snapshot[0].title = 'Add login'
  })

  it('bounds an overlong description and the label list', () => {
    const row = mk('a', 0, {
      specSnapshot: [{
        ticketId: 1,
        title: 't',
        description: 'x'.repeat(40_000),
        labels: Array.from({ length: 50 }, (_, i) => `l${i}`),
      }],
    })
    const stored = readSpecSnapshot(row.spec_snapshot)!
    expect(stored[0].description).toHaveLength(32_768)
    expect(stored[0].labels).toHaveLength(32)
  })

  it('a continuation generation carries its OWN launch snapshot', () => {
    mk('a', 0, { specSnapshot: [{ ticketId: 1, title: 'v1 wording', description: null, labels: [] }] })
    transitionDecision(db, 'a', 'building', 'on_review')
    const { delivery } = createPrDeliveryGeneration(db, {
      id: 'b',
      railIndex: 0,
      loopId: 'loop-1',
      railKey: '0-loop-1',
      ticketIds: [1, 2],
      baseBranch: 'main',
      loopName: 'Implement',
      originSurface: 'dashboard',
      specSnapshot: [{ ticketId: 1, title: 'v2 wording', description: null, labels: [] }],
    }, { id: 'a', decision: 'on_review' })
    expect(readSpecSnapshot(delivery.spec_snapshot)?.[0].title).toBe('v2 wording')
    expect(readSpecSnapshot(getPrDelivery(db, 'a')!.spec_snapshot)?.[0].title).toBe('v1 wording')
  })

  it('readSpecSnapshot rejects malformed and non-array payloads', () => {
    expect(readSpecSnapshot('{oops')).toBeNull()
    expect(readSpecSnapshot('{"ticketId":1}')).toBeNull()
    expect(readSpecSnapshot(null)).toBeNull()
  })

  it('persists settle evidence through the decision patch and round-trips it', () => {
    mk('a', 0)
    const evidence = harvestDeliveryEvidence(
      { readEvents: () => [] },
      [{ ticketId: 1, runId: 'run-1', worktreePath: null }],
    )
    expect(transitionDecision(db, 'a', 'building', 'on_review', { settleEvidence: evidence })).toBe(true)
    const row = getPrDelivery(db, 'a')!
    expect(row.decision).toBe('on_review')
    expect(readSettleEvidence(row.settle_evidence)).toEqual(evidence)
  })

  it('leaves settle evidence NULL until settle', () => {
    const row = mk('a', 0)
    expect(row.settle_evidence).toBeNull()
    expect(readSettleEvidence(row.settle_evidence)).toBeNull()
  })

  it('an explicit null patch clears the column without disturbing the decision', () => {
    mk('a', 0)
    transitionDecision(db, 'a', 'building', 'on_review', {
      settleEvidence: harvestDeliveryEvidence({ readEvents: () => [] }, []),
    })
    expect(transitionDecision(db, 'a', 'on_review', 'on_review', { settleEvidence: null })).toBe(true)
    expect(getPrDelivery(db, 'a')!.settle_evidence).toBeNull()
  })
})
