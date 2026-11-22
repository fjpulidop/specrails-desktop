import { reconcileMilestoneChain, type ChainPlan, type ReconcileDelivery, type ReconcileInput, type ReconcileRun, type ReconcileTicket } from '../../../../modules/builder/runtime/milestone-chain-reconcile'
import type { MilestoneChainSnapshot } from '../../../../modules/builder/runtime/milestone-progress'

// Reconcile scenarios (docs/internals/project-builder.md#chain-reconciliation)
// built with the REAL reconcile function, one per ChainOfferKind, shared by the
// chain projector and specrails_blueprint tests.

export const ticket = (id: number, status = 'todo'): ReconcileTicket => ({ id, status, labels: ['M1'], title: `Spec ${id}`, executionOrder: id })
const delivery = (id: string, ticketId: number, decision: string, over: Partial<ReconcileDelivery> = {}): ReconcileDelivery =>
  ({ id, railIndex: 3, ticketIds: [ticketId], decision, implementationOutcome: 'succeeded', branch: `feat/${ticketId}`, runIds: [`run-${id}`], createdAt: '2026-11-21T10:00:00.000Z', ...over })
const run = (id: string, ticketId: number, status: string, over: Partial<ReconcileRun> = {}): ReconcileRun =>
  ({ id, ticketIds: [ticketId], railIndex: 3, status, outcome: status === 'completed' ? 'success' : null, pauseReason: null, forkOf: null, engineVersion: 2, startedAt: '2026-11-21T10:00:00.000Z', ...over })

export function plan(over: Partial<ReconcileInput> & { launched?: ReconcileInput['chain']['launched']; retryChunk?: number | null; pauseReason?: string; currentDeliveryId?: string } = {}): ChainPlan {
  const { launched, retryChunk, pauseReason, currentDeliveryId, ...rest } = over
  return reconcileMilestoneChain({
    chain: { milestoneN: 1, status: 'paused', chunks: [[1], [2], [3]], launched: launched ?? [], retryChunk: retryChunk ?? null, headBranch: null, integrationBranch: 'main', pauseReason: pauseReason ?? null, currentDeliveryId: currentDeliveryId ?? null },
    tickets: [ticket(1), ticket(2), ticket(3)], deliveries: [], runs: [], integrates: true, ...rest,
  })
}

export function chainSnapshot(over: Partial<MilestoneChainSnapshot> = {}): MilestoneChainSnapshot {
  return {
    id: 'c1', milestoneN: 1, mode: 'sequential', status: 'paused', pauseReason: 'chunk_failed', autoAdvance: true, nextChunk: 2, totalChunks: 3,
    currentRailIndex: 3, headBranch: null, retryChunk: 0, launched: [], createdAt: '2026-11-21T09:00:00.000Z', updatedAt: '2026-11-21T10:00:00.000Z',
    plan: null, nextEngine: { provider: 'claude', model: 'sonnet', reasoningEffort: null, source: 'usual' }, ...over,
  }
}

/** Every reconcile scenario of docs/internals/project-builder.md#chain-reconciliation, by the offer it yields. */
export const SCENARIOS: Record<string, () => ChainPlan> = {
  complete: () => plan({ tickets: [ticket(1, 'done'), ticket(2, 'done'), ticket(3, 'done')] }),
  next: () => plan({ tickets: [ticket(1, 'done'), ticket(2), ticket(3)], launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: ['x'], deliveryId: 'gone' }], retryChunk: 0 }),
  launch: () => plan({ launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: [], deliveryId: null }] }),
  retry: () => plan({ deliveries: [delivery('d', 1, 'discarded', { implementationOutcome: 'failed' })] }),
  follow_run: () => plan({ tickets: [ticket(1, 'done'), ticket(2, 'in_progress'), ticket(3)], deliveries: [delivery('manual', 2, 'building', { runIds: ['m'], railIndex: 5 })], runs: [run('m', 2, 'running', { railIndex: 5 })] }),
  resume_run: () => plan({ runs: [run('p', 1, 'paused', { pauseReason: 'user_paused' })] }),
  answer_run: () => plan({ runs: [run('q', 1, 'paused')] }),
  integrate: () => plan({ tickets: [ticket(1, 'on_review'), ticket(2), ticket(3)], deliveries: [delivery('manual', 1, 'on_review', { railIndex: 6 })] }),
  rebuild: () => plan({ tickets: [ticket(1, 'done'), ticket(2, 'done'), ticket(3, 'on_review')], deliveries: [delivery('manual-3', 3, 'on_review', { railIndex: 0 })], pauseReason: 'integration_failed:merge_failed', currentDeliveryId: 'manual-3' }),
  resume_failed_step: () => plan({ deliveries: [delivery('d', 1, 'implementation_failed', { implementationOutcome: 'failed', runIds: ['r1'] })], runs: [run('r1', 1, 'completed', { outcome: 'failed' })], launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: ['r1'], deliveryId: 'd' }], retryChunk: 0 }),
}

