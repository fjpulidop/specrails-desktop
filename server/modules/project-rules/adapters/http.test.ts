import fs from 'fs'
import os from 'os'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerProjectRulesHttp, type ProjectRulesHttpPorts } from './http'
import { createRulesInventoryRuns, type RulesInventoryRuns } from '../runtime/rules-inventory-runs'

describe('project rules HTTP adapter', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-http-')) })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  function app(over: Partial<ProjectRulesHttpPorts> = {}, runs?: RulesInventoryRuns) {
    const ports: ProjectRulesHttpPorts = {
      project: { id: 'p1', slug: `rules-${process.pid}`, path: dir },
      supported: async () => true,
      createRuleSpec: vi.fn((fields) => ({ id: 42, ...fields })),
      runInventory: vi.fn(async () => {
        fs.mkdirSync(path.join(dir, '.specrails'), { recursive: true })
        fs.writeFileSync(path.join(dir, '.specrails', 'rules.json'), JSON.stringify({ gates: [], rules: [{ text: 'Use getApiBase', status: 'automatable', proposedCheck: 'lint rule' }, { text: 'Modal', status: 'humanOnly' }] }))
        return { ok: true, exitCode: 0, output: 'done' }
      }),
      ...over,
    }
    const server = express()
    server.use(express.json())
    const router = express.Router()
    registerProjectRulesHttp(router, () => ports, runs)
    server.use('/api/projects', router)
    return { server, ports }
  }

  it('reports a missing inventory, runs it, then turns an automatable rule into a spec', async () => {
    const { server, ports } = app()
    expect((await request(server).get('/api/projects/p1/rules')).body).toEqual({ supported: true, running: false, state: 'missing' })
    const run = await request(server).post('/api/projects/p1/rules/inventory')
    expect(run.status).toBe(200)
    expect(run.body).toMatchObject({ ok: true, state: 'ok', inventory: { counts: { automatable: 1, humanOnly: 1, enforcedBy: 0 } } })
    const created = await request(server).post('/api/projects/p1/rules/specs').send({ index: 0 })
    expect(created.status).toBe(201)
    expect(ports.createRuleSpec).toHaveBeenCalledWith(expect.objectContaining({ title: 'Enforce: Use getApiBase', labels: ['rules', 'automation'] }))
    expect((await request(server).post('/api/projects/p1/rules/specs').send({ index: 1 })).body.error).toBe('rule_not_automatable')
    expect((await request(server).post('/api/projects/p1/rules/specs').send({ index: 7 })).status).toBe(404)
    expect((await request(server).post('/api/projects/p1/rules/specs').send({ index: -1 })).status).toBe(400)
    expect((await request(server).post('/api/projects/p1/rules/specs').send({ id: 'index-0' })).status).toBe(201)
    expect((await request(server).post('/api/projects/p1/rules/specs').send({ id: 'r-missing' })).status).toBe(404)
  })

  it('refuses writes without the Core capability but still shows the file', async () => {
    const { server } = app({ supported: async () => false })
    fs.mkdirSync(path.join(dir, '.specrails'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.specrails', 'rules.json'), '{not json')
    expect((await request(server).get('/api/projects/p1/rules')).body).toMatchObject({ supported: false, state: 'invalid', message: 'rules.json is not valid JSON' })
    expect((await request(server).post('/api/projects/p1/rules/inventory')).status).toBe(409)
    expect((await request(server).post('/api/projects/p1/rules/specs').send({ index: 0 })).status).toBe(409)
  })

  it('reports a failed inventory run and refuses a concurrent one', async () => {
    let release!: () => void
    const { server } = app({ runInventory: () => new Promise((resolve) => { release = () => resolve({ ok: false, exitCode: 2, output: 'unknown command rules' }) }) })
    const first = request(server).post('/api/projects/p1/rules/inventory').then((res) => res)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const second = await request(server).post('/api/projects/p1/rules/inventory')
    expect(second.body.error).toBe('rules_inventory_running')
    release()
    const res = await first
    expect(res.status).toBe(502)
    expect(res.body).toMatchObject({ ok: false, exitCode: 2, output: 'unknown command rules', state: 'missing' })
    // The panel reads how the last run ended.
    expect((await request(server).get('/api/projects/p1/rules')).body.lastRun).toMatchObject({ trigger: 'manual', ok: false, exitCode: 2, output: 'unknown command rules' })
  })

  it('shares the run with the automatic inventory after setup: running, refused re-run, last run', async () => {
    let release!: () => void
    const runs = createRulesInventoryRuns({ run: () => new Promise((resolve) => { release = () => resolve({ ok: false, exitCode: 1, output: 'no provider' }) }), log: { warn: vi.fn() } })
    const { server, ports } = app({ runInventory: undefined }, runs)
    const auto = runs.runAfterSetup(ports.project, async () => true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await request(server).get('/api/projects/p1/rules')).body).toMatchObject({ running: true, state: 'missing' })
    expect((await request(server).post('/api/projects/p1/rules/inventory')).body.error).toBe('rules_inventory_running')
    release()
    await expect(auto).resolves.toBe('failed')
    expect((await request(server).get('/api/projects/p1/rules')).body).toMatchObject({ running: false, lastRun: { trigger: 'setup', ok: false, output: 'no provider' } })
  })

  it('answers 404 for a spec request without an inventory', async () => {
    const { server } = app()
    expect((await request(server).post('/api/projects/p1/rules/specs').send({ index: 0 })).body.error).toBe('rules_missing')
  })
})
