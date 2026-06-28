import { describe, it, expect, vi } from 'vitest'
import { launchIsolatedRail, type IsolatedLaunchIO } from './rail-isolated-launch'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { listRailWorktrees } from './rail-worktrees-store'
import type { ProjectContext } from './project-registry'

function fakeCtx() {
  const db = initDb(':memory:')
  const desktopDb = initDesktopDb(':memory:')
  const run = vi.fn(() => new Promise<never>(() => { /* never settles → merge-back never scheduled */ }))
  const onLoopRunFinished = vi.fn()
  const onRailLaunch = vi.fn()
  const broadcast = vi.fn()
  const railLoopRuns = new Map<string, { railIndex: number; ticketIds: number[] }>()
  const ctx = {
    project: { id: 'proj', slug: 'p', path: '/repo' },
    db,
    desktopDb,
    loopRunManager: { run },
    getTicketSpec: (id: number) => ({ title: `T${id}`, description: 'd', ticketIds: [id] }),
    railLoopRuns,
    onLoopRunFinished,
    jiraSyncManager: { onRailLaunch },
    broadcast,
  } as unknown as ProjectContext
  return { ctx, db, run, onLoopRunFinished, railLoopRuns }
}

const graph = { nodes: [], edges: [], config: {} } as never
const input = (ticketIds: number[], ctx: ProjectContext) => ({
  ctx, railIndex: 0, ticketIds, loopId: 'factory:implement', loopName: 'Implement',
  loopGraph: graph, provider: 'claude', model: 'sonnet',
})

describe('launchIsolatedRail', () => {
  it('allocates a worktree + run per ticket, records the ledger, and returns run ids', async () => {
    const { ctx, db, run, railLoopRuns } = fakeCtx()
    const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
    const io: IsolatedLaunchIO = { git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) }, create, remove: vi.fn(async () => {}) }

    const ids = await launchIsolatedRail(input([1, 2], ctx), io)

    expect(ids).toHaveLength(2)
    expect(create).toHaveBeenCalledTimes(2)
    expect(run).toHaveBeenCalledTimes(2)
    expect(railLoopRuns.size).toBe(2)
    const ledger = listRailWorktrees(db, 0)
    expect(ledger.map((r) => r.ticket_id)).toEqual([1, 2])
    expect(ledger.every((r) => r.merge_state === 'building')).toBe(true)
  })

  it('tears down partial allocation and throws when a worktree fails (all-or-nothing)', async () => {
    const { ctx, run } = fakeCtx()
    let n = 0
    const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => {
      if (++n === 2) throw new Error('git worktree add failed')
      return { branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }
    })
    const remove = vi.fn(async () => {})
    const io: IsolatedLaunchIO = { git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) }, create, remove }

    await expect(launchIsolatedRail(input([1, 2], ctx), io)).rejects.toThrow(/worktree add failed/)
    // the one successfully-allocated worktree (#1) is torn down; no runs spawned
    expect(remove).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
  })
})
