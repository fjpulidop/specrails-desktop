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

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('jiraApi.getSpecDetails', () => {
  const DETAILS = {
    fields: [
      { label: 'Status', value: 'In Progress' },
      { label: 'Epic Link', value: 'PROJ-1', href: 'https://acme.atlassian.net/browse/PROJ-1' },
    ],
    development: {
      pullRequests: [
        {
          id: '1',
          title: 'Add feature',
          url: 'https://github.com/acme/repo/pull/1',
          status: 'OPEN',
          sourceBranch: 'feature/x',
          destBranch: 'main',
          author: 'Ada',
          lastUpdate: '2026-06-01T12:00:00Z',
        },
      ],
      branches: [],
      commits: [],
    },
  }

  it('GETs the spec details endpoint and parses the body', async () => {
    const fn = mockFetch(DETAILS)
    const result = await jiraApi.getSpecDetails(7)
    const { url, init } = call(fn)
    expect(url).toBe(`${BASE}/jira/specs/7/details`)
    // No explicit init/method => GET
    expect(init.method).toBeUndefined()
    expect(result).toEqual(DETAILS)
  })

  it('rejects with the body error message on a non-ok response', async () => {
    mockFetch({ error: 'issue-error' }, { ok: false, status: 502 })
    await expect(jiraApi.getSpecDetails(7)).rejects.toThrow('issue-error')
  })

  it('rejects with a generic message including the status when the body has no error', async () => {
    mockFetch(undefined, { ok: false, status: 409, raw: '' })
    await expect(jiraApi.getSpecDetails(7)).rejects.toThrow('Request failed (409)')
  })
})
