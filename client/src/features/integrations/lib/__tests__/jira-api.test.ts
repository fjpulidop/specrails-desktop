import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jiraApi } from '../jira-api'

vi.mock('../../../../lib/api', () => ({ getApiBase: () => '/api/projects/p1' }))

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
const TEST_INPUT = { baseUrl: 'https://acme.atlassian.net', accountEmail: 'a@b.com', token: 'tok' }

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('jiraApi.getConnection', () => {
  it('GETs the connection endpoint and parses the body', async () => {
    const body = { connected: true, connection: { projectId: 'p1' } }
    const fn = mockFetch(body)
    const result = await jiraApi.getConnection()
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/connection`)
    // No explicit init/method => GET
    expect(init.method).toBeUndefined()
    expect(result).toEqual(body)
  })
})

describe('jiraApi.test', () => {
  it('POSTs the test input as JSON', async () => {
    const body = { ok: true, deployment: 'cloud', displayName: 'Acme' }
    const fn = mockFetch(body)
    const result = await jiraApi.test(TEST_INPUT)
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/test`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(JSON_HEADERS)
    expect(init.body).toBe(JSON.stringify(TEST_INPUT))
    expect(JSON.parse(init.body as string)).toEqual(TEST_INPUT)
    expect(result).toEqual(body)
  })
})

describe('jiraApi.discoverProjects', () => {
  it('POSTs the discover-projects endpoint with the query field', async () => {
    const body = { projects: [{ id: '1', key: 'AB', name: 'Alpha' }] }
    const fn = mockFetch(body)
    const input = { ...TEST_INPUT, query: 'alp' }
    const result = await jiraApi.discoverProjects(input)
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/discover-projects`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(init.body as string)).toEqual(input)
    expect(result).toEqual(body)
  })
})

describe('jiraApi.discoverStatuses', () => {
  it('POSTs the discover-statuses endpoint with projectKey', async () => {
    const body = { statuses: [{ id: '10', name: 'To Do', category: 'new' }] }
    const fn = mockFetch(body)
    const input = { ...TEST_INPUT, projectKey: 'AB' }
    const result = await jiraApi.discoverStatuses(input)
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/discover-statuses`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(init.body as string)).toEqual(input)
    expect(result).toEqual(body)
  })
})

describe('jiraApi.connect', () => {
  it('POSTs the connect endpoint with jiraProjectKey + statusMap', async () => {
    const body = { connection: { projectId: 'p1', enabled: true } }
    const fn = mockFetch(body)
    const input = { ...TEST_INPUT, jiraProjectKey: 'AB', statusMap: { todo: '10' } }
    const result = await jiraApi.connect(input)
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/connect`)
    expect(init.method).toBe('POST')
    expect(init.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(init.body as string)).toEqual(input)
    expect(result).toEqual(body)
  })
})

describe('jiraApi.setEnabled', () => {
  it('PATCHes the connection endpoint with the enabled flag', async () => {
    const body = { connection: { projectId: 'p1', enabled: false } }
    const fn = mockFetch(body)
    const result = await jiraApi.setEnabled(false)
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/connection`)
    expect(init.method).toBe('PATCH')
    expect(init.headers).toEqual(JSON_HEADERS)
    expect(JSON.parse(init.body as string)).toEqual({ enabled: false })
    expect(result).toEqual(body)
  })
})

describe('jiraApi.disconnect', () => {
  it('DELETEs the connection endpoint', async () => {
    const body = { connected: false }
    const fn = mockFetch(body)
    const result = await jiraApi.disconnect()
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/connection`)
    expect(init.method).toBe('DELETE')
    expect(init.body).toBeUndefined()
    expect(result).toEqual(body)
  })
})

describe('jiraApi.syncNow', () => {
  it('POSTs the sync endpoint', async () => {
    const body = { ok: true, upserted: 7 }
    const fn = mockFetch(body)
    const result = await jiraApi.syncNow()
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/sync`)
    expect(init.method).toBe('POST')
    expect(init.body).toBeUndefined()
    expect(result).toEqual(body)
  })
})

describe('jiraApi.resume', () => {
  it('POSTs the resume endpoint', async () => {
    const body = { ok: true }
    const fn = mockFetch(body)
    const result = await jiraApi.resume()
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/resume`)
    expect(init.method).toBe('POST')
    expect(result).toEqual(body)
  })
})

describe('jiraApi.listOutbox', () => {
  it('GETs the outbox endpoint with no querystring when state is omitted', async () => {
    const body = {
      ops: [],
      counts: { pending: 0, inflight: 0, done: 0, dead: 0 },
    }
    const fn = mockFetch(body)
    const result = await jiraApi.listOutbox()
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/outbox`)
    expect(init.method).toBeUndefined()
    expect(result).toEqual(body)
  })

  it('GETs the outbox endpoint with ?state=<state> when provided', async () => {
    const body = {
      ops: [
        {
          id: 1,
          jiraIssueId: 'AB-1',
          opType: 'transition',
          state: 'dead',
          attempts: 3,
          lastError: 'boom',
          deadReason: 'max-attempts',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-02',
        },
      ],
      counts: { pending: 0, inflight: 0, done: 0, dead: 1 },
    }
    const fn = mockFetch(body)
    const result = await jiraApi.listOutbox('dead')
    const { url } = call(fn)
    expect(url).toBe(`${BASE}/jira/outbox?state=dead`)
    expect(result).toEqual(body)
  })
})

describe('jiraApi.retryOutbox', () => {
  it('POSTs the retry endpoint with the op id in the path', async () => {
    const body = { ok: true }
    const fn = mockFetch(body)
    const result = await jiraApi.retryOutbox(42)
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/outbox/42/retry`)
    expect(init.method).toBe('POST')
    expect(result).toEqual(body)
  })
})

describe('asJson error path', () => {
  it('rejects with the body error message on a non-ok response', async () => {
    mockFetch({ error: 'Invalid credentials' }, { ok: false, status: 401 })
    await expect(jiraApi.getConnection()).rejects.toThrow('Invalid credentials')
  })

  it('rejects with a generic message including the status when the body is empty', async () => {
    mockFetch(undefined, { ok: false, status: 503, raw: '' })
    await expect(jiraApi.syncNow()).rejects.toThrow('Request failed (503)')
  })

  it('parses an ok response with an empty body into {}', async () => {
    const fn = mockFetch(undefined, { ok: true, status: 204, raw: '' })
    const result = await jiraApi.resume()
    call(fn)
    expect(result).toEqual({})
  })
})
