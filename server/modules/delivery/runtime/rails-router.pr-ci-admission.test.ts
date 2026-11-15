// Mission-origin CI repair of a PR without a Specrails delivery: prepare from a
// mission, start from the card, settle, reload and refuse. GitHub, git and the
// loop engine are controlled doubles; the router, stores and settlement are real.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter } from './rails-router'
import { getPrCiAdmission } from './pr-ci/pr-ci-admission'
import { createPrDelivery } from './rail-pr-store'
import '../../../providers'

const SHA = 'a'.repeat(40)
const { capabilities, gh, ghCalls, materialize, host, hostRows, probe } = vi.hoisted(() => ({
  capabilities: { value: { engineV2: 1, workflowDefinitions: 1, hostTasks: 1 } as Record<string, number> },
  gh: { byUrl: new Map<string, { code: number; stdout: string; stderr: string }>() },
  ghCalls: [] as Array<{ cwd: string; url: string }>,
  materialize: vi.fn(),
  hostRows: new Map<string, Record<string, unknown>>(),
  host: { value: null as unknown },
  probe: vi.fn(),
}))
const remotes: Record<string, string> = { '/work/app': 'https://github.com/acme/app.git', '/work/api': 'git@github.com:acme/api.git' }
vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({ loadCoreAgentRuntime: async () => ({ api: { capabilities: capabilities.value } }) }))
vi.mock('../../loops/runtime/loop-definition-recovery', async importActual => ({ ...(await importActual<typeof import('../../loops/runtime/loop-definition-recovery')>()), probeDefinitionRun: probe }))
vi.mock('./isolated-worktree', async importActual => ({ ...(await importActual<typeof import('./isolated-worktree')>()), materializeIsolatedWorktree: materialize }))
vi.mock('../../../worktree-manager', async importActual => ({
  ...(await importActual<typeof import('../../../worktree-manager')>()), repoIsolationStatus: async () => 'ok',
  defaultGitRunner: { run: async (args: string[]) => ({ code: 0, stdout: args[0] === 'rev-parse' ? SHA : '', stderr: '' }) },
  removeWorktree: async () => {},
}))
vi.mock('./pr-publisher', async importActual => ({
  ...(await importActual<typeof import('./pr-publisher')>()),
  defaultExec: { run: async (cmd: string, args: string[], cwd: string) => {
    if (cmd === 'git') return { code: 0, stdout: remotes[cwd] ?? '', stderr: '' }
    ghCalls.push({ cwd, url: args[2] })
    return gh.byUrl.get(args[2]) ?? { code: 1, stdout: '', stderr: 'Could not resolve to a PullRequest' }
  } },
}))
vi.mock('../../missions/runtime/agent-chat-registry', async importActual => ({ ...(await importActual<typeof import('../../missions/runtime/agent-chat-registry')>()), getAgentChatManager: () => host.value }))

const API_PR = 'https://github.com/acme/api/pull/7'
const APP_PR = 'https://github.com/acme/app/pull/7'
const pr = (over: Record<string, unknown> = {}) => ({ code: 0, stderr: '', stdout: JSON.stringify({ state: 'OPEN', isDraft: false, headRefName: 'fix/ci', baseRefName: 'main', isCrossRepository: false, headRefOid: SHA, ...over }) })

let db: DbInstance, desktopDb: DbInstance
let run: ReturnType<typeof vi.fn>
let finishRun: (outcome: string) => void
function app() {
  const a = express(); a.use(express.json())
  const projectCtx = {
    db, desktopDb, railJobs: new Map(), railLoopRuns: new Map(),
    project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'], path: '/work/app', primaryRepositoryId: 'r-app', repositories: [
      { id: 'r-app', projectId: 'p1', name: 'app', path: '/work/app', isPrimary: true, kind: 'git', integrationBranch: null, addedAt: '' },
      { id: 'r-api', projectId: 'p1', name: 'api', path: '/work/api', isPrimary: false, kind: 'git', integrationBranch: null, addedAt: '' },
    ] },
    queueManager: { enqueue: vi.fn() }, loopRunManager: { run, cancel: vi.fn(), assertEngineSupport: vi.fn(async () => {}) },
    broadcast: () => {}, getTicketSpec: () => ({ title: 'T', description: 'D' }), onLoopRunFinished: vi.fn(),
    jiraSyncManager: { onRailLaunch: () => {} },
  }
  a.use((req, _res, next) => { (req as unknown as { projectCtx: unknown }).projectCtx = projectCtx; next() })
  a.use('/rails', createRailsRouter())
  return a
}
const prepare = (prUrl: string, origin: string | null = 'mission-1') => request(app()).post('/rails/pr-ci/admissions').send({ prUrl, ...(origin ? { originConversationId: origin } : {}) })
const settled = () => new Promise(resolve => setTimeout(resolve, 20))

beforeEach(() => {
  db = initDb(':memory:'); desktopDb = initDesktopDb(':memory:')
  capabilities.value = { engineV2: 1, workflowDefinitions: 1, hostTasks: 1 }
  gh.byUrl.clear(); gh.byUrl.set(API_PR, pr()); gh.byUrl.set(APP_PR, pr({ headRefName: 'other-branch' }))
  ghCalls.length = 0; hostRows.clear()
  host.value = {
    upsertSystemRow: (conversationId: string, row: Record<string, unknown>, key: string) => { hostRows.set(`${conversationId}|${key}`, row); return 'm1' },
    getSystemRow: (conversationId: string, key: string) => hostRows.get(`${conversationId}|${key}`) ?? null,
  }
  materialize.mockReset().mockImplementation(async (input: { worktreesRoot: string }) => ({ worktreePath: `${input.worktreesRoot}/ticket-0` }))
  probe.mockReset().mockResolvedValue({ completion: { ok: true, reasons: [] } })
  run = vi.fn(() => new Promise(resolve => { finishRun = outcome => resolve({ runId: run.mock.calls[0][0].runId, outcome, iterations: 1, totalCostUsd: null }) }))
})
afterEach(() => { vi.unstubAllEnvs(); db.close(); desktopDb.close() })

describe('prepare from a mission', () => {
  it('shows the card for a secondary repository PR, querying only that repository, and starts nothing', async () => {
    const res = await prepare(API_PR)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body).toMatchObject({ state: 'offered', repositoryId: 'r-api', prNumber: 7, headBranch: 'fix/ci', baseBranch: 'main' })
    expect(ghCalls).toEqual([{ cwd: '/work/api', url: API_PR }])
    expect(hostRows.size).toBe(1)
    expect([...hostRows.values()][0]).toMatchObject({ kind: 'pr-ci-offer', origin: 'mission', state: 'offered', repositoryId: 'r-api', repository: 'api' })
    expect(materialize).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS n FROM rail_pr_deliveries').get()).toEqual({ n: 0 })
  })

  it('keeps one admission and one card however often it is prepared', async () => {
    const first = await prepare(API_PR), second = await prepare(API_PR)
    expect(second.body.admissionId).toBe(first.body.admissionId)
    expect(hostRows.size).toBe(1)
  })

  it('keeps same-numbered PRs of two repositories apart', async () => {
    gh.byUrl.set(APP_PR, pr())
    const api = await prepare(API_PR), app = await prepare(APP_PR)
    expect(app.body.repositoryId).toBe('r-app')
    expect(app.body.admissionId).not.toBe(api.body.admissionId)
    expect(hostRows.size).toBe(2)
  })

  it.each([
    ['a repository outside the project', 'https://github.com/other/thing/pull/1', undefined, 409, 'pr_repository_not_in_project'],
    ['a closed PR', API_PR, pr({ state: 'CLOSED' }), 409, 'pr_not_open'],
    ['a merged PR', API_PR, pr({ state: 'MERGED' }), 409, 'pr_not_open'],
    ['a fork PR', API_PR, pr({ isCrossRepository: true }), 409, 'pr_fork_unsupported'],
    ['a GitHub authentication failure', API_PR, { code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials' }, 502, 'pr_github_unavailable'],
    ['a missing PR', API_PR, { code: 1, stdout: '', stderr: 'GraphQL: Could not resolve to a PullRequest' }, 404, 'target_pr_not_found'],
    ['unusable refs', API_PR, pr({ baseRefName: 'fix/ci' }), 409, 'target_pr_invalid'],
  ])('refuses %s with its own reason and shows no card', async (_label, url, response, status, code) => {
    if (response) gh.byUrl.set(url, response)
    const res = await prepare(url)
    expect(res.status).toBe(status)
    expect(res.body.error).toBe(code)
    expect(hostRows.size).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM pr_ci_admissions').get()).toEqual({ n: 0 })
  })

  it('refuses an invalid URL, a missing mission, a disabled flag and a Core without host tasks', async () => {
    expect((await prepare('12')).body.error).toBe('pr_url_invalid')
    expect((await prepare(API_PR, null)).body.error).toBe('origin_conversation_required')
    capabilities.value = { engineV2: 1, workflowDefinitions: 1 }
    expect((await prepare(API_PR)).body.error).toBe('engine_unsupported')
    vi.stubEnv('SPECRAILS_PR_CI_LOOP', 'false')
    expect((await prepare(API_PR)).status).toBe(403)
  })
})

describe('start from the card', () => {
  it('runs on the PR head in an isolated worktree, once, and keeps the result after the run settles and the mission reloads', async () => {
    const { body } = await prepare(API_PR)
    const [first, second] = await Promise.all([request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`), request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`)])
    expect([first.status, second.status].sort(), JSON.stringify([first.body, second.body])).toEqual([202, 409])
    expect(run).toHaveBeenCalledTimes(1)
    const input = run.mock.calls[0][0]
    expect(input).toMatchObject({ loopId: 'factory:pr-ci', projectId: 'p1', repositoryId: 'r-api', railIndex: null, ticketId: null })
    expect(materialize.mock.calls[0][0]).toMatchObject({ repoDir: '/work/api', branch: 'fix/ci', baseRef: 'refs/remotes/origin/fix/ci' })
    expect([...hostRows.values()][0]).toMatchObject({ state: 'started', runId: input.runId })
    // Accepting the start is not a finished repair.
    expect(getPrCiAdmission(db, 'p1', body.admissionId)?.state).toBe('started')

    finishRun('success')
    await settled()
    expect(getPrCiAdmission(db, 'p1', body.admissionId)).toMatchObject({ state: 'green', run_id: input.runId })
    expect([...hostRows.values()][0]).toMatchObject({ state: 'green', runId: input.runId })
    // A reload re-reads the persisted row: the same result, and preparing again does not undo it into a second run.
    const again = await prepare(API_PR)
    expect(again.body.admissionId).toBe(body.admissionId)
    expect(db.prepare('SELECT COUNT(*) AS n FROM pr_ci_admissions').get()).toEqual({ n: 1 })
  })

  it('stores a stop with its concrete reason', async () => {
    const { body } = await prepare(API_PR)
    await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`)
    probe.mockResolvedValue({ completion: { ok: false, reasons: ['Round budget exhausted'] } })
    finishRun('failed')
    await settled()
    expect(getPrCiAdmission(db, 'p1', body.admissionId)).toMatchObject({ state: 'needs-attention', reason: 'Round budget exhausted' })
  })

  it('refuses a PR changed since the offer without mounting or running anything', async () => {
    const { body } = await prepare(API_PR)
    gh.byUrl.set(API_PR, pr({ headRefName: 'someone-elses-branch' }))
    const res = await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('pr_changed')
    expect(materialize).not.toHaveBeenCalled()
    expect(run).not.toHaveBeenCalled()
  })

  it('releases the claim with the reason when the worktree cannot be mounted', async () => {
    const { body } = await prepare(API_PR)
    materialize.mockRejectedValueOnce(new Error('branch checked out elsewhere'))
    const res = await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`)
    expect(res.body).toMatchObject({ error: 'isolation_failed', detail: 'branch checked out elsewhere' })
    expect(run).not.toHaveBeenCalled()
    expect(getPrCiAdmission(db, 'p1', body.admissionId)).toMatchObject({ state: 'offered', run_id: null })
  })

  it('refuses while a delivery is building on the same PR', async () => {
    const { body } = await prepare(API_PR)
    const delivery = createPrDelivery(db, { railIndex: 0, railKey: 'r0', ticketIds: [1], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent-chat', originConversationId: 'c9', loopId: 'factory:implement' })
    db.prepare("UPDATE rail_pr_deliveries SET decision = 'building', pr_url = ? WHERE id = ?").run(API_PR, delivery.id)
    const blocked = await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`)
    expect(blocked.body.error).toBe('pr_ci_run_active')
    expect(run).not.toHaveBeenCalled()
  })

  it('blocks the delivery-backed start on the same PR while the mission-origin run is active', async () => {
    const { body } = await prepare(API_PR)
    await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`)
    const delivery = createPrDelivery(db, { railIndex: 0, railKey: 'r0', ticketIds: [7], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent-chat', originConversationId: 'conv-1', loopId: 'factory:implement' })
    db.prepare("UPDATE rail_pr_deliveries SET decision = 'pr_draft', pr_url = ?, pr_number = 7, branch = 'fix/ci', pr_state = 'pr-created', delivery_sha = ?, implementation_outcome = 'succeeded', delivery_outcome = 'ready' WHERE id = ?").run(API_PR, SHA, delivery.id)
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: delivery.id })
    expect(res.status, JSON.stringify(res.body)).toBe(409)
    expect(res.body).toMatchObject({ error: 'pr_ci_run_active', runId: run.mock.calls[0][0].runId })
  })

  it('honours the flag and the Core capability at start', async () => {
    const { body } = await prepare(API_PR)
    capabilities.value = { engineV2: 1, workflowDefinitions: 1 }
    expect((await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`)).body.error).toBe('engine_unsupported')
    vi.stubEnv('SPECRAILS_PR_CI_LOOP', 'false')
    expect((await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/start`)).status).toBe(403)
    expect((await request(app()).post('/rails/pr-ci/admissions/bad%20id/start')).status).toBe(400)
  })

  it('dismisses an offer once', async () => {
    const { body } = await prepare(API_PR)
    expect((await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/dismiss`)).body).toMatchObject({ state: 'dismissed' })
    expect((await request(app()).post(`/rails/pr-ci/admissions/${body.admissionId}/dismiss`)).status).toBe(409)
  })
})
