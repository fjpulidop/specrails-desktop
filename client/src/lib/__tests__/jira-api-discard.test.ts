import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraApi } from '../../features/integrations/lib/jira-api'

vi.mock('../api', () => ({ getApiBase: () => '/api/projects/p1' }))

const BASE = '/api/projects/p1'

function mockFetch(body: unknown, opts: { ok?: boolean; status?: number; raw?: string } = {}) {
  const ok = opts.ok ?? true
  const status = opts.status ?? (ok ? 200 : 500)
  const text = opts.raw !== undefined ? opts.raw : JSON.stringify(body)
  const fn = vi.fn(async () => ({
    ok,
    status,
    text: async () => text,
  }))
  global.fetch = fn as unknown as typeof fetch
  return fn
}

/** Reads the [url, init] of the single fetch call. */
function call(fn: ReturnType<typeof vi.fn>) {
  expect(fn).toHaveBeenCalledTimes(1)
  const [url, init] = fn.mock.calls[0]
  return { url, init: (init ?? {}) as RequestInit }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('jiraApi.discardSpec', () => {
  it('POSTs /jira/specs/:id/discard with the comment in the body', async () => {
    const body = { ok: true }
    const fn = mockFetch(body)
    const result = await jiraApi.discardSpec(7, 'No longer needed')
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/specs/7/discard`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(init.body as string)).toEqual({ comment: 'No longer needed' })
    expect(result).toEqual(body)
  })

  it('serializes a null comment in the body', async () => {
    const body = { ok: true }
    const fn = mockFetch(body)
    await jiraApi.discardSpec(42, null)
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/specs/42/discard`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ comment: null })
  })

  it('propagates the server error message on a non-ok response', async () => {
    mockFetch({ error: 'Discard status not configured' }, { ok: false, status: 409 })
    await expect(jiraApi.discardSpec(7, null)).rejects.toThrow('Discard status not configured')
  })
})

describe('jiraApi.patchConnection', () => {
  it('PATCHes /jira/connection with the discardStatus patch', async () => {
    const body = { connection: { projectId: 'p1', discardStatus: 'Cancelled' } }
    const fn = mockFetch(body)
    const result = await jiraApi.patchConnection({ discardStatus: 'Cancelled' })
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/connection`)
    expect(init.method).toBe('PATCH')
    expect(init.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(init.body as string)).toEqual({ discardStatus: 'Cancelled' })
    expect(result).toEqual(body)
  })

  it('PATCHes a null discardStatus (clear the configuration)', async () => {
    const body = { connection: { projectId: 'p1', discardStatus: null } }
    const fn = mockFetch(body)
    await jiraApi.patchConnection({ discardStatus: null })
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/connection`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ discardStatus: null })
  })

  it('PATCHes the enabled flag alongside the discardStatus when both are provided', async () => {
    const body = { connection: { projectId: 'p1', enabled: false, discardStatus: 'Done' } }
    const fn = mockFetch(body)
    await jiraApi.patchConnection({ enabled: false, discardStatus: 'Done' })
    const { init } = call(fn)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false, discardStatus: 'Done' })
  })
})

describe('jiraApi.listStatuses', () => {
  it('GETs /jira/statuses and returns the statuses', async () => {
    const body = {
      statuses: [
        { id: '10', name: 'To Do', category: 'new' },
        { id: '20', name: 'Cancelled', category: 'done' },
      ],
    }
    const fn = mockFetch(body)
    const result = await jiraApi.listStatuses()
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/statuses`)
    // No explicit init/method => GET
    expect(init.method).toBeUndefined()
    expect(result).toEqual(body)
  })

  it('propagates the server error message on a non-ok response', async () => {
    mockFetch({ error: 'Not connected' }, { ok: false, status: 400 })
    await expect(jiraApi.listStatuses()).rejects.toThrow('Not connected')
  })
})
