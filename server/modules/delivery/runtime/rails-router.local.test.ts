// Rail launches on a LOCAL (OpenAI-compatible) engine: override mapping.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from '../../../db'
import { initDesktopDb } from '../../../desktop-db'
import { createRailsRouter } from './rails-router'
import { setRailTickets } from './rails-store'
import { createLoop, publishLoop } from '../../loops/runtime/loops-store'
import type { LoopGraph } from '../../loops/runtime/loop-graph'
import { syncLocalAdapters } from '../../../providers/local-adapter-registry'
import { unregisterAdapter } from '../../../providers/registry'
import '../../../providers'

vi.mock('../../../project-git', async (importActual) => ({
  ...(await importActual<typeof import('../../../project-git')>()),
  getRepoStatus: vi.fn(async () => 'no-git'),
}))

function graph(): LoopGraph {
  return {
    nodes: [
      { id: 's', type: 'start', position: { x: 0, y: 0 } },
      { id: 'ai', type: 'ai-step', position: { x: 0, y: 1 }, data: { prompt: 'Implement {{spec.title}}' } },
      { id: 'e', type: 'end', position: { x: 0, y: 2 } },
    ],
    edges: [{ id: 'e1', source: 's', target: 'ai' }, { id: 'e2', source: 'ai', target: 'e' }],
    config: { maxIterations: 5, timeoutMinutes: 20 },
  }
}

describe('rails-router launch on a local engine', () => {
  let db: DbInstance
  let desktopDb: DbInstance
  let run: ReturnType<typeof vi.fn>
  let enqueue: ReturnType<typeof vi.fn>

  function app(providers: string[]) {
    const a = express(); a.use(express.json())
    a.use((req, _res, next) => {
      ;(req as unknown as { projectCtx: unknown }).projectCtx = {
        db, desktopDb, railJobs: new Map(), railLoopRuns: new Map(),
        project: { id: 'p1', slug: 's1', provider: providers[0], providers, path: '/repo' },
        queueManager: { enqueue }, loopRunManager: { run, cancel: vi.fn() },
        broadcast: () => {}, getTicketSpec: () => ({ title: 'T', description: 'D' }), onLoopRunFinished: () => {},
        jiraSyncManager: { onRailLaunch: () => {} },
      }
      next()
    })
    a.use('/rails', createRailsRouter())
    return a
  }

  beforeEach(() => {
    db = initDb(':memory:'); desktopDb = initDesktopDb(':memory:')
    setRailTickets(db, 0, [7], 'loop')
    const loop = createLoop(desktopDb, { id: 'loop-1', name: 'Ship', graph: graph() }); publishLoop(desktopDb, loop.id)
    run = vi.fn().mockResolvedValue({ runId: 'rid', outcome: 'success', iterations: 1, totalCostUsd: 0 })
    enqueue = vi.fn().mockReturnValue({ id: 'job-1', queuePosition: 0 })
    syncLocalAdapters([{ id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', defaultModel: 'qwen' }])
  })
  afterEach(() => { unregisterAdapter('local'); db.close(); desktopDb.close() })

  it('maps the local engine to { provider, model } — effort dropped — for the runtime override', async () => {
    const res = await request(app(['claude', 'local'])).post('/rails/0/launch').send({ mode: 'loop', loopId: 'loop-1', aiEngine: 'local', model: 'qwen3.5-9b:latest', reasoning_effort: 'high' })
    expect(res.status).toBe(202)
    const arg = run.mock.calls[0][0] as Record<string, unknown>
    expect(arg.provider).toBe('local')
    expect(arg.runtimeProviderOverride).toEqual({ provider: 'local', model: 'qwen3.5-9b:latest' })
  })

  it('strips effort from an explicit body override on a local engine and keeps the mismatch guard', async () => {
    const ok = await request(app(['claude', 'local'])).post('/rails/0/launch').send({ mode: 'loop', loopId: 'loop-1', aiEngine: 'local', runtimeProviderOverride: { provider: 'local', model: 'm', effort: 'high' } })
    expect(ok.status).toBe(202)
    expect((run.mock.calls[0][0] as Record<string, unknown>).runtimeProviderOverride).toEqual({ provider: 'local', model: 'm' })
    const mismatch = await request(app(['claude', 'local'])).post('/rails/0/launch').send({ mode: 'loop', loopId: 'loop-1', aiEngine: 'local', runtimeProviderOverride: { provider: 'claude' } })
    expect(mismatch.status).toBe(400)
    expect(mismatch.body.error).toBe('runtime_provider_mismatch')
  })

  it('rejects a cost cap for a local engine (400 local_engine_no_cost_cap)', async () => {
    const res = await request(app(['claude', 'local'])).post('/rails/0/launch').send({ mode: 'loop', loopId: 'loop-1', aiEngine: 'local', maxCostUsd: 5 })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('local_engine_no_cost_cap')
    expect(run).not.toHaveBeenCalled()
  })

  it('freestyle is allowed via the capability and enqueues with provider=local (no profile)', async () => {
    const res = await request(app(['claude', 'local'])).post('/rails/0/launch').send({ mode: 'freestyle', aiEngine: 'local', model: 'custom/model:v1' })
    expect(res.status).toBe(202)
    // Loops on ⇒ freestyle derives its factory loop and runs through the
    // LoopRunManager (no queue job). The custom alias survives byte-for-byte.
    const arg = run.mock.calls[0][0] as Record<string, unknown>
    expect(arg.provider).toBe('local')
    expect(arg.model).toBe('custom/model:v1')
    expect(arg.runtimeProviderOverride).toEqual({ provider: 'local', model: 'custom/model:v1' })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('an undetected local id is rejected with the "not installed" error (kill switch / unreachable)', async () => {
    const res = await request(app(['claude'])).post('/rails/0/launch').send({ mode: 'loop', loopId: 'loop-1', aiEngine: 'local' })
    expect(res.status).toBe(400)
    expect(res.body.error).toContain("provider 'local' is not installed")
  })
})
