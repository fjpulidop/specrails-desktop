// pr-ci-loop: `POST /rails/:railIndex/pr-ci` admission. The isolated launch
// itself is replaced: these cases prove the route's guards and that it reuses
// the ordinary continuation contract with the delivery's frozen launch choices.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter } from './rails-router'
import { getRail, setRailTickets } from './rails-store'
import { createPrDelivery, getPrDelivery } from './rail-pr-store'
import '../../../providers'

const { capabilities, lifecycle, launch } = vi.hoisted(() => ({
  capabilities: { value: { engineV2: 1, workflowDefinitions: 1, hostTasks: 1 } as Record<string, number> },
  lifecycle: vi.fn(),
  launch: vi.fn(),
}))
vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({ loadCoreAgentRuntime: async () => ({ api: { capabilities: capabilities.value } }) }))
vi.mock('./pr-lifecycle', async importActual => ({ ...(await importActual<typeof import('./pr-lifecycle')>()), observePrLifecycle: lifecycle }))
vi.mock('../../../worktree-manager', async importActual => ({ ...(await importActual<typeof import('../../../worktree-manager')>()), repoIsolationStatus: async () => 'ok' }))
vi.mock('./rail-isolated-launch', async importActual => ({ ...(await importActual<typeof import('./rail-isolated-launch')>()), launchIsolatedRail: launch }))

let db: DbInstance, desktopDb: DbInstance
function app() {
  const a = express(); a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as unknown as { projectCtx: unknown }).projectCtx = {
      db, desktopDb, railJobs: new Map(), railLoopRuns: new Map(),
      project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'], path: '/repo' },
      queueManager: { enqueue: vi.fn() }, loopRunManager: { run: vi.fn(), cancel: vi.fn(), assertEngineSupport: vi.fn(async () => {}) },
      broadcast: () => {}, getTicketSpec: () => ({ title: 'T', description: 'D' }), onLoopRunFinished: () => {},
      jiraSyncManager: { onRailLaunch: () => {} },
    }
    next()
  })
  a.use('/rails', createRailsRouter())
  return a
}
function draft(over: Record<string, unknown> = {}): string {
  const row = createPrDelivery(db, { railIndex: 0, railKey: 'r0', ticketIds: [7], baseBranch: 'main', loopName: 'Implement', loopId: 'factory:implement', originSurface: 'agent-chat', originConversationId: 'conv-1',
    launchConfig: { mode: 'implement', loopId: 'factory:implement', aiEngine: 'claude', model: 'sonnet', reasoning_effort: 'high', profileName: null } })
  const set = { decision: 'pr_draft', pr_url: 'https://github.com/acme/app/pull/7', pr_number: 7, branch: 'feat/7', pr_state: 'pr-created', delivery_sha: 'a'.repeat(40), implementation_outcome: 'succeeded', delivery_outcome: 'ready', ...over }
  db.prepare(`UPDATE rail_pr_deliveries SET ${Object.keys(set).map(key => `${key} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), row.id)
  return row.id
}
const open = { ok: true, state: 'OPEN', isDraft: true, headRefName: 'feat/7', baseRefName: 'main', isCrossRepository: false, headRefOid: 'a'.repeat(40), mergeCommitOid: null, commitOids: [], includesExpectedSha: null }

beforeEach(() => {
  db = initDb(':memory:'); desktopDb = initDesktopDb(':memory:')
  setRailTickets(db, 0, [7], 'implement')
  capabilities.value = { engineV2: 1, workflowDefinitions: 1, hostTasks: 1 }
  lifecycle.mockReset().mockResolvedValue(open)
  launch.mockReset().mockResolvedValue(['run-ci'])
})
afterEach(() => { vi.unstubAllEnvs(); db.close(); desktopDb.close() })

describe('POST /rails/:railIndex/pr-ci', () => {
  it('launches factory:pr-ci as a continuation of the PR with the frozen engine choices', async () => {
    const id = draft()
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: id })
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(res.body).toMatchObject({ loopId: 'factory:pr-ci', mode: 'loop', isolated: true })
    const input = launch.mock.calls[0][0] as Record<string, any>
    expect(input).toMatchObject({ loopId: 'factory:pr-ci', provider: 'claude', model: 'sonnet', effort: 'high', originConversationId: 'conv-1', originSurface: 'agent-chat',
      requiredPrContinuation: { deliveryId: id, decision: 'pr_draft', branch: 'feat/7', baseBranch: 'main', prUrl: 'https://github.com/acme/app/pull/7', prNumber: 7, deliverySha: 'a'.repeat(40) } })
    expect(input.loopGraph.nodes.some((node: { data?: { kind?: string } }) => ['approval', 'question', 'gate'].includes(String(node.data?.kind)))).toBe(false)
    expect(input).not.toHaveProperty('followUp')
  })

  it('runs on the delivery\'s specs when the rail was released after the PR', async () => {
    const id = draft()
    setRailTickets(db, 0, [], 'implement')
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: id })
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect((launch.mock.calls[0][0] as Record<string, unknown>).ticketIds).toEqual([7])
    expect(getRail(db, 0).ticketIds).toEqual([7])
  })

  it('answers 403 when the feature flag is off', async () => {
    vi.stubEnv('SPECRAILS_PR_CI_LOOP', 'false')
    expect((await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: draft() })).status).toBe(403)
    expect(launch).not.toHaveBeenCalled()
  })

  it('is hidden behind the Core capability', async () => {
    capabilities.value = { engineV2: 1, workflowDefinitions: 1 }
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: draft() })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('engine_unsupported')
  })

  it('refuses the loop through the generic launch door', async () => {
    const res = await request(app()).post('/rails/0/launch').send({ mode: 'loop', loopId: 'factory:pr-ci' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('pr_ci_requires_delivery')
  })

  it.each([
    ['an unknown delivery', () => 'missing', 404, 'pr_delivery_not_found'],
    ['a delivery without a PR', () => draft({ decision: 'on_review', pr_url: null, pr_state: 'none' }), 409, 'pr_ci_not_allowed'],
    ['an operation in flight', () => draft({ operation: 'publish', operation_token: 't', operation_started_at_ms: 1 }), 409, 'pr_operation_in_progress'],
  ])('refuses %s', async (_label, make, status, error) => {
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: make() })
    expect(res.status).toBe(status)
    expect(res.body.error).toBe(error)
    expect(launch).not.toHaveBeenCalled()
  })

  it.each([
    ['a fork PR', { ...open, isCrossRepository: true }, 'pr_fork_unsupported'],
    ['a merged PR', { ...open, state: 'MERGED' }, 'pr_not_open'],
    ['an unverifiable PR', { ok: false, detail: 'gh: not logged in' }, 'pr_unverifiable'],
  ])('checks GitHub and refuses %s', async (_label, observed, error) => {
    lifecycle.mockResolvedValue(observed)
    const id = draft()
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: id })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(error)
    expect(getPrDelivery(db, id)?.decision).toBe('pr_draft')
  })

  it('validates the body', async () => {
    expect((await request(app()).post('/rails/0/pr-ci').send({})).status).toBe(400)
    expect((await request(app()).post('/rails/99/pr-ci').send({ prDeliveryId: 'x' })).status).toBe(400)
  })
})

describe('POST /rails/:railIndex/relaunch on a CI loop generation', () => {
  const failedCi = () => draft({ loop_id: 'factory:pr-ci', decision: 'implementation_failed', implementation_outcome: 'failed', delivery_outcome: 'blocked', delivery_sha: null,
    status_code: 'implementation_failed', status_detail: null })

  it('re-attaches the failed generation to its open PR and watches the CI again', async () => {
    const id = failedCi()
    const res = await request(app()).post('/rails/0/relaunch').send({ sourceId: id, originConversationId: 'conv-1', originSurface: 'agent-chat' })
    expect(res.status, JSON.stringify(res.body)).toBe(202)
    expect(getPrDelivery(db, id)).toMatchObject({ decision: 'pr_draft', implementation_outcome: 'succeeded', status_code: 'ci_needs_attention', delivery_sha: 'a'.repeat(40) })
    expect(launch.mock.calls[0][0]).toMatchObject({ loopId: 'factory:pr-ci',
      requiredPrContinuation: { deliveryId: id, decision: 'pr_draft', prUrl: 'https://github.com/acme/app/pull/7', deliverySha: 'a'.repeat(40) } })
  })

  it('refuses, without touching the generation, when its PR is no longer open', async () => {
    lifecycle.mockResolvedValue({ ...open, state: 'CLOSED' })
    const id = failedCi()
    const res = await request(app()).post('/rails/0/relaunch').send({ sourceId: id })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('pr_ci_relaunch_unavailable')
    expect(getPrDelivery(db, id)?.decision).toBe('implementation_failed')
    expect(launch).not.toHaveBeenCalled()
  })
})

describe('GET /rails/pr-ci-availability', () => {
  it('reports the capability and the flag', async () => {
    expect((await request(app()).get('/rails/pr-ci-availability')).body).toEqual({ available: true })
    capabilities.value = { engineV2: 1, workflowDefinitions: 1 }
    expect((await request(app()).get('/rails/pr-ci-availability')).body).toEqual({ available: false })
    capabilities.value = { engineV2: 1, workflowDefinitions: 1, hostTasks: 1 }
    vi.stubEnv('SPECRAILS_PR_CI_LOOP', 'false')
    expect((await request(app()).get('/rails/pr-ci-availability')).body).toEqual({ available: false })
  })
})

describe('POST /rails/pr-ci-offer/dismiss', () => {
  it('answers 409 when nothing was offered and 404 for an unknown delivery', async () => {
    expect((await request(app()).post('/rails/pr-ci-offer/dismiss').send({ prDeliveryId: draft() })).status).toBe(409)
    expect((await request(app()).post('/rails/pr-ci-offer/dismiss').send({ prDeliveryId: 'missing' })).status).toBe(404)
  })
})

describe('POST /rails/:railIndex/pr-ci on a multi-repository delivery', () => {
  function multiDraft(children: Array<Record<string, unknown>>): string {
    const parent = draft({ pr_url: null, pr_number: null, branch: null, pr_state: 'none', execution_manifest: JSON.stringify({ version: 1, selectedRepositoryIds: ['a', 'b'], repositories: [] }) })
    children.forEach((over, index) => {
      const child = createPrDelivery(db, { railIndex: 20 + index, railKey: `c${index}`, ticketIds: [7], baseBranch: 'main', loopName: 'Implement', originSurface: 'agent-chat', loopId: 'factory:implement', parentDeliveryId: parent, repositoryId: ['a', 'b'][index], repositoryPath: `/repos/${['app', 'lib'][index]}` })
      const set = { decision: 'pr_draft', pr_url: `https://github.com/acme/${['app', 'lib'][index]}/pull/${index + 1}`, pr_number: index + 1, branch: `feat/${index}`, delivery_sha: 'a'.repeat(40), pr_state: 'pr-created', ...over }
      db.prepare(`UPDATE rail_pr_deliveries SET ${Object.keys(set).map(key => `${key} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(set), child.id)
    })
    return parent
  }

  it('checks every repository PR on GitHub, in its own repository', async () => {
    const id = multiDraft([{}, {}])
    lifecycle.mockImplementation(async (_exec: unknown, _cwd: string, prUrl: string) => prUrl.includes('/lib/') ? { ...open, state: 'CLOSED' } : open)
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: id })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ error: 'pr_not_open', prUrl: 'https://github.com/acme/lib/pull/2' })
    expect(lifecycle.mock.calls.map(call => [call[1], call[2]])).toEqual([['/repos/app', 'https://github.com/acme/app/pull/1'], ['/repos/lib', 'https://github.com/acme/lib/pull/2']])
    expect(launch).not.toHaveBeenCalled()
  })

  it.each([
    ['a repository under review without its PR', [{}, { pr_url: null }], 'pr_ci_not_allowed'],
    ['a repository with an operation in flight', [{ operation: 'publish', operation_token: 't', operation_started_at_ms: 1 }, {}], 'pr_operation_in_progress'],
  ])('refuses %s', async (_label, children, error) => {
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: multiDraft(children) })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe(error)
    expect(lifecycle).not.toHaveBeenCalled()
  })

  it('admits it when every PR under review is open, ignoring merged repositories', async () => {
    const id = multiDraft([{}, { decision: 'merged' }])
    const res = await request(app()).post('/rails/0/pr-ci').send({ prDeliveryId: id })
    expect(lifecycle).toHaveBeenCalledTimes(1)
    expect(res.body.error).not.toBe('pr_ci_not_allowed')
  })
})
