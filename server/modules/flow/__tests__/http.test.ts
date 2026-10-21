import { afterEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import {
  FlowConflictError,
  FlowLaunchRejectedError,
  FlowNotFoundError,
  FlowTransitionError,
  FlowUnavailableError,
  FlowValidationError,
  type FlowService,
} from '..'
import { registerFlowHttp } from '../adapters/http'

afterEach(() => vi.restoreAllMocks())

const FLOW = { id: 'flow-1', conversationId: 'conv-1', state: 'active' }

function service(overrides: Partial<Record<keyof FlowService, unknown>> = {}): FlowService {
  return {
    startFlow: vi.fn(async () => FLOW),
    pauseFlow: vi.fn(async () => ({ ...FLOW, state: 'paused' })),
    resumeFlow: vi.fn(async () => FLOW),
    discardFlow: vi.fn(async () => ({ ...FLOW, state: 'discarded' })),
    handOffFlow: vi.fn(async () => ({ flow: { ...FLOW, state: 'handed_off' }, loopRunIds: ['run-1'], deliveryId: 'd-1' })),
    onFlowDelivered: vi.fn(),
    reconcile: vi.fn(),
    getFlow: vi.fn(() => FLOW),
    getByConversation: vi.fn(() => FLOW),
    diffSummary: vi.fn(async () => ({ branch: 'b', baseSha: null, headSha: null, files: [], totals: { files: 0, additions: 0, deletions: 0 } })),
    costSoFar: vi.fn(() => ({ flowId: 'flow-1', costUsd: 0.5, turns: 2, unpricedTurns: 0, tokensIn: 10, tokensOut: 5 })),
    availability: vi.fn(async () => ({ available: true, reason: 'ok', missing: [] })),
    ...overrides,
  } as unknown as FlowService
}

function app(target: FlowService | undefined) {
  const instance = express()
  instance.use(express.json())
  registerFlowHttp(instance as unknown as express.Router, () => target)
  return instance
}

describe('Flow HTTP routes', () => {
  it('serves the lifecycle routes with thin translation', async () => {
    const flows = service()
    const server = app(flows)
    expect((await request(server).get('/p1/flow/availability')).body).toEqual({ available: true, reason: 'ok', missing: [] })
    const started = await request(server).post('/p1/flow').send({ conversationId: 'conv-1', idea: 'Try it', title: ' T ', flowId: 'client-id' })
    expect(started.status).toBe(201)
    expect(flows.startFlow).toHaveBeenCalledWith({ conversationId: 'conv-1', idea: 'Try it', title: 'T', flowId: 'client-id' })
    expect((await request(server).get('/p1/flow/by-conversation/conv-1')).body).toEqual({ flow: FLOW })
    expect((await request(server).get('/p1/flow/flow-1')).body).toEqual({ flow: FLOW })
    expect((await request(server).post('/p1/flow/flow-1/pause')).body.flow.state).toBe('paused')
    expect((await request(server).post('/p1/flow/flow-1/resume')).body.flow.state).toBe('active')
    expect((await request(server).post('/p1/flow/flow-1/discard')).body.flow.state).toBe('discarded')
    const handOff = await request(server).post('/p1/flow/flow-1/hand-off').send({ railIndex: 2, loopId: 'factory:flow-spec', reasoning_effort: 'high' })
    expect(handOff.status).toBe(202)
    expect(handOff.body).toMatchObject({ loopRunIds: ['run-1'], deliveryId: 'd-1' })
    expect(flows.handOffFlow).toHaveBeenCalledWith({ flowId: 'flow-1', railIndex: 2, options: { loopId: 'factory:flow-spec', aiEngine: undefined, model: undefined, reasoningEffort: 'high' } })
    expect((await request(server).get('/p1/flow/flow-1/diff')).body.totals).toEqual({ files: 0, additions: 0, deletions: 0 })
    expect((await request(server).get('/p1/flow/flow-1/cost')).body).toMatchObject({ costUsd: 0.5, unpricedTurns: 0 })
  })

  it('validates identifiers and the rail index', async () => {
    const server = app(service())
    expect((await request(server).get('/p1/flow/bad%20id')).status).toBe(400)
    expect((await request(server).post('/p1/flow/flow-1/hand-off').send({ railIndex: '2' })).body).toMatchObject({ error: 'invalid_rail_index' })
    expect((await request(server).post('/p1/flow/flow-1/hand-off').send({ railIndex: 1, loopId: 5 })).body).toMatchObject({ error: 'invalid_loopId' })
  })

  it.each([
    [new FlowValidationError('idea_required', 'Describe it'), 400, 'idea_required'],
    [new FlowNotFoundError('flow-1'), 404, 'flow_not_found'],
    [new FlowUnavailableError('needs flowSessions', ['flowSessions']), 409, 'feature_unavailable'],
    [new FlowConflictError('flow_already_open', 'open', 'flow-9'), 409, 'flow_already_open'],
    [new FlowTransitionError('illegal_transition', 'no'), 409, 'illegal_transition'],
    [new FlowLaunchRejectedError(409, 'pr_decision_pending', 'pending'), 409, 'pr_decision_pending'],
    [new FlowLaunchRejectedError(500, 'boom', 'internal'), 502, 'boom'],
    [new Error('private detail'), 500, 'flow_failed'],
  ])('maps %s to HTTP', async (error, status, code) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = app(service({ startFlow: vi.fn(async () => { throw error }) }))
    const response = await request(server).post('/p1/flow').send({ conversationId: 'c', idea: 'x' })
    expect(response.status).toBe(status)
    expect(response.body.error).toBe(code)
    if (error instanceof FlowUnavailableError) expect(response.body.missing).toEqual(['flowSessions'])
    if (error instanceof FlowConflictError) expect(response.body.flowId).toBe('flow-9')
  })

  it('answers feature_unavailable when the project has no Flow service', async () => {
    const response = await request(app(undefined)).get('/p1/flow/availability')
    expect(response.status).toBe(409)
    expect(response.body.error).toBe('feature_unavailable')
  })
})
