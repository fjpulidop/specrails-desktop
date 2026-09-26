import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { registerLoopsRoutes } from './loops-router'
import type { LoopGraph } from './loop-graph'

const runtime = vi.hoisted(() => ({
  api: { capabilities: { engineV2: 1, workflowDefinitions: 1 } },
  listWorkflows: vi.fn(),
  validateWorkflowDefinition: vi.fn(),
}))
vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({
  loadCoreAgentRuntime: async () => runtime,
}))
let db: DbInstance
function graph(): LoopGraph {
  return {
    nodes: [
      { id: 'start', type: 'start', position: { x: 0, y: 0 } },
      {
        id: 'finish',
        type: 'core',
        position: { x: 0, y: 100 },
        data: { kind: 'end', params: { outcome: 'success' } },
      },
    ],
    edges: [{ id: 'enter', source: 'start', target: 'finish' }],
    config: { maxIterations: 1, timeoutMinutes: 0 },
  }
}
beforeEach(() => {
  db = initDesktopDb(':memory:')
  runtime.api.capabilities = { engineV2: 1, workflowDefinitions: 1 }
  runtime.listWorkflows.mockReset()
  runtime.validateWorkflowDefinition.mockReset()
  delete process.env.SPECRAILS_LOOPS_SECTION
})
afterEach(() => db.close())
function api() {
  const instance = express()
  instance.use(express.json())
  const router = express.Router()
  registerLoopsRoutes(router, { db })
  instance.use('/api', router)
  return request(instance)
}
async function draft() {
  return (await api().post('/api/loops').send({ name: 'Definition', graph: graph() })).body.loop.id as string
}

describe('Core definition publication', () => {
  it('serves Core catalog before the loop-id route and gates unavailable engines', async () => {
    const catalog = {
      type: 'runtime-workflows',
      definitionSchema: { properties: { schemaVersion: { const: 1 } } },
      nodeKindsVersion: 1,
      nodeKinds: [],
      builtins: [],
    }
    runtime.listWorkflows.mockReturnValue(catalog)
    expect((await api().get('/api/loops/catalog')).body).toMatchObject({
      ...catalog,
      definitionSchema: { properties: { schemaVersion: { const: 1 } } },
    })
    runtime.api.capabilities.engineV2 = 0
    expect((await api().get('/api/loops/catalog')).status).toBe(409)
  })
  it('validates a raw structural draft through Core before publishing', async () => {
    runtime.validateWorkflowDefinition.mockReturnValue({
      ok: true,
      version: 'a'.repeat(64),
      definition: {},
      graph: { nodes: [], edges: [] },
    })
    const response = await api().post(`/api/loops/${await draft()}/publish`)
    expect(response.status).toBe(200)
    expect(response.body.loop.status).toBe('published')
    expect(runtime.validateWorkflowDefinition).toHaveBeenCalledWith(
      expect.objectContaining({ schemaVersion: 1, entry: 'finish' }),
      { structural: true },
    )
    expect(runtime.validateWorkflowDefinition.mock.calls[0][0]).not.toHaveProperty('version')
  })
  it('retains the draft and returns node-specific Core diagnostics', async () => {
    runtime.validateWorkflowDefinition.mockReturnValue({
      ok: false,
      errors: [
        { code: 'piece_params_invalid', path: '/nodes/finish/params/outcome', message: 'Invalid outcome' },
      ],
    })
    const id = await draft(),
      response = await api().post(`/api/loops/${id}/publish`)
    expect(response.status).toBe(400)
    expect(response.body.errors[0]).toMatchObject({ nodeId: 'finish', message: 'Invalid outcome' })
    expect((await api().get(`/api/loops/${id}`)).body.loop.status).toBe('draft')
  })
  it('never publishes a definition using an unsupported engine', async () => {
    runtime.api.capabilities.engineV2 = 0
    const response = await api().post(`/api/loops/${await draft()}/publish`)
    expect(response.status).toBe(409)
    expect(runtime.validateWorkflowDefinition).not.toHaveBeenCalled()
  })
  it('keeps legacy publication independent of Core capabilities', async () => {
    runtime.api.capabilities.engineV2 = 0
    const legacy = graph()
    legacy.nodes[1] = { ...legacy.nodes[1], type: 'end', data: { outcome: 'success' } }
    const id = (await api().post('/api/loops').send({ name: 'Legacy', graph: legacy })).body.loop.id
    expect((await api().post(`/api/loops/${id}/publish`)).status).toBe(200)
    expect(runtime.validateWorkflowDefinition).not.toHaveBeenCalled()
  })
})
