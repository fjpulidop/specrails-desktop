import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { MilestoneChainManager, chunkTickets, chainRailName, orderChainTickets, isBuilderRailName, MAX_TICKETS_PER_CHAIN_CHUNK, type MilestoneChainIO } from './milestone-chain'
import { getChain, listActiveChains, listChains, updateChain, parseLaunched } from './milestone-chain-store'
import type { PrDeliverySnapshot } from '../../delivery/runtime/rail-pr-store'
import type { Blueprint } from './blueprint-types'
import type { WsMessage } from '../../../types'

// The manager never touches HTTP or git directly — every side effect rides the
// injected IO, so these tests exercise the durable state machine end to end.

let db: DbInstance
let sent: WsMessage[]

function blueprint(): Blueprint {
  return {
    blueprintVersion: 1, product: { name: 'P', pitch: 'p', audience: 'a' }, coreFlow: 'f', platform: 'web',
    stack: { language: 'ts', framework: 'x', db: 'sqlite' }, assumptions: [], specsComplete: true, m1Specs: [],
    milestones: [{ id: 'm1', title: 'Skeleton', goal: 'g', status: 'committed', plannedSpecs: [] }, { id: 'm2', title: 'Two', goal: 'g', status: 'planned', plannedSpecs: [] }],
  }
}

function snap(over: Partial<PrDeliverySnapshot> & { id: string; railIndex: number }): PrDeliverySnapshot {
  return {
    loopId: null, railKey: `rail-${over.railIndex}`, ticketIds: [], baseBranch: 'main', branch: null, prUrl: null, prNumber: null,
    prState: 'none', decision: 'building', implementationOutcome: 'unknown', deliveryOutcome: 'unknown', statusCode: null, statusDetail: null,
    deliverySha: null, isContinuation: false, supersedesDeliveryId: null, restoredFromDeliveryId: null, operation: null, cleanupWarnings: [],
    safetyArchives: [], branches: [], units: [], loopName: 'Implement', worktreeIds: [], runIds: [], originSurface: 'dashboard', originConversationId: null,
    createdAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T10:00:00.000Z', ...over,
  } as PrDeliverySnapshot
}

interface Fake {
  io: MilestoneChainIO
  launches: Array<{ railIndex: number; body: { mode: string; baseBranch?: string; baseDeliveryIds?: string[] } }>
  rails: string[]
  deliveries: Map<string, PrDeliverySnapshot>
  deliveryByRail: Map<number, string>
  tickets: Array<{ id: number; status: string; labels: string[]; prerequisites?: number[]; executionOrder?: number | null }>
  renamed: Array<{ railIndex: number; name: string }>
  railLimit: number
  branches: Set<string>
  runs: Map<string, { settled: boolean; outcome: string | null }>
  failLaunch: { status: number; error: string } | null
  assignments: Array<{ railIndex: number; ticketIds: number[] }>
}

function fake(over: Partial<Fake> = {}): Fake {
  let nextRail = 3
  let nextRun = 1
  const f: Fake = {
    launches: [], rails: [], deliveries: new Map(), deliveryByRail: new Map(),
    tickets: [1, 2, 3].map((id) => ({ id, status: 'todo', labels: ['M1'] })),
    branches: new Set(['main']), runs: new Map(), failLaunch: null, assignments: [], renamed: [], railLimit: 12,
    io: null as unknown as MilestoneChainIO,
    ...over,
  }
  f.io = {
    createRail: async (name) => {
      if (3 + f.rails.length >= f.railLimit) return { ok: false, status: 400, error: 'rail_limit_reached' }
      f.rails.push(name); return { ok: true, railIndex: nextRail++ }
    },
    assignTickets: async (railIndex, ticketIds) => { f.assignments.push({ railIndex, ticketIds }); return { ok: true } },
    launch: async (railIndex, body) => {
      if (f.failLaunch) return { ok: false, ...f.failLaunch }
      f.launches.push({ railIndex, body })
      const runId = `run-${nextRun++}`
      f.runs.set(runId, { settled: false, outcome: null })
      const id = `d-${railIndex}`
      f.deliveries.set(id, snap({ id, railIndex, runIds: [runId] }))
      f.deliveryByRail.set(railIndex, id)
      // The launched tickets leave todo (the real route flips them in_progress).
      return { ok: true, loopRunIds: [runId] }
    },
    findRailByName: (name) => { const i = f.rails.indexOf(name); return i === -1 ? null : 3 + i },
    listRails: () => f.rails.map((name, i) => ({ railIndex: 3 + i, name })),
    renameRail: async (railIndex, name) => { f.rails[railIndex - 3] = name; f.renamed.push({ railIndex, name }); return { ok: true } },
    activeDeliveryForRail: (railIndex) => {
      const id = f.deliveryByRail.get(railIndex)
      const d = id ? f.deliveries.get(id) ?? null : null
      // Mirrors getActivePrDeliveryByRail: a terminal decision no longer holds the rail.
      return d && !['discarded', 'merged', 'completed', 'superseded'].includes(d.decision) ? d : null
    },
    getDelivery: (id) => f.deliveries.get(id) ?? null,
    branchExists: async (b) => f.branches.has(b),
    readTickets: () => f.tickets,
    readBlueprint: () => blueprint(),
    integrationBranch: async () => 'main',
    runState: (runId) => f.runs.get(runId) ?? null,
    broadcast: (m) => { sent.push(m) },
    now: () => 1_700_000_000_000,
  }
  return f
}

/** Settle the delivery of a rail: the rail.pr_state tap the manager observes. */
function settle(f: Fake, mgr: MilestoneChainManager, railIndex: number, decision: PrDeliverySnapshot['decision'], branch: string | null) {
  const id = f.deliveryByRail.get(railIndex)!
  const d = f.deliveries.get(id)!
  f.deliveries.set(id, { ...d, decision, branch })
  if (branch) f.branches.add(branch)
  mgr.observe({ type: 'rail.pr_state', prDeliveryId: id } as unknown as WsMessage)
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => { db = initDb(':memory:'); sent = [] })

describe('chunking + naming + ordering', () => {
  it('puts one spec on each rail and names the rail after it', () => {
    expect(MAX_TICKETS_PER_CHAIN_CHUNK).toBe(1)
    expect(chunkTickets([1, 2, 3])).toEqual([[1], [2], [3]])
    expect(chainRailName(1, [12])).toBe('M1 · #12')
    expect(chainRailName(2, [])).toBe('M2')
    expect(isBuilderRailName('M1 · #12')).toBe(true)
    expect(isBuilderRailName('M3')).toBe(true)
    expect(isBuilderRailName('M1 · 2')).toBe(true)
    expect(isBuilderRailName('Rail 1')).toBe(false)
    expect(isBuilderRailName(null)).toBe(false)
  })

  it('orders specs topologically by prerequisites, ties by execution_order then id', () => {
    expect(orderChainTickets([
      { id: 1, prerequisites: [3], executionOrder: 1 },
      { id: 2, prerequisites: [], executionOrder: 3 },
      { id: 3, prerequisites: [], executionOrder: 2 },
      { id: 4, prerequisites: [1, 2], executionOrder: 4 },
    ])).toEqual([3, 1, 2, 4])
    // Unset execution_order sorts last, then by id; outside prerequisites are ignored.
    expect(orderChainTickets([
      { id: 9, prerequisites: [99] },
      { id: 5, executionOrder: null },
      { id: 7, executionOrder: 1 },
    ])).toEqual([7, 5, 9])
    // A cycle never blocks the milestone: best-ranked remaining spec first.
    expect(orderChainTickets([
      { id: 1, prerequisites: [2], executionOrder: 1 },
      { id: 2, prerequisites: [1], executionOrder: 2 },
      { id: 3, prerequisites: [], executionOrder: 3 },
    ])).toEqual([3, 1, 2])
    expect(orderChainTickets([])).toEqual([])
  })
})

describe('MilestoneChainManager — sequential', () => {
  it('stacks grouped chunks from durable delivery history after restart without guessing a primary branch', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    await mgr.start(1)
    const first = f.deliveries.get('d-3')!
    f.deliveries.set(first.id, { ...first, executionManifest: {
      version: 1, groupId: first.id, projectId: 'p1', primaryRepositoryId: 'web', artifactRepositoryId: 'api',
      selectedRepositoryIds: ['api'], repositories: [],
    } })
    // This branch exists in the API repo only; the primary repo lookup would fail.
    settle(f, mgr, 3, 'on_review', null)
    await flush()
    expect(f.launches[1].body).toEqual({ mode: 'implement', baseDeliveryIds: ['d-3'] })
    const restored = new MilestoneChainManager(db, 'p1', f.io)
    settle(f, restored, 4, 'no_changes', null)
    await flush()
    expect(f.launches[2].body).toEqual({ mode: 'implement', baseDeliveryIds: ['d-3', 'd-4'] })
    expect(getChain(db, listChains(db)[0].id)?.head_branch).toBeNull()
  })

  it('start launches ONLY chunk 1, records the row, 409s a second start', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.status).toBe(202)
    expect(res.launched).toHaveLength(1)
    expect(res.launched[0]).toMatchObject({ chunk: 1, railIndex: 3, ticketIds: [1], runIds: ['run-1'], deliveryId: 'd-3' })
    expect(res.pending).toEqual([[2], [3]])
    expect(f.rails).toEqual(['M1 · #1'])
    expect(f.launches[0].body).toEqual({ mode: 'implement' })
    const row = getChain(db, res.chainId!)!
    expect(row).toMatchObject({ status: 'running', next_chunk: 1, current_rail_index: 3, current_delivery_id: 'd-3', integration_branch: 'main' })
    expect(sent.filter((m) => m.type === 'milestone.chain_changed')).toHaveLength(1)
    const again = await mgr.start(1)
    expect(again).toMatchObject({ ok: false, status: 409, error: 'chain_active', chainId: res.chainId })
  })

  it('advances on the delivery settle, STACKING chunk 2 on chunk 1 branch, and completes after the last chunk', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    settle(f, mgr, 3, 'on_review', 'feat/1-implement')
    await flush()
    expect(f.launches).toHaveLength(2)
    expect(f.launches[1]).toEqual({ railIndex: 4, body: { mode: 'implement', baseBranch: 'feat/1-implement' } })
    let row = getChain(db, chainId)!
    expect(row).toMatchObject({ status: 'running', next_chunk: 2, head_branch: 'feat/1-implement', current_rail_index: 4, current_delivery_id: 'd-4' })
    // A duplicate broadcast of chunk 1's settle is inert.
    settle(f, mgr, 3, 'on_review', 'feat/1-implement')
    await flush()
    expect(f.launches).toHaveLength(2)
    settle(f, mgr, 4, 'on_review', 'feat/2-implement')
    await flush()
    expect(f.launches[2].body.baseBranch).toBe('feat/2-implement')
    settle(f, mgr, 5, 'no_changes', null)
    await flush()
    row = getChain(db, chainId)!
    expect(row.status).toBe('completed')
    // no_changes keeps the previous head.
    expect(row.head_branch).toBe('feat/2-implement')
    expect(parseLaunched(row).map((l) => l.chunk)).toEqual([1, 2, 3])
    expect(listActiveChains(db)).toHaveLength(0)
    expect(mgr.listForProgress()[0]).toMatchObject({ id: chainId, status: 'completed', totalChunks: 3 })
  })

  it('a failed chunk pauses with a reason from the engine outcome and never skips ahead', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    mgr.onRunSettled('run-1', 'stalled') // engine hook fires first (delivery still building)
    expect(getChain(db, chainId)!.status).toBe('running')
    settle(f, mgr, 3, 'discarded', null)
    await flush()
    const row = getChain(db, chainId)!
    expect(row).toMatchObject({ status: 'paused', pause_reason: 'chunk_stalled' })
    expect(f.launches).toHaveLength(1)
    // Resume retries the SAME (failed) chunk from the current head (none =
    // integration) — never the next one (run 10dedd5a relaunched tickets 4–6
    // while 1–3 had failed). The failed delivery is `discarded` (terminal) here,
    // so the retry REUSES rail 3 instead of allocating a duplicate rail.
    expect(getChain(db, chainId)!.retry_chunk).toBe(0)
    const resumed = await mgr.resume(chainId)
    expect(resumed.ok).toBe(true)
    expect(f.launches).toHaveLength(2)
    expect(f.launches[1]).toMatchObject({ railIndex: 3, body: { mode: 'implement' } })
    expect(f.launches[1].body.baseBranch).toBeUndefined()
    expect(f.assignments.at(-1)).toEqual({ railIndex: 3, ticketIds: [1] })
    expect(f.rails).toHaveLength(1)
    const after = getChain(db, chainId)!
    expect(after).toMatchObject({ status: 'running', next_chunk: 1, pause_reason: null, retry_chunk: null })
    // The retry replaces the failed attempt's entry (one entry per chunk).
    expect(parseLaunched(after).map((l) => [l.chunk, l.railIndex])).toEqual([[1, 3]])
    // It then advances normally: chunk 2 stacks on chunk 1's delivered branch.
    settle(f, mgr, 3, 'on_review', 'feat/1-retry')
    await flush()
    expect(f.launches[2]).toMatchObject({ railIndex: 4, body: { baseBranch: 'feat/1-retry' } })
    expect(f.assignments.at(-1)).toEqual({ railIndex: 4, ticketIds: [2] })
  })

  it('a NEW chain for the same milestone reuses a free rail already named for the chunk instead of duplicating it', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const first = await mgr.start(1)
    const firstId = first.ok ? first.chainId! : ''
    mgr.cancel(firstId)
    // The old rail's delivery is discarded (terminal) → free; "M1 · 1" exists already.
    const id = f.deliveryByRail.get(3)!
    f.deliveries.set(id, { ...f.deliveries.get(id)!, decision: 'discarded' })
    const second = await mgr.start(1)
    expect(second.ok).toBe(true)
    expect(f.rails).toEqual(['M1 · #1'])
    expect(f.launches[1]).toMatchObject({ railIndex: 3 })
    expect(f.assignments.at(-1)).toEqual({ railIndex: 3, ticketIds: [1] })
    // …but never a rail whose delivery is still undecided.
    mgr.cancel(second.ok ? second.chainId! : '')
    const third = await mgr.start(1)
    expect(third.ok).toBe(true)
    expect(f.rails).toEqual(['M1 · #1', 'M1 · #1'])
    expect(f.launches[2]).toMatchObject({ railIndex: 4 })
  })

  it('a retry takes a FRESH rail while the failed delivery is still undecided on the old one', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    mgr.onRunSettled('run-1', 'failed')
    // implementation_failed is an ACTIVE (undecided) decision: the user has not reviewed it.
    settle(f, mgr, 3, 'implementation_failed', null)
    await flush()
    expect(getChain(db, chainId)).toMatchObject({ status: 'paused', pause_reason: 'chunk_failed', retry_chunk: 0 })
    await mgr.resume(chainId)
    expect(f.launches[1].railIndex).toBe(4)
    expect(f.assignments.at(-1)).toEqual({ railIndex: 4, ticketIds: [1] })
    expect(f.rails).toEqual(['M1 · #1', 'M1 · #1'])
    expect(getChain(db, chainId)).toMatchObject({ status: 'running', next_chunk: 1, current_rail_index: 4 })
  })

  it('a provider usage limit pauses the chain with its OWN reason (never a generic stall)', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    mgr.onRunSettled('run-1', 'stalled', 'provider_limit')
    settle(f, mgr, 3, 'implementation_failed', null)
    await flush()
    expect(getChain(db, chainId)).toMatchObject({ status: 'paused', pause_reason: 'provider_limit', last_run_outcome: 'provider_limit' })
    // Resume after the reset relaunches the SAME chunk.
    await mgr.resume(chainId)
    expect(f.launches).toHaveLength(2)
  })

  it('pause reasons: stopped → chunk_stopped, plain failure → chunk_failed', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    mgr.onRunSettled('run-1', 'stopped')
    settle(f, mgr, 3, 'implementation_failed', null)
    await flush()
    expect(getChain(db, res.ok ? res.chainId! : '')!.pause_reason).toBe('chunk_stopped')
    const g = fake()
    const mgr2 = new MilestoneChainManager(initDb(':memory:'), 'p1', g.io)
    await mgr2.start(1)
    settle(g, mgr2, 3, 'implementation_failed', null)
    await flush()
    expect(mgr2.listActive()[0].pauseReason).toBe('chunk_failed')
  })

  it('a rejected chunk-1 launch relays the guard and leaves no active chain', async () => {
    const f = fake({ failLaunch: { status: 409, error: 'tickets_in_flight' } })
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    expect(res).toMatchObject({ ok: false, status: 409, error: 'tickets_in_flight' })
    expect(listActiveChains(db)).toHaveLength(0)
    expect(listChains(db)[0]).toMatchObject({ status: 'cancelled', pause_reason: 'launch_rejected:tickets_in_flight' })
  })

  it('a rejected LATER chunk pauses with launch_rejected:<error>', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    f.failLaunch = { status: 409, error: 'tickets_in_flight' }
    settle(f, mgr, 3, 'on_review', 'feat/1')
    await flush()
    expect(getChain(db, res.ok ? res.chainId! : '')!).toMatchObject({ status: 'paused', pause_reason: 'launch_rejected:tickets_in_flight', head_branch: 'feat/1' })
  })

  it('a missing head branch pauses head_missing (advance + resume)', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    const id = f.deliveryByRail.get(3)!
    f.deliveries.set(id, { ...f.deliveries.get(id)!, decision: 'on_review', branch: 'feat/gone' })
    mgr.observe({ type: 'rail.pr_state', prDeliveryId: id } as unknown as WsMessage)
    await flush()
    expect(getChain(db, chainId)!).toMatchObject({ status: 'paused', pause_reason: 'head_missing', head_branch: 'feat/gone' })
    const resumed = await mgr.resume(chainId)
    expect(resumed).toMatchObject({ ok: false, status: 409, error: 'head_missing' })
    f.branches.add('feat/gone')
    const ok = await mgr.resume(chainId)
    expect(ok.ok).toBe(true)
    expect(f.launches[1].body.baseBranch).toBe('feat/gone')
  })

  it('cancel leaves the in-flight rail alone and stops the chain; control errors are typed', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    expect(await mgr.resume(chainId)).toMatchObject({ ok: false, status: 409, error: 'chain_not_paused' })
    expect(mgr.cancel(chainId)).toMatchObject({ ok: true, status: 200 })
    settle(f, mgr, 3, 'on_review', 'feat/1')
    await flush()
    expect(f.launches).toHaveLength(1)
    expect(getChain(db, chainId)!.status).toBe('cancelled')
    expect(mgr.cancel(chainId)).toMatchObject({ ok: false, status: 409, error: 'chain_terminal' })
    expect(mgr.cancel('nope')).toMatchObject({ ok: false, status: 404 })
    expect(await mgr.resume('nope')).toMatchObject({ ok: false, status: 404 })
    expect(mgr.get(chainId)?.status).toBe('cancelled')
    expect(mgr.get('nope')).toBeNull()
  })

  it('a settle while paused records the head but never auto-advances', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    updateChain(db, chainId, 'running', { status: 'paused', pauseReason: 'head_discarded' })
    settle(f, mgr, 3, 'on_review', 'feat/1')
    await flush()
    expect(f.launches).toHaveLength(1)
    expect(getChain(db, chainId)!).toMatchObject({ status: 'paused', head_branch: 'feat/1', current_delivery_id: null })
  })

  it('delivery-less chunks (shared cwd) settle from the engine hook without stacking', async () => {
    const f = fake()
    f.io.activeDeliveryForRail = () => null
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    expect(getChain(db, chainId)!.current_delivery_id).toBeNull()
    mgr.onRunSettled('run-1', 'success')
    await flush()
    expect(f.launches).toHaveLength(2)
    expect(f.launches[1].body.baseBranch).toBeUndefined()
    mgr.onRunSettled('run-2', 'failed')
    await flush()
    expect(getChain(db, chainId)!).toMatchObject({ status: 'paused', pause_reason: 'chunk_failed' })
    mgr.onRunSettled('unknown-run', 'success') // ignored
  })

  it('errors: milestone not found / no todo tickets', async () => {
    const f = fake({ tickets: [{ id: 1, status: 'on_review', labels: ['M1'] }] })
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    expect(await mgr.start(1)).toMatchObject({ ok: false, status: 400, error: 'no_tickets' })
    expect(await mgr.start(9)).toMatchObject({ ok: false, status: 404, error: 'milestone_not_found' })
  })
})

describe('MilestoneChainManager — wave checkpoints (D9)', () => {
  it('auto-advance off: a delivered chunk parks the chain at awaiting_approval with the head; resume launches the next chunk stacked', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1, { autoAdvance: false })
    const chainId = res.ok ? res.chainId! : ''
    expect(getChain(db, chainId)!.auto_advance).toBe(0)
    settle(f, mgr, 3, 'on_review', 'feat/1-implement')
    await flush()
    // NOT launched — waiting for the user's go.
    expect(f.launches).toHaveLength(1)
    let row = getChain(db, chainId)!
    expect(row).toMatchObject({ status: 'awaiting_approval', next_chunk: 1, head_branch: 'feat/1-implement', current_delivery_id: null, pause_reason: null })
    expect(sent.filter((m) => m.type === 'milestone.chain_changed').at(-1)).toMatchObject({ chain: { status: 'awaiting_approval', autoAdvance: false } })
    expect(mgr.listActive().map((c) => c.status)).toEqual(['awaiting_approval'])
    // A duplicate settle broadcast is inert.
    settle(f, mgr, 3, 'on_review', 'feat/1-implement')
    await flush()
    expect(f.launches).toHaveLength(1)

    const resumed = await mgr.resume(chainId)
    expect(resumed.ok).toBe(true)
    expect(f.launches).toHaveLength(2)
    expect(f.launches[1].body.baseBranch).toBe('feat/1-implement')
    row = getChain(db, chainId)!
    expect(row).toMatchObject({ status: 'running', next_chunk: 2, auto_advance: 0 })
    // Second chunk delivered → checkpoint again; the LAST chunk completes without one.
    settle(f, mgr, 4, 'on_review', 'feat/2-implement')
    await flush()
    expect(getChain(db, chainId)!.status).toBe('awaiting_approval')
    await mgr.resume(chainId)
    settle(f, mgr, 5, 'on_review', 'feat/3-implement')
    await flush()
    expect(getChain(db, chainId)!.status).toBe('completed')
    expect(f.launches).toHaveLength(3)
  })

  it('setAutoAdvance on at a checkpoint launches immediately; off keeps the next settle at a checkpoint', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1, { autoAdvance: false })
    const chainId = res.ok ? res.chainId! : ''
    settle(f, mgr, 3, 'on_review', 'feat/1')
    await flush()
    expect(getChain(db, chainId)!.status).toBe('awaiting_approval')
    const on = await mgr.setAutoAdvance(chainId, true)
    expect(on.ok && on.status).toBe(202)
    expect(f.launches).toHaveLength(2)
    expect(getChain(db, chainId)).toMatchObject({ status: 'running', auto_advance: 1 })
    // Flip it back off mid-flight: the running chunk's settle parks again.
    const off = await mgr.setAutoAdvance(chainId, false)
    expect(off.ok && off.status).toBe(200)
    expect(off.ok && off.chain.autoAdvance).toBe(false)
    settle(f, mgr, 4, 'on_review', 'feat/4')
    await flush()
    expect(getChain(db, chainId)!.status).toBe('awaiting_approval')
    expect(f.launches).toHaveLength(2)
    // Typed errors.
    expect(await mgr.setAutoAdvance('nope', true)).toMatchObject({ ok: false, status: 404, error: 'chain_not_found' })
    mgr.cancel(chainId)
    expect(await mgr.setAutoAdvance(chainId, true)).toMatchObject({ ok: false, status: 409, error: 'chain_terminal' })
  })

  it('a failure while auto-advance is off still PAUSES (checkpoints are reached only by success); delivery-less chunks checkpoint too', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1, { autoAdvance: false })
    const chainId = res.ok ? res.chainId! : ''
    settle(f, mgr, 3, 'implementation_failed', null)
    await flush()
    expect(getChain(db, chainId)).toMatchObject({ status: 'paused', pause_reason: 'chunk_failed' })
    // Resume retries the SAME chunk (paused semantics), still auto-off.
    await mgr.resume(chainId)
    expect(getChain(db, chainId)).toMatchObject({ status: 'running', next_chunk: 1, retry_chunk: null, auto_advance: 0 })

    // Delivery-less path: engine settle success parks at the checkpoint.
    const g = fake()
    g.io.activeDeliveryForRail = () => null
    const mgr2 = new MilestoneChainManager(initDb(':memory:'), 'p2', g.io)
    await mgr2.start(1, { autoAdvance: false })
    const runId = g.launches.length ? 'run-1' : ''
    mgr2.onRunSettled(runId, 'success')
    await flush()
    expect(mgr2.listActive()[0]).toMatchObject({ status: 'awaiting_approval', autoAdvance: false })
    expect(g.launches).toHaveLength(1)
  })

  it('startup recovery leaves a checkpoint alone (it is the user\'s call), and a checkpoint reached while down is replayed once', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1, { autoAdvance: false })
    const chainId = res.ok ? res.chainId! : ''
    // The delivery settled while the server was down: no observe() call.
    const id = f.deliveryByRail.get(3)!
    f.deliveries.set(id, { ...f.deliveries.get(id)!, decision: 'on_review', branch: 'feat/1' })
    f.branches.add('feat/1')
    await mgr.recoverOnStartup()
    expect(getChain(db, chainId)).toMatchObject({ status: 'awaiting_approval', head_branch: 'feat/1' })
    expect(f.launches).toHaveLength(1)
    await mgr.recoverOnStartup()
    expect(getChain(db, chainId)!.status).toBe('awaiting_approval')
    expect(f.launches).toHaveLength(1)
  })
})

describe('MilestoneChainManager — one spec per rail, sequential only', () => {
  it('auto-continue is ON by default: each delivered spec launches the next, stacked', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    expect(getChain(db, chainId)).toMatchObject({ auto_advance: 1, mode: 'sequential' })
    settle(f, mgr, 3, 'on_review', 'feat/1')
    await flush()
    expect(f.launches[1]).toEqual({ railIndex: 4, body: { mode: 'implement', baseBranch: 'feat/1' } })
    expect(f.rails).toEqual(['M1 · #1', 'M1 · #2'])
  })

  it('launches specs in dependency order, not id order', async () => {
    const f = fake({ tickets: [
      { id: 1, status: 'todo', labels: ['M1'], prerequisites: [2], executionOrder: 1 },
      { id: 2, status: 'todo', labels: ['M1'], prerequisites: [], executionOrder: 2 },
      { id: 3, status: 'done', labels: ['M1'] },
      { id: 4, status: 'todo', labels: ['M2'] },
    ] })
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    expect(res.ok && res.pending).toEqual([[1]])
    expect(f.assignments[0]).toEqual({ railIndex: 3, ticketIds: [2] })
    expect(f.rails).toEqual(['M1 · #2'])
  })

  it('a single-spec milestone completes right away', async () => {
    const f = fake({ tickets: [{ id: 1, status: 'todo', labels: ['M1'] }] })
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    expect(f.rails).toEqual(['M1 · #1'])
    settle(f, mgr, 3, 'on_review', 'feat/1')
    await flush()
    expect(getChain(db, res.ok ? res.chainId! : '')!.status).toBe('completed')
  })

  it('reuses a free builder rail (decided PR) before allocating a new slot, renaming it after its spec', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    // Spec 1's PR is merged (terminal) before its settle broadcast arrives.
    settle(f, mgr, 3, 'merged', 'feat/1')
    await flush()
    expect(f.launches[1].railIndex).toBe(3)
    expect(f.rails).toEqual(['M1 · #2'])
    expect(f.renamed).toEqual([{ railIndex: 3, name: 'M1 · #2' }])
    expect(f.assignments.at(-1)).toEqual({ railIndex: 3, ticketIds: [2] })
    expect(getChain(db, chainId)).toMatchObject({ status: 'running', next_chunk: 2, current_rail_index: 3 })
  })

  it('never reuses a builder rail that is running or holds an undecided delivery', async () => {
    const f = fake()
    const busy = new Set<number>([4])
    f.io.railBusy = (i) => busy.has(i)
    // Rail 3 has an undecided PR from an earlier chain; rail 4 is running.
    await f.io.createRail('M2 · #9')
    await f.io.createRail('M2 · #10')
    f.deliveries.set('old', snap({ id: 'old', railIndex: 3, decision: 'pr_ready' }))
    f.deliveryByRail.set(3, 'old')
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    await mgr.start(1)
    expect(f.launches[0].railIndex).toBe(5)
    expect(f.rails).toEqual(['M2 · #9', 'M2 · #10', 'M1 · #1'])
  })

  it('rail limit on the FIRST spec: nothing launches and the typed rail_limit_reached guard is relayed', async () => {
    const f = fake({ railLimit: 3 })
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    expect(res).toMatchObject({ ok: false, status: 409, error: 'rail_limit_reached' })
    expect(f.launches).toHaveLength(0)
    expect(listActiveChains(db)).toHaveLength(0)
    expect(listChains(db)[0]).toMatchObject({ status: 'cancelled', pause_reason: 'rail_limit_reached' })
  })

  it('rail limit mid-chain pauses rail_limit_reached; deciding a PR frees a rail and Resume launches the SAME next spec', async () => {
    const f = fake({ railLimit: 4 })
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const chainId = res.ok ? res.chainId! : ''
    settle(f, mgr, 3, 'on_review', 'feat/1')
    await flush()
    const row = getChain(db, chainId)!
    expect(row).toMatchObject({ status: 'paused', pause_reason: 'rail_limit_reached', next_chunk: 1, head_branch: 'feat/1' })
    expect(f.launches).toHaveLength(1)
    // Still full: Resume re-pauses with the same reason and launches nothing.
    const stillFull = await mgr.resume(chainId)
    expect(stillFull.ok).toBe(true)
    expect(getChain(db, chainId)).toMatchObject({ status: 'paused', pause_reason: 'rail_limit_reached' })
    expect(f.launches).toHaveLength(1)
    // The user merges spec 1's PR: its rail is free again.
    const d = f.deliveries.get('d-3')!
    f.deliveries.set('d-3', { ...d, decision: 'merged' })
    await mgr.resume(chainId)
    expect(f.launches).toHaveLength(2)
    expect(f.launches[1]).toEqual({ railIndex: 3, body: { mode: 'implement', baseBranch: 'feat/1' } })
    expect(f.assignments.at(-1)).toEqual({ railIndex: 3, ticketIds: [2] })
    expect(getChain(db, chainId)).toMatchObject({ status: 'running', next_chunk: 2, pause_reason: null })
  })
})

describe('MilestoneChainManager — startup recovery', () => {
  it('replays a chunk whose delivery settled while the server was down, exactly once', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    const id = f.deliveryByRail.get(3)!
    f.deliveries.set(id, { ...f.deliveries.get(id)!, decision: 'on_review', branch: 'feat/1' })
    f.branches.add('feat/1')
    const fresh = new MilestoneChainManager(db, 'p1', f.io)
    await fresh.recoverOnStartup()
    await flush()
    expect(f.launches).toHaveLength(2)
    expect(f.launches[1].body.baseBranch).toBe('feat/1')
    await fresh.recoverOnStartup()
    await flush()
    expect(f.launches).toHaveLength(2)
    expect(getChain(db, res.ok ? res.chainId! : '')!.next_chunk).toBe(2)
  })

  it('a still-building delivery is left alone; a vanished one pauses run_lost', async () => {
    const f = fake()
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    await new MilestoneChainManager(db, 'p1', f.io).recoverOnStartup()
    expect(getChain(db, res.ok ? res.chainId! : '')!.status).toBe('running')
    f.deliveries.clear()
    await new MilestoneChainManager(db, 'p1', f.io).recoverOnStartup()
    expect(getChain(db, res.ok ? res.chainId! : '')!).toMatchObject({ status: 'paused', pause_reason: 'run_lost' })
  })

  it('delivery-less chunks recover from the loop-run rows', async () => {
    const f = fake()
    f.io.activeDeliveryForRail = () => null
    const mgr = new MilestoneChainManager(db, 'p1', f.io)
    const res = await mgr.start(1)
    f.runs.set('run-1', { settled: true, outcome: 'success' })
    await new MilestoneChainManager(db, 'p1', f.io).recoverOnStartup()
    await flush()
    expect(f.launches).toHaveLength(2)
    f.runs.delete('run-2')
    await new MilestoneChainManager(db, 'p1', f.io).recoverOnStartup()
    expect(getChain(db, res.ok ? res.chainId! : '')!).toMatchObject({ status: 'paused', pause_reason: 'run_lost' })
  })
})


describe('incremental integration before the next spec', () => {
  it('waits for confirmed integration and launches the next spec from the accumulated integration branch once', async () => {
    const f = fake(), mgr = new MilestoneChainManager(db, 'p', f.io)
    let finish!: () => void
    f.io.integrateDelivery = vi.fn(async delivery => {
      await new Promise<void>(resolve => { finish = resolve })
      f.deliveries.set(delivery.id, { ...delivery, decision: 'merged' })
      return { ok: true }
    })
    await mgr.start(1)
    settle(f, mgr, 3, 'on_review', 'spec-one')
    settle(f, mgr, 3, 'on_review', 'spec-one')
    await flush()
    expect(f.launches).toHaveLength(1)
    expect(f.io.integrateDelivery).toHaveBeenCalledTimes(1)
    finish(); await flush(); await flush()
    expect(f.launches).toHaveLength(2)
    expect(f.launches[1].body).toEqual({ mode: 'implement', baseBranch: 'main' })
    expect(f.assignments[1].ticketIds).toEqual([2])
  })
  it('pauses failed integration and retries integration rather than reimplementing the same spec', async () => {
    const f = fake(), mgr = new MilestoneChainManager(db, 'p', f.io)
    const integrate = vi.fn<NonNullable<MilestoneChainIO['integrateDelivery']>>()
      .mockResolvedValueOnce({ ok: false, status: 409, error: 'merge_local_blocked' })
      .mockImplementationOnce(async delivery => { f.deliveries.set(delivery.id, { ...delivery, decision: 'merged' }); return { ok: true } })
    f.io.integrateDelivery = integrate
    const started = await mgr.start(1)
    expect(started.ok).toBe(true)
    settle(f, mgr, 3, 'on_review', 'spec-one'); await flush()
    const row = listActiveChains(db)[0]
    expect(row).toMatchObject({ status: 'paused', pause_reason: 'integration_failed:merge_local_blocked', current_delivery_id: 'd-3', retry_chunk: null })
    expect(f.launches).toHaveLength(1)
    await mgr.resume(row.id); await flush()
    expect(integrate).toHaveBeenCalledTimes(2)
    expect(f.assignments.map(item => item.ticketIds)).toEqual([[1], [2]])
  })
  it('recovers an integration pending at restart and honors checkpoints after integration', async () => {
    const f = fake(), mgr = new MilestoneChainManager(db, 'p', f.io)
    f.io.integrateDelivery = async delivery => { f.deliveries.set(delivery.id, { ...delivery, decision: 'merged' }); return { ok: true } }
    await mgr.start(1, { autoAdvance: false })
    const row = listActiveChains(db)[0]
    f.deliveries.set('d-3', { ...f.deliveries.get('d-3')!, decision: 'on_review', branch: 'spec-one' })
    updateChain(db, row.id, 'running', { status: 'waiting', pauseReason: 'integration_pending' })
    await new MilestoneChainManager(db, 'p', f.io).recoverOnStartup()
    expect(getChain(db, row.id)).toMatchObject({ status: 'awaiting_approval', head_branch: 'main', current_delivery_id: null })
    expect(f.launches).toHaveLength(1)
    await mgr.resume(row.id)
    expect(f.launches[1].body.baseBranch).toBe('main')
  })
  it('never advances an incomplete spec even if a partial delivery is on review', async () => {
    const f = fake(), mgr = new MilestoneChainManager(db, 'p', f.io)
    f.io.integrateDelivery = vi.fn()
    await mgr.start(1)
    f.deliveries.set('d-3', { ...f.deliveries.get('d-3')!, implementationOutcome: 'partially_succeeded' })
    settle(f, mgr, 3, 'on_review', 'partial'); await flush()
    expect(f.io.integrateDelivery).not.toHaveBeenCalled()
    expect(f.launches).toHaveLength(1)
    expect(listActiveChains(db)[0].status).toBe('paused')
  })
})

it('builds three specs cumulatively in real Git worktrees by integrating each before the next allocation', async () => {
  const repository = mkdtempSync(path.join(tmpdir(), 'incremental-builder-'))
  const git = (args: string[], cwd = repository) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  try {
    git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
    writeFileSync(path.join(repository, 'project.txt'), 'baseline\n'); git(['add', '.']); git(['commit', '-qm', 'baseline'])
    const f = fake(), mgr = new MilestoneChainManager(db, 'p', f.io), launch = f.io.launch
    const worktrees: string[] = []
    f.io.launch = async (rail, body) => {
      const worktree = path.join(repository, 'worktree-' + (worktrees.length + 1))
      git(['worktree', 'add', '-b', 'spec-' + (worktrees.length + 1), worktree, body.baseBranch ?? 'main'])
      const before = readFileSync(path.join(worktree, 'project.txt'), 'utf8')
      expect(before).toBe('baseline\n' + worktrees.map((_, i) => 'spec-' + (i + 1) + '\n').join(''))
      writeFileSync(path.join(worktree, 'project.txt'), before + 'spec-' + (worktrees.length + 1) + '\n')
      git(['add', 'project.txt'], worktree); git(['commit', '-qm', 'implement spec'], worktree)
      worktrees.push(worktree)
      return launch(rail, body)
    }
    f.io.integrateDelivery = async delivery => {
      git(['merge', '--no-ff', '--no-edit', delivery.branch!])
      f.deliveries.set(delivery.id, { ...delivery, decision: 'merged' })
      return { ok: true }
    }
    await mgr.start(1)
    for (let spec = 1; spec <= 3; spec++) {
      const rail = f.launches.at(-1)!.railIndex
      settle(f, mgr, rail, 'on_review', 'spec-' + spec)
      await flush(); await flush()
    }
    expect(f.launches).toHaveLength(3)
    expect(readFileSync(path.join(repository, 'project.txt'), 'utf8')).toBe('baseline\nspec-1\nspec-2\nspec-3\n')
    expect(listChains(db)[0].status).toBe('completed')
  } finally { rmSync(repository, { recursive: true, force: true }) }
})
