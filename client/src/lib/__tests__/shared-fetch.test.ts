import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sharedFetch, _pendingSharedFetches } from '../shared-fetch'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('sharedFetch', () => {
  it('shares one request between concurrent identical GETs, each with its own body', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ runs: [1] }), { status: 200 }))
    const [a, b] = await Promise.all([sharedFetch('/api/projects/p1/rails'), sharedFetch('/api/projects/p1/rails')])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/rails')
    expect(await a.json()).toEqual({ runs: [1] })
    expect(await b.json()).toEqual({ runs: [1] })
  })

  it('never caches after the request settles (live refreshes reach the server)', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }))
    await sharedFetch('/api/loops')
    expect(_pendingSharedFetches()).toBe(0)
    await sharedFetch('/api/loops')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keys by full URL (project ids never share) and by cache mode', async () => {
    fetchMock.mockImplementation(async () => new Response('{}', { status: 200 }))
    await Promise.all([
      sharedFetch('/api/projects/p1/profiles?provider=claude'),
      sharedFetch('/api/projects/p2/profiles?provider=claude'),
      sharedFetch('/api/projects/p1/profiles?provider=claude', { cache: 'no-store' }),
    ])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/profiles?provider=claude', { cache: 'no-store' })
  })

  it('shares failures with every waiter and retries afterwards', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const results = await Promise.allSettled([sharedFetch('/x'), sharedFetch('/x')])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }))
    await expect(sharedFetch('/x')).resolves.toBeInstanceOf(Response)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("a caller's abort ends only its own wait", async () => {
    const pending = deferred<Response>()
    fetchMock.mockReturnValueOnce(pending.promise)
    const controller = new AbortController()
    const aborted = sharedFetch('/blueprint', { signal: controller.signal })
    const other = sharedFetch('/blueprint')
    controller.abort()
    await expect(aborted).rejects.toBeTruthy()
    pending.resolve(new Response('{"ok":true}', { status: 200 }))
    expect(await (await other).json()).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects immediately for an already-aborted signal without fetching', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(sharedFetch('/y', { signal: controller.signal })).rejects.toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
