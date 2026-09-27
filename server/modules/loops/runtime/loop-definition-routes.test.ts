import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from '../../../desktop-db'
import type { DbInstance } from '../../../db'
import { registerLoopsRoutes } from './loops-router'
import type { LoopGraph } from './loop-graph'
import { getLoop, readLegacyLoopGraph, updateLoop } from './loops-store'

const runtime = vi.hoisted(() => ({
  api: { capabilities: { engineV2: 1, workflowDefinitions: 1 } },
  beforeLoad: undefined as (() => void) | undefined,
  listWorkflows: vi.fn(),
  validateWorkflowDefinition: vi.fn(),
}))
vi.mock('../../agent-runtime/runtime/agent-runtime-loader', () => ({
  loadCoreAgentRuntime: async () => { runtime.beforeLoad?.(); return runtime },
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
  runtime.beforeLoad = undefined
  runtime.listWorkflows.mockReset()
  runtime.validateWorkflowDefinition.mockReset()
  delete process.env.SPECRAILS_LOOPS_SECTION
})
afterEach(() => db.close())
function api(isLoopRunning?: () => boolean) {
  const instance = express()
  instance.use(express.json())
  const router = express.Router()
  registerLoopsRoutes(router, { db, isLoopRunning })
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
  it('rejects publication when a different graph is saved while the Core runtime loads', async () => {
    const id = await draft()
    const changed = graph(); changed.nodes[1].data!.params = { outcome: 'failure' }
    runtime.beforeLoad = () => { updateLoop(db, id, { graph: changed }) }
    runtime.validateWorkflowDefinition.mockReturnValue({ ok: true, definition: {}, graph: { nodes: [], edges: [] }, version: 'a'.repeat(64) })
    const response = await api().post(`/api/loops/${id}/publish`)
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('loop_changed')
    expect((await api().get(`/api/loops/${id}`)).body.loop).toMatchObject({ status: 'draft', graph: changed })
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

async function legacyDraft() {
  const legacy: LoopGraph = {
    nodes: [{ id: 'start', type: 'start', position: { x: 0, y: 0 } },
      { id: 'work', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Complete the task' } },
      { id: 'done', type: 'end', position: { x: 0, y: 2 } }],
    edges: [{ id: 'enter', source: 'start', target: 'work' }, { id: 'finish', source: 'work', target: 'done' }],
    config: { maxIterations: 2, timeoutMinutes: 0 },
  }
  const response = await api().post('/api/loops').send({ name: 'Legacy conversion', graph: legacy })
  return { id: response.body.loop.id as string, graph: legacy }
}
describe('atomic legacy conversion', () => {
  function ready() {
    runtime.listWorkflows.mockReturnValue({ nodeKindsVersion: 5 })
    runtime.validateWorkflowDefinition.mockReturnValue({ ok: true })
  }
  it('validates through Core before saving a draft and preserves the original exactly once', async () => {
    ready()
    const source = await legacyDraft()
    const response = await api().post(`/api/loops/${source.id}/convert`).send({})
    expect(response.status, JSON.stringify(response.body)).toBe(200)
    expect(response.body.loop.status).toBe('draft')
    expect(response.body.nodeIds.work).toBe('work')
    expect(runtime.validateWorkflowDefinition).toHaveBeenCalledWith(expect.objectContaining({ schemaVersion: 1 }), { structural: true })
    expect(readLegacyLoopGraph(db, source.id)?.graph).toEqual(source.graph)
    const backup = readLegacyLoopGraph(db, source.id)
    expect((await api().post(`/api/loops/${source.id}/convert`).send({})).body.alreadyConverted).toBe(true)
    expect(readLegacyLoopGraph(db, source.id)).toEqual(backup)
  })
  it('keeps a rejected conversion unchanged without inventing a backup', async () => {
    ready(); runtime.validateWorkflowDefinition.mockReturnValue({ ok: false, errors: [{ code: 'invalid_params' }] })
    const source = await legacyDraft()
    expect((await api().post(`/api/loops/${source.id}/convert`).send({})).status).toBe(422)
    expect(getLoop(db, source.id)?.graph).toEqual(source.graph)
    expect(readLegacyLoopGraph(db, source.id)).toBeUndefined()
  })
  it('refuses a concurrent edit rather than replacing it with the validated old graph', async () => {
    ready(); const source = await legacyDraft()
    runtime.beforeLoad = () => { updateLoop(db, source.id, { name: 'Concurrent edit' }) }
    expect((await api().post(`/api/loops/${source.id}/convert`).send({})).status).toBe(409)
    expect(getLoop(db, source.id)?.name).toBe('Concurrent edit')
    expect(getLoop(db, source.id)?.graph).toEqual(source.graph)
    expect(readLegacyLoopGraph(db, source.id)).toBeUndefined()
  })
  it('requires the guarded catalog and rechecks active executions after runtime loading', async () => {
    ready(); const source = await legacyDraft()
    runtime.listWorkflows.mockReturnValue({ nodeKindsVersion: 4 })
    expect((await api().post(`/api/loops/${source.id}/convert`).send({})).status).toBe(409)
    ready(); let active = false
    runtime.beforeLoad = () => { active = true }
    expect((await api(() => active).post(`/api/loops/${source.id}/convert`).send({})).status).toBe(409)
    expect(getLoop(db, source.id)?.graph).toEqual(source.graph)
    expect(readLegacyLoopGraph(db, source.id)).toBeUndefined()
  })
})
