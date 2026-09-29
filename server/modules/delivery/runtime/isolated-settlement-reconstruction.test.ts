import { afterEach, beforeEach, expect, it } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { initDb, createJob, type DbInstance } from '../../../db'
import { createLoopRun, saveDefinitionRun } from '../../loops/runtime/loop-runs-store'
import type { LoopRunRequest } from '../../loops/runtime/loop-run-manager'
import { createPrDelivery } from './rail-pr-store'
import { createRailWorktree } from './rail-worktrees-store'
import { readIsolatedSettlementRecords } from './isolated-settlement-store'
import { ensureIsolatedSettlementSnapshot } from './isolated-settlement-reconstruction'
import type { RunExecutionManifest } from './multi-repo-execution-store'

let db: DbInstance
let manifest: RunExecutionManifest
beforeEach(() => {
  db = initDb(':memory:')
  manifest = { version: 1, groupId: 'group', projectId: 'project', primaryRepositoryId: 'a', artifactRepositoryId: 'a', selectedRepositoryIds: ['a', 'b'],
    repositories: ['a', 'b'].map(id => ({ repositoryId: id, name: id, sourcePath: path.join(os.tmpdir(), 'source-' + id), gitCommonDir: path.join(os.tmpdir(), 'source-' + id, '.git'),
      baseBranch: 'main', baseSha: 'a'.repeat(40), worktreePath: path.join(os.tmpdir(), 'work-' + id), branch: 'work-' + id, worktreeId: 'mount-' + id })) }
  const delivery = (id: string) => createPrDelivery(db, { id, ...(id === 'group' ? {} : { parentDeliveryId: 'group' }), railIndex: 0, loopId: 'loop', railKey: id, ticketIds: [1], baseBranch: 'main', loopName: 'Loop', originSurface: 'dashboard' })
  delivery('group')
  for (const repository of manifest.repositories) {
    const id = repository.repositoryId
    delivery('delivery-' + id)
    db.prepare('UPDATE rail_pr_deliveries SET parent_delivery_id=?,repository_id=?,repository_path=?,run_ids=?,worktree_ids=?,branches=? WHERE id=?').run(
      'group', id, repository.sourcePath, '["run"]', JSON.stringify([repository.worktreeId]), JSON.stringify([{ ticketId: 1, runId: 'run', branch: repository.branch,
        worktreePath: repository.worktreePath, initialSha: 'b'.repeat(40), branchOwnership: 'created', overlayExcludes: ['.claude', 'CLAUDE.md'], succeeded: false }]), 'delivery-' + id)
    createRailWorktree(db, { id: repository.worktreeId, runId: 'run', railIndex: 0, ticketId: 1, branch: repository.branch, worktreePath: repository.worktreePath, repositoryId: id, repositoryPath: repository.sourcePath })
  }
  createJob(db, { id: 'run', command: 'loop:test', started_at: new Date().toISOString(), owner: 'loop' })
  createLoopRun(db, { id: 'run', projectId: 'project', loopId: 'loop', ticketIds: [1], railIndex: 0, ticketCompletionStatus: 'on_review', iterationLimit: 3, startedAt: new Date().toISOString() })
  const request: LoopRunRequest = { runId: 'run', projectId: 'project', loopId: 'loop', cwd: manifest.repositories[0].worktreePath,
    executionManifest: manifest, provider: 'claude', model: 'old-model', deferTerminalOutcome: true,
    graph: { nodes: [], edges: [], config: { maxIterations: 3, timeoutMinutes: 0 } } }
  saveDefinitionRun(db, 'run', { request, context: { runId: 'run', repositories: manifest.repositories.map(repo => ({ id: repo.repositoryId, path: repo.worktreePath })) } })
})
afterEach(() => db.close())
const count = () => db.prepare('SELECT COUNT(*) AS n FROM definition_delivery_settlements').get()

it('reconstructs every leg atomically from recorded identities, without granting cleanup or inventing provenance', () => {
  const before = db.prepare('SELECT * FROM loop_runs WHERE id=?').get('run')
  expect(ensureIsolatedSettlementSnapshot(db, 'project', 'run')).toEqual({ delivery_id: 'delivery-a' })
  for (const id of ['a', 'b']) {
    const snapshot = readIsolatedSettlementRecords(db, 'project', 'delivery-' + id)[0].snapshot
    expect(snapshot).toMatchObject({ reconstructedFrom: 'durable-branch-records', projectId: 'project',
      run: { runId: 'run', initialSha: 'b'.repeat(40), baseRef: 'a'.repeat(40), automaticRelease: false, worktreeOwnership: 'preexisting',
        overlayExcludes: ['.claude', 'CLAUDE.md'], overlayCleanupEvidence: [], warmLinkEvidence: [], settlementIgnoredPaths: null, provenanceSnapshot: null, continuationTarget: null } })
    expect(snapshot.commitMessage).toContain('(run run)')
  }
  expect(db.prepare('SELECT * FROM loop_runs WHERE id=?').get('run')).toEqual(before)
  expect(ensureIsolatedSettlementSnapshot(db, 'project', 'run')).toEqual({ delivery_id: 'delivery-a' })
  expect(count()).toEqual({ n: 2 })
})

it.each([
  "UPDATE rail_pr_deliveries SET branches='[]' WHERE id='delivery-b'",
  "UPDATE rail_pr_deliveries SET branches=json_remove(branches,'$[0].initialSha') WHERE id='delivery-b'",
  "UPDATE rail_pr_deliveries SET branches=json_remove(branches,'$[0].overlayExcludes') WHERE id='delivery-b'",
  "UPDATE rail_pr_deliveries SET branches=json_set(branches,'$[0].overlayExcludes[0]','../outside') WHERE id='delivery-b'",
  "UPDATE rail_pr_deliveries SET branches=json_set(branches,'$[0].ticketId',99) WHERE id='delivery-b'",
  "UPDATE rail_pr_deliveries SET branches=json_set(branches,'$[0].branchOwnership','borrowed-pr') WHERE id='delivery-b'",
  "UPDATE rail_pr_deliveries SET is_continuation=1 WHERE id='delivery-b'",
  "UPDATE rail_pr_deliveries SET decision='discarded' WHERE id='delivery-b'",
  "UPDATE rail_pr_deliveries SET operation_token='other' WHERE id='group'",
  "UPDATE rail_pr_deliveries SET worktree_ids='[]' WHERE id='delivery-b'",
  "UPDATE rail_worktrees SET run_id='other' WHERE id='mount-b'",
  "UPDATE rail_worktrees SET merge_state='released' WHERE id='mount-b'",
])('rejects incomplete or changed historical proof without partially restoring earlier legs: %s', sql => {
  db.exec(sql)
  expect(() => ensureIsolatedSettlementSnapshot(db, 'project', 'run')).toThrow('Original isolated settlement snapshot is unavailable')
  expect(count()).toEqual({ n: 0 })
})

it('rolls back both legs when persistence fails and retries without duplicate snapshots', () => {
  db.exec("CREATE TRIGGER reject_reconstruction BEFORE INSERT ON definition_delivery_settlements WHEN NEW.delivery_id='delivery-b' BEGIN SELECT RAISE(ABORT,'second leg failed'); END")
  expect(() => ensureIsolatedSettlementSnapshot(db, 'project', 'run')).toThrow('second leg failed')
  expect(count()).toEqual({ n: 0 })
  db.exec('DROP TRIGGER reject_reconstruction')
  expect(ensureIsolatedSettlementSnapshot(db, 'project', 'run')).toBeDefined()
  expect(count()).toEqual({ n: 2 })
})
it('rejects another project before reading or creating settlement ownership', () => {
  expect(() => ensureIsolatedSettlementSnapshot(db, 'other', 'run')).toThrow('another project')
  expect(count()).toEqual({ n: 0 })
})
