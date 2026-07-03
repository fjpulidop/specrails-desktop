import { describe, it, expect, vi } from 'vitest'
import { launchIsolatedRail, reconcileRailWorktrees, type IsolatedLaunchIO } from './rail-isolated-launch'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { listRailWorktrees, createRailWorktree, updateRailWorktreeState, getRailWorktree } from './rail-worktrees-store'
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

  it('branches worktrees off the resolved integration branch (repo default)', async () => {
    const { ctx } = fakeCtx()
    const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
    const git = {
      run: async (args: string[]) =>
        args[0] === 'symbolic-ref'
          ? { code: 0, stdout: 'refs/remotes/origin/develop\n', stderr: '' }
          : { code: 0, stdout: '', stderr: '' },
    }
    const io: IsolatedLaunchIO = { git, create, remove: vi.fn(async () => {}) }

    await launchIsolatedRail(input([1], ctx), io)

    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({ ticketId: 1, baseRef: 'develop' }))
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

describe('reconcileRailWorktrees (startup sweep)', () => {
  it('removes non-terminal orphans (keeping branches) and marks them failed; leaves terminal rows', async () => {
    const db = initDb(':memory:')
    createRailWorktree(db, { id: 'a', railIndex: 0, ticketId: 1, branch: 'sr/p/ticket-1', worktreePath: '/wt/1' })
    createRailWorktree(db, { id: 'b', railIndex: 0, ticketId: 2, branch: 'sr/p/ticket-2', worktreePath: '/wt/2' })
    createRailWorktree(db, { id: 'c', railIndex: 0, ticketId: 3, branch: 'sr/p/ticket-3', worktreePath: '/wt/3' })
    updateRailWorktreeState(db, 'a', 'merged')      // terminal — untouched
    updateRailWorktreeState(db, 'c', 'merging')     // non-terminal — swept
    // b stays 'building' — non-terminal — swept
    const remove = vi.fn(async () => {})

    const n = await reconcileRailWorktrees(db, '/repo', { git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) }, remove })

    expect(n).toBe(2)
    expect(remove).toHaveBeenCalledTimes(2)
    // branches kept for inspection
    expect(remove.mock.calls.every((c) => (c[1] as { deleteBranch?: boolean }).deleteBranch === false)).toBe(true)
    expect(getRailWorktree(db, 'a')?.merge_state).toBe('merged')
    expect(getRailWorktree(db, 'b')?.merge_state).toBe('failed')
    expect(getRailWorktree(db, 'c')?.merge_state).toBe('failed')
  })

  it('is a no-op (no git/remove calls) when there are no orphans', async () => {
    const db = initDb(':memory:')
    const remove = vi.fn(async () => {})
    const n = await reconcileRailWorktrees(db, '/repo', { git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) }, remove })
    expect(n).toBe(0)
    expect(remove).not.toHaveBeenCalled()
  })
})
