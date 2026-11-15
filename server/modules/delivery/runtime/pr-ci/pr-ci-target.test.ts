import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../../db'
import { claimPrCiAdmission, setPrCiAdmissionWorktree, upsertPrCiAdmission } from './pr-ci-admission'
import { resolvePrCiTargets } from './pr-ci-target'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

function startedAdmission() {
  const row = upsertPrCiAdmission(db, { projectId: 'p1', repositoryId: 'r-api', repositoryPath: '/work/api', prNumber: 7, prUrl: 'https://github.com/a/api/pull/7',
    headBranch: 'fix', headSha: 'a'.repeat(40), baseBranch: 'develop', originConversationId: 'c1' })
  claimPrCiAdmission(db, 'p1', row.id, 'run-1')
  setPrCiAdmissionWorktree(db, row.id, '/wt/run-1')
  return row
}

describe('resolvePrCiTargets from a persisted admission', () => {
  it('[spec:mission-pr-ci-repair/repair-runs-on-the-same-pr-with-unchanged-guarantees] returns the frozen repository, PR, branch and base of the started run', () => {
    const row = startedAdmission()
    expect(resolvePrCiTargets(db, 'p1', 'run-1')).toEqual([{
      admissionId: row.id, repositoryId: 'r-api', runId: 'run-1', repositoryName: 'api', prUrl: 'https://github.com/a/api/pull/7', prNumber: 7,
      branch: 'fix', baseBranch: 'develop', worktreePath: '/wt/run-1', repoDir: '/work/api', overlayExcludes: [],
    }])
  })

  it('[spec:mission-pr-ci-repair/repair-runs-on-the-same-pr-with-unchanged-guarantees] resolves only by the run id the host recorded, so another run or project gets nothing', () => {
    startedAdmission()
    expect(resolvePrCiTargets(db, 'p1', 'run-other')).toEqual([])
    expect(resolvePrCiTargets(db, 'p2', 'run-1')).toEqual([])
  })

  it('[spec:mission-pr-ci-repair/repair-runs-on-the-same-pr-with-unchanged-guarantees] has no target before the run starts or after it settles', () => {
    const row = upsertPrCiAdmission(db, { projectId: 'p1', repositoryId: 'r', repositoryPath: '/r', prNumber: 1, prUrl: 'https://github.com/a/b/pull/1', headBranch: 'h', headSha: null, baseBranch: 'main', originConversationId: null })
    expect(resolvePrCiTargets(db, 'p1', 'run-1')).toEqual([])
    claimPrCiAdmission(db, 'p1', row.id, 'run-1')
    expect(resolvePrCiTargets(db, 'p1', 'run-1')).toEqual([])
    setPrCiAdmissionWorktree(db, row.id, '/wt')
    expect(resolvePrCiTargets(db, 'p1', 'run-1')).toHaveLength(1)
    db.prepare("UPDATE pr_ci_admissions SET state = 'green' WHERE id = ?").run(row.id)
    expect(resolvePrCiTargets(db, 'p1', 'run-1')).toEqual([])
  })
})
