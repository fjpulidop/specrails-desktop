import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { initDb, type DbInstance } from './db'
import { initDesktopDb } from './desktop-db'
import { LoopRunManager, type LoopExecutors } from './loop-run-manager'
import { launchIsolatedRail, reconcileRailWorktrees, type IsolatedLaunchIO } from './rail-isolated-launch'
import { launchMultiRepositoryRail, listRepositoryDeliveries, refreshRepositoryDeliveryGroup } from './multi-repo-execution'
import { getActivePrDeliveryByRail, getPrDelivery, listActivePrDeliveries, toPrDeliverySnapshot, transitionDecision } from './rail-pr-store'
import { executePrDecision, type PrDecisionDeps } from './rail-pr-decision'
import { replayPendingRailPrTicketEffects } from './rail-pr-ticket-effects'
import { checkoutRepositoryDelivery } from './multi-repo-checkout'
import { createWorktree, defaultGitRunner } from './worktree-manager'
import { repositoryLockKey, withRepoLock } from './repo-lock'
import type { ProjectContext } from './project-registry'
import type { LoopGraph } from './loop-graph'
import type { RunExecutionManifest } from './multi-repo-execution-store'

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const graph: LoopGraph = {
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 } },
    { id: 'apply', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Implement the shared API contract.' } },
    { id: 'end', type: 'end', position: { x: 0, y: 2 } },
  ],
  edges: [{ id: 'a', source: 'start', target: 'apply' }, { id: 'b', source: 'apply', target: 'end' }],
  config: { timeoutMinutes: 1, maxIterations: 2 },
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specrails-multi-execution-'))
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  const repositories = ['backend', 'frontend'].map((name, index) => {
    const repoPath = path.join(dir, name)
    fs.mkdirSync(repoPath)
    git(repoPath, 'init', '-b', 'main')
    git(repoPath, 'config', 'user.name', 'Specrails tests')
    git(repoPath, 'config', 'user.email', 'specrails-test@example.invalid')
    fs.writeFileSync(path.join(repoPath, 'README.md'), `${name}\n`)
    git(repoPath, 'add', '.'); git(repoPath, 'commit', '-m', 'initial')
    return { id: name, projectId: 'project', name, path: repoPath, kind: 'git' as const, isPrimary: index === 0, integrationBranch: 'main', addedAt: new Date().toISOString() }
  })
  const db = initDb(':memory:')
  const desktopDb = initDesktopDb(':memory:')
  cleanup.push(() => { db.close(); desktopDb.close() })
  const ticketFile = path.join(dir, 'local-tickets.json')
  fs.writeFileSync(ticketFile, JSON.stringify({ schema_version: '1.3', revision: 1, next_id: 2, tickets: { '1': {
    id: 1, title: 'Shared contract', description: 'Backend and frontend agree on the API.', status: 'on_review',
    labels: [], metadata: {}, repositoryIds: repositories.map((repo) => repo.id),
  } } }))
  let manifest: RunExecutionManifest | undefined
  const runAiStep = vi.fn<LoopExecutors['runAiStep']>(async (request) => {
    manifest = request.executionManifest
    expect(manifest?.repositories).toHaveLength(2)
    // Before the provider runs every allocated worktree and the run manifest are durable.
    expect(db.prepare('SELECT execution_manifest FROM loop_runs WHERE id IN (SELECT run_id FROM rail_worktrees LIMIT 1)').get()).toBeTruthy()
    for (const repo of manifest!.repositories) fs.writeFileSync(path.join(repo.worktreePath, 'contract.json'), JSON.stringify({ api: 'v2', repository: repo.name }))
    return { text: 'Implemented and verified the shared contract.' }
  })
  const broadcasts = vi.fn()
  const manager = new LoopRunManager(db, broadcasts, {
    runAiStep, runShell: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    runDecider: vi.fn(async () => ({ continue: false, parsed: true, blocked: false, reasoning: 'verified' })),
  })
  const onLoopRunFinished = vi.fn()
  const jira = { onRailLaunch: vi.fn(), onRailMerged: vi.fn(() => true), onRailDiscard: vi.fn(() => true) }
  const ctx = {
    db, desktopDb, project: { id: 'project', slug: 'project', path: repositories[0].path, repositories },
    loopRunManager: manager, railLoopRuns: new Map(), onLoopRunFinished, jiraSyncManager: jira,
    broadcast: broadcasts, getTicketSpec: (id: number) => id ? { id, title: 'Shared contract', description: 'Backend + frontend', repositoryIds: ['backend', 'frontend'] } : undefined,
  } as unknown as ProjectContext
  const io: IsolatedLaunchIO = {
    create: (runner, input) => createWorktree(runner, { ...input, worktreesRoot: path.join(dir, 'worktrees', path.basename(input.repoDir)) }),
    overlay: () => ({ createdPaths: [], cleanupEvidence: [], warnings: [] }),
    linkNodeModules: () => ({ linked: [], skipped: [], warnings: [], evidence: [], authenticated: [] }),
    recordProvenance: () => {},
    resolveExecution: () => ({ relocated: false, cwd: repositories[0].path, repoDir: repositories[0].path, ticketsPath: ticketFile, workspaceDir: null, env: {} } as never),
    exec: { run: async () => ({ code: 1, stdout: '', stderr: 'offline test' }) },
  }
  const input = { ctx, railIndex: 0, ticketIds: [1], loopId: 'custom-test', loopName: 'Shared contract', loopGraph: graph, provider: 'claude', model: 'sonnet', scope: 'all' as const }
  const deps: PrDecisionDeps = { db, project: ctx.project, git: defaultGitRunner, exec: io.exec!, broadcast: broadcasts, ticketFile, assemblyRoot: path.join(dir, 'assembly'), jiraSyncManager: jira }
  return { dir, db, ctx, io, input, deps, repositories, runAiStep, onLoopRunFinished, jira, ticketFile, manifest: () => manifest }
}
async function settled(db: DbInstance): Promise<string> {
  await vi.waitFor(() => { expect(getActivePrDeliveryByRail(db, 0)?.decision).not.toBe('building') }, { timeout: 10000 })
  return getActivePrDeliveryByRail(db, 0)!.id
}

describe('coordinated multi-repository execution', () => {
  it('runs one provider across two real worktrees, persists scope and retries only the incomplete local integration', async () => {
    const f = fixture()
    const runIds = await launchIsolatedRail(f.input, f.io)
    const parentId = await settled(f.db)
    expect(runIds).toHaveLength(1)
    expect(f.runAiStep).toHaveBeenCalledTimes(1)
    expect(f.onLoopRunFinished).toHaveBeenCalledTimes(1)
    expect(listActivePrDeliveries(f.db).map((row) => row.id)).toEqual([parentId])
    expect(listRepositoryDeliveries(f.db, parentId)).toHaveLength(2)
    expect(f.manifest()!.repositories.map((repo) => repo.repositoryId)).toEqual(['backend', 'frontend'])
    for (const repo of f.repositories) expect(fs.existsSync(path.join(repo.path, 'contract.json'))).toBe(false)
    fs.writeFileSync(path.join(f.repositories[0].path, 'local-notes.txt'), 'preserve unrelated work')
    let primaryMerges = 0
    const failSecond: PrDecisionDeps = { ...f.deps, git: { run: async (args, cwd) => {
      if (args[0] === 'merge' && !args.includes('--abort')) {
        if (cwd === f.repositories[0].path) primaryMerges++
        if (cwd === f.repositories[1].path) return { code: 1, stdout: '', stderr: 'test conflict in frontend' }
      }
      return defaultGitRunner.run(args, cwd)
    } } }
    const first = await executePrDecision(failSecond, { prDeliveryId: parentId, action: 'merge-local', expectedDecision: 'on_review' })
    expect(first.status, JSON.stringify(first.body)).toBeGreaterThanOrEqual(400)
    expect(listRepositoryDeliveries(f.db, parentId).map((row) => row.decision)).toEqual(['merged', 'on_review'])
    expect(getPrDelivery(f.db, parentId)?.delivery_outcome).toBe('partial')
    expect(JSON.parse(fs.readFileSync(f.ticketFile, 'utf8')).tickets['1'].status).toBe('on_review')
    expect(f.jira.onRailMerged).not.toHaveBeenCalled()
    const second = await executePrDecision(f.deps, { prDeliveryId: parentId, action: 'merge-local', expectedDecision: getPrDelivery(f.db, parentId)!.decision })
    expect(second.status, JSON.stringify(second.body)).toBe(200)
    expect(getPrDelivery(f.db, parentId)?.decision).toBe('merged')
    expect(primaryMerges).toBe(1)
    expect(JSON.parse(fs.readFileSync(f.ticketFile, 'utf8')).tickets['1'].status).toBe('done')
    expect(f.jira.onRailMerged).toHaveBeenCalledTimes(1)
    for (const repo of f.repositories) expect(fs.existsSync(path.join(repo.path, 'contract.json'))).toBe(true)
    expect(fs.readFileSync(path.join(f.repositories[0].path, 'local-notes.txt'), 'utf8')).toBe('preserve unrelated work')
  }, 20000)

  it('does not start a provider if the second allocation fails and settles every existing barrier', async () => {
    const f = fixture()
    let allocations = 0
    const create = f.io.create!
    await expect(launchIsolatedRail(f.input, { ...f.io, create: async (...args) => {
      if (++allocations === 2) throw new Error('second repository unavailable')
      return create(...args)
    } })).rejects.toThrow('second repository unavailable')
    expect(f.runAiStep).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(listRepositoryDeliveries(f.db, getActivePrDeliveryByRail(f.db, 0)!.id).some((row) => row.decision === 'building')).toBe(false), { timeout: 10000 })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM loop_runs').get()).toEqual({ n: 0 })
  }, 20000)

  it('preserves both implementations and blocks acceptance when shared ticket settlement fails', async () => {
    const f = fixture()
    f.onLoopRunFinished.mockImplementation(() => { throw new Error('shared ticket storage unavailable') })
    await launchIsolatedRail(f.input, f.io)
    const parentId = await settled(f.db)
    const parent = getPrDelivery(f.db, parentId)!
    expect(parent.decision).toBe('pr_failed')
    expect(parent.status_code).toBe('settlement_interrupted')
    expect(parent.status_detail).toContain('shared ticket storage unavailable')
    for (const child of listRepositoryDeliveries(f.db, parentId)) {
      expect(child.delivery_outcome).toBe('blocked')
      for (const unit of toPrDeliverySnapshot(child).branches) expect(fs.existsSync(path.join(unit.worktreePath!, 'contract.json'))).toBe(true)
    }
    expect(f.jira.onRailMerged).not.toHaveBeenCalled()
  }, 20000)

  it('checks out only the selected repository, preserving shared review state and frozen paths', async () => {
    const f = fixture()
    await launchIsolatedRail(f.input, f.io)
    const parentId = await settled(f.db)
    const snap = toPrDeliverySnapshot(getPrDelivery(f.db, parentId)!)
    f.ctx.project.repositories!.find((repo) => repo.id === 'frontend')!.path = '/a-later-project-edit'
    const ambiguous = await checkoutRepositoryDelivery(f.deps, { prDeliveryId: parentId })
    expect(ambiguous.status).toBe(400)
    const result = await checkoutRepositoryDelivery(f.deps, { prDeliveryId: parentId, repositoryId: 'frontend' })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    expect(git(f.repositories[0].path, 'branch', '--show-current')).toBe('main')
    const frozen = snap.executionManifest!.repositories.find((repo) => repo.repositoryId === 'frontend')!
    expect(git(frozen.sourcePath, 'branch', '--show-current')).toBe(frozen.branch)
    expect(fs.existsSync(frozen.worktreePath)).toBe(false)
    expect(getPrDelivery(f.db, parentId)?.decision).toBe('on_review')
    expect(f.jira.onRailMerged).not.toHaveBeenCalled()
  }, 20000)

  it('rejects ambiguous custom shells before allocation', async () => {
    const f = fixture()
    const loopGraph = structuredClone(graph)
    loopGraph.nodes[1] = { ...loopGraph.nodes[1], type: 'shell', data: { command: 'npm test' } }
    await expect(launchIsolatedRail({ ...f.input, loopGraph }, f.io)).rejects.toThrow('explicit selected repositoryId')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM rail_worktrees').get()).toEqual({ n: 0 })
    expect(f.runAiStep).not.toHaveBeenCalled()
  })

  it('supports standalone coordinated runs without claiming or creating a synthetic ticket', async () => {
    const f = fixture()
    const ids = await launchMultiRepositoryRail({ ...f.input, ticketIds: [], repositoryIds: ['backend', 'frontend'] }, f.io)
    await settled(f.db)
    expect(ids).toHaveLength(1)
    const run = f.db.prepare('SELECT ticket_id, ticket_ids_json FROM loop_runs WHERE id = ?').get(ids[0])
    expect(run).toEqual({ ticket_id: null, ticket_ids_json: '[]' })
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM ticket_outcome_ownership').get()).toEqual({ n: 0 })
  }, 20000)

  it('revises both repositories from their exact previous commits and preserves both versions', async () => {
    const f = fixture()
    await launchIsolatedRail(f.input, f.io)
    const priorId = await settled(f.db)
    const prior = toPrDeliverySnapshot(getPrDelivery(f.db, priorId)!)
    f.runAiStep.mockImplementationOnce(async ({ executionManifest }) => {
      for (const repo of executionManifest!.repositories) {
        expect(fs.existsSync(path.join(repo.worktreePath, 'contract.json'))).toBe(true)
        expect(repo.baseSha).toBe(prior.repositoryDeliveries!.find((entry) => entry.repositoryId === repo.repositoryId)!.deliverySha)
        fs.writeFileSync(path.join(repo.worktreePath, 'revision.txt'), 'both versions are preserved')
      }
      return { text: 'Revision verified across repositories.' }
    })
    await launchIsolatedRail({ ...f.input, revision: { ofDeliveryId: priorId, decision: 'on_review', note: 'Keep v1 and add the revision.' } }, f.io)
    const nextId = await settled(f.db)
    expect(nextId).not.toBe(priorId)
    expect(getPrDelivery(f.db, priorId)?.decision).toBe('superseded')
    expect(f.runAiStep).toHaveBeenCalledTimes(2)
    const result = await executePrDecision(f.deps, { prDeliveryId: nextId, action: 'merge-local', expectedDecision: 'on_review' })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    for (const repo of f.repositories) {
      expect(fs.existsSync(path.join(repo.path, 'contract.json'))).toBe(true)
      expect(fs.existsSync(path.join(repo.path, 'revision.txt'))).toBe(true)
    }
  }, 20000)

  it('restores the previous delivery and retains its borrowed worktree if revision allocation fails', async () => {
    const f = fixture()
    await launchIsolatedRail(f.input, f.io)
    const priorId = await settled(f.db)
    const paths = toPrDeliverySnapshot(getPrDelivery(f.db, priorId)!).executionManifest!.repositories.map((repo) => repo.worktreePath)
    let count = 0
    await expect(launchIsolatedRail({ ...f.input, revision: { ofDeliveryId: priorId, decision: 'on_review', note: 'Revise' } }, {
      ...f.io, create: async (...args) => { if (++count === 2) throw new Error('allocation failed'); return f.io.create!(...args) },
    })).rejects.toThrow('allocation failed')
    expect(getActivePrDeliveryByRail(f.db, 0)?.id).toBe(priorId)
    expect(getPrDelivery(f.db, priorId)?.decision).toBe('on_review')
    expect(f.runAiStep).toHaveBeenCalledTimes(1)
    for (const worktree of paths) expect(fs.existsSync(worktree)).toBe(true)
  }, 20000)

  it('commits parent acceptance and the shared-ticket outbox atomically and can recover the interrupted projection', async () => {
    const f = fixture()
    await launchIsolatedRail(f.input, f.io)
    const parentId = await settled(f.db)
    for (const child of listRepositoryDeliveries(f.db, parentId)) transitionDecision(f.db, child.id, child.decision, 'merged', { deliveryOutcome: 'delivered' })
    f.db.exec("CREATE TEMP TRIGGER interrupt_effect BEFORE INSERT ON rail_pr_ticket_effects BEGIN SELECT RAISE(ABORT, 'simulated crash'); END")
    expect(() => refreshRepositoryDeliveryGroup(f.db, parentId)).toThrow('simulated crash')
    expect(getPrDelivery(f.db, parentId)?.decision).toBe('on_review')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM rail_pr_ticket_effects').get()).toEqual({ n: 0 })
    f.db.exec('DROP TRIGGER interrupt_effect')
    refreshRepositoryDeliveryGroup(f.db, parentId)
    expect(getPrDelivery(f.db, parentId)?.decision).toBe('merged')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM rail_pr_ticket_effects').get()).toEqual({ n: 1 })
    replayPendingRailPrTicketEffects(f.deps)
    expect(JSON.parse(fs.readFileSync(f.ticketFile, 'utf8')).tickets['1'].status).toBe('done')
    expect(f.jira.onRailMerged).toHaveBeenCalledTimes(1)
  }, 20000)

  it('reconciles worktree references against each frozen Git repository after restart', async () => {
    const f = fixture()
    await launchIsolatedRail(f.input, f.io)
    const parentId = await settled(f.db)
    const before = toPrDeliverySnapshot(getPrDelivery(f.db, parentId)!)
    await reconcileRailWorktrees(f.db, f.repositories[0].path, { exec: f.io.exec })
    const after = toPrDeliverySnapshot(getPrDelivery(f.db, parentId)!)
    expect(after.repositoryDeliveries!.map((repo) => [repo.repositoryId, repo.deliverySha])).toEqual(before.repositoryDeliveries!.map((repo) => [repo.repositoryId, repo.deliverySha]))
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM rail_worktrees WHERE merge_state = 'needs-review'").get()).toEqual({ n: 0 })
  }, 20000)

  it('stacks each repository on its frozen previous chunk but accepts into its integration branch', async () => {
    const f = fixture()
    const repositoryBaseBranches: Record<string, string> = {}
    const repositoryBaseShas: Record<string, string> = {}
    for (const repo of f.repositories) {
      git(repo.path, 'checkout', '-b', 'previous-chunk')
      fs.writeFileSync(path.join(repo.path, 'previous.txt'), repo.name)
      git(repo.path, 'add', '.'); git(repo.path, 'commit', '-m', 'previous chunk')
      repositoryBaseBranches[repo.id] = 'previous-chunk'
      repositoryBaseShas[repo.id] = git(repo.path, 'rev-parse', 'HEAD')
      git(repo.path, 'checkout', 'main')
    }
    await launchIsolatedRail({ ...f.input, repositoryBaseBranches, repositoryBaseShas }, f.io)
    const parentId = await settled(f.db)
    const snapshot = toPrDeliverySnapshot(getPrDelivery(f.db, parentId)!)
    expect(snapshot.repositoryDeliveries!.map((repo) => [repo.baseBranch, repo.integrationBranch])).toEqual([['previous-chunk', 'main'], ['previous-chunk', 'main']])
    const result = await executePrDecision(f.deps, { prDeliveryId: parentId, action: 'merge-local', expectedDecision: 'on_review' })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    for (const repo of f.repositories) {
      expect(git(repo.path, 'branch', '--show-current')).toBe('main')
      expect(fs.existsSync(path.join(repo.path, 'previous.txt'))).toBe(true)
      expect(fs.existsSync(path.join(repo.path, 'contract.json'))).toBe(true)
    }
  }, 20000)

  it('rejects a moved stacked base before starting any provider', async () => {
    const f = fixture()
    await expect(launchIsolatedRail({ ...f.input, repositoryBaseBranches: { frontend: 'main' }, repositoryBaseShas: { frontend: 'f'.repeat(40) } }, f.io)).rejects.toThrow('base changed')
    expect(f.runAiStep).not.toHaveBeenCalled()
  }, 20000)

  it('revises a partially accepted stacked group from current accepted work and exact pending work', async () => {
    const f = fixture()
    const repositoryBaseBranches: Record<string, string> = {}
    for (const repo of f.repositories) {
      git(repo.path, 'checkout', '-b', 'previous-chunk')
      fs.writeFileSync(path.join(repo.path, 'previous.txt'), repo.name)
      git(repo.path, 'add', '.'); git(repo.path, 'commit', '-m', 'previous chunk')
      repositoryBaseBranches[repo.id] = 'previous-chunk'
      git(repo.path, 'checkout', 'main')
    }
    await launchIsolatedRail({ ...f.input, repositoryBaseBranches }, f.io)
    const parentId = await settled(f.db)
    const partial = await executePrDecision(f.deps, { prDeliveryId: parentId, action: 'merge-local', repositoryId: 'backend', expectedDecision: 'on_review' })
    expect(partial.status, JSON.stringify(partial.body)).toBe(200)
    fs.writeFileSync(path.join(f.repositories[0].path, 'subsequent.txt'), 'new integration work')
    git(f.repositories[0].path, 'add', '.'); git(f.repositories[0].path, 'commit', '-m', 'subsequent integration work')
    f.runAiStep.mockImplementationOnce(async ({ executionManifest }) => {
      for (const repo of executionManifest!.repositories) {
        expect(fs.existsSync(path.join(repo.worktreePath, 'contract.json'))).toBe(true)
        expect(fs.existsSync(path.join(repo.worktreePath, 'previous.txt'))).toBe(true)
        if (repo.repositoryId === 'backend') expect(fs.existsSync(path.join(repo.worktreePath, 'subsequent.txt'))).toBe(true)
        expect(repo.integrationBranch).toBe('main')
        fs.writeFileSync(path.join(repo.worktreePath, 'revision.txt'), 'shared revision')
      }
      return { text: 'Verified the complete revised contract.' }
    })
    await launchIsolatedRail({ ...f.input, revision: { ofDeliveryId: parentId, decision: 'on_review', note: 'Complete the shared delivery.' } }, f.io)
    const revisedId = await settled(f.db)
    const result = await executePrDecision(f.deps, { prDeliveryId: revisedId, action: 'merge-local', expectedDecision: 'on_review' })
    expect(result.status, JSON.stringify(result.body)).toBe(200)
    for (const repo of f.repositories) {
      expect(git(repo.path, 'branch', '--show-current')).toBe('main')
      expect(fs.existsSync(path.join(repo.path, 'revision.txt'))).toBe(true)
    }
    expect(fs.existsSync(path.join(f.repositories[0].path, 'subsequent.txt'))).toBe(true)
  }, 20000)

  it('defaults a standalone shell to its single selected secondary repository', async () => {
    const f = fixture()
    const loopGraph = structuredClone(graph)
    loopGraph.nodes[1] = { ...loopGraph.nodes[1], type: 'shell', data: { command: 'npm test' } }
    await launchIsolatedRail({ ...f.input, repositoryIds: ['frontend'], loopGraph }, f.io)
    const parentId = await settled(f.db)
    const snapshot = toPrDeliverySnapshot(getPrDelivery(f.db, parentId)!)
    expect(snapshot.executionManifest!.selectedRepositoryIds).toEqual(['frontend'])
    expect(snapshot.executionManifest!.artifactRepositoryId).toBe('frontend')
    expect(snapshot.decision).toBe('no_changes')
    expect(f.runAiStep).not.toHaveBeenCalled()
  }, 20000)

  it('recovers interrupted per-repository settlement using the common run marker without swapping SHA evidence', async () => {
    const f = fixture()
    await launchIsolatedRail(f.input, f.io)
    const parentId = await settled(f.db)
    const prior = toPrDeliverySnapshot(getPrDelivery(f.db, parentId)!)
    for (const child of listRepositoryDeliveries(f.db, parentId)) transitionDecision(f.db, child.id, child.decision, 'building', { branches: [] })
    transitionDecision(f.db, parentId, 'on_review', 'building')
    await reconcileRailWorktrees(f.db, f.repositories[0].path, { exec: f.io.exec })
    const after = toPrDeliverySnapshot(getPrDelivery(f.db, parentId)!)
    expect(after.decision).toBe('on_review')
    expect(after.repositoryDeliveries!.map((repo) => repo.deliverySha)).toEqual(prior.repositoryDeliveries!.map((repo) => repo.deliverySha))
    for (const child of listRepositoryDeliveries(f.db, parentId)) {
      expect(toPrDeliverySnapshot(child).branches.every((unit) => Boolean(unit.finalSha))).toBe(true)
    }
  }, 20000)

  it('does not complete a shared spec when child integration accepted only a partial implementation', async () => {
    const f = fixture()
    await launchIsolatedRail(f.input, f.io)
    const parentId = await settled(f.db)
    for (const child of listRepositoryDeliveries(f.db, parentId)) transitionDecision(f.db, child.id, child.decision, 'merged', { implementationOutcome: 'partially_succeeded' })
    refreshRepositoryDeliveryGroup(f.db, parentId)
    expect(getPrDelivery(f.db, parentId)?.decision).toBe('pr_failed')
    expect(getPrDelivery(f.db, parentId)?.status_code).toBe('partial_delivery')
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM rail_pr_ticket_effects').get()).toEqual({ n: 0 })
  }, 20000)

  it('shares a lock across primary checkout, worktree and symlink', async () => {
    const f = fixture()
    const handle = await createWorktree(defaultGitRunner, { repoDir: f.repositories[0].path, worktreesRoot: path.join(f.dir, 'lock-wt'), slug: 'lock', ticketId: 9, baseRef: 'main' })
    const link = path.join(f.dir, 'alias')
    fs.symlinkSync(f.repositories[0].path, link, 'dir')
    expect(repositoryLockKey(handle.worktreePath)).toBe(repositoryLockKey(link))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const order: number[] = []
    const first = withRepoLock(link, async () => { order.push(1); await gate })
    const next = withRepoLock(handle.worktreePath, async () => { order.push(2) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual([1])
    release(); await Promise.all([first, next])
    expect(order).toEqual([1, 2])
  })
})
