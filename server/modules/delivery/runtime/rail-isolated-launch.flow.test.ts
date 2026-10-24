import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { __resetFetchOriginCache } from '../../../integration-branch'
import type { ProjectContext } from '../../../project-registry'
import { createSqliteFlowRepository } from '../../flow/adapters/sqlite'
import { createFlowHandOffAuthority } from '../../flow/adapters/bindings'
import type { FlowSession } from '../../flow'
import { launchIsolatedRail, type IsolatedLaunchIO } from './rail-isolated-launch'
import { FlowWorktreeMismatchError } from './flow-worktree-handoff'
import { listRailWorktrees } from './rail-worktrees-store'
import { getActivePrDeliveryByRail, getPrDelivery, toPrDeliverySnapshot } from './rail-pr-store'
import { ownedDeliveryBranches } from '../adapters/decisions/ownership'

const { mockRunMergeBack, failSnapshot } = vi.hoisted(() => ({ mockRunMergeBack: vi.fn(), failSnapshot: { value: false } }))
vi.mock('./rail-merge-orchestrator', () => ({ runMergeBack: mockRunMergeBack }))
vi.mock('./isolated-settlement-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./isolated-settlement-store')>()
  return {
    ...actual,
    saveIsolatedSettlementSnapshot: (...args: Parameters<typeof actual.saveIsolatedSettlementSnapshot>) => {
      if (failSnapshot.value) throw new Error('snapshot could not commit')
      return actual.saveIsolatedSettlementSnapshot(...args)
    },
  }
})

const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const FLOW_PATH = '/wt/flow-1/ticket-7'
const BRANCH = 'feat/7-kanban'

beforeEach(() => {
  __resetFetchOriginCache()
  mockRunMergeBack.mockReset().mockResolvedValue([])
  failSnapshot.value = false
})
afterEach(() => { delete process.env.SPECRAILS_RAIL_DELIVER_PR })

function setup(headOnMount = HEAD, opts: { repositoryId?: string } = {}) {
  const db = initDb(':memory:')
  const desktopDb = initDesktopDb(':memory:')
  const run = vi.fn(() => new Promise<never>(() => { /* never settles */ }))
  const ctx = {
    project: opts.repositoryId
      ? { id: 'proj', slug: 'p', path: '/repo', primaryRepositoryId: 'core', repositories: [
          { id: 'core', projectId: 'proj', name: 'core', path: '/repo', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: 't' },
          { id: 'api', projectId: 'proj', name: 'api', path: '/api', isPrimary: false, kind: 'git', integrationBranch: null, addedAt: 't' },
          { id: 'web', projectId: 'proj', name: 'web', path: '/web', isPrimary: false, kind: 'git', integrationBranch: null, addedAt: 't' },
        ] }
      : { id: 'proj', slug: 'p', path: '/repo' },
    db, desktopDb,
    loopRunManager: { run },
    getTicketSpec: (id: number) => ({ title: `T${id}`, description: 'd', ticketIds: [id] }),
    railLoopRuns: new Map(),
    onLoopRunFinished: vi.fn(),
    jiraSyncManager: { onRailLaunch: vi.fn() },
    broadcast: vi.fn(),
  } as unknown as ProjectContext
  const repository = createSqliteFlowRepository(db)
  const session: FlowSession = {
    id: 'flow-1', conversationId: 'conv-1', ticketId: 7, state: 'paused', branch: BRANCH, worktreePath: FLOW_PATH,
    baseSha: BASE, headSha: HEAD, coreSessionId: null, railIndex: 0, deliveryId: null, step: 'handoff:launch',
    ...(opts.repositoryId ? { repositoryId: opts.repositoryId } : {}),
    createdAt: 't', updatedAt: 't',
  }
  repository.insert(session)
  const required = createFlowHandOffAuthority(repository, { now: () => 'now' }).resolve('flow-1')
  const create = vi.fn(async () => ({ branch: BRANCH, worktreePath: FLOW_PATH, worktreeCreated: false, branchCreated: false }))
  const remove = vi.fn(async () => {})
  const git = {
    run: vi.fn(async (args: string[], cwd: string) => {
      if (args[0] === 'symbolic-ref') return { code: 0, stdout: 'refs/remotes/origin/main\n', stderr: '' }
      if (args.join(' ') === 'rev-parse --verify HEAD' && cwd === FLOW_PATH) return { code: 0, stdout: `${headOnMount}\n`, stderr: '' }
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { code: 0, stdout: `${BASE}\n`, stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    }),
  }
  const io: IsolatedLaunchIO = {
    git, create, remove,
    overlay: vi.fn(() => ({ createdPaths: [], warnings: [], cleanupEvidence: [] })) as never,
    linkNodeModules: vi.fn(() => ({ linked: [], authenticated: [], warnings: [], evidence: [] })) as never,
    snapshot: vi.fn(() => null) as never,
  }
  const launch = (patch: Record<string, unknown> = {}) => launchIsolatedRail({
    ctx, railIndex: 0, ticketIds: [7], loopId: 'factory:implement', loopName: 'Implement',
    loopGraph: { nodes: [], edges: [], config: {} } as never, provider: 'claude', model: 'sonnet',
    originSurface: 'agent-chat', originConversationId: 'conv-1',
    requiredFlowWorktree: required, ...patch,
  }, io)
  return { ctx, db, run, repository, required, create, remove, git, io, launch }
}

describe('launchIsolatedRail — Flow hand-off (requiredFlowWorktree)', () => {
  it('adopts the exact Flow worktree and transfers ownership atomically', async () => {
    const { db, run, repository, create, remove, launch } = setup()
    const ids = await launch()
    expect(ids).toHaveLength(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ branch: BRANCH, baseRef: BASE, fresh: false, reuseBranchWorktree: true }))
    expect(remove).not.toHaveBeenCalled()
    const ledger = listRailWorktrees(db, 0)
    expect(ledger).toEqual([expect.objectContaining({ ticket_id: 7, branch: BRANCH, worktree_path: FLOW_PATH, merge_state: 'building' })])
    const delivery = getActivePrDeliveryByRail(db, 0)!
    expect(repository.get('flow-1')).toMatchObject({ state: 'handed_off', step: null, railIndex: 0, deliveryId: delivery.id })
  })

  it('rejects a HEAD that differs from the frozen one with FlowWorktreeMismatchError (no ledger, Flow untouched)', async () => {
    const { db, run, repository, remove, launch } = setup('c'.repeat(40))
    const error = await launch().catch((caught) => caught)
    expect(error).toBeInstanceOf(FlowWorktreeMismatchError)
    expect(error.code).toBe('flow_worktree_mismatch')
    expect(run).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(listRailWorktrees(db, 0)).toEqual([])
    expect(repository.get('flow-1')).toMatchObject({ state: 'paused', step: 'handoff:launch' })
    const closed = db.prepare('SELECT decision FROM rail_pr_deliveries').all()
    expect(closed).toEqual([{ decision: 'discarded' }])
  })

  it('rejects a mount on another path or branch', async () => {
    const wrongPath = setup()
    wrongPath.create.mockResolvedValueOnce({ branch: BRANCH, worktreePath: '/wt/other', worktreeCreated: false, branchCreated: false })
    await expect(wrongPath.launch()).rejects.toThrow(/not mounted at/)
    const wrongBranch = setup()
    wrongBranch.create.mockResolvedValueOnce({ branch: 'other', worktreePath: FLOW_PATH, worktreeCreated: false, branchCreated: false })
    await expect(wrongBranch.launch()).rejects.toThrow(/is on other/)
    expect(wrongBranch.remove).not.toHaveBeenCalled()
  })

  it('never removes the branch when it had to remount a missing Flow worktree', async () => {
    const { create, remove, launch } = setup()
    create.mockResolvedValueOnce({ branch: BRANCH, worktreePath: '/wt/remounted', worktreeCreated: true, branchCreated: false })
    await expect(launch()).rejects.toBeInstanceOf(FlowWorktreeMismatchError)
    expect(remove).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ worktreePath: '/wt/remounted', deleteBranch: false }))
  })

  it('rolls back the ledger row and the Flow state together when the adoption fails', async () => {
    const { db, repository, launch } = setup()
    // The Flow moved on (e.g. a concurrent reconciliation): adoption must not commit.
    db.prepare("UPDATE flow_sessions SET head_sha = ? WHERE id = 'flow-1'").run('d'.repeat(40))
    await expect(launch()).rejects.toThrow(/does not match the frozen Flow HEAD/)
    expect(listRailWorktrees(db, 0)).toEqual([])
    expect(repository.get('flow-1')).toMatchObject({ state: 'paused', step: 'handoff:launch' })
  })

  it('returns an adopted worktree to the Flow when the launch rolls back after adoption', async () => {
    const { db, repository, remove, run, launch } = setup()
    failSnapshot.value = true
    const definitionGraph = { nodes: [{ id: 'core', type: 'core', position: { x: 0, y: 0 }, data: {} }], edges: [], config: {} }
    await expect(launch({ loopGraph: definitionGraph })).rejects.toThrow('snapshot could not commit')
    expect(run).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(listRailWorktrees(db, 0)).toEqual([])
    expect(repository.get('flow-1')).toMatchObject({ state: 'paused', step: 'handoff:launch', deliveryId: null })
  })

  it('never combines with continuation, revision or retry contracts', async () => {
    const { create, launch } = setup()
    await expect(launch({ ticketIds: [7, 8] })).rejects.toBeInstanceOf(FlowWorktreeMismatchError)
    await expect(launch({ revision: { ofDeliveryId: 'x', decision: 'pr_draft', note: 'n' } })).rejects.toBeInstanceOf(FlowWorktreeMismatchError)
    expect(create).not.toHaveBeenCalled()
  })

  it('treats the adopted branch as rail-owned on release once delivered', async () => {
    const { db, launch } = setup()
    await launch()
    const delivery = getPrDelivery(db, getActivePrDeliveryByRail(db, 0)!.id)!
    const snapshot = { ...toPrDeliverySnapshot(delivery), branches: [{ ticketId: 7, branch: BRANCH, succeeded: true, deliveryOutcome: 'ready' as const, branchOwnership: 'adopted' as const }] }
    expect([...ownedDeliveryBranches(delivery, snapshot)]).toEqual([BRANCH])
  })

  it('a Flow in a non-primary repository runs as that ONE repository and settles on the GROUP delivery', async () => {
    const { db, run, repository, required, create, launch } = setup(HEAD, { repositoryId: 'api' })
    expect(required.repositoryId).toBe('api')
    await launch({ repositoryIds: ['api'] })
    expect(run).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ repoDir: '/api', branch: BRANCH, baseRef: BASE, reuseBranchWorktree: true }))
    const parent = getActivePrDeliveryByRail(db, 0)!
    expect(parent.parent_delivery_id).toBeNull()
    const children = db.prepare('SELECT * FROM rail_pr_deliveries WHERE parent_delivery_id = ?').all(parent.id) as Array<{ id: string; repository_id: string; repository_path: string }>
    expect(children).toEqual([expect.objectContaining({ repository_id: 'api', repository_path: '/api' })])
    // The Flow adopts the parent: the only delivery whose rail.pr_state is broadcast.
    expect(repository.get('flow-1')).toMatchObject({ state: 'handed_off', step: null, deliveryId: parent.id })
    expect(listRailWorktrees(db, 0)).toEqual([expect.objectContaining({ worktree_path: FLOW_PATH, branch: BRANCH })])
    // Core measures the change from the Flow reservation commit, not the frozen HEAD.
    const manifest = JSON.parse(getPrDelivery(db, parent.id)!.execution_manifest!) as { repositories: Array<{ repositoryId: string; baseSha: string }> }
    expect(manifest.repositories).toEqual([expect.objectContaining({ repositoryId: 'api', baseSha: BASE })])
  })

  it('refuses a non-primary Flow launched with another repository scope, and a primary Flow inside a repository group', async () => {
    const other = setup(HEAD, { repositoryId: 'api' })
    await expect(other.launch({ repositoryIds: ['web'] })).rejects.toBeInstanceOf(FlowWorktreeMismatchError)
    await expect(other.launch({ repositoryIds: ['api', 'web'] })).rejects.toBeInstanceOf(FlowWorktreeMismatchError)
    expect(other.create).not.toHaveBeenCalled()
    expect(other.repository.get('flow-1')).toMatchObject({ state: 'paused', step: 'handoff:launch' })
    const primary = setup(HEAD, { repositoryId: undefined })
    const ctxWithMembers = setup(HEAD, { repositoryId: 'api' })
    // A primary Flow (no repositoryId) never rides a repository group leg.
    await expect(ctxWithMembers.launch({ repositoryIds: ['api'], requiredFlowWorktree: { ...primary.required, repositoryId: undefined } })).rejects.toBeInstanceOf(FlowWorktreeMismatchError)
  })
})
