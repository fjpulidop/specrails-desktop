// Characterization pins for launchIsolatedRail branches the main suite did not
// reach: the existing-PR continuation push decision (before/after push lifecycle
// observations), the legacy merge-back outcome handling, an unexpected per-run
// settlement rejection and the aggregate-settlement failure fallback. They
// record today's observable results so the staged split stays byte-identical.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { launchIsolatedRail, type IsolatedLaunchIO } from './rail-isolated-launch'
import { initDb } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { listRailWorktrees } from './rail-worktrees-store'
import { getActivePrDeliveryByRail } from './rail-pr-store'
import { __resetFetchOriginCache } from '../../../integration-branch'
import * as loopRunsStore from '../../loops/runtime/loop-runs-store'
import type { ProjectContext } from '../../../project-registry'

const { mockRunMergeBack } = vi.hoisted(() => ({ mockRunMergeBack: vi.fn() }))
vi.mock('./rail-merge-orchestrator', () => ({ runMergeBack: mockRunMergeBack }))

const ORIG_PR = process.env.SPECRAILS_RAIL_DELIVER_PR
beforeEach(() => {
  __resetFetchOriginCache()
  mockRunMergeBack.mockReset().mockResolvedValue([])
  delete process.env.SPECRAILS_RAIL_DELIVER_PR
})
afterEach(() => {
  vi.restoreAllMocks()
  if (ORIG_PR === undefined) delete process.env.SPECRAILS_RAIL_DELIVER_PR
  else process.env.SPECRAILS_RAIL_DELIVER_PR = ORIG_PR
})

const SHA = 'a'.repeat(40)
const OTHER = 'c'.repeat(40)
const graph = { nodes: [], edges: [], config: {} } as never
const settlingRun = (outcome = 'success') => (req: { runId: string }) =>
  Promise.resolve({ runId: req.runId, outcome, iterations: 1, totalCostUsd: 0 })

function fakeCtx(runImpl: (req: { runId: string }) => Promise<unknown>, ticketStatus?: string) {
  const db = initDb(':memory:')
  const desktopDb = initDesktopDb(':memory:')
  const broadcast = vi.fn()
  const ctx = {
    project: { id: 'proj', slug: 'p', path: '/repo' },
    db,
    desktopDb,
    loopRunManager: { run: vi.fn(runImpl) },
    getTicketSpec: (id: number) => ({
      id, title: 'Add key-terms activity', description: 'Review follow-ups.', ticketIds: [id],
      ...(ticketStatus ? { status: ticketStatus, labels: ['feature'], jira_key: 'SKILLS-70' } : {}),
    }),
    railLoopRuns: new Map(),
    onLoopRunFinished: vi.fn(),
    jiraSyncManager: { onRailLaunch: vi.fn() },
    broadcast,
  } as unknown as ProjectContext
  return { ctx, db, broadcast }
}

const input = (ticketIds: number[], ctx: ProjectContext) => ({
  ctx, railIndex: 0, ticketIds, loopId: 'factory:implement', loopName: 'Implement',
  loopGraph: graph, provider: 'claude', model: 'sonnet',
})

// ─── Existing-PR continuation push decision ────────────────────────────────

const BRANCH = 'feat/SKILLS-70-review-followups'
const PR_URL = 'https://github.com/o/r/pull/2148'

type Lifecycle = { fail: string } | {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  head?: string
  commits?: string[]
  baseRefName?: string
}

const lifecycleJson = (l: Exclude<Lifecycle, { fail: string }>) => JSON.stringify({
  state: l.state, isDraft: false, headRefName: BRANCH, baseRefName: l.baseRefName ?? 'main',
  isCrossRepository: false, headRefOid: l.head ?? SHA, mergeCommit: null,
  commits: (l.commits ?? [l.head ?? SHA]).map((oid) => ({ oid })),
  number: 2148, url: PR_URL,
})

/** `views[0]` answers launch-time discovery, `views[1]` the pre-push check,
 * `views[2]` the post-push check; later calls repeat the last entry. */
async function runContinuation(opts: {
  views: Lifecycle[]
  push?: 'ok' | 'rejected' | 'throw'
  unchanged?: boolean
}) {
  const { ctx, db } = fakeCtx(settlingRun('success'), 'on_review')
  let viewCalls = 0
  const git = {
    run: async (args: string[], cwd: string) => {
      if (cwd.startsWith('/wt/') && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: `${BRANCH}\n`, stderr: '' }
      if (cwd.startsWith('/wt/') && args.join(' ') === 'rev-parse --verify HEAD') return { code: 0, stdout: `${SHA}\n`, stderr: '' }
      if (!args.includes('--quiet') && args.join(' ') === `rev-parse --verify refs/heads/${BRANCH}`) return { code: 0, stdout: `${SHA}\n`, stderr: '' }
      if (opts.unchanged && args[0] === 'commit') return { code: 1, stdout: 'nothing to commit', stderr: '' }
      if (args[0] === 'for-each-ref') return { code: 0, stdout: `${BRANCH}\n`, stderr: '' }
      if (args[0] === 'rev-parse' && args.at(-1) === `refs/heads/${BRANCH}`) return { code: 0, stdout: `${SHA}\n`, stderr: '' }
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { code: 0, stdout: `${SHA}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
  }
  const exec = {
    run: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args[0] === 'remote') return { code: 0, stdout: 'https://github.com/o/r.git\n', stderr: '' }
      if (cmd === 'git' && args[0] === 'push') {
        if (opts.push === 'throw') throw new Error('push transport exploded')
        return opts.push === 'rejected' ? { code: 1, stdout: '', stderr: 'rejected' } : { code: 0, stdout: '', stderr: '' }
      }
      if (args[1] === 'view') {
        const view = opts.views[Math.min(viewCalls, opts.views.length - 1)]
        viewCalls++
        return 'fail' in view ? { code: 1, stdout: '', stderr: view.fail } : { code: 0, stdout: lifecycleJson(view), stderr: '' }
      }
      return {
        code: 0,
        stdout: JSON.stringify([{
          number: 2148, title: 'SKILLS-70 review follow-ups', body: 'Follow-up work for SKILLS-70.',
          headRefName: BRANCH, baseRefName: 'main', url: PR_URL, isDraft: false,
        }]),
        stderr: '',
      }
    }),
  }
  const create = vi.fn(async () => ({ branch: BRANCH, worktreePath: '/wt/ticket-98', worktreeCreated: true, branchCreated: false }))
  await launchIsolatedRail(input([98], ctx), { git, exec, create, remove: vi.fn(async () => {}) } as unknown as IsolatedLaunchIO)
  await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).not.toBe('building'))
  const pushes = exec.run.mock.calls.filter(([cmd, args]) => cmd === 'git' && args[0] === 'push')
  return { db, row: getActivePrDeliveryByRail(db, 0)!, pushes }
}

const OPEN: Lifecycle = { state: 'OPEN' }

describe('launchIsolatedRail characterization — continuation push decision', () => {
  it('pre-push lifecycle unavailable → pr_failed / push_failed, no push', async () => {
    const { row, pushes } = await runContinuation({ views: [OPEN, { fail: 'gh offline' }] })
    expect(row).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'retryable_failure', status_code: 'push_failed',
      status_detail: 'could not confirm the existing PR is open before push: gh offline',
      pr_url: PR_URL, pr_state: 'pr-created', delivery_sha: SHA,
    })
    expect(pushes).toHaveLength(0)
  })

  it('pre-push MERGED including the exact SHA → pr_ready / delivered, no push', async () => {
    const { row, pushes } = await runContinuation({ views: [OPEN, { state: 'MERGED' }] })
    expect(row).toMatchObject({ decision: 'pr_ready', delivery_outcome: 'delivered', status_code: 'pr_ready', pr_url: PR_URL })
    expect(pushes).toHaveLength(0)
  })

  it('pre-push CLOSED without the SHA → detached for a new PR (on_review, local-only)', async () => {
    const { row, pushes } = await runContinuation({ views: [OPEN, { state: 'CLOSED', head: OTHER }] })
    expect(row).toMatchObject({
      decision: 'on_review', delivery_outcome: 'ready', status_code: 'ready_for_review',
      status_detail: 'the previous PR is closed without this implementation; create a new draft PR from the preserved commit',
      pr_url: null, pr_number: null, pr_state: 'local-only', is_continuation: 0,
    })
    expect(pushes).toHaveLength(0)
  })

  it('pre-push MERGED with no commit list → "could not prove" detail', async () => {
    const { row } = await runContinuation({ views: [OPEN, { state: 'MERGED', head: OTHER, commits: undefined }] })
    // An explicit empty commit list still proves absence; only a missing list is unknown.
    expect(row.decision).toBe('on_review')
    expect(row.status_detail).toMatch(/^the previous PR is merged /)
  })

  it('post-push lifecycle unavailable → pr_failed / push_failed after an exact push', async () => {
    const { row, pushes } = await runContinuation({ views: [OPEN, OPEN, { fail: 'timeout' }] })
    expect(row).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'retryable_failure', status_code: 'push_failed',
      status_detail: 'exact commit was pushed, but the PR lifecycle could not be confirmed: timeout',
    })
    expect(pushes).toHaveLength(1)
  })

  it('post-push OPEN with a lagging head → pr_failed, Retry push stays safe', async () => {
    const { row } = await runContinuation({ views: [OPEN, OPEN, { state: 'OPEN', head: OTHER }] })
    expect(row).toMatchObject({ decision: 'pr_failed', status_code: 'push_failed' })
    expect(row.status_detail).toMatch(/^the exact push completed, but the PR does not yet expose/)
  })

  it('post-push OPEN with the exact head → pr_ready (non-draft) / existing_pr_updated', async () => {
    const { row } = await runContinuation({ views: [OPEN, OPEN, OPEN] })
    expect(row).toMatchObject({ decision: 'pr_ready', delivery_outcome: 'delivered', status_code: 'existing_pr_updated' })
  })

  it('post-push MERGED including the SHA → pr_ready / delivered', async () => {
    const { row } = await runContinuation({ views: [OPEN, OPEN, { state: 'MERGED' }] })
    expect(row).toMatchObject({ decision: 'pr_ready', delivery_outcome: 'delivered', status_code: 'pr_ready' })
  })

  it('post-push MERGED without the SHA → new PR needed, prState pushed', async () => {
    const { row } = await runContinuation({ views: [OPEN, OPEN, { state: 'MERGED', head: OTHER }] })
    expect(row).toMatchObject({
      decision: 'on_review', status_code: 'ready_for_review', pr_url: null, pr_state: 'pushed',
      status_detail: 'the previous PR became merged without this implementation; create a new draft PR from the preserved commit',
    })
  })

  it('post-push OPEN on another base → new PR needed (identity mismatch)', async () => {
    const { row } = await runContinuation({ views: [OPEN, OPEN, { state: 'OPEN', baseRefName: 'develop' }] })
    expect(row).toMatchObject({
      decision: 'on_review', pr_state: 'pushed',
      status_detail: 'the existing PR no longer matches its recorded head/base after the exact push; create a new draft PR from the preserved commit',
    })
  })

  it('push transport throws → pr_failed with the thrown detail', async () => {
    const { row } = await runContinuation({ views: [OPEN, OPEN], push: 'throw' })
    expect(row).toMatchObject({ decision: 'pr_failed', status_code: 'push_failed', status_detail: 'push transport exploded' })
  })

  it('unchanged iteration whose open PR head moved → pr_failed / branch_verification_failed, worktree needs-review', async () => {
    const { db, row, pushes } = await runContinuation({ unchanged: true, views: [OPEN, { state: 'OPEN', head: OTHER }] })
    expect(row).toMatchObject({
      decision: 'pr_failed', delivery_outcome: 'blocked', status_code: 'branch_verification_failed',
      status_detail: 'the open PR head no longer exposes the exact verified commit from this unchanged iteration',
    })
    expect(JSON.parse(row.branches)[0]).toMatchObject({ deliveryOutcome: 'blocked', failureCode: 'branch_verification_failed' })
    expect(listRailWorktrees(db, 0)[0].merge_state).toBe('needs-review')
    expect(pushes).toHaveLength(0)
  })

  it('unchanged iteration on a PR closed with its exact head → pr_closed / delivered', async () => {
    const { row } = await runContinuation({ unchanged: true, views: [OPEN, { state: 'CLOSED' }] })
    expect(row).toMatchObject({ decision: 'pr_closed', delivery_outcome: 'delivered', status_code: 'pr_closed' })
  })

  it('unchanged iteration on a PR merged without its head → the head becomes ready work for a new PR', async () => {
    const { row } = await runContinuation({ unchanged: true, views: [OPEN, { state: 'MERGED', head: OTHER }] })
    expect(row).toMatchObject({ decision: 'on_review', delivery_outcome: 'ready', pr_url: null, pr_state: 'local-only' })
    expect(JSON.parse(row.branches)[0]).toMatchObject({ deliveryOutcome: 'ready' })
  })
})

// ─── Legacy merge-back, settlement rejection, aggregate failure ────────────

const okIo = (): IsolatedLaunchIO => ({
  git: { run: async (args: string[]) => args[0] === 'rev-parse' && args.includes('--verify') ? { code: 0, stdout: `${SHA}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' } },
  create: vi.fn(async (_g: unknown, { ticketId }: { ticketId: number }) => ({ branch: `sr/p/ticket-${ticketId}`, worktreePath: `/wt/ticket-${ticketId}` })),
  remove: vi.fn(async () => {}),
}) as unknown as IsolatedLaunchIO

describe('launchIsolatedRail characterization — settlement wiring', () => {
  it('legacy merge-back: progress states update the ledger + broadcast; merged units unmount without deleting the branch', async () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
    const { ctx, db, broadcast } = fakeCtx(settlingRun('success'))
    mockRunMergeBack.mockImplementation(async (opts: { onState: (id: number, s: string) => void; recording: unknown }) => {
      opts.onState(1, 'merged')
      opts.onState(1, 'verifying')
      return [{ ticketId: 1, branch: 'sr/p/ticket-1', state: 'merged' }, { ticketId: 99, branch: 'x', state: 'merged' }]
    })
    const io = okIo()
    await launchIsolatedRail(input([1], ctx), io)
    await vi.waitFor(() => expect(io.remove).toHaveBeenCalled())
    expect(mockRunMergeBack.mock.calls[0][0].recording).toMatchObject({ projectId: 'proj', jobId: 'rail-0-factory:implement', ticketId: 1 })
    expect(io.remove).toHaveBeenCalledWith(io.git, {
      repoDir: '/repo', worktreePath: '/wt/ticket-1', branch: 'sr/p/ticket-1', deleteBranch: false, force: false,
    })
    expect(listRailWorktrees(db, 0)[0].merge_state).toBe('merged')
    const progress = broadcast.mock.calls.map((c) => c[0]).filter((m) => m?.type === 'rail.worktree_progress')
    expect(progress).toEqual([{ type: 'rail.worktree_progress', projectId: 'proj', railIndex: 0, ticketId: 1, state: 'merged' }])
  })

  it('legacy merge-back: a unit unsafe to release is marked needs-review instead of unmounted', async () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
    const { ctx, db } = fakeCtx(settlingRun('success'))
    const io = okIo()
    // A dirty worktree (status reports a change after commit) cannot be released.
    io.git = { run: async (args: string[]) => {
      if (args[0] === 'status') return { code: 0, stdout: ' M src/a.ts\n', stderr: '' }
      return args[0] === 'rev-parse' && args.includes('--verify') ? { code: 0, stdout: `${SHA}\n`, stderr: '' } : { code: 0, stdout: '', stderr: '' }
    } } as never
    mockRunMergeBack.mockResolvedValue([{ ticketId: 1, branch: 'sr/p/ticket-1', state: 'merged' }])
    await launchIsolatedRail(input([1], ctx), io)
    await vi.waitFor(() => expect(mockRunMergeBack).toHaveBeenCalled())
    await vi.waitFor(() => expect(listRailWorktrees(db, 0)[0].merge_state).toBe('needs-review'))
    expect(io.remove).not.toHaveBeenCalled()
  })

  it('legacy merge-back failure is logged, never thrown', async () => {
    process.env.SPECRAILS_RAIL_DELIVER_PR = 'off'
    const { ctx } = fakeCtx(settlingRun('success'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRunMergeBack.mockRejectedValue(new Error('merge exploded'))
    await launchIsolatedRail(input([1], ctx), okIo())
    await vi.waitFor(() => expect(error).toHaveBeenCalledWith('[rail-isolated] merge-back failed:', expect.any(Error)))
  })

  it('an unexpected per-run settlement rejection is synthesized as a blocked settlement_interrupted unit', async () => {
    const { ctx, db } = fakeCtx(settlingRun('failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await launchIsolatedRail({ ...input([1], ctx), runtimeStateProject: { path: null as never } }, okIo())
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('implementation_failed'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(row).toMatchObject({ delivery_outcome: 'blocked', status_code: 'implementation_failed' })
    expect(JSON.parse(row.branches)[0]).toMatchObject({ deliveryOutcome: 'blocked', failureCode: 'settlement_interrupted' })
    expect(listRailWorktrees(db, 0)[0].merge_state).toBe('needs-review')
  })

  it('an aggregate settlement failure parks the delivery as pr_failed / settlement_interrupted', async () => {
    const { ctx, db } = fakeCtx(settlingRun('success'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(loopRunsStore, 'getLoopRun').mockImplementation(() => { throw new Error('ledger read failed') })
    await launchIsolatedRail(input([1], ctx), okIo())
    await vi.waitFor(() => expect(getActivePrDeliveryByRail(db, 0)?.decision).toBe('pr_failed'))
    const row = getActivePrDeliveryByRail(db, 0)!
    expect(row).toMatchObject({ delivery_outcome: 'blocked', status_code: 'settlement_interrupted', status_detail: 'ledger read failed', implementation_outcome: 'succeeded' })
    expect(JSON.parse(row.branches)[0]).toMatchObject({ deliveryOutcome: 'blocked', failureCode: 'settlement_interrupted' })
    expect(listRailWorktrees(db, 0)[0].merge_state).toBe('needs-review')
  })
})
