import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const mocks = vi.hoisted(() => ({ probe: vi.fn() }))
vi.mock('./local-engine-detection', async (importActual) => {
  const actual = await importActual<typeof import('./local-engine-detection')>()
  return { ...actual, probeConnection: mocks.probe }
})

import { createDesktopRouter } from './desktop-router'
import { initDesktopDb } from './desktop-db'
import type { ProjectRegistry } from './project-registry'
import { hasAdapter, unregisterAdapter, _clearForTests, register } from './providers/registry'
import { claudeAdapter } from './providers/claude-adapter'
import { _resetDetectionForTests, refreshDetection } from './provider-detection'
import { _resetForTests as resetProbeCache } from './local-engine-detection'
import { saveRuntimeProviders } from './modules/agent-runtime/runtime/agent-runtime-settings'

const ok = (models: string[]) => ({ reachable: true, installed: true, executable: true, authState: 'authenticated', models, latencyMs: 8 })
const down = { reachable: false, installed: false, executable: false, authState: 'unknown', models: [], latencyMs: 1500, error: 'timed out after 1500 ms' }
const cli = { id: 'claude', kind: 'cli', cli: 'claude' }
const local = { id: 'local', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'LOCAL_KEY' }

describe('desktop-router /runtime-providers (local engines)', () => {
  let home: string
  let app: express.Express
  let broadcast: ReturnType<typeof vi.fn>
  const prevKill = process.env.SPECRAILS_LOCAL_ENGINES

  beforeEach(() => {
    _clearForTests(); register(claudeAdapter)
    vi.spyOn(claudeAdapter, 'detectInstalled').mockResolvedValue({ installed: true, executable: true, version: '2.0.0', meetsMinimum: true })
    _resetDetectionForTests(); resetProbeCache(); mocks.probe.mockReset()
    delete process.env.SPECRAILS_LOCAL_ENGINES
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-home-'))
    vi.spyOn(os, 'homedir').mockReturnValue(home)
    const desktopDb = initDesktopDb(':memory:')
    const registry = { desktopDb, listContexts: vi.fn(() => []), getContext: vi.fn(), getProjectRow: vi.fn(), installedProvidersUnion: vi.fn(() => ['claude']) } as unknown as ProjectRegistry
    broadcast = vi.fn()
    app = express(); app.use(express.json()); app.use('/api', createDesktopRouter(registry, broadcast))
  })
  afterEach(() => {
    unregisterAdapter('local'); unregisterAdapter('lan-box'); _clearForTests()
    vi.restoreAllMocks(); fs.rmSync(home, { recursive: true, force: true })
    if (prevKill === undefined) delete process.env.SPECRAILS_LOCAL_ENGINES; else process.env.SPECRAILS_LOCAL_ENGINES = prevKill
  })

  it('GET returns connections + status (local from the probe cache, CLI from the detection snapshot)', async () => {
    saveRuntimeProviders([cli, local])
    // Nothing probed yet → probing placeholders.
    let res = await request(app).get('/api/runtime-providers')
    expect(res.status).toBe(200)
    expect(res.body.providers).toEqual([cli, local])
    expect(res.body.localEnginesEnabled).toBe(true)
    expect(res.body.status.local).toEqual({ kind: 'local', reachable: false, authState: 'unknown', models: [], probing: true })
    expect(res.body.status.claude).toMatchObject({ kind: 'cli', reachable: false, probing: true })
    // After a detection cycle (adapter registered via PUT below) both are populated.
    mocks.probe.mockResolvedValue({ ...ok(['qwen']), apiKeyEnvMissing: true, error: undefined })
    await request(app).put('/api/runtime-providers').send({ providers: [cli, local] })
    await refreshDetection()
    res = await request(app).get('/api/runtime-providers')
    expect(res.body.status.local).toEqual({ kind: 'local', reachable: true, authState: 'authenticated', models: ['qwen'], latencyMs: 8, apiKeyEnvMissing: true })
    expect(res.body.status.claude).toMatchObject({ kind: 'cli', reachable: true, installed: true, executable: true, version: '2.0.0', models: [] })
  })

  it('PUT saves, re-syncs the adapters, re-probes and broadcasts when the usable set changed', async () => {
    saveRuntimeProviders([cli])
    await refreshDetection()
    mocks.probe.mockResolvedValue(ok(['a', 'b']))
    const res = await request(app).put('/api/runtime-providers').send({ providers: [cli, { ...local, defaultModel: 'b', rates: { inputPer1M: 0.1, outputPer1M: 0.4 } }] })
    expect(res.status).toBe(200)
    expect(hasAdapter('local')).toBe(true)
    expect(res.body.providers[1]).toMatchObject({ defaultModel: 'b', rates: { inputPer1M: 0.1, outputPer1M: 0.4 } })
    expect(res.body.status.local).toMatchObject({ kind: 'local', reachable: true, models: ['a', 'b'] })
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'providers.detected_changed', detected: ['claude', 'local'] }))
    // Removing it unregisters and broadcasts again; an unchanged save stays silent.
    broadcast.mockClear()
    const removed = await request(app).put('/api/runtime-providers').send({ providers: [cli] })
    expect(removed.status).toBe(200)
    expect(hasAdapter('local')).toBe(false)
    expect(broadcast).toHaveBeenCalledTimes(1)
    broadcast.mockClear()
    await request(app).put('/api/runtime-providers').send({ providers: [cli] })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('PUT with an unreachable connection registers the adapter but does not add it to the detected set', async () => {
    await refreshDetection()
    mocks.probe.mockResolvedValue(down)
    const res = await request(app).put('/api/runtime-providers').send({ providers: [cli, local] })
    expect(res.status).toBe(200)
    expect(res.body.status.local).toMatchObject({ reachable: false, error: 'timed out after 1500 ms' })
    expect(broadcast).not.toHaveBeenCalled()
  })

  it('PUT rejects a reserved id and negative rates with 400, never touching the registry', async () => {
    let res = await request(app).put('/api/runtime-providers').send({ providers: [{ ...local, id: 'claude' }] })
    expect(res.status).toBe(400)
    expect(res.body.message).toContain("reserved for the claude CLI adapter")
    res = await request(app).put('/api/runtime-providers').send({ providers: [cli, { ...local, rates: { inputPer1M: -1, outputPer1M: 0 } }] })
    expect(res.status).toBe(400)
    expect(hasAdapter('local')).toBe(false)
  })

  it('PUT survives a failing re-probe (save still answers 200)', async () => {
    mocks.probe.mockRejectedValue(new Error('probe exploded'))
    const res = await request(app).put('/api/runtime-providers').send({ providers: [cli, local] })
    expect(res.status).toBe(200)
    expect(hasAdapter('local')).toBe(true)
  })

  it('kill switch: PUT saves without registering; GET reports localEnginesEnabled=false; /test still probes', async () => {
    process.env.SPECRAILS_LOCAL_ENGINES = 'false'
    mocks.probe.mockResolvedValue(ok(['m']))
    const put = await request(app).put('/api/runtime-providers').send({ providers: [cli, local] })
    expect(put.status).toBe(200)
    expect(hasAdapter('local')).toBe(false)
    expect(put.body.localEnginesEnabled).toBe(false)
    const get = await request(app).get('/api/runtime-providers')
    expect(get.body.providers).toHaveLength(2)
    const test = await request(app).post('/api/runtime-providers/test').send({ baseUrl: 'http://h/v1' })
    expect(test.status).toBe(200)
    expect(test.body).toEqual({ reachable: true, authState: 'authenticated', models: ['m'], latencyMs: 8 })
  })

  it('POST /test probes an unsaved draft and validates its shape', async () => {
    mocks.probe.mockResolvedValue({ ...ok([]), authState: 'unauthenticated', error: 'endpoint answered HTTP 401 (not authorized)', apiKeyEnvMissing: true })
    const res = await request(app).post('/api/runtime-providers/test').send({ baseUrl: 'http://h/v1', apiKeyEnv: 'K' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ reachable: true, authState: 'unauthenticated', models: [], latencyMs: 8, error: 'endpoint answered HTTP 401 (not authorized)', apiKeyEnvMissing: true })
    expect(mocks.probe).toHaveBeenCalledWith({ baseUrl: 'http://h/v1', apiKeyEnv: 'K' })
    // Empty/null apiKeyEnv means "none".
    await request(app).post('/api/runtime-providers/test').send({ baseUrl: 'http://h/v1', apiKeyEnv: '' })
    expect(mocks.probe).toHaveBeenLastCalledWith({ baseUrl: 'http://h/v1', apiKeyEnv: undefined })
    for (const body of [{}, { baseUrl: 'ftp://x' }, { baseUrl: 'http://u:p@h/v1' }, { baseUrl: 'http://h/v1?x=1' }]) {
      const bad = await request(app).post('/api/runtime-providers/test').send(body)
      expect(bad.status).toBe(400)
      expect(bad.body.error).toBe('invalid_base_url')
    }
    const badEnv = await request(app).post('/api/runtime-providers/test').send({ baseUrl: 'http://h/v1', apiKeyEnv: 'sk-live-secret' })
    expect(badEnv.status).toBe(400)
    expect(badEnv.body.error).toBe('invalid_api_key_env')
    // Nothing was saved by testing.
    expect(fs.existsSync(path.join(home, '.specrails', 'runtime-providers.json'))).toBe(false)
  })
})
