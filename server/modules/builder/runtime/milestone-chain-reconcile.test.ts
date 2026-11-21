import { describe, it, expect } from 'vitest'
import {
  deriveChainSpec,
  reconcileMilestoneChain,
  type ReconcileDelivery,
  type ReconcileInput,
  type ReconcileRun,
  type ReconcileTicket,
} from './milestone-chain-reconcile'

// One test per row of the casuistry table (docs/internals/project-builder.md
// #chain-reconciliation): §1 spec states, §2 next actions + offers.

const ticket = (id: number, status = 'todo', over: Partial<ReconcileTicket> = {}): ReconcileTicket =>
  ({ id, status, labels: ['M1'], title: `Spec ${id}`, executionOrder: id, ...over })
const delivery = (id: string, ticketId: number, decision: string, over: Partial<ReconcileDelivery> = {}): ReconcileDelivery =>
  ({ id, railIndex: 3, ticketIds: [ticketId], decision, implementationOutcome: 'succeeded', branch: `feat/${ticketId}`, runIds: [`run-${id}`], createdAt: '2026-11-21T10:00:00.000Z', ...over })
const run = (id: string, ticketId: number, status: string, over: Partial<ReconcileRun> = {}): ReconcileRun =>
  ({ id, ticketIds: [ticketId], railIndex: 3, status, outcome: status === 'completed' ? 'success' : null, pauseReason: null, forkOf: null, engineVersion: 2, startedAt: '2026-11-21T10:00:00.000Z', ...over })

function input(over: Partial<ReconcileInput> & { chunks?: number[][]; launched?: ReconcileInput['chain']['launched']; retryChunk?: number | null } = {}): ReconcileInput {
  const { chunks, launched, retryChunk, ...rest } = over
  return {
    chain: { milestoneN: 1, status: 'paused', chunks: chunks ?? [[1], [2], [3]], launched: launched ?? [], retryChunk: retryChunk ?? null, headBranch: null, integrationBranch: 'main' },
    tickets: [ticket(1), ticket(2), ticket(3)],
    deliveries: [],
    runs: [],
    integrates: true,
    ...rest,
  }
}

describe('§1 spec state', () => {
  it('S1 a done ticket is done whatever its runs and deliveries say', () => {
    expect(deriveChainSpec(ticket(1, 'done'), [delivery('d', 1, 'discarded')], [run('r', 1, 'running')]).state).toBe('done')
  })

  it('S2 a spec removed from the milestone (deleted, cancelled, label dropped) leaves the plan', () => {
    const plan = reconcileMilestoneChain(input({ tickets: [ticket(1, 'cancelled'), ticket(2, 'todo', { labels: ['M2'] })] }))
    expect(plan.order).toEqual([])
    expect(plan.action).toEqual({ kind: 'complete' })
  })

  it('S3 a running run (chain or manual) makes the spec running', () => {
    const spec = deriveChainSpec(ticket(1, 'in_progress'), [delivery('d', 1, 'building', { runIds: ['r'] })], [run('r', 1, 'running')])
    expect(spec).toMatchObject({ state: 'running', runId: 'r', deliveryId: 'd' })
  })

  it('S4 a run paused by the person, a restart, the budget or a limit is resumable in place', () => {
    for (const [reason, kind] of [['user_paused', 'user'], ['restart', 'restart'], ['budget_paused', 'budget'], ['limit_paused', 'limit']] as const) {
      expect(deriveChainSpec(ticket(1, 'in_progress'), [], [run('r', 1, 'paused', { pauseReason: reason })])).toMatchObject({ state: 'paused', pauseKind: kind })
    }
  })

  it('S5 a run paused on a question or an approval waits for the person', () => {
    expect(deriveChainSpec(ticket(1, 'in_progress'), [], [run('r', 1, 'paused')])).toMatchObject({ state: 'paused', pauseKind: 'decision' })
  })

  it('S6 a building delivery without a live run row is still running (settle in flight)', () => {
    expect(deriveChainSpec(ticket(1, 'in_progress'), [delivery('d', 1, 'building')], [run('run-d', 1, 'completed')]).state).toBe('running')
  })

  it('S7 a succeeded delivery under review, no changes, or a PR is delivered', () => {
    for (const decision of ['on_review', 'no_changes', 'pr_draft', 'pr_ready']) {
      expect(deriveChainSpec(ticket(1, 'on_review'), [delivery('d', 1, decision)], []).state).toBe('delivered')
    }
    // …but never a partial or failed implementation on review.
    expect(deriveChainSpec(ticket(1, 'todo'), [delivery('d', 1, 'on_review', { implementationOutcome: 'partially_succeeded' })], []).state).toBe('failed')
  })

  it('S8 a merged delivery is integrated even when a later duplicate attempt failed or was discarded', () => {
    const spec = deriveChainSpec(ticket(6, 'todo'), [
      delivery('merged', 6, 'merged', { createdAt: '2026-11-21T12:00:00.000Z' }),
      delivery('dup', 6, 'implementation_failed', { createdAt: '2026-11-21T13:00:00.000Z', implementationOutcome: 'failed' }),
    ], [])
    expect(spec).toMatchObject({ state: 'integrated', deliveryId: 'merged' })
  })

  it('S9 a failed delivery is resumable from its newest run unless that run was already continued', () => {
    const failed = delivery('d', 1, 'implementation_failed', { implementationOutcome: 'failed', runIds: ['r1'] })
    expect(deriveChainSpec(ticket(1), [failed], [run('r1', 1, 'completed', { outcome: 'failed' })])).toMatchObject({ state: 'failed', resumableRunId: 'r1' })
    expect(deriveChainSpec(ticket(1), [failed], [run('r1', 1, 'completed', { outcome: 'failed' }), run('r2', 1, 'completed', { outcome: 'failed', forkOf: 'r1' })]).resumableRunId).toBeNull()
    // Engine v1 runs cannot continue from a step.
    expect(deriveChainSpec(ticket(1), [failed], [run('r1', 1, 'completed', { outcome: 'failed', engineVersion: 1 })]).resumableRunId).toBeNull()
  })

  it('S10 a spec on review without a delivery row is delivered with nothing to integrate', () => {
    expect(deriveChainSpec(ticket(1, 'on_review'), [], [])).toMatchObject({ state: 'delivered', deliveryId: null })
  })

  it('S11 a spec whose only deliveries were discarded is pending again (last attempt failed when it did)', () => {
    expect(deriveChainSpec(ticket(1), [delivery('d', 1, 'discarded')], [])).toMatchObject({ state: 'pending', lastAttemptFailed: false })
    expect(deriveChainSpec(ticket(1), [delivery('d', 1, 'discarded', { implementationOutcome: 'failed' })], [])).toMatchObject({ state: 'pending', lastAttemptFailed: true })
  })

  it('S12 a spec that never ran is pending', () => {
    expect(deriveChainSpec(ticket(1), [], [])).toMatchObject({ state: 'pending', lastAttemptFailed: false })
  })
})

describe('§2 next action and offers', () => {
  it('A1 every spec settled completes the chain', () => {
    const plan = reconcileMilestoneChain(input({ tickets: [ticket(1, 'done'), ticket(2, 'done'), ticket(3, 'done')] }))
    expect(plan.action).toEqual({ kind: 'complete' })
    expect(plan.auto).toEqual({ kind: 'proceed', action: { kind: 'complete' } })
    expect(plan.offers.map((o) => o.kind)).toEqual(['complete'])
    expect(plan).toMatchObject({ settled: 3, total: 3 })
  })

  it('A2 continues with the next pending spec when the paused rail\'s spec is already delivered', () => {
    const plan = reconcileMilestoneChain(input({
      tickets: [ticket(1, 'done'), ticket(2), ticket(3)],
      launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: ['x'], deliveryId: 'gone' }],
      retryChunk: 0,
    }))
    expect(plan.action).toEqual({ kind: 'launch', ticketId: 2, retry: false })
    expect(plan.offers[0]).toMatchObject({ kind: 'next', ticketId: 2, title: 'Spec 2', from: 'recommended' })
    expect(plan.offers).toHaveLength(1)
    expect(plan).toMatchObject({ pausedTicketId: 1, pausedSpecSettled: true })
  })

  it('A2 a fresh pending spec that is the one the chain stopped on offers Launch, not "next"', () => {
    const plan = reconcileMilestoneChain(input({ launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: [], deliveryId: null }] }))
    expect(plan.offers[0]).toMatchObject({ kind: 'launch', ticketId: 1 })
  })

  it('A3 a pending spec whose last attempt failed is never retried automatically', () => {
    const plan = reconcileMilestoneChain(input({ deliveries: [delivery('d', 1, 'discarded', { implementationOutcome: 'failed' })] }))
    expect(plan.action).toEqual({ kind: 'launch', ticketId: 1, retry: true })
    expect(plan.auto).toEqual({ kind: 'pause', reason: 'chunk_failed', ticketId: 1 })
    expect(plan.offers.map((o) => o.kind)).toEqual(['retry'])
  })

  it('A4 a spec someone is already running is adopted, never launched twice', () => {
    const plan = reconcileMilestoneChain(input({
      tickets: [ticket(1, 'done'), ticket(2, 'in_progress'), ticket(3)],
      deliveries: [delivery('manual', 2, 'building', { runIds: ['m'], railIndex: 5 })],
      runs: [run('m', 2, 'running', { railIndex: 5 })],
    }))
    expect(plan.action).toEqual({ kind: 'adopt_run', ticketId: 2, runId: 'm', deliveryId: 'manual', railIndex: 5 })
    expect(plan.auto).toEqual({ kind: 'proceed', action: plan.action })
    expect(plan.offers[0]).toMatchObject({ kind: 'follow_run', ticketId: 2, runId: 'm' })
  })

  it('A5 a run the person paused is resumed in place on Resume, and only adopted automatically', () => {
    const plan = reconcileMilestoneChain(input({ runs: [run('p', 1, 'paused', { pauseReason: 'user_paused' })] }))
    expect(plan.action).toMatchObject({ kind: 'resume_run', ticketId: 1, runId: 'p', pauseKind: 'user' })
    expect(plan.auto).toEqual({ kind: 'proceed', action: { kind: 'adopt_run', ticketId: 1, runId: 'p', deliveryId: null, railIndex: 3 } })
    expect(plan.offers.map((o) => o.kind)).toEqual(['resume_run'])
  })

  it('A6 a run waiting for an answer is followed, never resumed by the chain', () => {
    const plan = reconcileMilestoneChain(input({ runs: [run('q', 1, 'paused')] }))
    expect(plan.action).toMatchObject({ kind: 'answer_run', runId: 'q' })
    expect(plan.auto.kind).toBe('proceed')
    expect(plan.offers.map((o) => o.kind)).toEqual(['answer_run'])
  })

  it('A7 a delivery under review (manual or the chain\'s) is integrated before the next spec', () => {
    const plan = reconcileMilestoneChain(input({
      tickets: [ticket(1, 'on_review'), ticket(2), ticket(3)],
      deliveries: [delivery('manual', 1, 'on_review', { railIndex: 6 })],
    }))
    expect(plan.action).toEqual({ kind: 'integrate', ticketId: 1, deliveryId: 'manual', railIndex: 6 })
    expect(plan.offers[0]).toMatchObject({ kind: 'integrate', ticketId: 1, nextTicketId: 2 })
    // Legacy stacking: the delivered spec is settled and the next rail stacks on it.
    const legacy = reconcileMilestoneChain({ ...input({ tickets: [ticket(1, 'on_review'), ticket(2), ticket(3)], deliveries: [delivery('manual', 1, 'on_review')] }), integrates: false })
    expect(legacy.action).toEqual({ kind: 'launch', ticketId: 2, retry: false })
    expect(legacy.baseBranch).toBe('feat/1')
    expect(legacy.baseDeliveryIds).toEqual(['manual'])
  })

  it('A8 a genuinely failed spec with a resumable run offers the failed step first and a fresh retry second', () => {
    const plan = reconcileMilestoneChain(input({
      deliveries: [delivery('d', 1, 'implementation_failed', { implementationOutcome: 'failed', runIds: ['r1'] })],
      runs: [run('r1', 1, 'completed', { outcome: 'failed' })],
      launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: ['r1'], deliveryId: 'd' }],
      retryChunk: 0,
    }))
    expect(plan.action).toEqual({ kind: 'resume_failed', ticketId: 1, runId: 'r1', deliveryId: 'd', railIndex: 3 })
    expect(plan.auto).toEqual({ kind: 'pause', reason: 'chunk_failed', ticketId: 1 })
    expect(plan.offers.map((o) => [o.kind, o.from])).toEqual([['resume_failed_step', 'failed_step'], ['retry_from_start', 'start']])
    expect(plan.pausedSpecSettled).toBe(false)
  })

  it('A9 a failed spec without a resumable run offers only a retry', () => {
    const plan = reconcileMilestoneChain(input({ deliveries: [delivery('d', 1, 'pr_failed', { runIds: [] })] }))
    expect(plan.action).toEqual({ kind: 'launch', ticketId: 1, retry: true })
    expect(plan.offers.map((o) => o.kind)).toEqual(['retry'])
  })
})

describe('reconciliation scenarios', () => {
  it('the generala shape: #6 merged by hand twice, the chain\'s own #6 rail stopped and discarded → continue with #7', () => {
    const plan = reconcileMilestoneChain({
      chain: {
        milestoneN: 1, status: 'paused', chunks: [[5], [6], [7], [8], [9]], retryChunk: 1, headBranch: 'feat/5-deliver-a-complete-local-two-player-match', integrationBranch: 'main',
        launched: [
          { chunk: 1, railIndex: 3, ticketIds: [5], runIds: ['662c'], deliveryId: '2d82' },
          { chunk: 2, railIndex: 3, ticketIds: [6], runIds: ['b061'], deliveryId: '538a' },
        ],
      },
      tickets: [
        ...[1, 2, 3, 4, 5, 6].map((id) => ticket(id, 'done', { prerequisites: id > 1 ? [id - 1] : [] })),
        ticket(7, 'todo', { title: 'Animate the tabletop and screen transitions', prerequisites: [5] }),
        ticket(8, 'todo', { prerequisites: [4] }),
        ticket(9, 'todo', { prerequisites: [8] }),
      ],
      deliveries: [
        delivery('2d82', 5, 'merged', { createdAt: '2026-11-21 07:18:12' }),
        delivery('6344', 6, 'merged', { createdAt: '2026-11-21 07:44:03', runIds: ['fork-ce6e'] }),
        delivery('9fad', 6, 'merged', { createdAt: '2026-11-21 12:03:07', runIds: ['fork-06bc'] }),
        delivery('538a', 6, 'discarded', { createdAt: '2026-11-21 13:16:57', implementationOutcome: 'failed', runIds: ['b061'] }),
      ],
      runs: [
        run('d587', 6, 'completed', { outcome: 'failed' }),
        run('fork-ce6e', 6, 'completed', { outcome: 'success', forkOf: 'fork-cd2c' }),
        run('68446', 6, 'completed', { outcome: 'failed' }),
        run('fork-06bc', 6, 'completed', { outcome: 'success', forkOf: '68446' }),
        run('b061', 6, 'completed', { outcome: 'stopped' }),
      ],
      integrates: true,
    })
    expect(plan.order).toEqual([5, 6, 7, 8, 9])
    expect(plan.specs.map((s) => s.state)).toEqual(['done', 'done', 'pending', 'pending', 'pending'])
    expect(plan.action).toEqual({ kind: 'launch', ticketId: 7, retry: false })
    expect(plan.auto.kind).toBe('proceed')
    expect(plan.offers).toEqual([expect.objectContaining({ kind: 'next', ticketId: 7, title: 'Animate the tabletop and screen transitions' })])
    expect(plan).toMatchObject({ pausedTicketId: 6, pausedSpecSettled: true, settled: 2, total: 5, baseBranch: null })
  })

  it('a later spec delivered by hand out of order is skipped (merged) or integrated (on review) when the chain reaches it', () => {
    const base = input({ tickets: [ticket(1, 'done'), ticket(2), ticket(3, 'done')] })
    expect(reconcileMilestoneChain(base).action).toEqual({ kind: 'launch', ticketId: 2, retry: false })
    const reached = reconcileMilestoneChain({ ...base, tickets: [ticket(1, 'done'), ticket(2, 'done'), ticket(3, 'done')] })
    expect(reached.action).toEqual({ kind: 'complete' })
  })

  it('a manual delivery later discarded makes the spec pending again', () => {
    const plan = reconcileMilestoneChain(input({
      tickets: [ticket(1, 'done'), ticket(2, 'todo'), ticket(3)],
      deliveries: [delivery('manual', 2, 'discarded')],
    }))
    expect(plan.action).toEqual({ kind: 'launch', ticketId: 2, retry: false })
  })

  it('specs added to the milestone after launch join the order; drafts and already-done specs do not', () => {
    const plan = reconcileMilestoneChain(input({
      chunks: [[1]],
      tickets: [ticket(1, 'done'), ticket(4, 'todo', { executionOrder: 0 }), ticket(5, 'draft'), ticket(6, 'done'), ticket(7, 'on_review')],
    }))
    expect(plan.order).toEqual([4, 1])
    expect(plan.action).toEqual({ kind: 'launch', ticketId: 4, retry: false })
  })

  it('prerequisites edited after launch re-order the remaining specs', () => {
    const plan = reconcileMilestoneChain(input({ tickets: [ticket(1), ticket(2, 'todo', { prerequisites: [3] }), ticket(3)] }))
    expect(plan.order).toEqual([1, 3, 2])
  })

  it('a chain delivery whose ticket ids were lost still belongs to the spec it was launched for', () => {
    const plan = reconcileMilestoneChain(input({
      deliveries: [delivery('d', 1, 'merged', { ticketIds: [] })],
      launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: [], deliveryId: 'd' }],
    }))
    expect(plan.specs[0].state).toBe('integrated')
    expect(plan.action).toMatchObject({ kind: 'launch', ticketId: 2 })
  })
})
