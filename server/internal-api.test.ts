import { describe, it, expect, vi } from 'vitest'
import { createInternalApi, internalApiError } from './internal-api'

function response(status: number, text: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => text } as unknown as Response
}

describe('internal-api (loopback master-token client)', () => {
  it('calls 127.0.0.1:<port>/api<path> with the bearer token and JSON body, parsing JSON back', async () => {
    const fetchImpl = vi.fn(async () => response(202, '{"loopRunIds":["r1"]}'))
    const api = createInternalApi({ port: 4321, fetchImpl: fetchImpl as unknown as typeof fetch, token: () => 'tok' })
    const res = await api.call('POST', '/projects/p1/rails/0/launch', { mode: 'batch-implement' })
    expect(res).toEqual({ ok: true, status: 202, body: { loopRunIds: ['r1'] } })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:4321/api/projects/p1/rails/0/launch')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json')
    expect(init.body).toBe('{"mode":"batch-implement"}')
  })

  it('never throws on 4xx — the status + parsed body come back for typed handling', async () => {
    const fetchImpl = vi.fn(async () => response(409, '{"error":"tickets_in_flight","ticketIds":[1]}'))
    const api = createInternalApi({ port: 1, fetchImpl: fetchImpl as unknown as typeof fetch, token: () => 't' })
    const res = await api.call('GET', '/x')
    expect(res.ok).toBe(false)
    expect(res.status).toBe(409)
    expect(internalApiError(res)).toEqual({ error: 'tickets_in_flight' })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBeUndefined()
    expect((init.headers as Record<string, string>)['content-type']).toBeUndefined()
  })

  it('non-JSON and empty bodies are tolerated', async () => {
    const api = createInternalApi({ port: 1, fetchImpl: (async () => response(500, 'boom')) as unknown as typeof fetch, token: () => 't' })
    const res = await api.call('DELETE', '/y')
    expect(res.body).toBe('boom')
    expect(internalApiError(res)).toEqual({ error: 'http_500', detail: 'boom' })
    const empty = createInternalApi({ port: 1, fetchImpl: (async () => response(204, '')) as unknown as typeof fetch, token: () => 't' })
    expect((await empty.call('GET', '/z')).body).toBeNull()
    expect(internalApiError({ ok: false, status: 502, body: null })).toEqual({ error: 'http_502' })
    expect(internalApiError({ ok: false, status: 400, body: { error: 'x', detail: 'why' } })).toEqual({ error: 'x', detail: 'why' })
  })
})
