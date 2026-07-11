import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveHome } from './artifact-registry'
import { launchIsolatedRail, reconcileRailWorktrees, type IsolatedLaunchIO } from './rail-isolated-launch'
import { initDb } from './db'
import { initDesktopDb } from './desktop-db'
import { listRailWorktrees, createRailWorktree, updateRailWorktreeState, getRailWorktree } from './rail-worktrees-store'
import { createPrDelivery, getActivePrDeliveryByRail, getPrDelivery, listActivePrDeliveries, PrDeliveryGenerationConflict, transitionDecision, type DeliverBranchRecord } from './rail-pr-store'
import { createLoopRun } from './loop-runs-store'
import { insertLinkWithId } from './jira/jira-db'
import { setAgentChatManager } from './agent-chat-registry'
import type { AgentChatManager } from './agent-chat-manager'
import type { RailPrStateMessage, RailFetchDegradedMessage } from './types'
import type { ProjectContext } from './project-registry'
import { __resetFetchOriginCache } from './integration-branch'
import { PR_NEVER_STAGE_PATHS } from './worktree-manager'
import { recoveryRefForDelivery } from './rail-pr-recovery-git'

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
const TEST_SHA = 'a'.repeat(40)
const recoveryPrExec = (branch: string, headSha = 'b'.repeat(40)) => ({
  run: async () => ({
    code: 0,
    stdout: JSON.stringify({
      state: 'OPEN', isDraft: false, headRefName: branch, baseRefName: 'main',
      isCrossRepository: false,
      headRefOid: headSha, mergeCommit: null, commits: [{ oid: headSha }],
    }),
    stderr: '',
  }),
})
const successfulGitResult = (args: string[]) =>
  args[0] === 'rev-parse' && args.includes('--verify')
    ? { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
    : { code: 0, stdout: '', stderr: '' }

function recoveryRefAwareGit(
  fallback: (args: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }> | { code: number; stdout: string; stderr: string },
) {
  const refs = new Map<string, string>()
  const run = vi.fn(async (args: string[], cwd: string) => {
    if (args[0] === 'for-each-ref' && args[2] === 'refs/specrails/recovery/') {
      return {
        code: 0,
        stdout: [...refs].map(([ref, sha]) => `${ref}\t${sha}`).join('\n'),
        stderr: '',
      }
    }
    if (args[0] === 'show-ref' && args[3]?.startsWith('refs/specrails/recovery/')) {
      return refs.has(args[3])
        ? { code: 0, stdout: '', stderr: '' }
        : { code: 1, stdout: '', stderr: '' }
    }
    if (args[0] === 'update-ref' && args[1] === '-d') {
      const [, , ref, expected] = args
      if (!refs.has(ref)) return { code: 0, stdout: '', stderr: '' }
      if (expected && refs.get(ref) !== expected) return { code: 1, stdout: '', stderr: 'mismatch' }
      refs.delete(ref)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (args[0] === 'update-ref' && args[1]?.startsWith('refs/specrails/recovery/')) {
      const [, ref, sha, expected] = args
      if (expected && refs.has(ref)) return { code: 1, stdout: '', stderr: 'exists' }
      refs.set(ref, sha)
      return { code: 0, stdout: '', stderr: '' }
    }
    if (
      args[0] === 'rev-parse' && args[1] === '--verify' &&
      args[2]?.startsWith('refs/specrails/recovery/')
    ) {
      const value = refs.get(args[2])
      return value
        ? { code: 0, stdout: `${value}\n`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'missing' }
    }
    return fallback(args, cwd)
  })
  return { git: { run }, run, refs }
}
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
        return successfulGitResult(args)
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

  it('keeps a pre-existing resumable branch when a later allocation rolls back', async () => {
    const { ctx, db, run } = fakeCtx()
    createRailWorktree(db, {
      id: 'prior-ticket-1',
      railIndex: 0,
      ticketId: 1,
      branch: 'feat/1-t1',
      worktreePath: '/old/ticket-1',
      mergeState: 'failed',
    })
    let allocations = 0
    const create = vi.fn(async (_g: unknown, createInput: { branch?: string; ticketId: number }) => {
      allocations++
      if (allocations === 2) throw new Error('second allocation failed')
      return {
        branch: createInput.branch!,
        worktreePath: `/wt/ticket-${createInput.ticketId}`,
        worktreeCreated: true,
        branchCreated: false,
      }
    })
    const remove = vi.fn(async () => {})
    const git = {
      run: async (args: string[]) => args[0] === 'for-each-ref'
        ? { code: 0, stdout: 'feat/1-t1\n', stderr: '' }
        : { code: 0, stdout: '', stderr: '' },
    }

    await expect(launchIsolatedRail(input([1, 2], ctx), { git, create, remove }))
      .rejects.toThrow(/second allocation failed/)

    expect(run).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith(git, {
      repoDir: '/repo',
      worktreePath: '/wt/ticket-1',
      branch: 'feat/1-t1',
      deleteBranch: false,
    })
    expect(getRailWorktree(db, 'prior-ticket-1')?.merge_state).toBe('failed')
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
    ({ git: { run: async (args: string[]) => successfulGitResult(args) }, create, remove: vi.fn(async () => {}) }) as IsolatedLaunchIO

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
    const states = prStates(broadcast)
    expect(states).toHaveLength(2)
    expect(states[0]).toMatchObject({
      ...base, runIds: [], implementationOutcome: 'running', deliveryOutcome: 'pending',
      statusCode: 'implementation_running', units: [],
    })
    expect(states[1]).toMatchObject({
      ...base, runIds: ids, implementationOutcome: 'running', deliveryOutcome: 'pending',
      statusCode: 'implementation_running', units: [],
    })
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
    const units = JSON.parse(row.branches)
    expect(units).toHaveLength(2)
    expect(units[0]).toMatchObject({
      ticketId: 1, branch: 'sr/p/ticket-1', succeeded: true, runId: ids[0],
      implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
      initialSha: TEST_SHA, finalSha: TEST_SHA, changed: true, failureCode: null,
    })
    expect(units[1]).toMatchObject({
      ticketId: 2, branch: 'sr/p/ticket-2', succeeded: true, runId: ids[1],
      implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
      initialSha: TEST_SHA, finalSha: TEST_SHA, changed: true, failureCode: null,
    })
    expect(row).toMatchObject({
      implementation_outcome: 'succeeded', delivery_outcome: 'ready', status_code: 'ready_for_review',
    })
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

  it('a proven clean zero-delta run becomes no_changes and never offers delivery', async () => {
    const { ctx, db, onLoopRunFinished } = fakeCtx(settlingRun('success'))
    const remove = vi.fn(async () => {})
    const create = vi.fn(async (_git: unknown, createInput: { branch: string; ticketId: number }) => ({
      branch: createInput.branch,
      worktreePath: `/wt/ticket-${createInput.ticketId}`,
      branchCreated: true,
      worktreeCreated: true,
    }))
    const git = {
      run: async (args: string[]) => args[0] === 'commit'
        ? { code: 1, stdout: 'nothing to commit', stderr: '' }
        : successfulGitResult(args),
    }

    const ids = await launchIsolatedRail(input([1], ctx), { git, create, remove })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('no_changes'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(row).toMatchObject({
      implementation_outcome: 'succeeded', delivery_outcome: 'no_changes', status_code: 'no_changes',
    })
    expect(JSON.parse(row.branches)[0]).toMatchObject({
      runId: ids[0], implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes',
      initialSha: TEST_SHA, finalSha: TEST_SHA, changed: false, succeeded: false,
    })
    expect(onLoopRunFinished).toHaveBeenCalledWith(ids[0], 'success', { ticketCompletionStatus: 'on_review' })
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1))
  })

  it('does not offer an empty PR for a resumed branch with zero commits ahead of base', async () => {
    const { ctx, db } = fakeCtx(settlingRun('success'))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'commit') return { code: 1, stdout: 'nothing to commit', stderr: '' }
        if (args[0] === 'diff') return { code: 0, stdout: '', stderr: '' }
        return successfulGitResult(args)
      },
    }

    await launchIsolatedRail(input([1], ctx), { ...okIo(), git })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('no_changes'))
    expect(JSON.parse(getActivePrDeliveryByRail(db, 0)!.branches)[0]).toMatchObject({
      branch: 'sr/p/ticket-1', changed: false, deliveryOutcome: 'no_changes', succeeded: false,
    })
  })

  it('persists a mixed batch as partial without dropping the failed unit', async () => {
    let call = 0
    const { ctx, db } = fakeCtx(async ({ runId }) => ({ runId, outcome: call++ === 0 ? 'success' : 'failed' }))
    const create = vi.fn(async (_git: unknown, createInput: { branch: string; ticketId: number }) => ({
      branch: createInput.branch,
      worktreePath: `/wt/ticket-${createInput.ticketId}`,
      branchCreated: true,
      worktreeCreated: true,
    }))

    const ids = await launchIsolatedRail(input([1, 2], ctx), {
      git: { run: async (args: string[]) => successfulGitResult(args) },
      create,
      remove: vi.fn(async () => {}),
    })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('on_review'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(row).toMatchObject({
      implementation_outcome: 'partially_succeeded', delivery_outcome: 'partial', status_code: 'partial_success',
    })
    const units = JSON.parse(row.branches)
    expect(units).toHaveLength(2)
    expect(units[0]).toMatchObject({ runId: ids[0], implementationOutcome: 'succeeded', deliveryOutcome: 'ready' })
    expect(units[1]).toMatchObject({ runId: ids[1], implementationOutcome: 'failed', deliveryOutcome: 'not_started' })
  })

  it('retains a successful unit when deferred terminal settlement throws', async () => {
    const { ctx, db, onLoopRunFinished } = fakeCtx(settlingRun('success'))
    onLoopRunFinished.mockImplementation(() => { throw new Error('terminal callback unavailable') })

    const ids = await launchIsolatedRail(input([1], ctx), okIo())

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_failed'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(row).toMatchObject({
      implementation_outcome: 'succeeded', delivery_outcome: 'blocked', status_code: 'settlement_interrupted',
    })
    expect(JSON.parse(row.branches)).toHaveLength(1)
    expect(JSON.parse(row.branches)[0]).toMatchObject({
      runId: ids[0], implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      failureCode: 'settlement_interrupted',
    })
    expect(listRailWorktrees(db, 0)[0].merge_state).toBe('needs-review')
  })

  it('successful engine + dirty commit failure stays successful and preserves a needs-review worktree', async () => {
    const { ctx, db, broadcast, onLoopRunFinished } = fakeCtx(settlingRun('success'))
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'commit') return { code: 1, stdout: '', stderr: 'pre-commit hook rejected the commit' }
        if (args[0] === 'status') return { code: 0, stdout: ' M src/app.ts\n', stderr: '' }
        return successfulGitResult(args)
      },
    }

    const ids = await launchIsolatedRail(input([1], ctx), { ...okIo(), git })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_failed'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(row).toMatchObject({
      implementation_outcome: 'succeeded', delivery_outcome: 'blocked', status_code: 'commit_failed',
    })
    expect(JSON.parse(row.branches)[0]).toMatchObject({
      ticketId: 1, branch: 'sr/p/ticket-1', succeeded: false, runId: ids[0],
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', failureCode: 'commit_failed',
    })
    expect(onLoopRunFinished).toHaveBeenCalledWith(ids[0], 'success', { ticketCompletionStatus: 'on_review' })
    expect(getRailWorktree(db, JSON.parse(row.worktree_ids)[0])?.merge_state).toBe('needs-review')
    expect(prStates(broadcast).map((m) => m.decision)).toEqual(['building', 'building', 'pr_failed'])
    expect(mockRunMergeBack).not.toHaveBeenCalled()
  })

  it('a git status failure blocks delivery without rewriting successful engine truth', async () => {
    const { ctx, db, onLoopRunFinished } = fakeCtx(settlingRun('success'))
    const git = {
      run: async (args: string[]) => args[0] === 'status'
        ? { code: 128, stdout: '', stderr: 'cannot read index' }
        : successfulGitResult(args),
    }

    const ids = await launchIsolatedRail(input([1], ctx), { ...okIo(), git })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_failed'))
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      implementation_outcome: 'succeeded', delivery_outcome: 'blocked', status_code: 'commit_failed',
    })
    expect(JSON.parse(getActivePrDeliveryByRail(db, 0)!.branches)[0]).toMatchObject({
      runId: ids[0], implementationOutcome: 'succeeded', deliveryOutcome: 'blocked', failureCode: 'commit_failed',
    })
    expect(onLoopRunFinished).toHaveBeenCalledWith(ids[0], 'success', { ticketCompletionStatus: 'on_review' })
    expect(listRailWorktrees(db, 0)[0].merge_state).toBe('needs-review')
  })

  it('settle (0 succeeded) → implementation_failed with run logs, branches persisted with succeeded:false', async () => {
    const { ctx, db, broadcast } = fakeCtx(settlingRun('failure'))

    const ids = await launchIsolatedRail(input([1], ctx), okIo())

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('implementation_failed'))
    const all = db.prepare('SELECT decision, branches FROM rail_pr_deliveries').all() as { decision: string; branches: string }[]
    expect(all).toHaveLength(1)
    expect(all[0].decision).toBe('implementation_failed')
    expect(JSON.parse(all[0].branches)[0]).toMatchObject({
      ticketId: 1, branch: 'sr/p/ticket-1', succeeded: false, runId: ids[0],
      implementationOutcome: 'failed', deliveryOutcome: 'not_started',
      initialSha: TEST_SHA, finalSha: TEST_SHA,
    })
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

  it('always closes the building row on allocation failure; no shared-cwd continuation handoff remains', async () => {
    const { ctx, db, broadcast } = fakeCtx()
    let prDeliveryId = ''
    const create = vi.fn(async () => {
      throw new Error('git worktree add failed')
    })

    await expect(launchIsolatedRail({
      ...input([1], ctx),
      onPrDeliveryCreated: (id) => { prDeliveryId = id },
    }, okIo(create))).rejects.toThrow(/worktree add failed/)

    const row = getActivePrDeliveryByRail(db, 0)
    expect(row).toBeUndefined()
    expect(prDeliveryId).not.toBe('')
    expect(prStates(broadcast).map((m) => m.decision)).toEqual(['building', 'discarded'])
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
      expect(updatePrDecisionCard).toHaveBeenLastCalledWith('conv-9', expect.objectContaining({
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
        implementationOutcome: 'succeeded',
        deliveryOutcome: 'ready',
        statusCode: 'ready_for_review',
      }))
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
        return successfulGitResult(args)
      },
    }
    const create = mockCreate()

    await launchIsolatedRail(input([98], ctx), {
      git,
      create,
      remove: vi.fn(async () => {}),
    })

    await vi.waitFor(() => expect(calls.some((c) => c.args[0] === 'commit')).toBe(true))
    expect(calls.find((c) => c.args[0] === 'commit')!.args).toEqual(expect.arrayContaining([
      'commit',
      '--no-verify',
      '--only',
      '-m',
      expect.stringMatching(/^specrails: SKILLS-70 ticket-98 \(run /),
    ]))
  })
})

describe('launchIsolatedRail — active PR continuation', () => {
  beforeEach(() => { delete process.env.SPECRAILS_RAIL_DELIVER_PR }) // PR mode default-on
  afterEach(() => setAgentChatManager(null))

  const continuationSha = 'a'.repeat(40)
  const openPrLifecycle = (input: {
    branch: string
    url: string
    number: number
    isDraft?: boolean
    title?: string
    body?: string
    sha?: string
  }) => JSON.stringify({
    state: 'OPEN',
    isDraft: input.isDraft ?? false,
    headRefName: input.branch,
    baseRefName: 'main',
    isCrossRepository: false,
    headRefOid: input.sha ?? continuationSha,
    mergeCommit: null,
    commits: [{ oid: input.sha ?? continuationSha }],
    number: input.number,
    url: input.url,
    title: input.title ?? 'Existing implementation',
    body: input.body ?? 'Follow-up implementation.',
  })
  const matchingPushRemote = (prUrl: string) => {
    const segments = new URL(prUrl).pathname.split('/').filter(Boolean)
    return { code: 0, stdout: `https://github.com/${segments[0]}/${segments[1]}.git\n`, stderr: '' }
  }
  const verifiedContinuationRef = (args: string[], cwd: string, branch: string) => {
    if (cwd.startsWith('/wt/') && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
      return { code: 0, stdout: `${branch}\n`, stderr: '' }
    }
    if (cwd.startsWith('/wt/') && args.join(' ') === 'rev-parse --verify HEAD') {
      return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
    }
    if (!args.includes('--quiet') && args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
      return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
    }
    return null
  }

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

  const seedDiscardedHistoricalContinuation = (
    db: ReturnType<typeof initDb>,
    ticketIds: number[],
    branch = 'feat/SKILLS-70-historical-followup',
  ) => {
    const row = createPrDelivery(db, {
      id: `discarded-history-${ticketIds.join('-')}`,
      railIndex: 0,
      loopId: 'factory:implement',
      railKey: '0-factory:implement',
      ticketIds,
      baseBranch: 'main',
      loopName: 'Implement',
      originSurface: 'dashboard',
      isContinuation: true,
    })
    transitionDecision(db, row.id, 'building', 'discarded', {
      branch,
      prUrl: 'https://github.com/o/r/pull/2170',
      prNumber: 2170,
      prState: 'local-only',
      deliverySha: continuationSha,
      implementationOutcome: 'succeeded',
      deliveryOutcome: 'retryable_failure',
      statusCode: 'push_failed',
      isContinuation: true,
    })
    return row
  }

  const historicalContinuationIo = (branch: string) => {
    const git = {
      run: async (args: string[], cwd: string) => {
        if (cwd.startsWith('/wt/') && args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (cwd.startsWith('/wt/') && args.join(' ') === 'rev-parse --verify HEAD') {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/remotes/origin/${branch}`) {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: openPrLifecycle({
          branch,
          url: 'https://github.com/o/r/pull/2170',
          number: 2170,
        }),
        stderr: '',
      })),
    }
    const create = vi.fn(async (_git: unknown, request: { branch: string; ticketId: number }) => ({
      branch: request.branch,
      worktreePath: `/wt/ticket-${request.ticketId}`,
      worktreeCreated: true,
      branchCreated: false,
    }))
    return { git, exec, create, remove: vi.fn(async () => {}) }
  }

  it('scope=all recovers a discarded continuation only from the same complete historical ticket set', async () => {
    const { ctx, db, run } = fakeCtx()
    const branch = 'feat/SKILLS-70-historical-followup'
    const predecessor = seedDiscardedHistoricalContinuation(db, [99, 98], branch)
    const io = historicalContinuationIo(branch)

    const ids = await launchIsolatedRail({ ...input([98, 99], ctx), scope: 'all' }, io)

    expect(ids).toHaveLength(1)
    expect(io.create).toHaveBeenCalledTimes(1)
    expect(io.create).toHaveBeenCalledWith(io.git, expect.objectContaining({
      ticketId: 98,
      branch,
      baseRef: `origin/${branch}`,
      refreshFromBaseRef: true,
    }))
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toMatchObject({
      ticketId: 98,
      spec: { ticketIds: [98, 99] },
      isolation: { branch },
    })
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      ticket_ids: '[98,99]',
      branch,
      pr_url: 'https://github.com/o/r/pull/2170',
      delivery_sha: continuationSha,
      is_continuation: 1,
      supersedes_delivery_id: predecessor.id,
    })
    expect(io.exec.run).toHaveBeenCalledTimes(1)
  })

  it('scope=all does not lend a one-ticket historical PR to a larger batch', async () => {
    const { ctx, db, run } = fakeCtx()
    const historicalBranch = 'feat/SKILLS-70-historical-followup'
    seedDiscardedHistoricalContinuation(db, [98], historicalBranch)
    const io = historicalContinuationIo(historicalBranch)

    const ids = await launchIsolatedRail({ ...input([98, 99], ctx), scope: 'all' }, io)

    expect(ids).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(io.create).toHaveBeenCalledWith(io.git, expect.objectContaining({ ticketId: 98 }))
    expect(io.create).not.toHaveBeenCalledWith(io.git, expect.objectContaining({ branch: historicalBranch }))
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      ticket_ids: '[98,99]',
      branch: null,
      pr_url: null,
      is_continuation: 0,
    })
    expect(io.exec.run).not.toHaveBeenCalled()
  })

  it('fails closed when the router-required PR branch cannot be materialized', async () => {
    const { ctx, run } = continuationCtx()
    const create = vi.fn()

    await expect(launchIsolatedRail({
      ...input([98], ctx),
      requiredPrContinuation: {
        deliveryId: 'missing-delivery',
        decision: 'pr_ready',
        branch: 'feat/missing-pr-head',
        baseBranch: 'main',
        prUrl: 'https://github.com/o/r/pull/999',
        prNumber: 999,
        deliverySha: continuationSha,
      },
    }, {
      git: { run: async () => ({ code: 0, stdout: '', stderr: '' }) },
      exec: { run: vi.fn(async () => ({ code: 0, stdout: '[]', stderr: '' })) },
      create,
      remove: vi.fn(async () => {}),
    })).rejects.toThrow(/cannot safely continue PR branch feat\/missing-pr-head/)

    expect(create).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('does not admit an internal continuation when the open PR head moved away from deliverySha', async () => {
    const { ctx, db, run } = continuationCtx()
    const branch = 'feat/SKILLS-19-key-terms-activity'
    const prUrl = 'https://github.com/o/r/pull/2147'
    const movedSha = 'b'.repeat(40)
    const prior = createPrDelivery(db, {
      id: 'moved-head-generation', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [98], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'dashboard',
    })
    transitionDecision(db, prior.id, 'building', 'pr_ready', {
      branch, prUrl, prNumber: 2147, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered', statusCode: 'pr_ready',
      deliverySha: continuationSha,
    })
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: `${movedSha}\n`, stderr: '' }
        }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: openPrLifecycle({ branch, url: prUrl, number: 2147, sha: movedSha }),
        stderr: '',
      })),
    }
    const create = vi.fn()

    await expect(launchIsolatedRail({
      ...input([98], ctx),
      requiredPrContinuation: {
        deliveryId: prior.id, decision: 'pr_ready', branch, baseBranch: 'main', prUrl, prNumber: 2147,
        deliverySha: continuationSha,
      },
    }, { git, exec, create, remove: vi.fn(async () => {}) })).rejects.toThrow(
      /cannot safely continue PR branch/,
    )

    expect(create).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({ id: prior.id, decision: 'pr_ready' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM rail_pr_deliveries').get()).toEqual({ n: 1 })
  })

  it('does not run an internal continuation from local commits beyond the verified deliverySha', async () => {
    const { ctx, db, run } = continuationCtx()
    const branch = 'feat/SKILLS-19-key-terms-activity'
    const prUrl = 'https://github.com/o/r/pull/2147'
    const localAheadSha = 'b'.repeat(40)
    const prior = createPrDelivery(db, {
      id: 'local-ahead-generation', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [98], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'dashboard',
    })
    transitionDecision(db, prior.id, 'building', 'pr_ready', {
      branch, prUrl, prNumber: 2147, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered', statusCode: 'pr_ready',
      deliverySha: continuationSha,
    })
    const git = {
      run: async (args: string[], cwd: string) => {
        if (cwd.startsWith('/wt/') && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (cwd.startsWith('/wt/') && args.join(' ') === 'rev-parse --verify HEAD') {
          return { code: 0, stdout: `${localAheadSha}\n`, stderr: '' }
        }
        if (!args.includes('--quiet') && args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${localAheadSha}\n`, stderr: '' }
        }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: `${localAheadSha}\n`, stderr: '' }
        }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async () => ({
        code: 0,
        stdout: openPrLifecycle({ branch, url: prUrl, number: 2147, sha: continuationSha }),
        stderr: '',
      })),
    }
    const create = vi.fn(async () => ({
      branch, worktreePath: '/wt/ticket-98', worktreeCreated: true, branchCreated: false,
    }))

    await expect(launchIsolatedRail({
      ...input([98], ctx),
      requiredPrContinuation: {
        deliveryId: prior.id, decision: 'pr_ready', branch, baseBranch: 'main', prUrl, prNumber: 2147,
        deliverySha: continuationSha,
      },
    }, { git, exec, create, remove: vi.fn(async () => {}) })).rejects.toThrow(
      /local PR branch .* is not at the verified continuation commit/,
    )

    expect(create).toHaveBeenCalledTimes(1)
    expect(run).not.toHaveBeenCalled()
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({ id: prior.id, decision: 'pr_ready' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM rail_pr_deliveries').get()).toEqual({ n: 2 })
  })

  it('does not adopt unrelated local-ahead commits when continuing an externally discovered PR', async () => {
    const { ctx, db, run } = continuationCtx()
    const branch = 'feat/SKILLS-70-existing-review'
    const prUrl = 'https://github.com/o/r/pull/2149'
    const localAheadSha = 'b'.repeat(40)
    const git = {
      run: async (args: string[], cwd: string) => {
        if (cwd.startsWith('/wt/') && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (cwd.startsWith('/wt/') && args.join(' ') === 'rev-parse --verify HEAD') {
          return { code: 0, stdout: `${localAheadSha}\n`, stderr: '' }
        }
        if (!args.includes('--quiet') && args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${localAheadSha}\n`, stderr: '' }
        }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') return matchingPushRemote(prUrl)
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (args[1] === 'view') return {
          code: 0,
          stdout: openPrLifecycle({ branch, url: prUrl, number: 2149, sha: continuationSha }),
          stderr: '',
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            number: 2149, title: 'SKILLS-70 review follow-up', body: 'SKILLS-70',
            headRefName: branch, baseRefName: 'main', url: prUrl, isDraft: false,
          }]),
          stderr: '',
        }
      }),
    }
    const create = vi.fn(async () => ({
      branch, worktreePath: '/wt/ticket-98', worktreeCreated: true, branchCreated: false,
    }))

    await expect(launchIsolatedRail(input([98], ctx), {
      git, exec, create, remove: vi.fn(async () => {}),
    })).rejects.toThrow(/not at the verified continuation commit/)

    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({
      branch, baseRef: `origin/${branch}`, refreshFromBaseRef: true,
    }))
    expect(run).not.toHaveBeenCalled()
    expect(exec.run.mock.calls.filter(([cmd, args]) => cmd === 'git' && args[0] === 'push')).toHaveLength(0)
    expect(getActivePrDeliveryByRail(db, 0)).toBeUndefined()
  })

  it('accepts a new verified post-run commit and pushes that exact SHA instead of the old baseline', async () => {
    const { ctx, db } = continuationCtx()
    const branch = 'feat/SKILLS-70-existing-review'
    const prUrl = 'https://github.com/o/r/pull/2150'
    const finalSha = 'c'.repeat(40)
    let currentSha = continuationSha
    let viewCalls = 0
    const git = {
      run: async (args: string[], cwd: string) => {
        if (cwd.startsWith('/wt/') && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (cwd.startsWith('/wt/') && args.join(' ') === 'rev-parse --verify HEAD') {
          return { code: 0, stdout: `${currentSha}\n`, stderr: '' }
        }
        if (!args.includes('--quiet') && args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          return { code: 0, stdout: `${currentSha}\n`, stderr: '' }
        }
        if (cwd.startsWith('/wt/') && args[0] === 'commit') {
          currentSha = finalSha
          return { code: 0, stdout: `[${branch} ${finalSha.slice(0, 7)}] follow-up\n`, stderr: '' }
        }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') return matchingPushRemote(prUrl)
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (args[1] === 'view') {
          viewCalls++
          return {
            code: 0,
            stdout: openPrLifecycle({
              branch, url: prUrl, number: 2150,
              sha: viewCalls >= 3 ? finalSha : continuationSha,
            }),
            stderr: '',
          }
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            number: 2150, title: 'SKILLS-70 review follow-up', body: 'SKILLS-70',
            headRefName: branch, baseRefName: 'main', url: prUrl, isDraft: false,
          }]),
          stderr: '',
        }
      }),
    }

    await launchIsolatedRail(input([98], ctx), {
      git,
      exec,
      create: vi.fn(async () => ({
        branch, worktreePath: '/wt/ticket-98', worktreeCreated: true, branchCreated: false,
      })),
      remove: vi.fn(async () => {}),
    })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_ready'))
    expect(exec.run).toHaveBeenCalledWith(
      'git', ['push', 'https://github.com/o/r.git', `${finalSha}:refs/heads/${branch}`], '/repo',
    )
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      delivery_sha: finalSha, status_code: 'existing_pr_updated', delivery_outcome: 'delivered',
    })
  })

  it('restores the superseded PR generation atomically when continuation allocation fails', async () => {
    const { ctx, db, broadcast, run } = continuationCtx()
    const branch = 'feat/SKILLS-19-key-terms-activity'
    const prUrl = 'https://github.com/o/r/pull/2147'
    const prior = createPrDelivery(db, {
      id: 'prior-generation', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [98], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'dashboard',
    })
    transitionDecision(db, prior.id, 'building', 'pr_ready', {
      branch, prUrl, prNumber: 2147, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered', statusCode: 'pr_ready',
      deliverySha: continuationSha,
    })
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async (_cmd: string, args: string[]) => ({
        code: 0,
        stdout: args[1] === 'view'
          ? openPrLifecycle({ branch, url: prUrl, number: 2147 })
          : JSON.stringify([{
          number: 2147, title: 'Existing implementation', body: 'SKILLS-70',
          headRefName: branch, baseRefName: 'main', url: prUrl, isDraft: false,
          }]),
        stderr: '',
      })),
    }

    await expect(launchIsolatedRail({
      ...input([98], ctx),
      requiredPrContinuation: {
        deliveryId: prior.id, decision: 'pr_ready', branch, baseBranch: 'main', prUrl, prNumber: 2147,
        deliverySha: continuationSha,
      },
    }, {
      git,
      exec,
      create: vi.fn(async () => { throw new Error('worktree allocation failed') }),
      remove: vi.fn(async () => {}),
    })).rejects.toThrow(/worktree allocation failed/)

    expect(run).not.toHaveBeenCalled()
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({ id: prior.id, decision: 'pr_ready' })
    const generations = db.prepare('SELECT * FROM rail_pr_deliveries ORDER BY rowid').all() as Array<Record<string, unknown>>
    expect(generations).toHaveLength(2)
    expect(generations[0]).toMatchObject({
      id: prior.id, decision: 'pr_ready', restored_from_delivery_id: generations[1].id,
    })
    expect(generations[1]).toMatchObject({
      decision: 'discarded', is_continuation: 1, supersedes_delivery_id: prior.id,
    })
    const states = prStates(broadcast)
    expect(states.map((state) => state.decision)).toEqual([
      'superseded', 'building', 'discarded', 'pr_ready',
    ])
    expect(states.at(-1)).toMatchObject({
      prDeliveryId: prior.id,
      restoredFromDeliveryId: generations[1].id,
    })
  })

  it('continues a matched open GitHub PR on its head branch instead of creating a fresh ticket branch', async () => {
    const { ctx, db } = continuationCtx()
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const git = {
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, 'feat/SKILLS-19-key-terms-activity')
        if (verified) return verified
        if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: 'feat/SKILLS-19-key-terms-activity\n', stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-19-key-terms-activity') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return matchingPushRemote('https://github.com/org/repo/pull/2147')
        }
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (cmd === 'gh' && args[0] === 'pr') {
          if (args[1] === 'view') return {
            code: 0,
            stdout: openPrLifecycle({
              branch: 'feat/SKILLS-19-key-terms-activity',
              url: 'https://github.com/org/repo/pull/2147',
              number: 2147,
            }),
            stderr: '',
          }
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

  it('groups multiple tickets targeting the same PR into one verified worktree and one atomic batch run', async () => {
    const { ctx, db, run } = continuationCtx()
    const branch = 'feat/SKILLS-70-review-followups'
    const create = vi.fn(async () => ({
      branch,
      worktreePath: '/wt/ticket-98',
      worktreeCreated: true,
      branchCreated: false,
    }))
    const git = {
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, branch)
        if (verified) return verified
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return matchingPushRemote('https://github.com/o/r/pull/2148')
        }
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (args[1] === 'view') return {
          code: 0,
          stdout: openPrLifecycle({ branch, url: 'https://github.com/o/r/pull/2148', number: 2148 }),
          stderr: '',
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            number: 2148,
            title: 'SKILLS-70 review follow-ups',
            body: 'Follow-up work for SKILLS-70.',
            headRefName: branch,
            baseRefName: 'main',
            url: 'https://github.com/o/r/pull/2148',
            isDraft: false,
          }]),
          stderr: '',
        }
      }),
    }

    const ids = await launchIsolatedRail(input([98, 99], ctx), {
      git,
      exec,
      create,
      remove: vi.fn(async () => {}),
    })

    expect(ids).toHaveLength(1)
    expect(create).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][0]).toMatchObject({
      ticketId: 98,
      spec: { ticketIds: [98, 99] },
      isolation: { branch, worktreePath: '/wt/ticket-98' },
    })
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_ready'))
    const units = JSON.parse(getActivePrDeliveryByRail(db, 0)!.branches)
    expect(units).toHaveLength(2)
    expect(units[0]).toMatchObject({
      ticketId: 98, branch, succeeded: true, implementationOutcome: 'succeeded',
      deliveryOutcome: 'ready', initialSha: continuationSha, finalSha: continuationSha,
    })
    expect(units[1]).toMatchObject({
      ticketId: 99, branch, succeeded: true, implementationOutcome: 'succeeded',
      deliveryOutcome: 'ready', initialSha: continuationSha, finalSha: continuationSha,
    })
    expect(exec.run).toHaveBeenCalledWith(
      'git',
      ['push', 'https://github.com/o/r.git', `${continuationSha}:refs/heads/${branch}`],
      '/repo',
    )
    expect(getActivePrDeliveryByRail(db, 0)?.delivery_sha).toBe(continuationSha)
  })

  it('settles as pr_closed when the exact pushed commit is observed in a PR that closed during delivery', async () => {
    const { ctx, db } = continuationCtx()
    const branch = 'feat/SKILLS-70-review-followups'
    const prUrl = 'https://github.com/o/r/pull/2148'
    let viewCalls = 0
    const create = vi.fn(async () => ({
      branch, worktreePath: '/wt/ticket-98', worktreeCreated: true, branchCreated: false,
    }))
    const git = {
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, branch)
        if (verified) return verified
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') return matchingPushRemote(prUrl)
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (args[1] === 'view') {
          viewCalls++
          if (viewCalls <= 2) {
            return { code: 0, stdout: openPrLifecycle({ branch, url: prUrl, number: 2148 }), stderr: '' }
          }
          return {
            code: 0,
            stdout: JSON.stringify({
              state: 'CLOSED', isDraft: false, headRefName: branch, baseRefName: 'main',
              isCrossRepository: false,
              headRefOid: continuationSha, mergeCommit: null,
              commits: [{ oid: continuationSha }], number: 2148, url: prUrl,
            }),
            stderr: '',
          }
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            number: 2148, title: 'SKILLS-70 review follow-ups', body: 'Follow-up work for SKILLS-70.',
            headRefName: branch, baseRefName: 'main', url: prUrl, isDraft: false,
          }]),
          stderr: '',
        }
      }),
    }

    await launchIsolatedRail(input([98], ctx), {
      git, exec, create, remove: vi.fn(async () => {}),
    })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_closed'))
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      decision: 'pr_closed', delivery_outcome: 'delivered', status_code: 'pr_closed',
      delivery_sha: continuationSha, branch, pr_url: prUrl,
    })
    expect(exec.run).toHaveBeenCalledWith(
      'git', ['push', 'https://github.com/o/r.git', `${continuationSha}:refs/heads/${branch}`], '/repo',
    )
  })

  it('reports an unchanged existing PR as no_changes without a redundant push', async () => {
    const { ctx, db } = continuationCtx()
    const branch = 'feat/SKILLS-19-key-terms-activity'
    const prUrl = 'https://github.com/org/repo/pull/2147'
    const create = vi.fn(async () => ({
      branch, worktreePath: '/wt/ticket-98', worktreeCreated: true, branchCreated: false,
    }))
    const git = {
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, branch)
        if (verified) return verified
        if (args[0] === 'commit') return { code: 1, stdout: 'nothing to commit', stderr: '' }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        return successfulGitResult(args)
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return matchingPushRemote('https://github.com/o/r/pull/2147')
        }
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (args[1] === 'view') return {
          code: 0,
          stdout: openPrLifecycle({ branch, url: prUrl, number: 2147 }),
          stderr: '',
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            number: 2147, title: 'Existing implementation', body: 'SKILLS-70',
            headRefName: branch, baseRefName: 'main', url: prUrl, isDraft: false,
          }]),
          stderr: '',
        }
      }),
    }

    await launchIsolatedRail(input([98], ctx), { git, exec, create, remove: vi.fn(async () => {}) })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('no_changes'))
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      implementation_outcome: 'succeeded', delivery_outcome: 'no_changes', status_code: 'no_changes',
      branch, pr_url: prUrl, pr_state: 'pr-created', delivery_sha: continuationSha,
    })
    expect(JSON.parse(getActivePrDeliveryByRail(db, 0)!.branches)[0]).toMatchObject({
      implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes', changed: false,
      initialSha: continuationSha, finalSha: continuationSha,
    })
    expect(exec.run.mock.calls.filter(([cmd, args]) => cmd === 'git' && args[0] === 'push')).toHaveLength(0)
  })

  it('never publishes pr_ready when the PR branch ref moves away from the worktree HEAD after the run', async () => {
    const { ctx, db } = continuationCtx()
    const branch = 'feat/SKILLS-19-key-terms-activity'
    const movedSha = 'b'.repeat(40)
    let strictBranchReads = 0
    const git = {
      run: async (args: string[], cwd: string) => {
        if (cwd.startsWith('/wt/') && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (cwd.startsWith('/wt/') && args.join(' ') === 'rev-parse --verify HEAD') {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        if (!args.includes('--quiet') && args.join(' ') === `rev-parse --verify refs/heads/${branch}`) {
          strictBranchReads++
          return {
            code: 0,
            stdout: `${strictBranchReads === 1 ? continuationSha : movedSha}\n`,
            stderr: '',
          }
        }
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return matchingPushRemote('https://github.com/o/r/pull/2147')
        }
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (args[1] === 'view') return {
          code: 0,
          stdout: openPrLifecycle({
            branch,
            url: 'https://github.com/o/r/pull/2147',
            number: 2147,
          }),
          stderr: '',
        }
        return {
          code: 0,
          stdout: JSON.stringify([{
            number: 2147,
            title: 'SKILLS-70 existing implementation',
            headRefName: branch,
            baseRefName: 'main',
            url: 'https://github.com/o/r/pull/2147',
            isDraft: false,
          }]),
          stderr: '',
        }
      }),
    }

    await launchIsolatedRail(input([98], ctx), {
      git,
      exec,
      create: vi.fn(async () => ({ branch, worktreePath: '/wt/ticket-98' })),
      remove: vi.fn(async () => {}),
    })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_failed'))
    expect(exec.run.mock.calls.filter(([cmd, args]) => cmd === 'git' && args[0] === 'push')).toHaveLength(0)
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      implementation_outcome: 'succeeded',
      delivery_outcome: 'blocked',
      status_code: 'branch_verification_failed',
    })
    expect(listRailWorktrees(db, 0)[0].merge_state).toBe('needs-review')
  })

  it('fails closed on a stale mounted branch and never deletes the borrowed PR branch', async () => {
    const { ctx, db, run } = continuationCtx()
    const branch = 'feat/SKILLS-19-key-terms-activity'
    const remove = vi.fn(async () => {})
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'for-each-ref') return { code: 0, stdout: `${branch}\n`, stderr: '' }
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: `${continuationSha}\n`, stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (_cmd: string, args: string[]) => ({
        code: 0,
        stdout: args[1] === 'view'
          ? openPrLifecycle({
              branch,
              url: 'https://github.com/o/r/pull/2147',
              number: 2147,
            })
          : JSON.stringify([{
              number: 2147,
              title: 'SKILLS-70 existing implementation',
              headRefName: branch,
              baseRefName: 'main',
              url: 'https://github.com/o/r/pull/2147',
              isDraft: false,
            }]),
        stderr: '',
      })),
    }

    await expect(launchIsolatedRail(input([98], ctx), {
      git,
      exec,
      create: vi.fn(async () => ({
        branch: 'main',
        worktreePath: '/wt/ticket-98',
        worktreeCreated: true,
        branchCreated: false,
      })),
      remove,
    })).rejects.toThrow(/resolved to mounted branch main/)

    expect(run).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledWith(git, {
      repoDir: '/repo',
      worktreePath: '/wt/ticket-98',
      branch: 'main',
      deleteBranch: false,
    })
    expect(getActivePrDeliveryByRail(db, 0)).toBeUndefined()
  })

  it('marks an existing-PR continuation as pr_failed when follow-up push fails', async () => {
    const { ctx, db } = continuationCtx()
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const git = {
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, 'feat/SKILLS-19-key-terms-activity')
        if (verified) return verified
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-19-key-terms-activity') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return matchingPushRemote('https://github.com/org/repo/pull/2147')
        }
        if (cmd === 'git' && args[0] === 'push') return { code: 1, stdout: '', stderr: 'no remote' }
        if (cmd === 'gh' && args[0] === 'pr') {
          if (args[1] === 'view') return {
            code: 0,
            stdout: openPrLifecycle({
              branch: 'feat/SKILLS-19-key-terms-activity',
              url: 'https://github.com/org/repo/pull/2147',
              number: 2147,
            }),
            stderr: '',
          }
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
      pr_state: 'pr-created',
      implementation_outcome: 'succeeded',
      delivery_outcome: 'retryable_failure',
      status_code: 'push_failed',
      delivery_sha: continuationSha,
    })
  })

  it('refuses to push an existing-PR continuation when origin has multiple push URLs', async () => {
    const { ctx, db } = continuationCtx()
    const branch = 'feat/SKILLS-19-key-terms-activity'
    const prUrl = 'https://github.com/org/repo/pull/2147'
    const create = vi.fn(async (_g: unknown, request: { branch?: string; ticketId: number }) => ({
      branch: request.branch ?? `sr/p/ticket-${request.ticketId}`,
      worktreePath: `/wt/ticket-${request.ticketId}`,
    }))
    const git = {
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, branch)
        if (verified) return verified
        if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${branch}`) {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return {
            code: 0,
            stdout: 'https://github.com/org/repo.git\nhttps://github.com/someone/fork.git\n',
            stderr: '',
          }
        }
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        if (cmd === 'gh' && args[0] === 'pr') {
          if (args[1] === 'view') return {
            code: 0,
            stdout: openPrLifecycle({ branch, url: prUrl, number: 2147 }),
            stderr: '',
          }
          return {
            code: 0,
            stdout: JSON.stringify([{
              number: 2147,
              title: '[SKILLS-70] Existing implementation',
              body: 'Implements ticket #98.',
              headRefName: branch,
              baseRefName: 'main',
              url: prUrl,
              isDraft: false,
            }]),
            stderr: '',
          }
        }
        return { code: 1, stdout: '', stderr: 'unexpected' }
      }),
    }

    await launchIsolatedRail(input([98], ctx), {
      git, exec, create, remove: vi.fn(async () => {}),
    })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_failed'))
    expect(exec.run.mock.calls.filter(([cmd, args]) => cmd === 'git' && args[0] === 'push')).toHaveLength(0)
    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      branch,
      pr_url: prUrl,
      implementation_outcome: 'succeeded',
      delivery_outcome: 'retryable_failure',
      status_code: 'push_failed',
      delivery_sha: continuationSha,
      status_detail: expect.stringContaining('exactly one URL'),
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
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, 'feat/SKILLS-19-key-terms-activity')
        if (verified) return verified
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-19-key-terms-activity') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return matchingPushRemote('https://github.com/org/repo/pull/2147')
        }
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
        if (args[0] === 'pr' && args[1] === 'view') return {
          code: 0,
          stdout: openPrLifecycle({
            number: 2147, branch: 'feat/SKILLS-19-key-terms-activity',
            url: 'https://github.com/org/repo/pull/2147',
            title: '[SKILLS-19] Key terms activity',
            body: 'Original implementation for the key-terms activity.',
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
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, 'feat/SKILLS-70-review-followups')
        if (verified) return verified
        if (args[0] === 'rev-parse' && args.at(-1) === 'refs/heads/feat/SKILLS-70-review-followups') {
          return { code: 0, stdout: '', stderr: '' }
        }
        return { code: 0, stdout: '', stderr: '' }
      },
    }
    const exec = {
      run: vi.fn(async (cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'remote') {
          return matchingPushRemote('https://github.com/o/r/pull/2148')
        }
        if (cmd === 'git' && args[0] === 'push') return { code: 0, stdout: '', stderr: '' }
        return {
          code: 0,
          stdout: args[1] === 'view'
            ? openPrLifecycle({
              branch: 'feat/SKILLS-70-review-followups',
              url: 'https://github.com/o/r/pull/2148', number: 2148,
            })
            : JSON.stringify([{
              number: 2148,
              title: 'SKILLS-70 review follow-ups',
              body: 'Follow-up work for the linked Jira issue.',
              headRefName: 'feat/SKILLS-70-review-followups',
              baseRefName: 'main',
              url: 'https://github.com/o/r/pull/2148',
              isDraft: false,
            }]),
          stderr: '',
        }
      }),
    }

    await launchIsolatedRail(input([98], ctx), { git, exec, create, remove: vi.fn(async () => {}) })

    expect(create).toHaveBeenCalledWith(git, expect.objectContaining({
      ticketId: 98,
      branch: 'feat/SKILLS-70-review-followups',
    }))
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('pr_ready'))
  })

  it('does not adopt an unrelated external PR that only says Fixes #<local ticket id>', async () => {
    const { ctx, db } = continuationCtx()
    ;(ctx as unknown as { getTicketSpec: (id: number) => unknown }).getTicketSpec = (id: number) => ({
      id,
      title: 'Improve the implementation flow',
      description: 'Review the local result and implement the requested refinements.',
      status: 'on_review',
      labels: ['feature'],
      ticketIds: [id],
    })
    const create = vi.fn(async (_g: unknown, createInput: { branch?: string; ticketId: number }) => ({
      branch: createInput.branch ?? `sr/p/ticket-${createInput.ticketId}`,
      worktreePath: `/wt/ticket-${createInput.ticketId}`,
    }))
    const unrelatedBranch = 'feat/unrelated-repository-issue-98'
    const exec = {
      run: vi.fn(async (_cmd: string, args: string[]) => ({
        code: 0,
        stdout: args[1] === 'list'
          ? JSON.stringify([{
              number: 3000,
              title: 'Unrelated repository change',
              body: 'Fixes #98',
              headRefName: unrelatedBranch,
              baseRefName: 'main',
              url: 'https://github.com/o/r/pull/3000',
              isDraft: false,
            }])
          : '[]',
        stderr: '',
      })),
    }

    await launchIsolatedRail(input([98], ctx), {
      git: { run: async (args: string[]) => successfulGitResult(args) },
      exec,
      create,
      remove: vi.fn(async () => {}),
    })

    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ticketId: 98,
      branch: 'feat/98-improve-the-implementation-flow',
    }))
    expect(create).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      branch: unrelatedBranch,
    }))
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).not.toBe('building'))
    const delivery = getActivePrDeliveryByRail(db, 0)!
    expect(delivery.pr_url).not.toBe('https://github.com/o/r/pull/3000')
    expect(JSON.parse(delivery.branches)[0]).toMatchObject({
      branch: 'feat/98-improve-the-implementation-flow',
    })
  })

  it('branches from origin/<open-pr-head> when only the remote PR branch exists locally', async () => {
    const { ctx } = continuationCtx()
    const create = vi.fn(async (_g: unknown, input: { branch?: string; ticketId: number }) => ({
      branch: input.branch ?? `sr/p/ticket-${input.ticketId}`,
      worktreePath: `/wt/ticket-${input.ticketId}`,
    }))
    const git = {
      run: async (args: string[], cwd: string) => {
        const verified = verifiedContinuationRef(args, cwd, 'feat/SKILLS-19-key-terms-activity')
        if (verified) return verified
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
      run: vi.fn(async (_cmd: string, args: string[]) => ({
        code: 0,
        stdout: args[1] === 'view'
          ? openPrLifecycle({
              branch: 'feat/SKILLS-19-key-terms-activity',
              url: 'https://github.com/org/repo/pull/2147', number: 2147, isDraft: true,
            })
          : JSON.stringify([{
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
        return successfulGitResult(args)
      },
    }

    // REAL createWorktree (no io.create injection) — the record/mount drift lived there.
    await launchIsolatedRail(input([1], ctx), { git, remove: vi.fn(async () => {}) })

    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)!.decision).toBe('on_review'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(JSON.parse(row.branches)[0]).toMatchObject({
      ticketId: 1, branch: 'sr/p/ticket-1', succeeded: true,
      implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
      initialSha: TEST_SHA, finalSha: TEST_SHA,
    })
    const fresh = listRailWorktrees(db, 0).filter((r) => r.id !== 'stale')
    expect(fresh).toHaveLength(1)
    expect(fresh[0].branch).toBe('sr/p/ticket-1')
    expect(fresh[0].merge_state).toBe('built')
  })
})

describe('launchIsolatedRail — failed-implementation cleanup (0 succeeded)', () => {
  beforeEach(() => { delete process.env.SPECRAILS_RAIL_DELIVER_PR }) // PR mode default-on

  const gitOk = () => ({ run: async (args: string[]) => successfulGitResult(args) })
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
      repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1', deleteBranch: false, force: false,
    })
    expect(remove).toHaveBeenCalledWith(expect.anything(), {
      repoDir: '/repo', worktreePath: '/wt/ticket-2', branch: 'sr/p/ticket-2', deleteBranch: false, force: false,
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
  const gitOk = () => ({ run: async (args: string[]) => successfulGitResult(args) })
  const okCreate = () =>
    vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` }))
  const noopOverlay = () => vi.fn(() => ({ createdPaths: [], cleanupEvidence: [], warnings: [] }))

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
    const overlay = vi.fn(() => ({ createdPaths: [], cleanupEvidence: [], warnings: ['failed to link .claude/commands/specrails: EACCES'] }))
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
    const { ctx, db } = fakeCtx(settlingRun('success'))
    const calls: { args: string[]; cwd: string }[] = []
    const git = { run: async (args: string[], cwd: string) => { calls.push({ args, cwd }); return successfulGitResult(args) } }
    const overlay = vi.fn(() => ({
      createdPaths: ['.claude/commands/specrails', '.claude/agents', '.sr-rail-overlay.json'],
      // These allocation-time proofs deliberately cannot be revalidated at the
      // injected non-existent /wt path. Commit exclusions must remain while
      // cleanup authorization is dropped.
      cleanupEvidence: [{ path: '.claude/commands/specrails', kind: 'symlink' as const, digest: 'a'.repeat(64) }],
      warnings: [],
    }))
    await launchIsolatedRail(input([1], ctx), { git, create: okCreate(), remove: vi.fn(async () => {}), overlay })

    await vi.waitFor(() => expect(calls.some((c) => c.args[0] === 'add')).toBe(true))
    const add = calls.find((c) => c.args[0] === 'add')!
    expect(add.cwd).toBe('/wt/ticket-1')
    expect(add.args).toEqual([
      'add', '-A', '--', '.',
      ...PR_NEVER_STAGE_PATHS.map((p) => `:(exclude)${p}`),
      ':(top,exclude,literal).claude/commands/specrails',
      ':(top,exclude,literal).claude/agents',
      ':(top,exclude,literal).sr-rail-overlay.json',
    ])
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('on_review'))
    const [record] = JSON.parse(getActivePrDeliveryByRail(db, 0)!.branches) as DeliverBranchRecord[]
    expect(record.overlayExcludes).toContain('.claude/commands/specrails')
    expect(record.overlayCleanupEvidence).toEqual([])
  })

  it('REGRESSION PIN: a no-op overlay (fully-tracked legacy repo) adds only permanent PR excludes', async () => {
    const { ctx } = fakeCtx(settlingRun('success'))
    const calls: { args: string[]; cwd: string }[] = []
    const git = { run: async (args: string[], cwd: string) => { calls.push({ args, cwd }); return successfulGitResult(args) } }
    await launchIsolatedRail(input([1], ctx), { git, create: okCreate(), remove: vi.fn(async () => {}), overlay: noopOverlay() })

    await vi.waitFor(() => expect(calls.some((c) => c.args[0] === 'add')).toBe(true))
    expect(calls.find((c) => c.args[0] === 'add')!.args).toEqual([
      'add', '-A', '--', '.',
      ...PR_NEVER_STAGE_PATHS.map((p) => `:(exclude)${p}`),
    ])
  })
})

describe('launchIsolatedRail — Code-Explorer provenance (construction story seam)', () => {
  const gitOk = () => ({ run: async (args: string[]) => successfulGitResult(args) })
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
  const seedInterruptedDelivery = (dirty: boolean) => {
    const db = initDb(':memory:')
    const runId = 'recovery-run'
    createLoopRun(db, {
      id: runId,
      projectId: 'proj',
      loopId: 'factory:implement',
      railIndex: 0,
      ticketId: 1,
      ticketIds: [1],
      ticketCompletionStatus: 'on_review',
      iterationLimit: 3,
      startedAt: new Date().toISOString(),
    })
    db.prepare(`UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?`).run(runId)
    const worktree = createRailWorktree(db, {
      id: 'recovery-wt', railIndex: 0, ticketId: 1, runId,
      branch: 'feat/1-recovery', worktreePath: '/wt/recovery',
    })
    const delivery = createPrDelivery(db, {
      id: 'recovery-delivery', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'dashboard',
    })
    transitionDecision(db, delivery.id, 'building', 'building', {
      runIds: [runId], worktreeIds: [worktree.id],
    })
    const git = {
      run: async (args: string[], cwd: string) => {
        if (args[0] === 'status') return { code: 0, stdout: dirty ? ' M src/recovery.ts\n' : '', stderr: '' }
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') {
          return { code: 0, stdout: 'feat/1-recovery\n', stderr: '' }
        }
        if (args.join(' ') === 'rev-parse --verify HEAD' || (
          cwd === '/repo' && args.join(' ') === 'rev-parse --verify refs/heads/feat/1-recovery'
        )) {
          return { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
        }
        return successfulGitResult(args)
      },
    }
    return { db, git, delivery, worktree }
  }

  const seedLegacyPrRecoveryCandidate = (id: string, subject?: string) => {
    const db = initDb(':memory:')
    const runId = `${id}-run`
    const branch = 'feat/existing-pr'
    const recoveredSha = 'c'.repeat(40)
    createLoopRun(db, {
      id: runId, projectId: 'proj', loopId: 'factory:implement', railIndex: 0,
      ticketId: 1, ticketIds: [1], ticketCompletionStatus: 'on_review',
      iterationLimit: 3, startedAt: new Date().toISOString(),
    })
    db.prepare(`UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?`).run(runId)
    const worktree = createRailWorktree(db, {
      id: `${id}-wt`, railIndex: 0, ticketId: 1, runId,
      branch, worktreePath: `/wt/${id}`, mergeState: 'failed',
    })
    const delivery = createPrDelivery(db, {
      id: `${id}-delivery`, railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'agent-chat', isContinuation: false,
    })
    transitionDecision(db, delivery.id, 'building', 'pr_failed', {
      runIds: [runId], worktreeIds: [worktree.id], branch,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted',
      }],
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted',
    })
    const { git, refs: recoveryRefs } = recoveryRefAwareGit(async (args: string[]) => {
        // `git log --grep` searches the whole commit message. Tests may return a
        // candidate here while `git show --format=%s` proves its subject is not
        // the settlement subject.
        if (args[0] === 'log') return { code: 0, stdout: `${recoveredSha}\n`, stderr: '' }
        if (args[0] === 'show') {
          return { code: 0, stdout: `${subject ?? `specrails: ticket-1 (run ${runId})`}\n`, stderr: '' }
        }
        return successfulGitResult(args)
      })
    return { db, runId, branch, recoveredSha, delivery, worktree, git, recoveryRefs }
  }

  it('preserves a successful dirty interrupted worktree and recovers an actionable blocked delivery', async () => {
    const { db, git, delivery, worktree } = seedInterruptedDelivery(true)
    const remove = vi.fn(async () => {})

    await reconcileRailWorktrees(db, '/repo', { git, remove })

    expect(remove).not.toHaveBeenCalled()
    expect(getRailWorktree(db, worktree.id)?.merge_state).toBe('needs-review')
    expect(db.prepare('SELECT * FROM rail_pr_deliveries WHERE id = ?').get(delivery.id)).toMatchObject({
      decision: 'pr_failed', implementation_outcome: 'succeeded',
      delivery_outcome: 'blocked', status_code: 'settlement_interrupted',
    })
  })

  it('reconstructs a successful clean interrupted branch as ready for review', async () => {
    const { db, git, delivery, worktree } = seedInterruptedDelivery(false)
    const remove = vi.fn(async () => {})

    await reconcileRailWorktrees(db, '/repo', { git, remove })

    expect(remove).not.toHaveBeenCalled()
    expect(getRailWorktree(db, worktree.id)?.merge_state).toBe('built')
    expect(db.prepare('SELECT * FROM rail_pr_deliveries WHERE id = ?').get(delivery.id)).toMatchObject({
      decision: 'on_review', implementation_outcome: 'succeeded',
      delivery_outcome: 'ready', status_code: 'ready_for_review',
    })
  })

  it('finishes safe cleanup after a crash that persisted no_changes before release', async () => {
    const { db, git, delivery, worktree } = seedInterruptedDelivery(false)
    transitionDecision(db, delivery.id, 'building', 'no_changes', {
      implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes', statusCode: 'no_changes',
    })
    const remove = vi.fn(async () => {})

    await reconcileRailWorktrees(db, '/repo', { git, remove })

    expect(remove).toHaveBeenCalledWith(git, {
      repoDir: '/repo', worktreePath: '/wt/recovery', branch: 'feat/1-recovery', deleteBranch: false, force: false,
    })
    expect(getRailWorktree(db, worktree.id)?.merge_state).toBe('released')
    expect(getPrDelivery(db, delivery.id)?.decision).toBe('no_changes')
  })

  it('startup cleanup inspects ignored data and preserves the worktree when any is unknown', async () => {
    const seeded = seedInterruptedDelivery(false)
    transitionDecision(seeded.db, seeded.delivery.id, 'building', 'no_changes', {
      implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes', statusCode: 'no_changes',
    })
    const calls: string[][] = []
    const git = {
      run: async (args: string[], cwd: string) => {
        calls.push(args)
        if (args[0] === 'status') return { code: 0, stdout: '!! ignored-user/valuable.bin\n', stderr: '' }
        return seeded.git.run(args, cwd)
      },
    }
    const remove = vi.fn(async () => {})

    await reconcileRailWorktrees(seeded.db, '/repo', { git, remove })

    expect(calls.find((args) => args[0] === 'status')).toContain('--ignored=matching')
    expect(remove).not.toHaveBeenCalled()
    expect(getRailWorktree(seeded.db, seeded.worktree.id)?.merge_state).toBe('needs-review')
  })

  it('recovers an exact retry SHA when a continuation crashed after safe worktree release', async () => {
    const db = initDb(':memory:')
    const runId = 'released-continuation-run'
    const branch = 'feat/existing-pr'
    createLoopRun(db, {
      id: runId, projectId: 'proj', loopId: 'factory:implement', railIndex: 0,
      ticketId: 1, ticketIds: [1], ticketCompletionStatus: 'on_review',
      iterationLimit: 3, startedAt: new Date().toISOString(),
    })
    db.prepare(`UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?`).run(runId)
    const worktree = createRailWorktree(db, {
      id: 'released-continuation-wt', railIndex: 0, ticketId: 1, runId,
      branch, worktreePath: '/wt/released', mergeState: 'released',
    })
    const delivery = createPrDelivery(db, {
      id: 'released-continuation-delivery', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'dashboard', isContinuation: true,
    })
    transitionDecision(db, delivery.id, 'building', 'building', {
      runIds: [runId], worktreeIds: [worktree.id], branch,
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
    })
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'log') return { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
        if (args[0] === 'show') return { code: 0, stdout: `specrails: ticket-1 (run ${runId})\n`, stderr: '' }
        return args.join(' ') === `rev-parse --verify refs/heads/${branch}`
          ? { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
          : successfulGitResult(args)
      },
    }

    await expect(reconcileRailWorktrees(db, '/repo', {
      git, exec: recoveryPrExec(branch), remove: vi.fn(async () => {}),
    })).resolves.toBe(0)

    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      decision: 'pr_failed', implementation_outcome: 'succeeded',
      delivery_outcome: 'retryable_failure', status_code: 'settlement_interrupted',
      delivery_sha: TEST_SHA,
    })
  })

  it('promotes a migrated blocked PR row and repairs its missing continuation marker', async () => {
    const db = initDb(':memory:')
    const runId = 'legacy-recovered-run'
    const branch = 'feat/existing-pr'
    createLoopRun(db, {
      id: runId, projectId: 'proj', loopId: 'factory:implement', railIndex: 0,
      ticketId: 1, ticketIds: [1], ticketCompletionStatus: 'on_review',
      iterationLimit: 3, startedAt: new Date().toISOString(),
    })
    db.prepare(`UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?`).run(runId)
    const worktree = createRailWorktree(db, {
      id: 'legacy-recovered-wt', railIndex: 0, ticketId: 1, runId,
      branch, worktreePath: '/wt/legacy-recovered', mergeState: 'failed',
    })
    const delivery = createPrDelivery(db, {
      id: 'legacy-recovered-delivery', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'agent-chat', isContinuation: false,
    })
    transitionDecision(db, delivery.id, 'building', 'pr_failed', {
      runIds: [runId], worktreeIds: [worktree.id], branch,
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted',
    })
    const onDeliveryRecovered = vi.fn()
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'log') return { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
        if (args[0] === 'show') return { code: 0, stdout: `specrails: ticket-1 (run ${runId})\n`, stderr: '' }
        return args.join(' ') === `rev-parse --verify refs/heads/${branch}`
          ? { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
          : successfulGitResult(args)
      },
    }

    await reconcileRailWorktrees(db, '/repo', {
      git, exec: recoveryPrExec(branch), remove: vi.fn(async () => {}), onDeliveryRecovered,
    })

    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      decision: 'pr_failed', is_continuation: 1,
      implementation_outcome: 'succeeded', delivery_outcome: 'retryable_failure',
      status_code: 'settlement_interrupted', delivery_sha: TEST_SHA,
    })
    expect(onDeliveryRecovered).toHaveBeenCalledWith(delivery.id)
  })

  it('recovers a uniquely run-marked settlement commit that survives only as an unreachable object', async () => {
    const seeded = seedLegacyPrRecoveryCandidate('legacy-unreachable-only')
    const oldPrHead = 'b'.repeat(40)
    const { git, refs: recoveryRefs } = recoveryRefAwareGit(async (args: string[]) => {
        if (args[0] === 'fsck') {
          return {
            code: 0,
            stdout: `unreachable blob ${'d'.repeat(40)}\nunreachable commit ${seeded.recoveredSha}\n`,
            stderr: '',
          }
        }
        if (args[0] === 'log') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'show') {
          const sha = args[args.length - 1]
          return {
            code: 0,
            stdout: sha === seeded.recoveredSha
              ? `specrails: ticket-1 (run ${seeded.runId})\n`
              : 'pre-existing PR commit\n',
            stderr: '',
          }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${seeded.branch}`) {
          return { code: 0, stdout: `${oldPrHead}\n`, stderr: '' }
        }
        return successfulGitResult(args)
      })

    await reconcileRailWorktrees(seeded.db, '/repo', {
      git, exec: recoveryPrExec(seeded.branch, oldPrHead), remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'retryable_failure',
      delivery_sha: seeded.recoveredSha, is_continuation: 1,
    })
    expect(git.run).toHaveBeenCalledWith(
      ['fsck', '--unreachable', '--no-reflogs', '--no-progress'], '/repo',
    )
    expect([...recoveryRefs.values()]).toEqual([seeded.recoveredSha])
  })

  it('pins a unique orphan but stays blocked when the same run still owns unsafe needs-review worktree evidence', async () => {
    const seeded = seedLegacyPrRecoveryCandidate('legacy-orphan-plus-needs-review')
    updateRailWorktreeState(seeded.db, seeded.worktree.id, 'needs-review')
    const exec = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'must not observe PR' })) }

    await reconcileRailWorktrees(seeded.db, '/repo', {
      git: seeded.git, exec, remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', status_code: 'recovery_unavailable',
      delivery_sha: seeded.recoveredSha, is_continuation: 1,
      status_detail: expect.stringContaining('needs-review'),
    })
    expect([...seeded.recoveryRefs.values()]).toEqual([seeded.recoveredSha])
    expect(getRailWorktree(seeded.db, seeded.worktree.id)?.merge_state).toBe('needs-review')
    expect(exec.run).not.toHaveBeenCalled()
  })

  it('pins unique run object Y but preserves and blocks on a safe authenticated worktree at different X', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-safe-x-orphan-y-'))
    const repoDir = path.join(root, 'repo')
    const worktreePath = path.join(root, 'ticket-1')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(worktreePath, { recursive: true })
    try {
      const seeded = seedLegacyPrRecoveryCandidate('legacy-safe-x-orphan-y')
      const worktreeSha = 'a'.repeat(40)
      const orphanSha = seeded.recoveredSha
      const worktreeRealPath = fs.realpathSync(worktreePath)
      seeded.db.prepare(`
        UPDATE rail_worktrees
           SET worktree_path = ?, merge_state = 'built'
         WHERE id = ?
      `).run(worktreePath, seeded.worktree.id)
      const { git, refs } = recoveryRefAwareGit(async (args: string[], cwd: string) => {
        if (args[0] === 'status' && (cwd === worktreePath || cwd === worktreeRealPath)) {
          return { code: 0, stdout: '', stderr: '' }
        }
        if (args.join(' ') === 'rev-parse --abbrev-ref HEAD' && (cwd === worktreePath || cwd === worktreeRealPath)) {
          return { code: 0, stdout: `${seeded.branch}\n`, stderr: '' }
        }
        if (args.join(' ') === 'rev-parse --verify HEAD' && (cwd === worktreePath || cwd === worktreeRealPath)) {
          return { code: 0, stdout: `${worktreeSha}\n`, stderr: '' }
        }
        if (args.join(' ') === `rev-parse --verify refs/heads/${seeded.branch}` && cwd === repoDir) {
          return { code: 0, stdout: `${worktreeSha}\n`, stderr: '' }
        }
        if (args.join(' ') === 'worktree list --porcelain' && cwd === repoDir) {
          return {
            code: 0,
            stdout: `worktree ${repoDir}\nHEAD ${worktreeSha}\nbranch refs/heads/main\n\nworktree ${worktreePath}\nHEAD ${worktreeSha}\nbranch refs/heads/${seeded.branch}\n`,
            stderr: '',
          }
        }
        if (args[0] === 'fsck') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'log') return { code: 0, stdout: `${orphanSha}\n`, stderr: '' }
        if (args[0] === 'show') {
          return { code: 0, stdout: `settle (run ${seeded.runId})\n`, stderr: '' }
        }
        return successfulGitResult(args)
      })
      const exec = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'must not observe PR' })) }

      await reconcileRailWorktrees(seeded.db, repoDir, {
        git, exec, remove: vi.fn(async () => {}),
      })

      expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
        decision: 'pr_failed', delivery_outcome: 'blocked', status_code: 'settlement_interrupted',
        delivery_sha: orphanSha, is_continuation: 1,
        status_detail: expect.stringContaining('mismatched worktree evidence'),
      })
      expect([...refs.values()]).toEqual([orphanSha])
      expect(getRailWorktree(seeded.db, seeded.worktree.id)).toMatchObject({
        merge_state: 'built', worktree_path: worktreePath,
      })
      const units = JSON.parse(getPrDelivery(seeded.db, seeded.delivery.id)!.branches) as DeliverBranchRecord[]
      expect(units[0]).toMatchObject({ worktreePath: worktreeRealPath })
      expect(exec.run).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('prefers advanced delivery ref B after a crash even when refs/reflogs still expose marked A and B', async () => {
    const seeded = seedLegacyPrRecoveryCandidate('legacy-ref-advanced-before-freeze')
    const earlierSha = 'b'.repeat(40)
    const advancedSha = seeded.recoveredSha
    const oldPrHead = 'd'.repeat(40)
    const { git, refs, run } = recoveryRefAwareGit(async (args: string[]) => {
      if (args[0] === 'fsck') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'log') return { code: 0, stdout: `${earlierSha}\n${advancedSha}\n`, stderr: '' }
      if (args[0] === 'show') return { code: 0, stdout: `settle (run ${seeded.runId})\n`, stderr: '' }
      if (args[0] === 'cat-file' || args[0] === 'merge-base') return { code: 0, stdout: '', stderr: '' }
      return successfulGitResult(args)
    })
    const recoveryRef = recoveryRefForDelivery(seeded.delivery.id)
    refs.set(recoveryRef, advancedSha)

    await reconcileRailWorktrees(seeded.db, '/repo', {
      git, exec: recoveryPrExec(seeded.branch, oldPrHead), remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'retryable_failure',
      status_code: 'settlement_interrupted', delivery_sha: advancedSha, is_continuation: 1,
    })
    expect(refs.get(recoveryRef)).toBe(advancedSha)
    expect(run.mock.calls.some(([args]) => (args as string[])[0] === 'log' || (args as string[])[0] === 'fsck')).toBe(false)
  })

  it('keeps a substituted protected ref blocked instead of replacing it with another marked object', async () => {
    const seeded = seedLegacyPrRecoveryCandidate('legacy-substituted-protection')
    const substitutedSha = 'e'.repeat(40)
    const discoveredSha = seeded.recoveredSha
    const { git, refs } = recoveryRefAwareGit(async (args: string[]) => {
      if (args[0] === 'fsck') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'log') return { code: 0, stdout: `${discoveredSha}\n`, stderr: '' }
      if (args[0] === 'show') {
        const inspected = args[args.length - 1]
        return {
          code: 0,
          stdout: inspected === substitutedSha
            ? 'unrelated substituted commit\n'
            : `settle (run ${seeded.runId})\n`,
          stderr: '',
        }
      }
      return successfulGitResult(args)
    })
    const recoveryRef = recoveryRefForDelivery(seeded.delivery.id)
    refs.set(recoveryRef, substitutedSha)
    const exec = { run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'must not observe PR' })) }

    await reconcileRailWorktrees(seeded.db, '/repo', {
      git, exec, remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', status_code: 'recovery_unavailable',
      delivery_sha: null, is_continuation: 1,
      status_detail: expect.stringContaining('different commit already owns'),
    })
    expect(refs.get(recoveryRef)).toBe(substitutedSha)
    expect(exec.run).not.toHaveBeenCalled()
  })

  it('classifies a unique run-owned commit already at the live PR head as delivered without Retry', async () => {
    const seeded = seedLegacyPrRecoveryCandidate('legacy-already-delivered')

    await reconcileRailWorktrees(seeded.db, '/repo', {
      git: seeded.git,
      exec: recoveryPrExec(seeded.branch, seeded.recoveredSha),
      remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
      decision: 'pr_ready', delivery_outcome: 'delivered', status_code: 'pr_ready',
      delivery_sha: seeded.recoveredSha, is_continuation: 1,
    })
    expect(seeded.recoveryRefs.size).toBe(0)
  })

  it('does not offer Retry for a divergent run-marked orphan and keeps its exact object protected', async () => {
    const seeded = seedLegacyPrRecoveryCandidate('legacy-unreachable-divergent')
    const oldPrHead = 'b'.repeat(40)
    const { git, refs: recoveryRefs } = recoveryRefAwareGit(async (args: string[]) => {
      if (args[0] === 'fsck') {
        return { code: 0, stdout: `unreachable commit ${seeded.recoveredSha}\n`, stderr: '' }
      }
      if (args[0] === 'log') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'show') {
        return { code: 0, stdout: `specrails: ticket-1 (run ${seeded.runId})\n`, stderr: '' }
      }
      if (args[0] === 'cat-file') return { code: 0, stdout: '', stderr: '' }
      if (args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'not an ancestor' }
      return successfulGitResult(args)
    })

    await reconcileRailWorktrees(seeded.db, '/repo', {
      git, exec: recoveryPrExec(seeded.branch, oldPrHead), remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', status_code: 'recovery_unavailable',
      delivery_sha: seeded.recoveredSha, is_continuation: 1,
      status_detail: expect.stringContaining('not a fast-forward'),
    })
    expect([...recoveryRefs.values()]).toEqual([seeded.recoveredSha])
  })

  it('unions refs/reflogs with unreachable objects and blocks two marked commits for one run', async () => {
    const seeded = seedLegacyPrRecoveryCandidate('legacy-unreachable-ambiguous')
    const unreachableSha = 'd'.repeat(40)
    const git = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'fsck') {
          return { code: 0, stdout: `unreachable commit ${unreachableSha}\n`, stderr: '' }
        }
        if (args[0] === 'log') {
          return { code: 0, stdout: `${seeded.recoveredSha}\n`, stderr: '' }
        }
        if (args[0] === 'show') {
          return { code: 0, stdout: `specrails: ticket-1 (run ${seeded.runId})\n`, stderr: '' }
        }
        return successfulGitResult(args)
      }),
    }

    await reconcileRailWorktrees(seeded.db, '/repo', {
      git, exec: recoveryPrExec(seeded.branch), remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', delivery_sha: null,
      status_detail: expect.stringContaining('multiple different commits'),
    })
  })

  it.each([
    {
      name: 'command failure',
      result: { code: 1, stdout: '', stderr: 'fsck failed' },
    },
    {
      name: 'malformed commit record',
      result: { code: 0, stdout: 'unreachable commit not-a-sha\n', stderr: '' },
    },
    {
      name: 'candidate cap exceeded',
      result: {
        code: 0,
        stdout: Array.from(
          { length: 513 },
          (_, index) => `unreachable commit ${index.toString(16).padStart(40, '0')}`,
        ).join('\n'),
        stderr: '',
      },
    },
  ])('keeps legacy recovery blocked when unreachable discovery has $name', async ({ result }) => {
    const seeded = seedLegacyPrRecoveryCandidate(`legacy-unreachable-invalid-${result.code}-${result.stdout.length}`)
    const git = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === 'fsck') return result
        if (args[0] === 'log') return { code: 0, stdout: '', stderr: '' }
        if (args[0] === 'show') return { code: 0, stdout: 'pre-existing PR commit\n', stderr: '' }
        return successfulGitResult(args)
      }),
    }

    await reconcileRailWorktrees(seeded.db, '/repo', {
      git, exec: recoveryPrExec(seeded.branch), remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', delivery_sha: null,
      status_detail: expect.stringContaining('could not prove a run-owned commit'),
    })
  })

  it('refuses a no-op legacy Retry push when the recovered branch is already the PR head', async () => {
    const db = initDb(':memory:')
    const runId = 'legacy-no-op-run'
    const branch = 'feat/existing-pr'
    createLoopRun(db, {
      id: runId, projectId: 'proj', loopId: 'factory:implement', railIndex: 0,
      ticketId: 1, ticketIds: [1], ticketCompletionStatus: 'on_review',
      iterationLimit: 3, startedAt: new Date().toISOString(),
    })
    db.prepare(`UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?`).run(runId)
    const worktree = createRailWorktree(db, {
      id: 'legacy-no-op-wt', railIndex: 0, ticketId: 1, runId,
      branch, worktreePath: '/wt/legacy-no-op', mergeState: 'failed',
    })
    const delivery = createPrDelivery(db, {
      id: 'legacy-no-op-delivery', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'agent-chat', isContinuation: false,
    })
    transitionDecision(db, delivery.id, 'building', 'pr_failed', {
      runIds: [runId], worktreeIds: [worktree.id], branch,
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted',
    })
    const git = {
      run: async (args: string[]) => {
        if (args[0] === 'show') return { code: 0, stdout: 'pre-existing PR commit\n', stderr: '' }
        return args.join(' ') === `rev-parse --verify refs/heads/${branch}`
          ? { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
          : successfulGitResult(args)
      },
    }

    await reconcileRailWorktrees(db, '/repo', {
      git, exec: recoveryPrExec(branch, TEST_SHA), remove: vi.fn(async () => {}),
    })

    const unavailableAt = getActivePrDeliveryByRail(db, 0)!.updated_at
    await reconcileRailWorktrees(db, '/repo', {
      git, exec: recoveryPrExec(branch, TEST_SHA), remove: vi.fn(async () => {}),
    })

    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', delivery_sha: null,
      status_code: 'recovery_unavailable',
      status_detail: expect.stringContaining('could not prove a run-owned commit'),
      updated_at: unavailableAt,
    })
    expect(getRailWorktree(db, worktree.id)?.branch).toBe(branch)
  })

  it('repairs an already PR-ready legacy row when reflog proves a different run-owned commit', async () => {
    const db = initDb(':memory:')
    const runId = 'legacy-already-retried-run'
    const branch = 'feat/existing-pr'
    const oldPrHead = 'b'.repeat(40)
    const recoveredRunSha = 'c'.repeat(40)
    createLoopRun(db, {
      id: runId, projectId: 'proj', loopId: 'factory:implement', railIndex: 0,
      ticketId: 1, ticketIds: [1], ticketCompletionStatus: 'on_review',
      iterationLimit: 3, startedAt: new Date().toISOString(),
    })
    db.prepare(`UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?`).run(runId)
    const worktree = createRailWorktree(db, {
      id: 'legacy-already-retried-wt', railIndex: 0, ticketId: 1, runId,
      branch, worktreePath: '/wt/legacy-already-retried', mergeState: 'failed',
    })
    const delivery = createPrDelivery(db, {
      id: 'legacy-already-retried-delivery', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'agent-chat', isContinuation: false,
    })
    transitionDecision(db, delivery.id, 'building', 'pr_failed', {
      runIds: [runId], worktreeIds: [worktree.id], branch,
      branches: [{
        ticketId: 1, runId, branch, succeeded: true,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted',
      }],
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'retryable_failure',
      statusCode: 'settlement_interrupted', deliverySha: oldPrHead,
    })
    transitionDecision(db, delivery.id, 'pr_failed', 'pr_ready', {
      implementationOutcome: 'succeeded', deliveryOutcome: 'delivered',
      statusCode: 'pr_ready', statusDetail: null, deliverySha: oldPrHead,
    })
    const { git } = recoveryRefAwareGit(async (args: string[]) => {
        if (args[0] === 'log') return { code: 0, stdout: `${recoveredRunSha}\n`, stderr: '' }
        if (args[0] === 'show') return { code: 0, stdout: `specrails: ticket-1 (run ${runId})\n`, stderr: '' }
        return successfulGitResult(args)
      })

    await reconcileRailWorktrees(db, '/repo', {
      git, exec: recoveryPrExec(branch, oldPrHead), remove: vi.fn(async () => {}),
    })

    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      decision: 'pr_failed', implementation_outcome: 'succeeded',
      delivery_outcome: 'retryable_failure', status_code: 'settlement_interrupted',
      delivery_sha: recoveredRunSha, is_continuation: 1,
      status_detail: expect.stringContaining('delivery can be retried safely'),
    })
    const healedUnits = JSON.parse(getPrDelivery(db, delivery.id)!.branches) as Array<Record<string, unknown>>
    expect(healedUnits[0]).toMatchObject({ finalSha: recoveredRunSha, deliveryOutcome: 'ready' })
    expect(healedUnits[0]).not.toHaveProperty('failureCode')
    expect(getRailWorktree(db, worktree.id)?.branch).toBe(branch)
  })

  it('keeps an exactly recovered legacy commit retryable when GitHub observation is transiently unavailable', async () => {
    const { db, recoveredSha, delivery, worktree, git } = seedLegacyPrRecoveryCandidate(
      'legacy-gh-unavailable',
    )
    const exec = {
      run: vi.fn(async () => ({ code: 1, stdout: '', stderr: 'temporary GitHub outage' })),
    }

    await reconcileRailWorktrees(db, '/repo', { git, exec, remove: vi.fn(async () => {}) })

    expect(getPrDelivery(db, delivery.id)).toMatchObject({
      decision: 'pr_failed', implementation_outcome: 'succeeded',
      delivery_outcome: 'retryable_failure', status_code: 'settlement_interrupted',
      delivery_sha: recoveredSha, is_continuation: 1,
      status_detail: expect.stringContaining('Retry push will revalidate before any push'),
    })
    expect(getRailWorktree(db, worktree.id)?.branch).toBe('feat/existing-pr')
    expect(exec.run).toHaveBeenCalledTimes(1)
  })

  it.each(['MERGED', 'CLOSED'] as const)(
    'detaches recovered work when the recorded PR is %s without that commit',
    async (state) => {
      const { db, branch, recoveredSha, delivery, git } = seedLegacyPrRecoveryCandidate(`legacy-${state.toLowerCase()}`)
      const remoteSha = 'd'.repeat(40)
      const exec = {
        run: async () => ({
          code: 0,
          stdout: JSON.stringify({
            state, isDraft: false, headRefName: branch, baseRefName: 'main',
            isCrossRepository: false,
            headRefOid: remoteSha,
            mergeCommit: state === 'MERGED' ? { oid: 'e'.repeat(40) } : null,
            commits: [{ oid: remoteSha }],
          }),
          stderr: '',
        }),
      }

      await reconcileRailWorktrees(db, '/repo', { git, exec, remove: vi.fn(async () => {}) })

      expect(getPrDelivery(db, delivery.id)).toMatchObject({
        decision: 'on_review', pr_url: null, pr_number: null, pr_state: 'local-only',
        delivery_outcome: 'ready', status_code: 'ready_for_review',
        delivery_sha: recoveredSha, is_continuation: 0,
        status_detail: expect.stringContaining('create a new draft PR'),
      })
      const units = JSON.parse(getPrDelivery(db, delivery.id)!.branches) as Array<Record<string, unknown>>
      expect(units[0]).toMatchObject({ succeeded: true, finalSha: recoveredSha, deliveryOutcome: 'ready' })
      expect(units[0]).not.toHaveProperty('failureCode')
    },
  )

  it('rejects a recovery grep hit whose run marker exists only outside the commit subject', async () => {
    const { db, delivery, worktree, git } = seedLegacyPrRecoveryCandidate(
      'legacy-body-marker',
      'unrelated aggregate commit',
    )

    await reconcileRailWorktrees(db, '/repo', {
      git, exec: recoveryPrExec('feat/existing-pr'), remove: vi.fn(async () => {}),
    })

    expect(getPrDelivery(db, delivery.id)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', delivery_sha: null,
      status_code: 'recovery_unavailable', is_continuation: 1,
      status_detail: expect.stringContaining('could not prove a run-owned commit'),
    })
    expect(getRailWorktree(db, worktree.id)?.branch).toBe('feat/existing-pr')
    expect(git.run).toHaveBeenCalledWith(
      ['show', '-s', '--format=%s', 'c'.repeat(40)], '/repo',
    )
  })

  it('keeps a migrated PR blocked when only needs-review evidence remains', async () => {
    const db = initDb(':memory:')
    const runId = 'legacy-needs-review-run'
    const branch = 'feat/existing-pr'
    createLoopRun(db, {
      id: runId, projectId: 'proj', loopId: 'factory:implement', railIndex: 0,
      ticketId: 1, ticketIds: [1], ticketCompletionStatus: 'on_review',
      iterationLimit: 3, startedAt: new Date().toISOString(),
    })
    db.prepare(`UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?`).run(runId)
    const worktree = createRailWorktree(db, {
      id: 'legacy-needs-review-wt', railIndex: 0, ticketId: 1, runId,
      branch, worktreePath: '/wt/legacy-needs-review', mergeState: 'needs-review',
    })
    const delivery = createPrDelivery(db, {
      id: 'legacy-needs-review-delivery', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'agent-chat', isContinuation: false,
    })
    transitionDecision(db, delivery.id, 'building', 'pr_failed', {
      runIds: [runId], worktreeIds: [worktree.id], branch,
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted',
    })
    const git = {
      run: vi.fn(async (args: string[]) => args.join(' ') === `rev-parse --verify refs/heads/${branch}`
        ? { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
        : successfulGitResult(args)),
    }

    await reconcileRailWorktrees(db, '/repo', { git, remove: vi.fn(async () => {}) })

    expect(getActivePrDeliveryByRail(db, 0)).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', delivery_sha: null,
      status_code: 'recovery_unavailable',
      status_detail: expect.stringContaining('needs-review'),
    })
    expect(git.run).not.toHaveBeenCalledWith(
      ['rev-parse', '--verify', `refs/heads/${branch}`], '/repo',
    )
  })

  it('restores actionable settlement recovery when a recovery_unavailable row regains a dirty authenticated worktree', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-recovery-restored-'))
    const repoDir = path.join(root, 'repo')
    const worktreePath = path.join(root, 'ticket-1')
    fs.mkdirSync(repoDir, { recursive: true })
    fs.mkdirSync(worktreePath, { recursive: true })
    try {
      const worktreeRealPath = fs.realpathSync(worktreePath)
      const seeded = seedLegacyPrRecoveryCandidate('legacy-restored-worktree')
      seeded.db.prepare(`
        UPDATE rail_worktrees
           SET worktree_path = ?, merge_state = 'needs-review'
         WHERE id = ?
      `).run(worktreePath, seeded.worktree.id)
      transitionDecision(seeded.db, seeded.delivery.id, 'pr_failed', 'pr_failed', {
        statusCode: 'recovery_unavailable',
        statusDetail: 'No recovery evidence was available on this computer.',
      })
      const git = {
        run: vi.fn(async (args: string[], cwd: string) => {
          if (args.join(' ') === 'worktree list --porcelain' && cwd === repoDir) {
            return {
              code: 0,
              stdout: `worktree ${repoDir}\nHEAD ${TEST_SHA}\nbranch refs/heads/main\n\nworktree ${worktreePath}\nHEAD ${TEST_SHA}\nbranch refs/heads/${seeded.branch}\n`,
              stderr: '',
            }
          }
          if (args[0] === 'status' && (cwd === worktreePath || cwd === worktreeRealPath)) {
            return { code: 0, stdout: ' M app/recovered.ts\n', stderr: '' }
          }
          if (args.join(' ') === 'rev-parse --abbrev-ref HEAD' && (cwd === worktreePath || cwd === worktreeRealPath)) {
            return { code: 0, stdout: `${seeded.branch}\n`, stderr: '' }
          }
          if (args.join(' ') === 'rev-parse --verify HEAD' && (cwd === worktreePath || cwd === worktreeRealPath)) {
            return { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
          }
          if (args.join(' ') === `rev-parse --verify refs/heads/${seeded.branch}` && cwd === repoDir) {
            return { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
          }
          return successfulGitResult(args)
        }),
      }

      await reconcileRailWorktrees(seeded.db, repoDir, {
        git, exec: recoveryPrExec(seeded.branch, TEST_SHA), remove: vi.fn(async () => {}),
      })

      expect(getPrDelivery(seeded.db, seeded.delivery.id)).toMatchObject({
        decision: 'pr_failed', delivery_outcome: 'blocked', delivery_sha: null,
        status_code: 'settlement_interrupted', is_continuation: 1,
        status_detail: expect.stringContaining('needs-review'),
      })
      const units = JSON.parse(getPrDelivery(seeded.db, seeded.delivery.id)!.branches) as DeliverBranchRecord[]
      expect(units[0]).toMatchObject({ worktreePath: worktreeRealPath })
      expect(getRailWorktree(seeded.db, seeded.worktree.id)?.merge_state).toBe('needs-review')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('projects only a currently registered recovery worktree and removes a stale device-local path', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-recovery-display-'))
    const repoDir = path.join(root, 'repo')
    const worktreePath = path.join(root, 'worktree')
    fs.mkdirSync(repoDir)
    fs.mkdirSync(worktreePath)
    const canonicalWorktreePath = fs.realpathSync(worktreePath)
    const db = initDb(':memory:')
    const runId = 'display-run'
    const branch = 'feat/display-recovery'
    createLoopRun(db, {
      id: runId, projectId: 'proj', loopId: 'factory:implement', railIndex: 0,
      ticketId: 1, ticketIds: [1], ticketCompletionStatus: 'on_review',
      iterationLimit: 3, startedAt: new Date().toISOString(),
    })
    db.prepare(`UPDATE loop_runs SET status = 'completed', final_outcome = 'success' WHERE id = ?`).run(runId)
    const worktree = createRailWorktree(db, {
      id: 'display-wt', railIndex: 0, ticketId: 1, runId,
      branch, worktreePath, mergeState: 'needs-review',
    })
    const delivery = createPrDelivery(db, {
      id: 'display-delivery', railIndex: 0, loopId: 'factory:implement',
      railKey: '0-factory:implement', ticketIds: [1], baseBranch: 'main',
      loopName: 'Implement', originSurface: 'agent-chat', isContinuation: true,
    })
    transitionDecision(db, delivery.id, 'building', 'pr_failed', {
      runIds: [runId], worktreeIds: [worktree.id], branch,
      branches: [{
        ticketId: 1, runId, branch, succeeded: false,
        implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
        failureCode: 'settlement_interrupted', worktreePath: '/stale/other-device/worktree',
      }],
      prUrl: 'https://github.com/o/r/pull/1', prNumber: 1, prState: 'pr-created',
      implementationOutcome: 'succeeded', deliveryOutcome: 'blocked',
      statusCode: 'settlement_interrupted', isContinuation: true,
    })
    let registered = true
    const git = {
      run: vi.fn(async (args: string[], cwd: string) => {
        if (args.join(' ') === 'worktree list --porcelain') {
          return {
            code: 0,
            stdout: [
              `worktree ${repoDir}`, `HEAD ${'a'.repeat(40)}`, 'branch refs/heads/main', '',
              ...(registered
                ? [`worktree ${worktreePath}`, `HEAD ${TEST_SHA}`, `branch refs/heads/${branch}`, '']
                : []),
            ].join('\n'),
            stderr: '',
          }
        }
        if (cwd === canonicalWorktreePath && args.join(' ') === 'rev-parse --abbrev-ref HEAD') {
          return { code: 0, stdout: `${branch}\n`, stderr: '' }
        }
        if (cwd === canonicalWorktreePath && args.join(' ') === 'rev-parse --verify HEAD') {
          return { code: 0, stdout: `${TEST_SHA}\n`, stderr: '' }
        }
        if (args[0] === 'fsck' || args[0] === 'log') return { code: 0, stdout: '', stderr: '' }
        return successfulGitResult(args)
      }),
    }

    try {
      await reconcileRailWorktrees(db, repoDir, { git, remove: vi.fn(async () => {}) })
      let units = JSON.parse(getPrDelivery(db, delivery.id)!.branches) as Array<Record<string, unknown>>
      expect(units[0].worktreePath).toBe(canonicalWorktreePath)

      // Reproduce a row previously reconciled on another build: the durable
      // detail is already the generic no-local-evidence text, but its branch
      // payload still carries a device-local path. Branch projection must not
      // be skipped merely because every top-level status field is unchanged.
      db.prepare(`UPDATE rail_pr_deliveries SET status_detail = ? WHERE id = ?`).run(
        'Exact commit recovery found dirty, needs-review, missing, or mismatched worktree evidence; no remaining local evidence was deleted.',
        delivery.id,
      )
      registered = false
      await reconcileRailWorktrees(db, repoDir, { git, remove: vi.fn(async () => {}) })
      units = JSON.parse(getPrDelivery(db, delivery.id)!.branches) as Array<Record<string, unknown>>
      expect(units[0]).not.toHaveProperty('worktreePath')
    } finally {
      db.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('preserves non-terminal worktrees with missing run evidence as needs-review', async () => {
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
    expect(remove).not.toHaveBeenCalled()
    expect(getRailWorktree(db, 'a')?.merge_state).toBe('merged')
    expect(getRailWorktree(db, 'b')?.merge_state).toBe('needs-review')
    expect(getRailWorktree(db, 'c')?.merge_state).toBe('needs-review')
  })

  it('is a no-op (no git/remove calls) when there are no orphans', async () => {
    const db = initDb(':memory:')
    const remove = vi.fn(async () => {})
    const git = { run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })) }
    const n = await reconcileRailWorktrees(db, '/repo', { git, remove })
    expect(n).toBe(0)
    expect(remove).not.toHaveBeenCalled()
    expect(git.run).not.toHaveBeenCalled()
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

  it('admits only one generation when two launches race for the same rail', async () => {
    const { ctx, db, run } = fakeCtx()
    const create = vi.fn(async (_git: unknown, createInput: { branch: string; ticketId: number }) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        branch: createInput.branch,
        worktreePath: `/wt/ticket-${createInput.ticketId}`,
        branchCreated: true,
        worktreeCreated: true,
      }
    })
    const io: IsolatedLaunchIO = {
      git: { run: async (args: string[]) => successfulGitResult(args) },
      create,
      remove: vi.fn(async () => {}),
    }

    const [first, second] = await Promise.allSettled([
      launchIsolatedRail(input([1], ctx), io),
      launchIsolatedRail(input([1], ctx), io),
    ])

    expect([first.status, second.status].sort()).toEqual(['fulfilled', 'rejected'])
    const rejected = first.status === 'rejected' ? first.reason : (second as PromiseRejectedResult).reason
    expect(rejected).toBeInstanceOf(PrDeliveryGenerationConflict)
    expect(create).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(listActivePrDeliveries(db)).toHaveLength(1)
  })
})
