import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import {
  createPrDelivery,
  getPrDelivery,
  getActivePrDeliveryByRail,
  listActivePrDeliveries,
  transitionDecision,
  toPrDeliverySnapshot,
  toRailPrStateMessage,
  toPrDecisionCardEnvelope,
  isTerminalPrDecision,
  TERMINAL_PR_DECISIONS,
  ACTIVE_PR_DECISIONS,
  type CreatePrDeliveryInput,
} from './rail-pr-store'

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
    mk('new', 0)
    mk('other-rail', 1)
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
    transitionDecision(db, 'a', 'building', 'discarded')
    expect(listActivePrDeliveries(db)).toEqual([])
  })
})

describe('decision sets', () => {
  it('classifies terminal decisions', () => {
    expect(isTerminalPrDecision('merged')).toBe(true)
    expect(isTerminalPrDecision('discarded')).toBe(true)
    expect(isTerminalPrDecision('building')).toBe(false)
    expect(isTerminalPrDecision('on_review')).toBe(false)
    expect(isTerminalPrDecision('pr_draft')).toBe(false)
    expect(isTerminalPrDecision('pr_ready')).toBe(false)
    expect(isTerminalPrDecision('pr_failed')).toBe(false)
  })

  it('ACTIVE and TERMINAL sets partition the decision space', () => {
    for (const d of ACTIVE_PR_DECISIONS) expect(TERMINAL_PR_DECISIONS.has(d)).toBe(false)
    expect(ACTIVE_PR_DECISIONS.size + TERMINAL_PR_DECISIONS.size).toBe(7)
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
    expect(snap).toEqual({
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
      branches: [
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
  })

  it('toRailPrStateMessage builds the exact rail.pr_state wire payload from a snapshot', () => {
    mk('a', 1, { ticketIds: [4, 6], originSurface: 'agent-chat', originConversationId: 'conv-7' })
    transitionDecision(db, 'a', 'building', 'on_review', {
      branches: [{ ticketId: 4, branch: 'sr/p/ticket-4', succeeded: true }],
      worktreeIds: ['wt-4'],
      runIds: ['run-4', 'run-6'],
    })
    const msg = toRailPrStateMessage('proj-1', toPrDeliverySnapshot(getPrDelivery(db, 'a')!))
    expect(msg).toEqual({
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
      runIds: ['run-4', 'run-6'],
      originConversationId: 'conv-7',
    })
  })

  it('toPrDecisionCardEnvelope builds the exact agent-chat card envelope (incl. runIds) from a snapshot', () => {
    mk('a', 3, { ticketIds: [9], originSurface: 'agent-chat', originConversationId: 'conv-2' })
    transitionDecision(db, 'a', 'building', 'building', { runIds: ['run-9'] })
    const envelope = toPrDecisionCardEnvelope('proj-1', toPrDeliverySnapshot(getPrDelivery(db, 'a')!))
    expect(envelope).toEqual({
      kind: 'pr_decision',
      prDeliveryId: 'a',
      railIndex: 3,
      projectId: 'proj-1',
      baseBranch: 'main',
      ticketIds: [9],
      decision: 'building',
      prUrl: null,
      prNumber: null,
      prState: 'none',
      branch: null,
      runIds: ['run-9'],
    })
  })
})
