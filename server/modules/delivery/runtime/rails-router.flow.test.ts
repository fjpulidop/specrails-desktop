import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter, FLOW_SPEC_LOOP_ID } from './rails-router'
import { setRailTickets } from './rails-store'
import { FlowHandOffNotReadyError, FlowWorktreeMismatchError, type FlowHandOffAuthority } from './flow-worktree-handoff'

const { mockRepoStatus, mockLaunchIsolated } = vi.hoisted(() => ({ mockRepoStatus: vi.fn(), mockLaunchIsolated: vi.fn() }))
vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({ loadCoreAgentRuntime: async () => ({ api: { capabilities: {} } }) }))
vi.mock('../../../worktree-manager', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  repoIsolationStatus: mockRepoStatus,
}))
vi.mock('./rail-isolated-launch', async (importActual) => ({
  ...(await (importActual as () => Promise<Record<string, unknown>>)()),
  launchIsolatedRail: mockLaunchIsolated,
}))

let db: DbInstance
let desktopDb: DbInstance
beforeEach(() => {
  db = initDb(':memory:')
  desktopDb = initDesktopDb(':memory:')
  mockRepoStatus.mockReset().mockResolvedValue('ok')
  mockLaunchIsolated.mockReset().mockResolvedValue(['flow-run'])
})
afterEach(() => { db.close(); desktopDb.close(); delete process.env.SPECRAILS_LOOPS_SECTION })

const required = {
  flowId: 'flow-1', ticketId: 7, conversationId: 'conv-1', branch: 'feat/7', worktreePath: '/wt/flow-1/ticket-7',
  headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), adopt: vi.fn(), release: vi.fn(),
}

function app(flowHandOff?: FlowHandOffAuthority) {
  const instance = express()
  instance.use(express.json())
  instance.use((req, _res, next) => {
    ;(req as unknown as { projectCtx: unknown }).projectCtx = {
      db, desktopDb, railJobs: new Map(), railLoopRuns: new Map(),
      project: { id: 'p1', slug: 's1', provider: 'claude', providers: ['claude'], path: '/repo' },
      broadcast: () => {}, loopRunManager: { run: vi.fn(), cancel: vi.fn() },
      getTicketSpec: (id: number) => ({ id, title: 'T', description: 'D' }),
      onLoopRunFinished: () => {},
      ...(flowHandOff ? { flowHandOff } : {}),
    }
    next()
  })
  instance.use('/rails', createRailsRouter())
  return instance
}

const authority = (resolve: FlowHandOffAuthority['resolve'] = () => required): FlowHandOffAuthority => ({ resolve })

describe('rails launch with flowId (Flow hand-off)', () => {
  it('passes the Flow worktree contract to the isolated launch', async () => {
    setRailTickets(db, 0, [7], 'implement')
    const res = await request(app(authority())).post('/rails/0/launch').send({ loopId: 'factory:implement', flowId: 'flow-1', originSurface: 'agent-chat', originConversationId: 'conv-1' })
    expect(res.status).toBe(202)
    expect(mockLaunchIsolated).toHaveBeenCalledWith(expect.objectContaining({ ticketIds: [7], requiredFlowWorktree: required, originConversationId: 'conv-1' }))
  })

  it('maps a worktree mismatch to 409 flow_worktree_mismatch', async () => {
    setRailTickets(db, 0, [7], 'implement')
    mockLaunchIsolated.mockRejectedValueOnce(new FlowWorktreeMismatchError('HEAD moved'))
    const res = await request(app(authority())).post('/rails/0/launch').send({ loopId: 'factory:implement', flowId: 'flow-1' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'flow_worktree_mismatch', detail: 'HEAD moved' })
  })

  it('refuses a Flow that is not waiting for this launch, or a rail with other specs', async () => {
    setRailTickets(db, 0, [7], 'implement')
    const notReady = await request(app(authority(() => { throw new FlowHandOffNotReadyError('not waiting') }))).post('/rails/0/launch').send({ flowId: 'flow-1' })
    expect(notReady.status).toBe(409)
    expect(notReady.body.error).toBe('flow_handoff_not_ready')
    setRailTickets(db, 0, [7, 8], 'implement')
    const mismatch = await request(app(authority())).post('/rails/0/launch').send({ loopId: 'factory:implement', flowId: 'flow-1' })
    expect(mismatch.status).toBe(409)
    expect(mismatch.body.error).toBe('flow_rail_mismatch')
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('requires worktree isolation and never falls back to the shared checkout', async () => {
    setRailTickets(db, 0, [7], 'implement')
    mockRepoStatus.mockResolvedValueOnce('no-git')
    const res = await request(app(authority())).post('/rails/0/launch').send({ loopId: 'factory:implement', flowId: 'flow-1' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('flow_requires_isolation')
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    const loopsOff = await request(app(authority())).post('/rails/0/launch').send({ flowId: 'flow-1' })
    expect(loopsOff.body.error).toBe('flow_requires_isolation')
    expect(mockLaunchIsolated).not.toHaveBeenCalled()
  })

  it('validates the flow id, incompatible options and projects without Flow', async () => {
    setRailTickets(db, 0, [7], 'implement')
    expect((await request(app(authority())).post('/rails/0/launch').send({ flowId: 'bad id' })).body.error).toBe('invalid_flow_id')
    expect((await request(app(authority())).post('/rails/0/launch').send({ flowId: 'flow-1', targetPrNumber: 4 })).body.error).toBe('flow_handoff_incompatible')
    expect((await request(app(authority())).post('/rails/0/launch').send({ flowId: 'flow-1', baseBranch: 'main' })).body.error).toBe('flow_handoff_incompatible')
    expect((await request(app()).post('/rails/0/launch').send({ flowId: 'flow-1' })).body.error).toBe('feature_unavailable')
  })

  it('only launches the Flow -> Spec loop from a hand-off', async () => {
    setRailTickets(db, 0, [7], 'implement')
    const res = await request(app()).post('/rails/0/launch').send({ loopId: FLOW_SPEC_LOOP_ID })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('flow_id_required')
  })
})
