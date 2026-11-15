import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../../db'
import { claimPrCiAdmission, dismissPrCiAdmission, getPrCiAdmission, getPrCiAdmissionByRun, listStartedPrCiAdmissions, releasePrCiAdmission, settlePrCiAdmission, upsertPrCiAdmission, type PrCiAdmissionTarget } from './pr-ci-admission'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })
afterEach(() => db.close())

const target = (over: Partial<PrCiAdmissionTarget> = {}): PrCiAdmissionTarget => ({
  projectId: 'p1', repositoryId: 'r1', repositoryPath: '/repo', prNumber: 5, prUrl: 'https://github.com/a/b/pull/5',
  headBranch: 'fix', headSha: 'a'.repeat(40), baseBranch: 'main', originConversationId: 'c1', ...over,
})

describe('PR CI admission store', () => {
  it('[spec:mission-pr-ci-repair/offers-and-active-runs-are-unique-per-project-repository-and-pr] keeps one row per project, repository and PR number', () => {
    const first = upsertPrCiAdmission(db, target())
    expect(upsertPrCiAdmission(db, target()).id).toBe(first.id)
    expect(upsertPrCiAdmission(db, target({ repositoryId: 'r2' })).id).not.toBe(first.id)
    expect(upsertPrCiAdmission(db, target({ projectId: 'p2' })).id).not.toBe(first.id)
  })

  it('[spec:mission-pr-ci-repair/offers-and-active-runs-are-unique-per-project-repository-and-pr] never rewrites a started admission under its run', () => {
    const row = upsertPrCiAdmission(db, target())
    expect(claimPrCiAdmission(db, 'p1', row.id, 'run-1')).toBe(true)
    const again = upsertPrCiAdmission(db, target({ headBranch: 'other' }))
    expect(again).toMatchObject({ state: 'started', run_id: 'run-1', head_branch: 'fix' })
  })

  it('[spec:mission-pr-ci-repair/offers-and-active-runs-are-unique-per-project-repository-and-pr] lets exactly one claim win', () => {
    const row = upsertPrCiAdmission(db, target())
    expect([claimPrCiAdmission(db, 'p1', row.id, 'run-1'), claimPrCiAdmission(db, 'p1', row.id, 'run-2')]).toEqual([true, false])
    expect(getPrCiAdmissionByRun(db, 'p1', 'run-1')?.id).toBe(row.id)
  })

  it('[spec:mission-pr-ci-repair/offers-and-active-runs-are-unique-per-project-repository-and-pr] does not claim across projects', () => {
    const row = upsertPrCiAdmission(db, target())
    expect(claimPrCiAdmission(db, 'p2', row.id, 'run-1')).toBe(false)
  })

  it('[spec:mission-pr-ci-repair/offers-and-active-runs-are-unique-per-project-repository-and-pr] releases a failed claim with its reason and settles once', () => {
    const row = upsertPrCiAdmission(db, target())
    claimPrCiAdmission(db, 'p1', row.id, 'run-1')
    releasePrCiAdmission(db, row.id, 'worktree failed')
    expect(getPrCiAdmission(db, 'p1', row.id)).toMatchObject({ state: 'offered', run_id: null, reason: 'worktree failed' })
    claimPrCiAdmission(db, 'p1', row.id, 'run-2')
    expect(settlePrCiAdmission(db, row.id, { state: 'green', pushes: 1, rounds: 1 })).toBe(true)
    expect(settlePrCiAdmission(db, row.id, { state: 'needs-attention', reason: 'x', pushes: 0, rounds: 0 })).toBe(false)
    expect(getPrCiAdmission(db, 'p1', row.id)).toMatchObject({ state: 'green', pushes: 1 })
    expect(listStartedPrCiAdmissions(db, 'p1')).toEqual([])
  })

  it('[spec:mission-pr-ci-repair/start-requires-explicit-user-action] dismisses only an offered admission and re-offers it after a new prepare', () => {
    const row = upsertPrCiAdmission(db, target())
    expect(dismissPrCiAdmission(db, 'p1', row.id)).toBe(true)
    expect(dismissPrCiAdmission(db, 'p1', row.id)).toBe(false)
    expect(upsertPrCiAdmission(db, target()).state).toBe('offered')
  })
})
