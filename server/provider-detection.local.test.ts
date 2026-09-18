// Local (OpenAI-compatible) adapters inside the app-level detection cycle.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  adapters: [] as unknown[],
  probe: vi.fn(),
}))
vi.mock('./providers', () => ({ listAdapters: () => mocks.adapters }))
vi.mock('./core-compat', () => ({ checkCoreCompat: vi.fn(async () => ({ compatible: true })), coreCompatSupportsProvider: vi.fn(() => true) }))
vi.mock('./local-engine-detection', async (importActual) => {
  const actual = await importActual<typeof import('./local-engine-detection')>()
  return { ...actual, probeConnection: mocks.probe }
})

import { getDetectionSnapshot, refreshDetection, refreshLocalDetection, _resetDetectionForTests } from './provider-detection'
import { getCachedModels, _resetForTests } from './local-engine-detection'

const cli = (id: string, installed = true) => ({
  id, displayName: id, minCliVersion: null,
  detectInstalled: vi.fn(async () => (installed ? { installed: true, executable: true, version: '1.0.0' } : { installed: false, executable: false })),
})
const local = (id: string, baseUrl = 'http://127.0.0.1:8080/v1', apiKeyEnv?: string) => ({
  id, displayName: id, minCliVersion: null, localConnection: { id, kind: 'openai-compatible', baseUrl, apiKeyEnv },
  detectInstalled: vi.fn(async () => ({ installed: true, executable: true })),
})
const ok = (models: string[]) => ({ reachable: true, installed: true, executable: true, authState: 'authenticated', models, latencyMs: 12 })

describe('provider-detection with local adapters', () => {
  const prev = process.env.SPECRAILS_LOCAL_ENGINES
  beforeEach(() => { _resetDetectionForTests(); _resetForTests(); mocks.probe.mockReset(); delete process.env.SPECRAILS_LOCAL_ENGINES })
  afterEach(() => { if (prev === undefined) delete process.env.SPECRAILS_LOCAL_ENGINES; else process.env.SPECRAILS_LOCAL_ENGINES = prev })

  it('probes a reachable connection in the same cycle, rows carry kind + models, id joins the detected set', async () => {
    mocks.adapters = [cli('claude'), local('local', 'http://h/v1', 'KEY')]
    mocks.probe.mockResolvedValue({ ...ok(['qwen', 'llama']), apiKeyEnvMissing: true })
    const snap = await getDetectionSnapshot()
    expect(snap.detected).toEqual(['claude', 'local'])
    expect(snap.providers.local).toMatchObject({ kind: 'local', installed: true, executable: true, authState: 'authenticated', usable: true, models: ['qwen', 'llama'], latencyMs: 12, apiKeyEnvMissing: true })
    expect(snap.providers.local.error).toBeUndefined()
    expect(snap.providers.claude.kind).toBeUndefined()
    expect(mocks.probe).toHaveBeenCalledWith({ baseUrl: 'http://h/v1', apiKeyEnv: 'KEY' })
    // The adapter's dynamic catalog reads the same cache.
    expect(getCachedModels('local')).toEqual(['qwen', 'llama'])
  })

  it('unauthenticated stays listed as usable with the badge state; unreachable is excluded', async () => {
    mocks.adapters = [cli('claude'), local('auth'), local('down')]
    mocks.probe
      .mockResolvedValueOnce({ ...ok([]), authState: 'unauthenticated', error: 'endpoint answered HTTP 401 (not authorized)' })
      .mockResolvedValueOnce({ reachable: false, installed: false, executable: false, authState: 'unknown', models: [], latencyMs: 1500, error: 'timed out after 1500 ms' })
    const snap = await getDetectionSnapshot()
    expect(snap.detected).toEqual(['claude', 'auth'])
    expect(snap.providers.auth).toMatchObject({ usable: true, authState: 'unauthenticated' })
    expect(snap.providers.down).toMatchObject({ usable: false, installed: false, error: 'timed out after 1500 ms' })
  })

  it('a probe that throws degrades to unreachable with a generic error', async () => {
    mocks.adapters = [local('boom')]
    mocks.probe.mockRejectedValueOnce(new Error('kaboom')).mockRejectedValueOnce('nope')
    let snap = await getDetectionSnapshot()
    expect(snap.providers.boom).toMatchObject({ usable: false, error: 'kaboom' })
    snap = (await refreshDetection()).snapshot
    expect(snap.providers.boom.error).toBe('nope')
    mocks.probe.mockResolvedValueOnce({ reachable: false, installed: false, executable: false, authState: 'unknown', models: [], latencyMs: 0 })
    snap = (await refreshDetection()).snapshot
    expect(snap.providers.boom.error).toBe('boom endpoint is unreachable.')
  })

  it('kill switch skips local adapters entirely', async () => {
    process.env.SPECRAILS_LOCAL_ENGINES = 'false'
    mocks.adapters = [cli('claude'), local('local')]
    const snap = await getDetectionSnapshot()
    expect(snap.detected).toEqual(['claude'])
    expect(snap.providers.local).toBeUndefined()
    expect(mocks.probe).not.toHaveBeenCalled()
  })

  it('refreshLocalDetection re-probes only local ids, keeps CLI rows, reports set changes', async () => {
    const claude = cli('claude')
    mocks.adapters = [claude, local('local')]
    mocks.probe.mockResolvedValueOnce({ reachable: false, installed: false, executable: false, authState: 'unknown', models: [], latencyMs: 3 })
    await getDetectionSnapshot()
    expect(claude.detectInstalled).toHaveBeenCalledTimes(1)
    mocks.adapters = [claude, local('local'), local('lan')]
    mocks.probe.mockResolvedValue(ok(['m']))
    const { snapshot, changed } = await refreshLocalDetection()
    expect(changed).toBe(true)
    expect(snapshot.detected).toEqual(['claude', 'local', 'lan'])
    expect(claude.detectInstalled).toHaveBeenCalledTimes(1) // CLI not re-probed
    const again = await refreshLocalDetection()
    expect(again.changed).toBe(false)
    // Under the kill switch the local rows disappear from the snapshot.
    process.env.SPECRAILS_LOCAL_ENGINES = '0'
    const off = await refreshLocalDetection()
    expect(off.snapshot.detected).toEqual(['claude'])
    expect(off.changed).toBe(true)
  })

  it('refreshLocalDetection without a snapshot falls back to a full refresh', async () => {
    mocks.adapters = [cli('claude')]
    const { snapshot } = await refreshLocalDetection()
    expect(snapshot.detected).toEqual(['claude'])
  })
})
