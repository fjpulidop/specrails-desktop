import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express, { type Express } from 'express'
import { Router } from 'express'
import request from 'supertest'
import { initDesktopDb } from './desktop-db'
import type { DbInstance } from './db'
import { registerLoopsRoutes } from './loops-router'
import type { LoopGraph } from './loop-graph'

function validGraph(): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 } },
      { id: 'e', type: 'end', position: { x: 0, y: 2 } },
    ],
    edges: [
      { id: 'e1', source: 's', target: 'ai' },
      { id: 'e2', source: 'ai', target: 'e' },
    ],
    config: { maxIterations: 5, timeoutMinutes: 20 },
  }
}

function buildApp(db: DbInstance, isLoopRunning?: (id: string) => boolean): Express {
  const app = express()
  app.use(express.json())
  const router = Router()
  registerLoopsRoutes(router, { db, isLoopRunning })
  app.use('/api', router)
  return app
}

let db: DbInstance
let app: Express

beforeEach(() => {
  delete process.env.SPECRAILS_LOOPS_SECTION
  db = initDesktopDb(':memory:')
  app = buildApp(db)
})

afterEach(() => {
  delete process.env.SPECRAILS_LOOPS_SECTION
})

describe('loops-router CRUD', () => {
  it('lists an empty library', async () => {
    const res = await request(app).get('/api/loops')
    expect(res.status).toBe(200)
    expect(res.body.loops).toEqual([])
  })

  it('creates a loop as a Draft (201)', async () => {
    const res = await request(app).post('/api/loops').send({ name: 'My Loop', graph: validGraph() })
    expect(res.status).toBe(201)
    expect(res.body.loop.status).toBe('draft')
    expect(res.body.loop.id).toBeTruthy()
    expect(res.body.loop.name).toBe('My Loop')
  })

  it('rejects creation without a name (400)', async () => {
    const res = await request(app).post('/api/loops').send({ graph: validGraph() })
    expect(res.status).toBe(400)
  })

  it('gets a loop by id, 404 for unknown', async () => {
    const created = await request(app).post('/api/loops').send({ name: 'X' })
    const id = created.body.loop.id
    expect((await request(app).get(`/api/loops/${id}`)).status).toBe(200)
    expect((await request(app).get('/api/loops/nope')).status).toBe(404)
  })

  it('deletes a loop (204)', async () => {
    const created = await request(app).post('/api/loops').send({ name: 'X' })
    const id = created.body.loop.id
    expect((await request(app).delete(`/api/loops/${id}`)).status).toBe(204)
    expect((await request(app).get(`/api/loops/${id}`)).status).toBe(404)
  })
})

describe('loops-router templates', () => {
  it('lists the Specrails starter templates', async () => {
    const res = await request(app).get('/api/loop-templates')
    expect(res.status).toBe(200)
    const ids = res.body.templates.map((t: { id: string }) => t.id)
    expect(ids).toContain('ship-and-green')
    expect(res.body.templates[0]).toHaveProperty('description')
  })

  it('instantiates a Draft from a template (201)', async () => {
    const res = await request(app).post('/api/loops/from-template/ship-and-green').send({})
    expect(res.status).toBe(201)
    expect(res.body.loop.status).toBe('draft')
    expect(res.body.loop.graph.nodes.length).toBeGreaterThan(0)
  })

  it('404s for an unknown template', async () => {
    expect((await request(app).post('/api/loops/from-template/ghost').send({})).status).toBe(404)
  })

  it('a template instantiation is immediately publishable', async () => {
    const created = await request(app).post('/api/loops/from-template/ship-and-green').send({})
    const pub = await request(app).post(`/api/loops/${created.body.loop.id}/publish`)
    expect(pub.status).toBe(200)
    expect(pub.body.loop.status).toBe('published')
  })
})

describe('loops-router lifecycle', () => {
  it('publishes a valid loop and refuses an invalid one (422 + errors)', async () => {
    const valid = await request(app).post('/api/loops').send({ name: 'V', graph: validGraph() })
    expect((await request(app).post(`/api/loops/${valid.body.loop.id}/publish`)).status).toBe(200)

    const invalid = await request(app).post('/api/loops').send({ name: 'I' }) // empty graph
    const res = await request(app).post(`/api/loops/${invalid.body.loop.id}/publish`)
    expect(res.status).toBe(422)
    expect(Array.isArray(res.body.errors)).toBe(true)
    expect(res.body.errors.length).toBeGreaterThan(0)
  })

  it('editing a published loop reverts it to Draft', async () => {
    const created = await request(app).post('/api/loops').send({ name: 'V', graph: validGraph() })
    const id = created.body.loop.id
    await request(app).post(`/api/loops/${id}/publish`)
    const res = await request(app).put(`/api/loops/${id}`).send({ name: 'V2' })
    expect(res.status).toBe(200)
    expect(res.body.loop.status).toBe('draft')
  })

  it('PUT unknown loop → 404', async () => {
    expect((await request(app).put('/api/loops/nope').send({ name: 'x' })).status).toBe(404)
  })

  it('duplicates a loop into a new Draft (201)', async () => {
    const created = await request(app).post('/api/loops').send({ name: 'Orig', graph: validGraph() })
    await request(app).post(`/api/loops/${created.body.loop.id}/publish`)
    const dup = await request(app).post(`/api/loops/${created.body.loop.id}/duplicate`).send({ name: 'Copy' })
    expect(dup.status).toBe(201)
    expect(dup.body.loop.name).toBe('Copy')
    expect(dup.body.loop.status).toBe('draft')
    expect(dup.body.loop.id).not.toBe(created.body.loop.id)
  })
})

describe('loops-router running guard', () => {
  it('rejects edit/unpublish/delete while the loop is running (409)', async () => {
    const runningApp = buildApp(db, () => true)
    const created = await request(runningApp).post('/api/loops').send({ name: 'R', graph: validGraph() })
    const id = created.body.loop.id
    expect((await request(runningApp).put(`/api/loops/${id}`).send({ name: 'x' })).status).toBe(409)
    expect((await request(runningApp).post(`/api/loops/${id}/unpublish`)).status).toBe(409)
    expect((await request(runningApp).delete(`/api/loops/${id}`)).status).toBe(409)
  })
})

describe('loops-router feature flag', () => {
  it('404s every route when SPECRAILS_LOOPS_SECTION=false', async () => {
    process.env.SPECRAILS_LOOPS_SECTION = 'false'
    expect((await request(app).get('/api/loops')).status).toBe(404)
    expect((await request(app).get('/api/loop-templates')).status).toBe(404)
    expect((await request(app).post('/api/loops').send({ name: 'X' })).status).toBe(404)
  })
})

describe('loops-router factory loops', () => {
  it('lists the built-in factory loops with their mode + graph', async () => {
    const res = await request(app).get('/api/loops/factory')
    expect(res.status).toBe(200)
    const ids = res.body.factoryLoops.map((f: { id: string }) => f.id)
    expect(ids).toEqual(['factory:implement', 'factory:batch', 'factory:ultracode'])
    const ultra = res.body.factoryLoops.find((f: { id: string }) => f.id === 'factory:ultracode')
    expect(ultra.mode).toBe('ultracode')
    expect(ultra.claudeOnly).toBe(true)
    expect(ultra.graph.nodes.length).toBeGreaterThan(0)
  })

  it('forks a factory loop into a new editable draft (factory unchanged)', async () => {
    const res = await request(app).post('/api/loops/factory/factory:implement/fork').send({})
    expect(res.status).toBe(201)
    expect(res.body.loop.status).toBe('draft')
    expect(res.body.loop.id).not.toBe('factory:implement')
    const list = await request(app).get('/api/loops')
    expect(list.body.loops.some((l: { id: string }) => l.id === res.body.loop.id)).toBe(true)
  })

  it('404s forking an unknown factory loop', async () => {
    expect((await request(app).post('/api/loops/factory/factory:nope/fork').send({})).status).toBe(404)
  })

  it('exposes the magic-command catalog for the builder palette', async () => {
    const res = await request(app).get('/api/loops/commands')
    expect(res.status).toBe(200)
    const names = res.body.commands.map((c: { name: string }) => c.name)
    expect(names).toEqual(expect.arrayContaining(['implement', 'batch', 'ultracode', 'verify', 'fix']))
    expect(res.body.commands.every((c: { label: string }) => typeof c.label === 'string')).toBe(true)
  })

  it('does not capture "factory" as a loop id (route ordering)', async () => {
    const res = await request(app).get('/api/loops/factory')
    expect(res.status).toBe(200)
    expect(res.body.factoryLoops).toBeDefined()
  })

  describe('constants library', () => {
    it('lists built-ins, creates/updates/deletes custom constants', async () => {
      const initial = await request(app).get('/api/loops/constants')
      expect(initial.status).toBe(200)
      expect(initial.body.constants.some((c: { name: string; builtin?: boolean }) => c.name === 'VERIFICATION_PASS' && c.builtin)).toBe(true)

      const created = await request(app).post('/api/loops/constants').send({ name: 'TICKET_PREFIX', value: 'PROJ-' })
      expect(created.status).toBe(201)
      const id = created.body.constant.id

      const updated = await request(app).put(`/api/loops/constants/${id}`).send({ value: 'ACME-' })
      expect(updated.status).toBe(200)
      expect(updated.body.constant.value).toBe('ACME-')

      const del = await request(app).delete(`/api/loops/constants/${id}`)
      expect(del.body.deleted).toBe(true)
      const after = await request(app).get('/api/loops/constants')
      expect(after.body.constants.some((c: { name: string }) => c.name === 'TICKET_PREFIX')).toBe(false)
    })

    it('rejects invalid name (400), reserved built-in name (400), and duplicate (409)', async () => {
      expect((await request(app).post('/api/loops/constants').send({ name: 'has space', value: 'v' })).status).toBe(400)
      expect((await request(app).post('/api/loops/constants').send({ name: 'VERIFICATION_PASS', value: 'v' })).status).toBe(400)
      await request(app).post('/api/loops/constants').send({ name: 'DUP', value: 'a' })
      expect((await request(app).post('/api/loops/constants').send({ name: 'DUP', value: 'b' })).status).toBe(409)
    })

    it('does not capture "constants" as a loop id (route ordering)', async () => {
      const res = await request(app).get('/api/loops/constants')
      expect(res.status).toBe(200)
      expect(res.body.constants).toBeDefined()
    })

    it('404s the whole constants surface when Loops is disabled', async () => {
      process.env.SPECRAILS_LOOPS_SECTION = 'false'
      expect((await request(app).get('/api/loops/constants')).status).toBe(404)
    })
  })

  describe('import', () => {
    it('imports new loops, skips duplicate names, returns the summary', async () => {
      await request(app).post('/api/loops').send({ name: 'Dup', graph: validGraph() })
      const res = await request(app).post('/api/loops/import').send({
        loops: [
          { name: 'Imported A', graph: validGraph() },
          { name: 'Dup', graph: validGraph() },
        ],
      })
      expect(res.status).toBe(200)
      expect(res.body.imported.map((l: { name: string }) => l.name)).toEqual(['Imported A'])
      expect(res.body.skipped).toEqual(['Dup'])
    })

    it('400s when body has no loops array', async () => {
      expect((await request(app).post('/api/loops/import').send({})).status).toBe(400)
    })

    it('does not capture "import" as a loop id (route ordering)', async () => {
      const res = await request(app).post('/api/loops/import').send({ loops: [] })
      expect(res.status).toBe(200)
      expect(res.body).toEqual({ imported: [], skipped: [] })
    })
  })

  describe('preview', () => {
    it('resolves step tokens for a dry-run preview (no spawn)', async () => {
      const graph: LoopGraph = {
        nodes: [
          { id: 's', type: 'start', position: { x: 0, y: 0 } },
          { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'finish with {{const:VERIFICATION_PASS}}' } },
          { id: 'e', type: 'end', position: { x: 0, y: 2 } },
        ],
        edges: [{ id: 'e1', source: 's', target: 'ai' }, { id: 'e2', source: 'ai', target: 'e' }],
        config: { maxIterations: 5, timeoutMinutes: 20 },
      }
      const res = await request(app).post('/api/loops/preview').send({ graph })
      expect(res.status).toBe(200)
      expect(res.body.steps).toHaveLength(1) // start/end skipped
      expect(res.body.steps[0].text).toContain('VERIFICATION: PASS') // built-in constant resolved
    })

    it('400s when no graph is supplied', async () => {
      expect((await request(app).post('/api/loops/preview').send({})).status).toBe(400)
    })
  })
})
