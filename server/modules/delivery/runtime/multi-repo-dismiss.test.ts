import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { executePrDecision, type PrDecisionDeps } from './rail-pr-decision'
import { createPrDelivery, getActivePrDeliveryByRail, getPrDelivery, withGroupContinuation } from './rail-pr-store'
import type { RepositoryDeliverySnapshot, RunExecutionManifest } from './multi-repo-execution-store'

/**
 * Observed stuck rails: relaunching a rail over a failed delivery creates the
 * new repository GROUP as a continuation (it supersedes the previous
 * generation), while each repository child is created fresh. The card offers
 * "Dismiss follow-up" for the continuation, but dismiss was then refused child
 * by child (`illegal_action`) and the rail stayed pending_decision forever.
 */
describe('dismissing a continuation repository group', () => {
  let db: DbInstance
  let dir: string
  beforeEach(() => {
    db = initDb(':memory:')
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-repo-dismiss-'))
  })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  function failedGroup(continuation: boolean, repositoryIds = ['app', 'api']): string[] {
    createPrDelivery(db, { id: 'group', railIndex: 1, railKey: 'rail-1', loopId: 'factory:implement', ticketIds: [1], baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard', isContinuation: continuation })
    const manifest: RunExecutionManifest = {
      version: 1, groupId: 'group', projectId: 'p', primaryRepositoryId: repositoryIds[0]!, artifactRepositoryId: repositoryIds[0]!, selectedRepositoryIds: repositoryIds,
      repositories: repositoryIds.map((repositoryId) => ({ repositoryId, name: repositoryId, sourcePath: path.join(dir, repositoryId), gitCommonDir: path.join(dir, repositoryId, '.git'), baseBranch: 'main', integrationBranch: 'main', baseSha: 'a'.repeat(40), worktreePath: path.join(dir, 'wt', repositoryId), branch: `fix/1-${repositoryId}`, worktreeId: `wt-${repositoryId}` })),
    }
    const children: RepositoryDeliverySnapshot[] = manifest.repositories.map((repo, index) => {
      const id = `child-${index}`
      createPrDelivery(db, { id, parentDeliveryId: 'group', repositoryId: repo.repositoryId, repositoryPath: repo.sourcePath, railIndex: 1, railKey: `rail-1-${index}`, ticketIds: [1], baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard' })
      db.prepare("UPDATE rail_pr_deliveries SET decision = 'implementation_failed', implementation_outcome = 'failed', delivery_outcome = 'blocked', status_code = 'run_stopped' WHERE id = ?").run(id)
      return { repositoryId: repo.repositoryId, name: repo.name, path: repo.sourcePath, deliveryId: id, baseBranch: 'main', branch: null, deliverySha: null, decision: 'implementation_failed', implementationOutcome: 'failed', deliveryOutcome: 'blocked', statusCode: 'run_stopped', statusDetail: null, prUrl: null, prNumber: null, worktreeIds: [], runIds: [`run-${index}`] }
    })
    db.prepare("UPDATE rail_pr_deliveries SET execution_manifest = ?, repository_deliveries = ?, decision = 'implementation_failed', implementation_outcome = 'failed', delivery_outcome = 'blocked', status_code = 'run_stopped' WHERE id = 'group'")
      .run(JSON.stringify(manifest), JSON.stringify(children))
    return children.map((child) => child.deliveryId)
  }

  function deps(): PrDecisionDeps {
    const ok = async () => ({ code: 0, stdout: '', stderr: '' })
    return {
      db, project: { id: 'p', slug: 'p', path: dir },
      git: { run: ok } as unknown as PrDecisionDeps['git'],
      exec: { run: ok } as unknown as PrDecisionDeps['exec'],
      broadcast: () => {}, agentChat: () => null, ticketFile: path.join(dir, 'tickets.json'),
    }
  }

  it('children read as continuations through their group', () => {
    const [child] = failedGroup(true)
    const stored = getPrDelivery(db, child!)!
    expect(stored.is_continuation).toBe(0)
    expect(withGroupContinuation(db, stored).is_continuation).toBe(1)
  })

  it('"Dismiss follow-up" closes every repository and frees the rail', async () => {
    const children = failedGroup(true)
    expect(getActivePrDeliveryByRail(db, 1)?.id).toBe('group')

    const result = await executePrDecision(deps(), { prDeliveryId: 'group', action: 'dismiss', expectedDecision: 'implementation_failed' })

    expect(result.status).toBe(200)
    expect(getPrDelivery(db, 'group')?.decision).toBe('discarded')
    for (const id of children) expect(getPrDelivery(db, id)?.decision).toBe('discarded')
    expect(getActivePrDeliveryByRail(db, 1)).toBeUndefined()
  })

  it('still refuses dismiss on a fresh (non-continuation) group, where Discard is the action', async () => {
    failedGroup(false)
    const result = await executePrDecision(deps(), { prDeliveryId: 'group', action: 'dismiss', expectedDecision: 'implementation_failed' })
    expect(result.status).toBe(409)
    expect(getPrDelivery(db, 'group')?.decision).toBe('implementation_failed')
  })
})
