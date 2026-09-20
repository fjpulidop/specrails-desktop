import { describe, it, expect, beforeEach, vi } from 'vitest'
import { probeConnection, getCachedModels, getCachedProbe, setCachedProbe, clearCachedProbe, _resetForTests, LOCAL_PROBE_TIMEOUT_MS } from './local-engine-detection'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('probeConnection', () => {
  it('2xx with data[] → authenticated + models, Bearer from env, trailing slashes trimmed', async () => {
    const fetchMock = vi.fn(async () => json({ data: [{ id: 'a' }, { id: 'b' }, { nope: 1 }] }))
    const r = await probeConnection({ baseUrl: 'http://h:1/v1///', apiKeyEnv: 'K' }, { fetch: fetchMock as never, env: { K: 'secret' } })
    expect(r).toMatchObject({ reachable: true, installed: true, executable: true, authState: 'authenticated', models: ['a', 'b'] })
    expect(r.apiKeyEnvMissing).toBeUndefined()
    expect(r.error).toBeUndefined()
    expect(typeof r.latencyMs).toBe('number')
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://h:1/v1/models')
    expect(init.redirect).toBe('manual')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('flags apiKeyEnvMissing but still probes when the env var is unset', async () => {
    const fetchMock = vi.fn(async () => json({ data: [] }))
    const r = await probeConnection({ baseUrl: 'http://h/v1', apiKeyEnv: 'MISSING' }, { fetch: fetchMock as never, env: {} })
    expect(r).toMatchObject({ reachable: true, authState: 'authenticated', models: [], apiKeyEnvMissing: true })
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty('authorization')
    // No apiKeyEnv at all → no header, no flag.
    const bare = await probeConnection({ baseUrl: 'http://h/v1' }, { fetch: fetchMock as never, env: {} })
    expect(bare.apiKeyEnvMissing).toBeUndefined()
  })

  it.each([401, 403])('HTTP %d → reachable but unauthenticated, no models', async (status) => {
    const r = await probeConnection({ baseUrl: 'http://h/v1', apiKeyEnv: 'K' }, { fetch: (async () => json({}, status)) as never, env: {} })
    expect(r).toMatchObject({ reachable: true, installed: true, executable: true, authState: 'unauthenticated', models: [], apiKeyEnvMissing: true })
    expect(r.error).toContain(String(status))
  })

  it('other statuses, non-JSON and missing data[] → unreachable', async () => {
    expect(await probeConnection({ baseUrl: 'http://h/v1' }, { fetch: (async () => json({}, 500)) as never })).toMatchObject({ reachable: false, installed: false, authState: 'unknown', error: 'endpoint answered HTTP 500' })
    expect(await probeConnection({ baseUrl: 'http://h/v1' }, { fetch: (async () => new Response('<html>', { status: 200 })) as never })).toMatchObject({ reachable: false, error: 'endpoint did not return JSON' })
    expect(await probeConnection({ baseUrl: 'http://h/v1' }, { fetch: (async () => json({ models: [] })) as never })).toMatchObject({ reachable: false, error: 'endpoint response has no `data` array' })
    expect(await probeConnection({ baseUrl: 'http://h/v1' }, { fetch: (async () => json(null)) as never })).toMatchObject({ reachable: false })
    expect(await probeConnection({ baseUrl: 'http://h/v1' }, { fetch: (async () => json({}, 302)) as never })).toMatchObject({ reachable: false, error: 'endpoint answered HTTP 302' })
  })

  it('network errors and timeouts never throw', async () => {
    const refused = await probeConnection({ baseUrl: 'http://h/v1', apiKeyEnv: 'K' }, { fetch: (async () => { throw new Error('ECONNREFUSED') }) as never, env: {} })
    expect(refused).toMatchObject({ reachable: false, installed: false, executable: false, authState: 'unknown', models: [], error: 'ECONNREFUSED', apiKeyEnvMissing: true })
    const timeoutErr = new Error('aborted'); timeoutErr.name = 'TimeoutError'
    const timedOut = await probeConnection({ baseUrl: 'http://h/v1' }, { fetch: (async () => { throw timeoutErr }) as never, timeoutMs: 7 })
    expect(timedOut.error).toBe('timed out after 7 ms')
    const weird = await probeConnection({ baseUrl: 'http://h/v1' }, { fetch: (async () => { throw 'string failure' }) as never })
    expect(weird.error).toBe('string failure')
    // Wide enough for a LAN endpoint (or a server that loads a model before
    // answering /models): a timed-out probe hides the engine for that cycle.
    expect(LOCAL_PROBE_TIMEOUT_MS).toBe(8000)
  })
})

describe('probe cache', () => {
  beforeEach(() => _resetForTests())

  it('caches per id and only authenticated probes contribute models', () => {
    expect(getCachedProbe('x')).toBeNull()
    expect(getCachedModels('x')).toEqual([])
    setCachedProbe('x', { reachable: true, installed: true, executable: true, authState: 'authenticated', models: ['m1'], latencyMs: 1 })
    expect(getCachedModels('x')).toEqual(['m1'])
    expect(getCachedProbe('x')?.models).toEqual(['m1'])
    setCachedProbe('x', { reachable: true, installed: true, executable: true, authState: 'unauthenticated', models: [], latencyMs: 1 })
    expect(getCachedModels('x')).toEqual([])
    clearCachedProbe('x')
    expect(getCachedProbe('x')).toBeNull()
  })
})
