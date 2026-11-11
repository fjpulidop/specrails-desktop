// pr-ci-loop: `POST /rails/:railIndex/pr-ci` admission. The isolated launch
// itself is replaced: these cases prove the route's guards and that it reuses
// the ordinary continuation contract with the delivery's frozen launch choices.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter } from './rails-router'
import { setRailTickets } from './rails-store'
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
