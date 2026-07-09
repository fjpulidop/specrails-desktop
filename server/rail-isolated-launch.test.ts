import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as path from 'path'
import { resolveHome } from './artifact-registry'
import { launchIsolatedRail, reconcileRailWorktrees, type IsolatedLaunchIO } from './rail-isolated-launch'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { listRailWorktrees, createRailWorktree, updateRailWorktreeState, getRailWorktree } from './rail-worktrees-store'
import { getActivePrDeliveryByRail, listActivePrDeliveries } from './rail-pr-store'
import { insertLinkWithId } from './jira/jira-db'
import { setAgentChatManager } from './agent-chat-registry'
import type { AgentChatManager } from './agent-chat-manager'
import type { RailPrStateMessage, RailFetchDegradedMessage } from './types'
import type { ProjectContext } from './project-registry'
import { __resetFetchOriginCache } from './integration-branch'
import { PR_NEVER_STAGE_PATHS } from './worktree-manager'

// The legacy merge-back must never spawn real executors from a test settle —
// stub it (PR-mode tests assert it is NOT called; the kill-switch-off pin
// asserts it IS).
const { mockRunMergeBack } = vi.hoisted(() => ({ mockRunMergeBack: vi.fn() }))
vi.mock('./rail-merge-orchestrator', () => ({ runMergeBack: mockRunMergeBack }))

const ORIG_PR = process.env.SPECRAILS_RAIL_DELIVER_PR
// fetchOrigin's TTL cache is module-level and keyed by repoDir — nearly every
// test below shares the same fake repo path ('/repo'), so without a reset the
// FIRST test's fetch/rev-parse outcome would leak into every subsequent test
// launched within the same 15s TTL window (test suites run far faster than
// that). Reset before every test so each case's own fake `git` is the one
// that actually answers `fetchOrigin`/`resolveWorktreeBaseRef`.
beforeEach(() => { __resetFetchOriginCache() })
beforeEach(() => { mockRunMergeBack.mockReset().mockResolvedValue([]) })
afterEach(() => {
  if (ORIG_PR === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
  else process.env.SPECRAILS_RAIL_DELIVER_PR = ORIG_PR
})

function fakeCtx(runImpl?: (req: { runId: string }) => Promise<unknown>) {
  const db = initDb(':memory:')
  const desktopDb = initDesktopDb(':memory:')
  const run = vi.fn(runImpl ?? (() => new Promise<never>(() => { /* never settles → merge-back never scheduled */ })))
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
  return { ctx, db, run, onLoopRunFinished, railLoopRuns, broadcast }
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

  it('branches worktrees off the resolved integration branch (repo default), remote-tracking ref once fetch succeeds', async () => {
    const { ctx } = fakeCtx()
    const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
    // This fake's catch-all `{ code: 0, ... }` branch means BOTH the new
    // `fetch origin` call and the `rev-parse --verify` existence check succeed
    // too — so baseRef resolves to the remote-tracking ref, not the bare name.
    const git = {
      run: async (args: string[]) =>
        args[0] === 'symbolic-ref'
          ? { code: 0, stdout: 'refs/remotes/origin/develop\n', stderr: '' }
          : { code: 0, stdout: '', stderr: '' },
    }
    const io: IsolatedLaunchIO = { git, create, remove: vi.fn(async () => {}) }

    await launchIsolatedRail(input([1], ctx), io)

    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({ ticketId: 1, baseRef: 'origin/develop' }))
  })

  it('fetch fails → falls back to the bare local branch name (legacy-identical); launch still completes', async () => {
    const { ctx } = fakeCtx()
    const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'fetch') return { code: 1, stdout: '', stderr: "fatal: unable to access 'origin': Could not resolve host" }
        if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'refs/remotes/origin/develop\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const io: IsolatedLaunchIO = { git, create, remove: vi.fn(async () => {}) }

    const ids = await launchIsolatedRail(input([1], ctx), io)

    expect(ids).toHaveLength(1) // no throw — the launch completes normally
    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({ ticketId: 1, baseRef: 'develop' }))
  })

  it('fetch fails → broadcasts rail.fetch_degraded (non-blocking, visible degradation)', async () => {
    const { ctx, broadcast } = fakeCtx()
    const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
    const git = {
      run: async (args: string[]) => (args[0] === 'fetch' ? { code: 1, stdout: '', stderr: 'fatal: no route to host' } : { code: 0, stdout: '', stderr: '' }),
    }
    const io: IsolatedLaunchIO = { git, create, remove: vi.fn(async () => {}) }

    await launchIsolatedRail(input([1], ctx), io)

    const degraded = broadcast.mock.calls.map((c) => c[0] as RailFetchDegradedMessage).find((m) => m?.type === 'rail.fetch_degraded')
    expect(degraded).toMatchObject({
      type: 'rail.fetch_degraded', projectId: 'proj', railIndex: 0,
      warning: 'git fetch origin failed; using local ref',
    })
  })

  // NOTE (task 3.5c): `IsolatedLaunchInput` has no `explicit` branch-override
  // field, and `launchIsolatedRail`'s own `resolveIntegrationBranch(...)` call
  // never passes one (only `projectSetting`) — so `source: 'explicit'` is
  // unreachable through this function's input surface today. Per the task's
  // own escape valve, that policy (no origin/ prefix, no existence-check
  // call) is exhaustively covered instead by `resolveWorktreeBaseRef`'s own
  // unit tests in integration-branch.test.ts (task 2.2c).

  it('a batch of 2+ units in ONE launchIsolatedRail call fetches origin exactly once (not once per unit)', async () => {
    const { ctx } = fakeCtx()
    const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
    let fetchCalls = 0
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'fetch') fetchCalls++
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const io: IsolatedLaunchIO = { git, create, remove: vi.fn(async () => {}) }

    await launchIsolatedRail(input([1, 2, 3], ctx), io)

    expect(fetchCalls).toBe(1)
  })

  it('scope=all → ONE worktree + one run covering every ticket', async () => {
    const { ctx, run } = fakeCtx()
    const create = vi.fn(async (_g, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
    const io: IsolatedLaunchIO = { git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) }, create, remove: vi.fn(async () => {}) }

    const ids = await launchIsolatedRail({ ...input([1, 2], ctx), scope: 'all' }, io)

    expect(ids).toHaveLength(1) // a single run, not one per ticket
    expect(create).toHaveBeenCalledTimes(1) // one worktree for the whole rail
    expect(create).toHaveBeenCalledWith(io.git, expect.objectContaining({ ticketId: 1 }))
    const runArg = (run as ReturnType<typeof vi.fn>).mock.calls[0][0] as { spec: { ticketIds: number[] } }
    expect(runArg.spec.ticketIds).toEqual([1, 2]) // the one run covers all tickets
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

// ── Cross-request batch dedup ("Launch all") ─────────────────────────────────
// Neither "batch" launch surface (the dashboard's client-side Promise.allSettled
// fan-out, the MCP launch_all server-side loop) is a real server-side batch
// transaction — each rail's launch is an independent HTTP request that ends up
// calling launchIsolatedRail once. The "one fetch per batch" acceptance
// criterion is therefore proven at the level this codebase can actually
// exercise it: TWO separate launchIsolatedRail calls for the SAME repo path,
// back-to-back, sharing the module-level fetchOrigin TTL cache.
describe('launchIsolatedRail — cross-request fetch dedup (Launch all simulation)', () => {
  it('two independent launchIsolatedRail calls for the SAME project.path within the TTL window share ONE real git fetch', async () => {
    const a = fakeCtx()
    const b = fakeCtx() // same project.path ('/repo') → same fetchOrigin cache key
    const create = vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
    let fetchCalls = 0
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'fetch') fetchCalls++
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const io: IsolatedLaunchIO = { git, create, remove: vi.fn(async () => {}) }

    // Simulates two rails' independent POST /:railIndex/launch requests
    // landing back-to-back for the same repo, as "Launch all" produces.
    await launchIsolatedRail(input([1], a.ctx), io)
    await launchIsolatedRail({ ...input([2], b.ctx), railIndex: 1 }, io)

    expect(fetchCalls).toBe(1)
    a.db.close(); b.db.close()
  })
})

// A run stub that settles immediately with the given outcome, echoing runId.
const settlingRun = (outcome = 'success') => (req: { runId: string }) =>
  Promise.resolve({ runId: req.runId, outcome, iterations: 1, totalCostUsd: 0 })

const prStates = (broadcast: ReturnType<typeof vi.fn>): RailPrStateMessage[] =>
  broadcast.mock.calls
    .map((c) => c[0] as RailPrStateMessage)
    .filter((m) => m?.type === 'rail.pr_state')

describe('launchIsolatedRail — ask-first PR delivery (rail_pr_deliveries lifecycle)', () => {
  const okIo = (
    create = vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` })),
  ): IsolatedLaunchIO =>
    ({ git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) }, create, remove: vi.fn(async () => {}) }) as IsolatedLaunchIO

  beforeEach(() => { delete process.env.SPECRAILS_RAIL_DELIVER_PR }) // default-on

  it('inserts a building row at launch (origin persisted) and broadcasts rail.pr_state at insert + run allocation', async () => {
    const { ctx, db, broadcast } = fakeCtx() // never-settling runs → row stays 'building'

    const ids = await launchIsolatedRail({ ...input([1, 2], ctx), scope: 'all', originSurface: 'agent-chat', originConversationId: 'conv-1' }, okIo())

    const row = getActivePrDeliveryByRail(db, 0)!
    expect(row).toMatchObject({
      rail_index: 0, loop_id: 'factory:implement', rail_key: '0-factory:implement',
      ticket_ids: '[1,2]', base_branch: 'HEAD', loop_name: 'Implement',
      decision: 'building', pr_state: 'none',
      origin_surface: 'agent-chat', origin_conversation_id: 'conv-1',
    })
    // run_ids round-trip: patched onto the row right after allocation.
    expect(JSON.parse(row.run_ids)).toEqual(ids)
    // Both durable broadcasts carry the EXACT snapshot payload shape: the
    // insert (runIds still []) then the allocation patch (runIds populated —
    // the building card/strip gains its per-run "View log" chips live).
    const base = {
      type: 'rail.pr_state', projectId: 'proj', railIndex: 0,
      prDeliveryId: row.id, railKey: '0-factory:implement', ticketIds: [1, 2],
      baseBranch: 'HEAD', branch: null, prUrl: null, prNumber: null,
      prState: 'none', decision: 'building', originConversationId: 'conv-1',
    }
    expect(prStates(broadcast)).toEqual([
      { ...base, runIds: [] },
      { ...base, runIds: ids },
    ])
  })

  it('origin defaults to dashboard / null when the launch input omits it', async () => {
    const { ctx, db } = fakeCtx()
    await launchIsolatedRail(input([1], ctx), okIo())
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(row.origin_surface).toBe('dashboard')
    expect(row.origin_conversation_id).toBeNull()
  })

  it('settle (≥1 succeeded) → on_review with branches + worktreeIds persisted; tickets park on_review; no merge-back', async () => {
    const { ctx, db, broadcast, onLoopRunFinished } = fakeCtx(settlingRun('success'))

    const ids = await launchIsolatedRail(input([1, 2], ctx), okIo())

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('on_review'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(JSON.parse(row.branches)).toEqual([
      { ticketId: 1, branch: 'sr/p/ticket-1', succeeded: true },
      { ticketId: 2, branch: 'sr/p/ticket-2', succeeded: true },
    ])
    // this launch's rail_worktrees ledger ids, verbatim (discard cleanup input)
    const ledgerIds = listRailWorktrees(db, 0).map((r) => r.id)
    expect([...(JSON.parse(row.worktree_ids) as string[])].sort()).toEqual([...ledgerIds].sort())
    // tickets parked at on_review at run settle (never done in PR mode)
    for (const id of ids) {
      expect(onLoopRunFinished).toHaveBeenCalledWith(id, 'success', { ticketCompletionStatus: 'on_review' })
    }
    // insert → allocation (run_ids patch, still building) → settle
    expect(prStates(broadcast).map((m) => m.decision)).toEqual(['building', 'building', 'on_review'])
    // the settle patch left the allocation's run_ids untouched (per-ticket order)
    expect(JSON.parse(row.run_ids)).toEqual(ids)
    expect(prStates(broadcast).at(-1)?.runIds).toEqual(ids)
    // legacy merge-back stays skipped in PR mode
    expect(mockRunMergeBack).not.toHaveBeenCalled()
  })

  it('success outcome with uncommitted deliverable changes fails the implementation card instead of offering Create PR', async () => {
    const { ctx, db, broadcast, onLoopRunFinished } = fakeCtx(settlingRun('success'))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'status') return { code: 0, stdout: ' M src/app.ts\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    const ids = await launchIsolatedRail(input([1], ctx), { ...okIo(), git })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('implementation_failed'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(JSON.parse(row.branches)).toEqual([{ ticketId: 1, branch: 'sr/p/ticket-1', succeeded: false }])
    expect(onLoopRunFinished).toHaveBeenCalledWith(ids[0], 'failed', { ticketCompletionStatus: 'on_review' })
    expect(prStates(broadcast).map((m) => m.decision)).toEqual(['building', 'building', 'implementation_failed'])
    expect(mockRunMergeBack).not.toHaveBeenCalled()
  })

  it('settle (0 succeeded) → implementation_failed with run logs, branches persisted with succeeded:false', async () => {
    const { ctx, db, broadcast } = fakeCtx(settlingRun('failure'))

    const ids = await launchIsolatedRail(input([1], ctx), okIo())

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('implementation_failed'))
    const all = db.prepare('SELECT decision, branches FROM rail_pr_deliveries').all() as { decision: string; branches: string }[]
    expect(all).toHaveLength(1)
    expect(all[0].decision).toBe('implementation_failed')
    expect(JSON.parse(all[0].branches)).toEqual([{ ticketId: 1, branch: 'sr/p/ticket-1', succeeded: false }])
    expect(prStates(broadcast).map((m) => m.decision)).toEqual(['building', 'building', 'implementation_failed'])
    expect(prStates(broadcast).at(-1)?.runIds).toEqual(ids)
    expect(mockRunMergeBack).not.toHaveBeenCalled()
  })

  it('worktree-allocation failure closes the building row (→ discarded) so it cannot block relaunch', async () => {
    const { ctx, db, broadcast } = fakeCtx()
    let n = 0
    const create = vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => {
      if (++n === 2) throw new Error('git worktree add failed')
      return { branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }
    })

    await expect(launchIsolatedRail(input([1, 2], ctx), okIo(create))).rejects.toThrow(/worktree add failed/)

    expect(getActivePrDeliveryByRail(db, 0)).toBeUndefined() // no orphan 'building' row
    expect(prStates(broadcast).map((m) => m.decision)).toEqual(['building', 'discarded'])
  })

  it('can preserve the building row on allocation failure for router-managed shared-cwd continuation fallback', async () => {
    const { ctx, db, broadcast } = fakeCtx()
    let prDeliveryId = ''
    const create = vi.fn(async () => {
      throw new Error('git worktree add failed')
    })

    await expect(launchIsolatedRail({
      ...input([1], ctx),
      preservePrDeliveryOnAllocationFailure: true,
      onPrDeliveryCreated: (id) => { prDeliveryId = id },
    }, okIo(create))).rejects.toThrow(/worktree add failed/)

    const row = getActivePrDeliveryByRail(db, 0)
    expect(row?.id).toBe(prDeliveryId)
    expect(row?.decision).toBe('building')
    expect(prStates(broadcast).map((m) => m.decision)).toEqual(['building'])
  })

  describe('agent-chat completion driver (card posted at launch, updated at settle)', () => {
    afterEach(() => setAgentChatManager(null))

    const fakeAgentChat = () => {
      const postPrDecisionCard = vi.fn()
      const updatePrDecisionCard = vi.fn()
      setAgentChatManager({ postPrDecisionCard, updatePrDecisionCard } as unknown as AgentChatManager)
      return { postPrDecisionCard, updatePrDecisionCard }
    }

    it('origin conversation set → building card at launch, runIds chip update at allocation, settled envelope at settle', async () => {
      const { postPrDecisionCard, updatePrDecisionCard } = fakeAgentChat()
      const { ctx, db } = fakeCtx(settlingRun('success'))

      const ids = await launchIsolatedRail(
        { ...input([1, 2], ctx), scope: 'all', originSurface: 'agent-chat', originConversationId: 'conv-9' },
        okIo(),
      )

      // The card lands immediately at launch, in 'building' state (no runs yet).
      expect(postPrDecisionCard).toHaveBeenCalledTimes(1)
      expect(postPrDecisionCard.mock.calls[0][0]).toBe('conv-9')
      expect(postPrDecisionCard.mock.calls[0][1]).toMatchObject({ kind: 'pr_decision', decision: 'building', runIds: [] })

      // Two in-place updates: run allocation (the building card gains its
      // per-run "View log" chips live) then the settled envelope.
      await vi.waitFor(() => expect(updatePrDecisionCard).toHaveBeenCalledTimes(2))
      expect(updatePrDecisionCard.mock.calls[0][0]).toBe('conv-9')
      expect(updatePrDecisionCard.mock.calls[0][1]).toMatchObject({ kind: 'pr_decision', decision: 'building', runIds: ids })
      const row = getActivePrDeliveryByRail(db, 0)!
      expect(updatePrDecisionCard).toHaveBeenLastCalledWith('conv-9', {
        kind: 'pr_decision',
        prDeliveryId: row.id,
        railIndex: 0,
        projectId: 'proj',
        baseBranch: 'HEAD',
        ticketIds: [1, 2],
        decision: 'on_review',
        prUrl: null,
        prNumber: null,
        prState: 'none',
        branch: null,
        runIds: ids,
      })
    })

    it('failed settle (0 succeeded) also updates the card so the origin learns the failed job outcome', async () => {
      const { updatePrDecisionCard } = fakeAgentChat()
      const { ctx } = fakeCtx(settlingRun('failure'))

      await launchIsolatedRail(
        { ...input([1], ctx), originSurface: 'agent-chat', originConversationId: 'conv-9' },
        okIo(),
      )

      // calls[0] is the allocation runIds update; the LAST call carries the
      // failed implementation outcome.
      await vi.waitFor(() => expect(updatePrDecisionCard).toHaveBeenCalledTimes(2))
      expect(updatePrDecisionCard.mock.calls[1][0]).toBe('conv-9')
      expect(updatePrDecisionCard.mock.calls[1][1]).toMatchObject({ kind: 'pr_decision', decision: 'implementation_failed' })
    })

    it('dashboard launch (origin null) → the card is never posted nor updated', async () => {
      const { postPrDecisionCard, updatePrDecisionCard } = fakeAgentChat()
      const { ctx, db } = fakeCtx(settlingRun('success'))

      await launchIsolatedRail(input([1], ctx), okIo())

      await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('on_review'))
      expect(postPrDecisionCard).not.toHaveBeenCalled()
      expect(updatePrDecisionCard).not.toHaveBeenCalled()
    })

    it('empty registry (tests / agent chat disabled) → settle completes without a crash', async () => {
      // No setAgentChatManager call — getAgentChatManager() returns null.
      const { ctx, db } = fakeCtx(settlingRun('success'))

      await launchIsolatedRail(
        { ...input([1], ctx), originSurface: 'agent-chat', originConversationId: 'conv-9' },
        okIo(),
      )

      await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('on_review'))
    })
  })

  it('kill-switch off: NO delivery row, tickets go done, legacy merge-back runs (byte-identical pin)', async () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
    const { ctx, db, broadcast, onLoopRunFinished } = fakeCtx(settlingRun('success'))

    const ids = await launchIsolatedRail(input([1], ctx), okIo())

    await vi.waitFor(() => expect(mockRunMergeBack).toHaveBeenCalledTimes(1))
    expect((db.prepare('SELECT COUNT(*) AS n FROM rail_pr_deliveries').get() as { n: number }).n).toBe(0)
    expect(prStates(broadcast)).toHaveLength(0)
    expect(onLoopRunFinished).toHaveBeenCalledWith(ids[0], 'success', { ticketCompletionStatus: 'done' })
  })
})

describe('launchIsolatedRail — conventional branch naming (pr-naming threading)', () => {
  const gitWithBranches = (branches: string[]) => ({
    run: async (args: string[]) =>
      args[0] === 'for-each-ref'
        ? { code: 0, stdout: branches.join('\n'), stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
  })
  const mockCreate = () =>
    vi.fn(async (_g: unknown, input: { ticketId: number; branch?: string; slug: string }) => ({
      branch: input.branch ?? `sr/${input.slug}/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))

  it('threads the conventional <type>/<id>-<kebab> name into worktree allocation', async () => {
    const { ctx } = fakeCtx()
    const create = mockCreate()
    await launchIsolatedRail(input([1, 2], ctx), { git: gitWithBranches([]), create, remove: vi.fn(async () => {}) })

    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ticketId: 1, branch: 'feat/1-t1' }))
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ ticketId: 2, branch: 'feat/2-t2' }))
  })

  it('JIRA ALWAYS PREVAILS: a jira_links row keys the branch ref', async () => {
    const { ctx, db } = fakeCtx()
    insertLinkWithId(db, { localId: 1, jiraIssueId: 'j-1', jiraKey: 'SKILLS-9', jiraProjectId: 'jp', deployment: 'cloud' })
    const create = mockCreate()
    await launchIsolatedRail(input([1], ctx), { git: gitWithBranches([]), create, remove: vi.fn(async () => {}) })

    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ branch: 'feat/SKILLS-9-t1' }))
  })

  it('a foreign existing branch collides → bounded -2 suffix', async () => {
    const { ctx } = fakeCtx()
    const create = mockCreate()
    await launchIsolatedRail(input([1], ctx), {
      git: gitWithBranches(['feat/1-t1']), create, remove: vi.fn(async () => {}),
    })

    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ branch: 'feat/1-t1-2' }))
  })

  it('a branch a PRIOR rail run allocated for the SAME ticket is resumed, not suffixed', async () => {
    const { ctx, db } = fakeCtx()
    createRailWorktree(db, { id: 'old', railIndex: 0, ticketId: 1, branch: 'feat/1-t1', worktreePath: '/wt/old', mergeState: 'failed' })
    const create = mockCreate()
    await launchIsolatedRail(input([1], ctx), {
      git: gitWithBranches(['feat/1-t1']), create, remove: vi.fn(async () => {}),
    })

    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ branch: 'feat/1-t1' }))
  })

  it('NEVER allocates the integration branch, even when the preferred name matches it', async () => {
    const { ctx } = fakeCtx()
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'refs/remotes/origin/feat/1-t1\n', stderr: '' }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: '', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const create = mockCreate()
    await launchIsolatedRail(input([1], ctx), { git, create, remove: vi.fn(async () => {}) })

    const allocated = (create.mock.calls[0][1] as { branch?: string }).branch
    expect(allocated).toBe('feat/1-t1-2') // suffixed away from the integration branch
  })

  it('bounded exhaustion falls back to the legacy sr/<slug>/ticket-<id> name', async () => {
    const { ctx } = fakeCtx()
    const taken = ['feat/1-t1', ...Array.from({ length: 25 }, (_, i) => `feat/1-t1-${i + 2}`)]
    const create = mockCreate()
    await launchIsolatedRail(input([1], ctx), {
      git: gitWithBranches(taken), create, remove: vi.fn(async () => {}),
    })

    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ branch: 'sr/p/ticket-1' }))
  })

  it('two units in one launch never collide with each other', async () => {
    // Same title for both tickets — the id inside the ref keeps them distinct.
    const { ctx } = fakeCtx()
    ;(ctx as unknown as { getTicketSpec: (id: number) => unknown }).getTicketSpec = () => ({ title: 'Same title' })
    const create = mockCreate()
    await launchIsolatedRail(input([1, 2], ctx), { git: gitWithBranches([]), create, remove: vi.fn(async () => {}) })

    const branches = create.mock.calls.map((c) => (c[1] as { branch?: string }).branch)
    expect(new Set(branches).size).toBe(2)
    expect(branches).toEqual(['feat/1-same-title', 'feat/2-same-title'])
  })

  it('commit messages include the Jira key when available so GitHub-Jira links commits to the ticket', async () => {
    const { ctx } = fakeCtx(settlingRun('success'))
    ;(ctx as unknown as { getTicketSpec: (id: number) => unknown }).getTicketSpec = (id: number) => ({
      title: 'Add key terms',
      description: 'd',
      jira_key: 'SKILLS-70',
      ticketIds: [id],
    })
    const calls: { args: string[]; cwd: string }[] = []
    const git = {
      run: async (args: string[], cwd: string) => {
        calls.push({ args, cwd })
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const create = mockCreate()

    await launchIsolatedRail(input([98], ctx), {
      git,
      create,
      remove: vi.fn(async () => {}),
    })

    await vi.waitFor(() => expect(calls.some((c) => c.args[0] === 'commit')).toBe(true))
    expect(calls.find((c) => c.args[0] === 'commit')!.args).toEqual([
      'commit',
      '-m',
      expect.stringMatching(/^specrails: SKILLS-70 ticket-98 \(run /),
    ])
  })
})

describe('launchIsolatedRail — active PR continuation', () => {
  beforeEach(() => { delete process.env.SPECRAILS_RAIL_DELIVER_PR }) // PR mode default-on
  afterEach(() => setAgentChatManager(null))

  const continuationCtx = (status = 'on_review') => {
    const ctxs = fakeCtx(settlingRun('success'))
    ;(ctxs.ctx as unknown as { getTicketSpec: (id: number) => unknown }).getTicketSpec = (id: number) => ({
      id,
      title: 'Add key-terms activity to Skills v2 lesson player',
      description: 'Review follow-ups for the existing implementation.',
      status,
      labels: ['feature'],
      jira_key: 'SKILLS-70',
      ticketIds: [id],
    })
    return ctxs
  }

  it('continues a matched open GitHub PR on its head branch instead of creating a fresh ticket branch', async () => {
    const { ctx, db } = continuationCtx()
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: 'feat/SKILLS-19-key-terms-activity\n', stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-19-key-terms-activity') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (cmd === 'gh' && args[0] === 'pr') {
          return {
            code: 0,
            stdout: JSON.stringify([{
              number: 2147,
              title: '[SKILLS-70] Skills V2: flashcard key-term matching + unified footer Continue',
              body: 'Implements ticket #98.',
              headRefName: 'feat/SKILLS-19-key-terms-activity',
              baseRefName: 'main',
              url: 'https://github.com/org/repo/pull/2147',
              isDraft: false,
            }]),
            stderr: '',
          }
        }
        return { code: 1, stdout: '', stderr: 'unexpected' }
      }),
    }

    await launchIsolatedRail(input([98], ctx), {
      git,
      exec,
      create,
      remove: vi.fn(async () => {}),
    })

    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({
      ticketId: 98,
      branch: 'feat/SKILLS-19-key-terms-activity',
    }))
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('pr_ready'))
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      base_branch: 'main',
      branch: 'feat/SKILLS-19-key-terms-activity',
      pr_url: 'https://github.com/org/repo/pull/2147',
      pr_number: 2147,
      pr_state: 'pr-created',
    })
  })

  it('marks an existing-PR continuation as pr_failed when follow-up push fails', async () => {
    const { ctx, db } = continuationCtx()
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-19-key-terms-activity') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'push') return { code: 1, stdout: '', stderr: 'no remote' }
        if (cmd === 'gh' && args[0] === 'pr') {
          return {
            code: 0,
            stdout: JSON.stringify([{
              number: 2147,
              title: '[SKILLS-70] Existing implementation',
              body: 'Implements ticket #98.',
              headRefName: 'feat/SKILLS-19-key-terms-activity',
              baseRefName: 'main',
              url: 'https://github.com/org/repo/pull/2147',
              isDraft: false,
            }]),
            stderr: '',
          }
        }
        return { code: 1, stdout: '', stderr: 'unexpected' }
      }),
    }

    await launchIsolatedRail(input([98], ctx), { git, exec, create, remove: vi.fn(async () => {}) })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('pr_failed'))
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      branch: 'feat/SKILLS-19-key-terms-activity',
      pr_url: 'https://github.com/org/repo/pull/2147',
      pr_state: 'local-only',
    })
  })

  it('continues the explicitly mentioned PR number even when the PR branch uses an older Jira key', async () => {
    const { ctx, db } = continuationCtx()
    ;(ctx as unknown as { getTicketSpec: (id: number) => unknown }).getTicketSpec = (id: number) => ({
      id,
      title: 'Add key-terms activity to Skills v2 lesson player',
      description: 'Review follow-ups (Adversarial Review - PR #2147, HEAD 5964efb8). Scope: F-001 and F-002 only.',
      status: 'on_review',
      labels: ['feature'],
      jira_key: 'SKILLS-70',
      ticketIds: [id],
    })
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-19-key-terms-activity') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'pr' && args[1] === 'list') return {
          code: 0,
          stdout: JSON.stringify([{
            number: 3000,
            title: 'SKILLS-70 unrelated Jira follow-up',
            body: 'This also mentions SKILLS-70 but is not the PR named by the review.',
            headRefName: 'feat/SKILLS-70-unrelated-followup',
            baseRefName: 'main',
            url: 'https://github.com/org/repo/pull/3000',
            isDraft: false,
          }]),
          stderr: '',
        }
        if (args[0] === 'pr' && args[1] === 'view' && args[2] === '2147') return {
          code: 0,
          stdout: JSON.stringify({
            number: 2147,
            title: '[SKILLS-19] Key terms activity',
            body: 'Original implementation for the key-terms activity.',
            headRefName: 'feat/SKILLS-19-key-terms-activity',
            baseRefName: 'main',
            url: 'https://github.com/org/repo/pull/2147',
            isDraft: false,
            state: 'OPEN',
          }),
          stderr: '',
        }
        return { code: 1, stdout: '', stderr: 'unexpected gh call' }
      }),
    }
    const postPrDecisionCard = vi.fn()
    const updatePrDecisionCard = vi.fn()
    setAgentChatManager({ postPrDecisionCard, updatePrDecisionCard } as unknown as AgentChatManager)

    await launchIsolatedRail(
      { ...input([98], ctx), originSurface: 'agent-chat', originConversationId: 'conv-pr-2147' },
      { git, exec, create, remove: vi.fn(async () => {}) },
    )

    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({
      ticketId: 98,
      branch: 'feat/SKILLS-19-key-terms-activity',
      baseRef: 'origin/feat/SKILLS-19-key-terms-activity',
      refreshFromBaseRef: true,
    }))
    expect(postPrDecisionCard).toHaveBeenCalledWith('conv-pr-2147', expect.objectContaining({
      kind: 'pr_decision',
      decision: 'building',
      branch: 'feat/SKILLS-19-key-terms-activity',
      prUrl: 'https://github.com/org/repo/pull/2147',
      prNumber: 2147,
      prState: 'pr-created',
    }))
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('pr_ready'))
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      base_branch: 'main',
      branch: 'feat/SKILLS-19-key-terms-activity',
      pr_url: 'https://github.com/org/repo/pull/2147',
      pr_number: 2147,
    })
  })

  it('continues an explicit Jira-matched PR when Jira review still materializes locally as in_progress', async () => {
    const { ctx, db } = continuationCtx('in_progress')
    insertLinkWithId(db, { localId: 98, jiraIssueId: 'jira-98', jiraKey: 'SKILLS-70', jiraProjectId: 'jp', deployment: 'cloud' })
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-70-review-followups') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify([{
          number: 2148,
          title: 'SKILLS-70 review follow-ups',
          body: 'Follow-up work for the linked Jira issue.',
          headRefName: 'feat/SKILLS-70-review-followups',
          baseRefName: 'main',
          url: 'https://github.com/o/r/pull/2148',
          isDraft: false,
        }]),
        stderr: '',
      })),
    }

    await launchIsolatedRail(input([98], ctx), { git, exec, create, remove: vi.fn(async () => {}) })

    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({
      ticketId: 98,
      branch: 'feat/SKILLS-70-review-followups',
    }))
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('pr_ready'))
  })

  it('branches from origin/<open-pr-head> when only the remote PR branch exists locally', async () => {
    const { ctx } = continuationCtx()
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-19-key-terms-activity') {
          return { code: 1, stdout: '', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/remotes/origin/feat/SKILLS-19-key-terms-activity') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: JSON.stringify([{
          number: 2147,
          title: '[SKILLS-70] Existing implementation',
          headRefName: 'feat/SKILLS-19-key-terms-activity',
          baseRefName: 'main',
          url: 'https://github.com/o/r/pull/2147',
          isDraft: true,
        }]),
        stderr: '',
      })),
    }

    await launchIsolatedRail(input([98], ctx), { git, exec, create, remove: vi.fn(async () => {}) })

    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({
      ticketId: 98,
      branch: 'feat/SKILLS-19-key-terms-activity',
      baseRef: 'origin/feat/SKILLS-19-key-terms-activity',
    }))
  })

  it('keeps the normal fresh-branch flow when the ticket is not on_review', async () => {
    const { ctx } = fakeCtx()
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const exec = { run: vi.fn(async () => ({ code: 0, stdout: '[]', stderr: '' })) }

    await launchIsolatedRail(input([1], ctx), {
      git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      exec,
      create,
      remove: vi.fn(async () => {}),
    })

    expect(exec.run).not.toHaveBeenCalled()
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ branch: 'feat/1-t1' }))
  })
})

describe('launchIsolatedRail — stale mounted worktree from a prior run (live #37 repro)', () => {
  beforeEach(() => { delete process.env.SPECRAILS_RAIL_DELIVER_PR })

  it('REPRO: the settled delivery + ledger record the branch that ACTUALLY carries the commits, not the preferred name', async () => {
    // A prior auto-discarded run of the SAME ticket left its worktree MOUNTED
    // on the legacy sr/ branch. The worktree path is keyed by ticketId only, so
    // the new launch's real createWorktree reuses that checkout — the run's
    // commits land on sr/p/ticket-1 while the old code recorded the preferred
    // feat/1-t1 name that never existed → `git push` had no ref → local-only
    // wedge that no retry could heal.
    const { ctx, db } = fakeCtx(settlingRun('success'))
    const wt = path.join(resolveHome(), '.specrails', 'projects', 'p', 'worktrees', 'ticket-1')
    createRailWorktree(db, { id: 'stale', railIndex: 0, ticketId: 1, branch: 'sr/p/ticket-1', worktreePath: wt, mergeState: 'failed' })
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          return { code: 0, stdout: `worktree /repo\nworktree ${wt}\n`, stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { code: 0, stdout: 'sr/p/ticket-1\n', stderr: '' } // the mounted checkout's REAL branch
        }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: 'sr/p/ticket-1\n', stderr: '' }
        return { code: 0, stdout: '', stderr: '' }
      },
    }

    // REAL createWorktree (no io.create injection) — the record/mount drift lived there.
    await launchIsolatedRail(input([1], ctx), { git, remove: vi.fn(async () => {}) })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('on_review'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(JSON.parse(row.branches)).toEqual([{ ticketId: 1, branch: 'sr/p/ticket-1', succeeded: true }])
    const fresh = listRailWorktrees(db, 0).filter((r) => r.id !== 'stale')
    expect(fresh).toHaveLength(1)
    expect(fresh[0].branch).toBe('sr/p/ticket-1')
    expect(fresh[0].merge_state).toBe('built')
  })
})

describe('launchIsolatedRail — failed-implementation cleanup (0 succeeded)', () => {
  beforeEach(() => { delete process.env.SPECRAILS_RAIL_DELIVER_PR }) // PR mode default-on

  const gitOk = () => ({ run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  const okCreate = () =>
    vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))

  it('unmounts every worktree at the failed-implementation settle (branches KEPT for resume; ledger terminal)', async () => {
    const { ctx, db } = fakeCtx(settlingRun('failure'))
    const remove = vi.fn(async () => {})

    await launchIsolatedRail(input([1, 2], ctx), { git: gitOk(), create: okCreate(), remove })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('implementation_failed'))
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(2))
    // Worktrees unmounted NOW (not left to poison the next run of the same
    // ticket) — but the branches survive: partial work stays resumable and
    // user-discard remains the only branch-deleting action.
    expect(remove).toHaveBeenCalledWith(expect.anything(), {
      repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1', deleteBranch: false,
    })
    expect(remove).toHaveBeenCalledWith(expect.anything(), {
      repoDir: '/repo', worktreePath: '/wt/ticket-2', branch: 'sr/p/ticket-2', deleteBranch: false,
    })
    expect(listRailWorktrees(db, 0).every((r) => r.merge_state === 'failed')).toBe(true)
  })

  it('a settle with ≥1 success keeps every worktree mounted (unchanged pre-decision behaviour)', async () => {
    const { ctx, db } = fakeCtx(settlingRun('success'))
    const remove = vi.fn(async () => {})

    await launchIsolatedRail(input([1], ctx), { git: gitOk(), create: okCreate(), remove })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('on_review'))
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('launchIsolatedRail — per-run worktree overlay', () => {
  const gitOk = () => ({ run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  const okCreate = () =>
    vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
  const noopOverlay = () => vi.fn(() => ({ createdPaths: [], warnings: [] }))

  it('applies the overlay to EVERY allocated worktree; legacy project → repo as source root, claude surface', async () => {
    const { ctx } = fakeCtx()
    const overlay = noopOverlay()
    await launchIsolatedRail(input([1, 2], ctx), { git: gitOk(), create: okCreate(), remove: vi.fn(async () => {}), overlay })

    expect(overlay).toHaveBeenCalledTimes(2)
    expect(overlay).toHaveBeenCalledWith({
      worktreePath: '/wt/ticket-1',
      sourceRoot: '/repo', // legacy: the repo's own on-disk untracked entries
      providerDir: '.claude',
      instructionsFilename: 'CLAUDE.md',
    })
  })

  it('RELOCATED project → the WORKSPACE is the overlay source root', async () => {
    const { ctx } = fakeCtx()
    const overlay = noopOverlay()
    const resolveExecution = vi.fn(() => ({ relocated: true, workspaceDir: '/home/.specrails/projects/p/workspace' })) as never
    await launchIsolatedRail(input([1], ctx), { git: gitOk(), create: okCreate(), remove: vi.fn(async () => {}), overlay, resolveExecution })

    expect(overlay).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: '/wt/ticket-1',
      sourceRoot: '/home/.specrails/projects/p/workspace',
    }))
  })

  it('overlay warnings degrade: rail.overlay_degraded broadcast, spawn still proceeds', async () => {
    const { ctx, run, broadcast } = fakeCtx()
    const overlay = vi.fn(() => ({ createdPaths: [], warnings: ['failed to link .claude/commands/specrails: EACCES'] }))
    const ids = await launchIsolatedRail(input([1], ctx), { git: gitOk(), create: okCreate(), remove: vi.fn(async () => {}), overlay })

    expect(ids).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1) // degraded ≠ aborted
    expect(broadcast).toHaveBeenCalledWith({
      type: 'rail.overlay_degraded',
      projectId: 'proj',
      railIndex: 0,
      ticketId: 1,
      warnings: ['failed to link .claude/commands/specrails: EACCES'],
    })
  })

  it('a THROWING overlay (defensive) degrades the same way instead of failing the launch', async () => {
    const { ctx, run, broadcast } = fakeCtx()
    const overlay = vi.fn(() => { throw new Error('boom') })
    const ids = await launchIsolatedRail(input([1], ctx), { git: gitOk(), create: okCreate(), remove: vi.fn(async () => {}), overlay: overlay as never })

    expect(ids).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'rail.overlay_degraded', warnings: ['boom'] }))
  })

  it('commit at settle EXCLUDES overlay-owned paths (never land on the ticket branch/PR)', async () => {
    const { ctx } = fakeCtx(settlingRun('success'))
    const calls: { args: string[]; cwd: string }[] = []
    const git = { run: async (args: string[], cwd: string) => { calls.push({ args, cwd }); return { code: 0, stdout: '', stderr: '' } } }
    const overlay = vi.fn(() => ({
      createdPaths: ['.claude/commands/specrails', '.claude/agents', '.sr-rail-overlay.json'],
      warnings: [],
    }))
    await launchIsolatedRail(input([1], ctx), { git, create: okCreate(), remove: vi.fn(async () => {}), overlay })

    await vi.waitFor(() => expect(calls.some((c) => c.args[0] === 'add')).toBe(true))
    const add = calls.find((c) => c.args[0] === 'add')!
    expect(add.cwd).toBe('/wt/ticket-1')
    expect(add.args).toEqual([
      'add', '-A', '--', '.',
      ...PR_NEVER_STAGE_PATHS.map((p) => `:(exclude)${p}`),
      ':(exclude).claude/commands/specrails',
      ':(exclude).claude/agents',
      ':(exclude).sr-rail-overlay.json',
    ])
  })

  it('REGRESSION PIN: a no-op overlay (fully-tracked legacy repo) adds only permanent PR excludes', async () => {
    const { ctx } = fakeCtx(settlingRun('success'))
    const calls: { args: string[]; cwd: string }[] = []
    const git = { run: async (args: string[], cwd: string) => { calls.push({ args, cwd }); return { code: 0, stdout: '', stderr: '' } } }
    await launchIsolatedRail(input([1], ctx), { git, create: okCreate(), remove: vi.fn(async () => {}), overlay: noopOverlay() })

    await vi.waitFor(() => expect(calls.some((c) => c.args[0] === 'add')).toBe(true))
    expect(calls.find((c) => c.args[0] === 'add')!.args).toEqual([
      'add', '-A', '--', '.',
      ...PR_NEVER_STAGE_PATHS.map((p) => `:(exclude)${p}`),
    ])
  })
})

describe('launchIsolatedRail — Code-Explorer provenance (construction story seam)', () => {
  const gitOk = () => ({ run: async () => ({ code: 0, stdout: '', stderr: '' }) })
  const okCreate = () =>
    vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
  const fakeSnapshot = { ref: '', untracked: ['.claude/agents'], headSha: 'base-sha' }

  it('snapshots each worktree at allocation and records provenance ONCE at settle', async () => {
    const { ctx } = fakeCtx(settlingRun('success'))
    const snapshot = vi.fn(() => fakeSnapshot)
    const recordProvenance = vi.fn(() => 1)
    const ids = await launchIsolatedRail(input([1, 2], ctx), {
      git: gitOk(), create: okCreate(), remove: vi.fn(async () => {}),
      snapshot, recordProvenance,
    })

    expect(snapshot).toHaveBeenCalledTimes(2)
    expect(snapshot).toHaveBeenCalledWith('/wt/ticket-1')
    await vi.waitFor(() => expect(recordProvenance).toHaveBeenCalledTimes(2))
    expect(recordProvenance).toHaveBeenCalledWith(expect.objectContaining({
      db: ctx.db,
      projectId: 'proj',
      runId: ids[0],
      ticketId: 1,
      repoDir: '/wt/ticket-1',
      snapshot: fakeSnapshot,
    }))
  })

  it('records provenance on the FAILURE settle path too (partial work is provenance)', async () => {
    const { ctx } = fakeCtx(() => Promise.reject(new Error('run crashed')))
    const recordProvenance = vi.fn(() => 0)
    await launchIsolatedRail(input([1], ctx), {
      git: gitOk(), create: okCreate(), remove: vi.fn(async () => {}),
      snapshot: vi.fn(() => fakeSnapshot), recordProvenance,
    })
    await vi.waitFor(() => expect(recordProvenance).toHaveBeenCalledTimes(1))
    expect(recordProvenance).toHaveBeenCalledWith(expect.objectContaining({ snapshot: fakeSnapshot, ticketId: 1 }))
  })

  it('a throwing snapshot degrades to null (run proceeds; recorder still called with null)', async () => {
    const { ctx, run } = fakeCtx(settlingRun('success'))
    const recordProvenance = vi.fn(() => 0)
    await launchIsolatedRail(input([1], ctx), {
      git: gitOk(), create: okCreate(), remove: vi.fn(async () => {}),
      snapshot: vi.fn(() => { throw new Error('no git') }), recordProvenance,
    })
    expect(run).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(recordProvenance).toHaveBeenCalledTimes(1))
    expect(recordProvenance).toHaveBeenCalledWith(expect.objectContaining({ snapshot: null }))
  })

  it('skips the snapshot entirely when the code explorer is disabled', async () => {
    process.env.SPECRAILS_CODE_EXPLORER = 'false'
    try {
      const { ctx } = fakeCtx(settlingRun('success'))
      const snapshot = vi.fn(() => fakeSnapshot)
      await launchIsolatedRail(input([1], ctx), {
        git: gitOk(), create: okCreate(), remove: vi.fn(async () => {}), snapshot,
      })
      expect(snapshot).not.toHaveBeenCalled()
    } finally {
      delete process.env.SPECRAILS_CODE_EXPLORER
    }
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

// ── Concurrent launches (Launch all / agent fan-out) ─────────────────────────
// Parallel rails are safe BECAUSE allocation is serialized per repo: the
// integration-branch resolution, the listLocalBranches snapshot, and the
// `git worktree add` fan-in all run under withRepoLock(baseRepo). Without it,
// two simultaneous launches interleave git worktree/branch creation on the
// same repository (ref-lock races, duplicate collision-suffixed branch names).
// The AI runs themselves stay fully parallel — only allocation is locked.

describe('launchIsolatedRail — concurrent-launch allocation serialization', () => {
  beforeEach(async () => {
    const { __resetRepoLocks } = await import('./repo-lock')
    __resetRepoLocks()
  })

  it('serializes worktree ALLOCATION across two concurrent launches on the same repo', async () => {
    // Two independent rails launched at the same instant (Launch all). The
    // injected `create` records concurrent occupancy — with the lock it must
    // never observe two allocations in flight at once.
    let active = 0
    let maxActive = 0
    const slowCreate = vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 15))
      active--
      return { branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }
    })
    const a = fakeCtx()
    const b = fakeCtx() // same project path '/repo' → same repo lock key
    const io: IsolatedLaunchIO = {
      git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      create: slowCreate,
      remove: vi.fn(async () => {}),
    }

    const [idsA, idsB] = await Promise.all([
      launchIsolatedRail(input([1, 2], a.ctx), io),
      launchIsolatedRail({ ...input([3], b.ctx), railIndex: 1 }, io),
    ])

    expect(idsA).toHaveLength(2)
    expect(idsB).toHaveLength(1)
    expect(slowCreate).toHaveBeenCalledTimes(3)
    expect(maxActive).toBe(1) // allocations never overlapped
    a.db.close(); b.db.close()
  })

  it('a failed allocation releases the lock — the concurrent launch still proceeds', async () => {
    let calls = 0
    const create = vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => {
      if (++calls === 1) throw new Error('git worktree add failed')
      return { branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }
    })
    const a = fakeCtx()
    const b = fakeCtx()
    const io: IsolatedLaunchIO = {
      git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      create,
      remove: vi.fn(async () => {}),
    }

    const [ra, rb] = await Promise.allSettled([
      launchIsolatedRail(input([1], a.ctx), io),
      launchIsolatedRail({ ...input([2], b.ctx), railIndex: 1 }, io),
    ])

    expect(ra.status).toBe('rejected') // first alloc failed → caller falls back
    expect(rb.status).toBe('fulfilled')
    expect((rb as PromiseFulfilledResult<string[]>).value).toHaveLength(1)
    a.db.close(); b.db.close()
  })
})
