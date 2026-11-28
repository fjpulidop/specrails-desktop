import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../../db'
import type { RepositoryProject } from '../../../../project-repositories'
import type { Exec, ExecResult } from '../pr-publisher'
import { createPrDelivery } from '../rail-pr-store'
import { getPrCiAdmission, upsertPrCiAdmission, type PrCiAdmissionRow } from './pr-ci-admission'
import { dismissPrCiAdmissionOffer, startPrCiAdmission, type PrCiStartDeps } from './pr-ci-admission-start'

const SHA = 'b'.repeat(40)
const PR_URL = 'https://github.com/acme/api/pull/7'
const project: RepositoryProject = {
  id: 'p1', path: '/work/app', primaryRepositoryId: 'r-app',
  repositories: [
    { id: 'r-app', projectId: 'p1', name: 'app', path: '/work/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' },
    { id: 'r-api', projectId: 'p1', name: 'api', path: '/work/api', isPrimary: false, kind: 'git', integrationBranch: null, addedAt: '' },
  ],
}
const remotes: Record<string, string> = { '/work/app': 'https://github.com/acme/app.git', '/work/api': 'https://github.com/acme/api.git' }
const view = (over: Record<string, unknown> = {}): ExecResult => ({ code: 0, stderr: '', stdout: JSON.stringify({ state: 'OPEN', isDraft: false, headRefName: 'fix/ci', baseRefName: 'main', isCrossRepository: false, headRefOid: SHA, ...over }) })

let db: DbInstance
let gh: ExecResult
let events: string[]
let announced: PrCiAdmissionRow[]
let prepareFails: string | null
beforeEach(() => { db = initDb(':memory:'); gh = view(); events = []; announced = []; prepareFails = null })
afterEach(() => db.close())

function deps(over: Partial<PrCiStartDeps> = {}): PrCiStartDeps {
  const exec: Exec = { run: async (cmd, args, cwd) => cmd === 'git' ? { code: 0, stdout: remotes[cwd] ?? '', stderr: '' } : args[0] === 'api' ? { code: 0, stdout: 'true\n', stderr: '' } : gh }
  let runs = 0
  return {
    db, project, exec,
    withRepositoryLock: async (_dir, fn) => fn(),
    newRunId: () => `run-${++runs}`,
    prepareWorktree: async (_admission, headSha, runId) => {
      events.push(`worktree:${runId}:${headSha}`)
      await Promise.resolve()
      if (prepareFails) throw new Error(prepareFails)
      return { worktreePath: `/wt/${runId}` }
    },
    launch: (_admission, worktreePath, runId) => { events.push(`launch:${runId}:${worktreePath}`) },
    announce: admission => { announced.push(admission) },
    ...over,
  }
}
const offer = (over: Record<string, unknown> = {}) => upsertPrCiAdmission(db, { projectId: 'p1', repositoryId: 'r-api', repositoryPath: '/work/api', prNumber: 7, prUrl: PR_URL,
  headBranch: 'fix/ci', headSha: SHA, baseBranch: 'main', originConversationId: 'c1', ...over })

describe('startPrCiAdmission', () => {
  it('[spec:mission-pr-ci-repair/repair-runs-on-the-same-pr-with-unchanged-guarantees] [spec:mission-pr-ci-repair/start-requires-explicit-user-action] mounts the PR head, launches once and reports started, not repaired', async () => {
    const row = offer()
    const result = await startPrCiAdmission(deps(), row.id)
    expect(result).toMatchObject({ ok: true, runId: 'run-1' })
    expect(events).toEqual([`worktree:run-1:${SHA}`, 'launch:run-1:/wt/run-1'])
    expect(getPrCiAdmission(db, 'p1', row.id)).toMatchObject({ state: 'started', run_id: 'run-1', worktree_path: '/wt/run-1', head_branch: 'fix/ci', base_branch: 'main' })
    expect(announced.at(-1)?.state).toBe('started')
  })

  it('[spec:mission-pr-ci-repair/offers-and-active-runs-are-unique-per-project-repository-and-pr] runs a double start exactly once and reports the running run to the second caller', async () => {
    const row = offer()
    const [first, second] = await Promise.all([startPrCiAdmission(deps(), row.id), startPrCiAdmission(deps(), row.id)])
    expect([first.ok, second.ok].sort()).toEqual([false, true])
    expect(events.filter(event => event.startsWith('launch'))).toHaveLength(1)
    const loser = [first, second].find(result => !result.ok)!
    expect(loser).toMatchObject({ ok: false, status: 409, error: 'pr_ci_already_running', runId: 'run-1' })
  })

  it('[spec:mission-pr-ci-repair/offers-and-active-runs-are-unique-per-project-repository-and-pr] serializes concurrent starts through the repository lock and the atomic claim', async () => {
    const row = offer()
    let chain: Promise<unknown> = Promise.resolve()
    const lock: PrCiStartDeps['withRepositoryLock'] = (_dir, fn) => { const next = chain.then(fn); chain = next.catch(() => undefined); return next }
    const results = await Promise.all([startPrCiAdmission(deps({ withRepositoryLock: lock }), row.id), startPrCiAdmission(deps({ withRepositoryLock: lock }), row.id)])
    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(events.filter(event => event.startsWith('worktree'))).toHaveLength(1)
  })

  it('[spec:mission-pr-ci-repair/offers-and-active-runs-are-unique-per-project-repository-and-pr] refuses while a delivery-backed run is building on the same PR', async () => {
    const row = offer()
    const delivery = createPrDelivery(db, { railIndex: 0, railKey: 'r0', ticketIds: [1], baseBranch: 'main', loopName: 'Fix PR CI', originSurface: 'agent-chat', originConversationId: 'c9', loopId: 'factory:pr-ci' })
    db.prepare("UPDATE rail_pr_deliveries SET decision = 'building', pr_url = ? WHERE id = ?").run(PR_URL, delivery.id)
    const result = await startPrCiAdmission(deps(), row.id)
    expect(result).toMatchObject({ ok: false, status: 409, error: 'pr_ci_run_active' })
    expect(events).toEqual([])
    expect(getPrCiAdmission(db, 'p1', row.id)?.state).toBe('offered')
  })

  it.each([
    ['head branch', { headRefName: 'other' }],
    ['base branch', { baseRefName: 'develop' }],
  ])('[spec:mission-pr-ci-repair/start-requires-explicit-user-action] [spec:mission-pr-ci-repair/repair-runs-on-the-same-pr-with-unchanged-guarantees] refuses without mounting or pushing when the %s changed after the offer', async (_label, change) => {
    const row = offer()
    gh = view(change)
    expect(await startPrCiAdmission(deps(), row.id)).toMatchObject({ ok: false, error: 'pr_changed' })
    expect(events).toEqual([])
    expect(getPrCiAdmission(db, 'p1', row.id)).toMatchObject({ state: 'offered', run_id: null })
  })

  it.each([
    ['a closed PR', { state: 'CLOSED' }, 'pr_not_open'],
    ['a merged PR', { state: 'MERGED' }, 'pr_not_open'],
    ['a fork PR', { isCrossRepository: true }, 'pr_fork_unsupported'],
  ])('[spec:mission-pr-ci-repair/pr-validation-reports-a-specific-reason-before-any-agent-starts] [spec:mission-pr-ci-repair/fork-prs-are-rejected-with-the-concrete-limitation] refuses %s before any agent starts', async (_label, change, code) => {
    const row = offer()
    gh = view(change)
    expect(await startPrCiAdmission(deps(), row.id)).toMatchObject({ ok: false, error: code })
    expect(events).toEqual([])
  })

  it('[spec:mission-pr-ci-repair/pr-validation-reports-a-specific-reason-before-any-agent-starts] reports an authentication failure instead of a missing PR', async () => {
    const row = offer()
    gh = { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' }
    expect(await startPrCiAdmission(deps(), row.id)).toMatchObject({ ok: false, status: 502, error: 'pr_github_unavailable' })
  })

  it('[spec:mission-pr-ci-repair/repair-runs-on-the-same-pr-with-unchanged-guarantees] releases the claim with the stated reason when the worktree cannot be prepared', async () => {
    const row = offer()
    prepareFails = 'the PR branch is checked out elsewhere'
    expect(await startPrCiAdmission(deps(), row.id)).toMatchObject({ ok: false, error: 'isolation_failed' })
    expect(getPrCiAdmission(db, 'p1', row.id)).toMatchObject({ state: 'offered', run_id: null, worktree_path: null })
    expect(getPrCiAdmission(db, 'p1', row.id)?.reason).toContain('checked out elsewhere')
    expect(events.some(event => event.startsWith('launch'))).toBe(false)
    prepareFails = null
    expect(await startPrCiAdmission(deps(), row.id)).toMatchObject({ ok: true })
  })

  it('[spec:mission-pr-ci-repair/start-requires-explicit-user-action] does not start another project\'s or a missing admission', async () => {
    const row = offer()
    expect(await startPrCiAdmission(deps({ project: { ...project, id: 'p2' } }), row.id)).toMatchObject({ ok: false, status: 404 })
    expect(await startPrCiAdmission(deps(), 'missing')).toMatchObject({ ok: false, status: 404 })
  })

  it('[spec:mission-pr-ci-repair/start-requires-explicit-user-action] never starts a dismissed offer', async () => {
    const row = offer()
    expect(dismissPrCiAdmissionOffer(deps(), row.id)).toMatchObject({ ok: true })
    expect(await startPrCiAdmission(deps(), row.id)).toMatchObject({ ok: false, error: 'pr_ci_offer_dismissed' })
  })
})

describe('dismissPrCiAdmissionOffer', () => {
  it('[spec:mission-pr-ci-repair/start-requires-explicit-user-action] dismisses once and shows it on the card', () => {
    const row = offer()
    expect(dismissPrCiAdmissionOffer(deps(), row.id)).toMatchObject({ ok: true })
    expect(announced.at(-1)?.state).toBe('dismissed')
    expect(dismissPrCiAdmissionOffer(deps(), row.id)).toMatchObject({ ok: false, status: 409 })
  })
})
