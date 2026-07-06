import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  JiraClient,
  detectDeployment,
  assertSecureJiraBaseUrl,
  JiraUrlError,
  type FetchImpl,
  type JiraClientConfig,
} from './jira-client'

// The fetchImpl produced by the most recent makeFetch() call. cloudCfg()/dcCfg()
// default to it so every test that calls makeFetch() before constructing a
// client is wired to the fake transport without per-call plumbing.
let currentFetchImpl: FetchImpl | undefined

afterEach(() => {
  currentFetchImpl = undefined
})

// ───────────────────────────────────────────────────────────────────────────
// Fake fetch harness. Captures every outbound request and returns a configurable
// response keyed by an optional matcher. Never hits the network.
// ───────────────────────────────────────────────────────────────────────────

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: any // parsed JSON body, or undefined when no body
  rawBody: string | undefined
  init: any
}

interface FakeResponseSpec {
  status?: number
  ok?: boolean
  body?: unknown // object => JSON.stringify; string => verbatim; undefined => empty
  headers?: Record<string, string>
  /** Throw inside fetch (network failure). */
  throwError?: Error | string
  /** Throw inside text() (parse path). */
  textThrows?: Error
}

function makeFetch(
  responder:
    | FakeResponseSpec
    | ((req: CapturedRequest) => FakeResponseSpec)
): { fetchImpl: FetchImpl; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = []
  const fetchImpl: FetchImpl = async (url: string, init?: any) => {
    const rawBody: string | undefined = init?.body
    let parsed: any = undefined
    if (typeof rawBody === 'string') {
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        parsed = rawBody
      }
    }
    const captured: CapturedRequest = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: parsed,
      rawBody,
      init,
    }
    requests.push(captured)

    const spec = typeof responder === 'function' ? responder(captured) : responder

    if (spec.throwError) {
      throw typeof spec.throwError === 'string' ? spec.throwError : spec.throwError
    }

    const status = spec.status ?? 200
    const ok = spec.ok ?? (status >= 200 && status < 300)
    const bodyText =
      spec.body === undefined
        ? ''
        : typeof spec.body === 'string'
          ? spec.body
          : JSON.stringify(spec.body)
    const headersObj = spec.headers ?? {}

    return {
      status,
      ok,
      headers: {
        get(name: string): string | null {
          // case-insensitive lookup
          const lower = name.toLowerCase()
          for (const k of Object.keys(headersObj)) {
            if (k.toLowerCase() === lower) return headersObj[k]
          }
          return null
        },
      },
      text: async () => {
        if (spec.textThrows) throw spec.textThrows
        return bodyText
      },
      json: async () => (bodyText ? JSON.parse(bodyText) : undefined),
    }
  }
  currentFetchImpl = fetchImpl
  return { fetchImpl, requests }
}

function cloudCfg(overrides: Partial<JiraClientConfig> = {}): JiraClientConfig {
  return {
    baseUrl: 'https://acme.atlassian.net',
    deployment: 'cloud',
    apiVersion: '3',
    authScheme: 'basic',
    accountEmail: 'user@acme.com',
    token: 'cloud-token',
    fetchImpl: currentFetchImpl,
    ...overrides,
  }
}

function dcCfg(overrides: Partial<JiraClientConfig> = {}): JiraClientConfig {
  return {
    baseUrl: 'https://jira.internal.example.com',
    deployment: 'dc',
    apiVersion: '2',
    authScheme: 'bearer',
    accountEmail: null,
    token: 'pat-token',
    fetchImpl: currentFetchImpl,
    ...overrides,
  }
}

// ───────────────────────────────────────────────────────────────────────────
// detectDeployment
// ───────────────────────────────────────────────────────────────────────────

describe('detectDeployment', () => {
  it('classifies *.atlassian.net as cloud (v3, basic)', () => {
    expect(detectDeployment('https://acme.atlassian.net')).toEqual({
      deployment: 'cloud',
      apiVersion: '3',
      authScheme: 'basic',
    })
  })

  it('classifies *.jira.com as cloud', () => {
    expect(detectDeployment('https://team.jira.com')).toEqual({
      deployment: 'cloud',
      apiVersion: '3',
      authScheme: 'basic',
    })
  })

  it('is case-insensitive on the host', () => {
    expect(detectDeployment('https://ACME.Atlassian.NET').deployment).toBe('cloud')
  })

  it('honours a path and trailing slash on a cloud url', () => {
    expect(detectDeployment('https://acme.atlassian.net/jira/').deployment).toBe('cloud')
  })

  it('classifies a self-hosted host as dc (v2, bearer)', () => {
    expect(detectDeployment('https://jira.internal.example.com')).toEqual({
      deployment: 'dc',
      apiVersion: '2',
      authScheme: 'bearer',
    })
  })

  it('does NOT treat a host merely containing atlassian.net as cloud unless it is a suffix', () => {
    // endsWith — a host like atlassian.net.evil.com must NOT match
    expect(detectDeployment('https://atlassian.net.evil.com').deployment).toBe('dc')
  })

  it('rejects an unparseable / scheme-less base URL (no insecure fallback)', () => {
    // Previously these fell back to a raw-string match; that fallback was a
    // security hole (no protocol validation) and is now rejected.
    expect(() => detectDeployment('mycompany.atlassian.net')).toThrow(JiraUrlError)
    expect(() => detectDeployment('not a url')).toThrow(JiraUrlError)
  })

  // ── BUG-JIRA-CLIENT-01: enforce https / loopback-only http ────────────────
  it('rejects a plaintext http base URL (creds would travel in cleartext)', () => {
    expect(() => detectDeployment('http://jira.internal.example.com')).toThrow(
      /must use https/
    )
  })

  it('allows http only for explicit localhost / loopback', () => {
    expect(detectDeployment('http://localhost:8080').deployment).toBe('dc')
    expect(detectDeployment('http://127.0.0.1:2990/jira').deployment).toBe('dc')
    expect(detectDeployment('http://[::1]:8080').deployment).toBe('dc')
  })

  it('still rejects http for a non-loopback host that merely looks local', () => {
    expect(() => detectDeployment('http://localhost.evil.com')).toThrow(/must use https/)
  })

  // ── BUG-JIRA-CLIENT-02: userinfo spoofing → wrong host ────────────────────
  it('rejects a base URL carrying userinfo (host-spoof guard)', () => {
    // new URL(...).host would be evil.com → classified dc → PAT sent to evil.com.
    expect(() => detectDeployment('https://acme.atlassian.net@evil.com/')).toThrow(
      JiraUrlError
    )
    expect(() => detectDeployment('https://user:pass@acme.atlassian.net/')).toThrow(
      /must not contain credentials/
    )
  })

  it('matches the parsed hostname (not host) so a port cannot spoof the suffix', () => {
    // A real cloud host with an explicit port still classifies as cloud.
    expect(detectDeployment('https://acme.atlassian.net:443/').deployment).toBe('cloud')
    // atlassian.net.evil.com is still dc (suffix match on hostname).
    expect(detectDeployment('https://atlassian.net.evil.com/').deployment).toBe('dc')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// assertSecureJiraBaseUrl — the shared validation primitive
// ───────────────────────────────────────────────────────────────────────────

describe('assertSecureJiraBaseUrl', () => {
  it('accepts a plain https cloud url and returns the lowercased hostname', () => {
    const { hostname } = assertSecureJiraBaseUrl('https://ACME.Atlassian.NET/jira/')
    expect(hostname).toBe('acme.atlassian.net')
  })

  it('rejects http for a non-loopback host', () => {
    expect(() => assertSecureJiraBaseUrl('http://jira.example.com')).toThrow(/must use https/)
  })

  it('permits http for loopback only', () => {
    expect(assertSecureJiraBaseUrl('http://127.0.0.1:2990').hostname).toBe('127.0.0.1')
  })

  it('rejects userinfo so the real host is never trusted', () => {
    expect(() => assertSecureJiraBaseUrl('https://x@evil.com')).toThrow(
      /must not contain credentials/
    )
  })

  it('throws a JiraUrlError carrying status 400', () => {
    try {
      assertSecureJiraBaseUrl('ftp://nope')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(JiraUrlError)
      expect((err as JiraUrlError).status).toBe(400)
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// constructor rejects insecure / spoofed base URLs (defence-in-depth)
// ───────────────────────────────────────────────────────────────────────────

describe('JiraClient constructor URL guard', () => {
  it('refuses to construct with a plaintext http base url', () => {
    expect(() => new JiraClient(dcCfg({ baseUrl: 'http://jira.example.com' }))).toThrow(
      /must use https/
    )
  })

  it('refuses to construct with a userinfo-bearing base url', () => {
    expect(
      () => new JiraClient(cloudCfg({ baseUrl: 'https://acme.atlassian.net@evil.com/' }))
    ).toThrow(JiraUrlError)
  })

  it('still constructs for a loopback http base url', () => {
    expect(new JiraClient(dcCfg({ baseUrl: 'http://localhost:8080' })).deployment).toBe('dc')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// constructor / auth / url
// ───────────────────────────────────────────────────────────────────────────

describe('JiraClient construction & auth', () => {
  it('exposes the configured deployment', () => {
    expect(new JiraClient(cloudCfg()).deployment).toBe('cloud')
    expect(new JiraClient(dcCfg()).deployment).toBe('dc')
  })

  it('uses globalThis.fetch when no fetchImpl is provided', async () => {
    const spy = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => '{"accountId":"a1"}',
      json: async () => ({ accountId: 'a1' }),
    }))
    const original = (globalThis as any).fetch
    ;(globalThis as any).fetch = spy
    try {
      const client = new JiraClient(cloudCfg({ fetchImpl: undefined }))
      const res = await client.myself()
      expect(spy).toHaveBeenCalledOnce()
      expect(res.ok).toBe(true)
    } finally {
      ;(globalThis as any).fetch = original
    }
  })

  it('builds a Basic auth header as base64(email:token) on cloud', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { accountId: 'x' } })
    await new JiraClient(cloudCfg({ accountEmail: 'bob@acme.com', token: 'sekret' })).myself()
    const expected = `Basic ${Buffer.from('bob@acme.com:sekret', 'utf-8').toString('base64')}`
    expect(requests[0].headers.Authorization).toBe(expected)
  })

  it('treats a null accountEmail as empty string in Basic auth', async () => {
    const { fetchImpl, requests } = makeFetch({ body: {} })
    await new JiraClient(cloudCfg({ accountEmail: null, token: 'sekret' })).myself()
    const expected = `Basic ${Buffer.from(':sekret', 'utf-8').toString('base64')}`
    expect(requests[0].headers.Authorization).toBe(expected)
  })

  it('builds a Bearer auth header from the raw PAT on dc', async () => {
    const { fetchImpl, requests } = makeFetch({ body: {} })
    await new JiraClient(dcCfg({ token: 'my-pat' })).myself()
    expect(requests[0].headers.Authorization).toBe('Bearer my-pat')
  })

  it('uses /rest/api/3 path segment on cloud', async () => {
    const { fetchImpl, requests } = makeFetch({ body: {} })
    await new JiraClient(cloudCfg()).myself()
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/myself')
  })

  it('uses /rest/api/2 path segment on dc', async () => {
    const { fetchImpl, requests } = makeFetch({ body: {} })
    await new JiraClient(dcCfg()).myself()
    expect(requests[0].url).toBe('https://jira.internal.example.com/rest/api/2/myself')
  })

  it('strips trailing slashes from the base url', async () => {
    const { fetchImpl, requests } = makeFetch({ body: {} })
    await new JiraClient(cloudCfg({ baseUrl: 'https://acme.atlassian.net///' })).myself()
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/myself')
  })

  it('sets Accept header and no Content-Type on a bodyless GET', async () => {
    const { fetchImpl, requests } = makeFetch({ body: {} })
    await new JiraClient(cloudCfg()).myself()
    expect(requests[0].headers.Accept).toBe('application/json')
    expect(requests[0].headers['Content-Type']).toBeUndefined()
    expect(requests[0].rawBody).toBeUndefined()
  })

  it('sets Content-Type and serialises the body on a POST', async () => {
    const { fetchImpl, requests } = makeFetch({ status: 204, ok: true, body: undefined })
    await new JiraClient(cloudCfg()).transitionIssue('PROJ-1', 'tid')
    expect(requests[0].headers['Content-Type']).toBe('application/json')
    expect(requests[0].rawBody).toBe(JSON.stringify({ transition: { id: 'tid' } }))
  })
})

// ───────────────────────────────────────────────────────────────────────────
// request() — ok / empty body / error classification / network
// ───────────────────────────────────────────────────────────────────────────

describe('request() success & body parsing', () => {
  it('parses a JSON body on a 200 ok response', async () => {
    const { fetchImpl } = makeFetch({ status: 200, body: { accountId: 'acc-1', displayName: 'Bob' } })
    const res = await new JiraClient(cloudCfg()).myself()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ accountId: 'acc-1', displayName: 'Bob' })
    }
  })

  it('returns data:undefined for an empty (204-style) body', async () => {
    const { fetchImpl } = makeFetch({ status: 204, ok: true, body: undefined })
    const res = await new JiraClient(cloudCfg()).transitionIssue('PROJ-1', 't1')
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data).toBeUndefined()
      expect(res.status).toBe(204)
    }
  })
})

describe('request() error classification', () => {
  const cases: Array<{ status: number; code: string }> = [
    { status: 401, code: 'auth' },
    { status: 403, code: 'permission' },
    { status: 404, code: 'not_found' },
    { status: 429, code: 'rate_limit' },
    { status: 400, code: 'validation' },
    { status: 422, code: 'validation' }, // any other 4xx => validation
    { status: 500, code: 'server' },
    { status: 503, code: 'server' },
  ]

  for (const { status, code } of cases) {
    it(`maps HTTP ${status} → code '${code}'`, async () => {
      const { fetchImpl } = makeFetch({ status, ok: false, body: { errorMessages: ['boom'] } })
      const res = await new JiraClient(cloudCfg()).myself()
      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.code).toBe(code)
        expect(res.status).toBe(status)
        expect(res.error).toContain('boom')
      }
    })
  }

  it('truncates a very long error body to 500 chars + ellipsis', async () => {
    const long = 'x'.repeat(1000)
    const { fetchImpl } = makeFetch({ status: 400, ok: false, body: long })
    const res = await new JiraClient(cloudCfg()).myself()
    expect(res.ok).toBe(false)
    if (!res.ok) {
      // string body is not JSON => returned verbatim then truncated
      expect(res.error.length).toBe(501) // 500 chars + the ellipsis char
      expect(res.error.endsWith('…')).toBe(true)
    }
  })

  it('does not truncate an error body at exactly 500 chars', async () => {
    const exact = 'y'.repeat(500)
    const { fetchImpl } = makeFetch({ status: 400, ok: false, body: exact })
    const res = await new JiraClient(cloudCfg()).myself()
    if (!res.ok) {
      expect(res.error).toBe(exact)
      expect(res.error.endsWith('…')).toBe(false)
    }
  })

  it('tolerates a text() failure on the error path (catch → empty string)', async () => {
    const { fetchImpl } = makeFetch({ status: 500, ok: false, textThrows: new Error('stream broke') })
    const res = await new JiraClient(cloudCfg()).myself()
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('server')
      expect(res.error).toBe('')
    }
  })
})

describe('request() Retry-After parsing on 429', () => {
  it('parses numeric Retry-After seconds → ms', async () => {
    const { fetchImpl } = makeFetch({ status: 429, ok: false, headers: { 'Retry-After': '5' } })
    const res = await new JiraClient(cloudCfg()).myself()
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('rate_limit')
      expect(res.retryAfterMs).toBe(5000)
    }
  })

  it('omits retryAfterMs when there is no Retry-After header', async () => {
    const { fetchImpl } = makeFetch({ status: 429, ok: false })
    const res = await new JiraClient(cloudCfg()).myself()
    if (!res.ok) {
      expect(res.code).toBe('rate_limit')
      expect(res.retryAfterMs).toBeUndefined()
    }
  })

  it('parses an HTTP-date Retry-After into a future delta', async () => {
    const future = new Date(Date.now() + 10_000).toUTCString()
    const { fetchImpl } = makeFetch({ status: 429, ok: false, headers: { 'Retry-After': future } })
    const res = await new JiraClient(cloudCfg()).myself()
    if (!res.ok) {
      expect(res.retryAfterMs).toBeGreaterThan(0)
      expect(res.retryAfterMs!).toBeLessThanOrEqual(10_000)
    }
  })

  it('keeps a past HTTP-date Retry-After as 0 (immediate retry, not dropped)', async () => {
    const past = new Date(Date.now() - 50_000).toUTCString()
    const { fetchImpl } = makeFetch({ status: 429, ok: false, headers: { 'Retry-After': past } })
    const res = await new JiraClient(cloudCfg()).myself()
    if (!res.ok) {
      // parseRetryAfter returns 0 for a past date → Jira says retry now. The fix
      // guards on `!== undefined`, so 0 is preserved instead of falling through
      // to exponential backoff.
      expect(res.retryAfterMs).toBe(0)
    }
  })

  it('drops retryAfterMs when Retry-After is unparseable', async () => {
    const { fetchImpl } = makeFetch({ status: 429, ok: false, headers: { 'Retry-After': 'soon-ish' } })
    const res = await new JiraClient(cloudCfg()).myself()
    if (!res.ok) {
      expect(res.retryAfterMs).toBeUndefined()
    }
  })
})

describe('request() network failures', () => {
  it('maps a thrown Error to code:network with the message', async () => {
    const { fetchImpl } = makeFetch({ throwError: new Error('ECONNREFUSED') })
    const res = await new JiraClient(cloudCfg()).myself()
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.code).toBe('network')
      expect(res.status).toBe(0)
      expect(res.error).toBe('ECONNREFUSED')
    }
  })

  it('maps a thrown non-Error value to code:network with String(value)', async () => {
    const { fetchImpl } = makeFetch({ throwError: 'string failure' })
    const res = await new JiraClient(cloudCfg()).myself()
    if (!res.ok) {
      expect(res.code).toBe('network')
      expect(res.error).toBe('string failure')
    }
  })
})

// ───────────────────────────────────────────────────────────────────────────
// metadata endpoints
// ───────────────────────────────────────────────────────────────────────────

describe('myself', () => {
  it('GETs /myself', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { accountId: 'a' } })
    await new JiraClient(cloudCfg()).myself()
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/myself')
  })
})

describe('getProject', () => {
  it('GETs /project/{key} with the key URL-encoded', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'PROJ', name: 'Project' } })
    const res = await new JiraClient(cloudCfg()).getProject('PR OJ/special')
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe(
      'https://acme.atlassian.net/rest/api/3/project/PR%20OJ%2Fspecial'
    )
    expect(res.ok).toBe(true)
  })
})

describe('myPermissions', () => {
  it('GETs /mypermissions with comma-joined permissions and no projectKey', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { permissions: {} } })
    await new JiraClient(cloudCfg()).myPermissions(['CREATE_ISSUES', 'TRANSITION_ISSUES'])
    expect(requests[0].url).toBe(
      'https://acme.atlassian.net/rest/api/3/mypermissions?permissions=CREATE_ISSUES%2CTRANSITION_ISSUES'
    )
  })

  it('appends projectKey when provided', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { permissions: {} } })
    await new JiraClient(cloudCfg()).myPermissions(['CREATE_ISSUES'], 'PROJ')
    const url = new URL(requests[0].url)
    expect(url.searchParams.get('permissions')).toBe('CREATE_ISSUES')
    expect(url.searchParams.get('projectKey')).toBe('PROJ')
  })
})

describe('getProjectStatuses', () => {
  it('GETs /project/{key}/statuses', async () => {
    const { fetchImpl, requests } = makeFetch({ body: [{ name: 'Bug', statuses: [] }] })
    await new JiraClient(dcCfg()).getProjectStatuses('PROJ')
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe(
      'https://jira.internal.example.com/rest/api/2/project/PROJ/statuses'
    )
  })
})

// ───────────────────────────────────────────────────────────────────────────
// searchProjects
// ───────────────────────────────────────────────────────────────────────────

describe('searchProjects (cloud v3)', () => {
  it('GETs /project/search and returns values', async () => {
    const values = [
      { id: '1', key: 'A', name: 'Alpha' },
      { id: '2', key: 'B', name: 'Beta' },
    ]
    const { fetchImpl, requests } = makeFetch({ body: { values } })
    const res = await new JiraClient(cloudCfg()).searchProjects()
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe(
      'https://acme.atlassian.net/rest/api/3/project/search?maxResults=50'
    )
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual(values)
  })

  it('passes a query through as the query param', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { values: [] } })
    await new JiraClient(cloudCfg()).searchProjects('alpha')
    const url = new URL(requests[0].url)
    expect(url.searchParams.get('query')).toBe('alpha')
    expect(url.searchParams.get('maxResults')).toBe('50')
  })

  it('defaults to [] when values is absent', async () => {
    const { fetchImpl } = makeFetch({ body: {} })
    const res = await new JiraClient(cloudCfg()).searchProjects()
    if (res.ok) expect(res.data).toEqual([])
  })

  it('propagates an error result unchanged', async () => {
    const { fetchImpl } = makeFetch({ status: 401, ok: false, body: { errorMessages: ['nope'] } })
    const res = await new JiraClient(cloudCfg()).searchProjects('x')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('auth')
  })
})

describe('searchProjects (dc v2)', () => {
  it('GETs /project (full list) and returns it unfiltered when no query', async () => {
    const all = [
      { id: '1', key: 'A', name: 'Alpha' },
      { id: '2', key: 'B', name: 'Beta' },
    ]
    const { fetchImpl, requests } = makeFetch({ body: all })
    const res = await new JiraClient(dcCfg()).searchProjects()
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe('https://jira.internal.example.com/rest/api/2/project')
    if (res.ok) expect(res.data).toEqual(all)
  })

  it('filters the full list by key+name (case-insensitive) on a query', async () => {
    const all = [
      { id: '1', key: 'WEB', name: 'Web App' },
      { id: '2', key: 'API', name: 'Backend' },
      { id: '3', key: 'MOB', name: 'Mobile' },
    ]
    const { fetchImpl } = makeFetch({ body: all })
    const res = await new JiraClient(dcCfg()).searchProjects('web')
    if (res.ok) {
      expect(res.data.map((p) => p.key)).toEqual(['WEB'])
    }
  })

  it('matches the query against the name portion too', async () => {
    const all = [
      { id: '1', key: 'WEB', name: 'Web App' },
      { id: '2', key: 'API', name: 'Backend Service' },
    ]
    const { fetchImpl } = makeFetch({ body: all })
    const res = await new JiraClient(dcCfg()).searchProjects('backend')
    if (res.ok) expect(res.data.map((p) => p.key)).toEqual(['API'])
  })

  it('caps the filtered result to 50', async () => {
    const all = Array.from({ length: 80 }, (_, i) => ({
      id: String(i),
      key: `K${i}`,
      name: 'common',
    }))
    const { fetchImpl } = makeFetch({ body: all })
    const res = await new JiraClient(dcCfg()).searchProjects('common')
    if (res.ok) expect(res.data.length).toBe(50)
  })

  it('caps the unfiltered result to 50 as well', async () => {
    const all = Array.from({ length: 80 }, (_, i) => ({ id: String(i), key: `K${i}`, name: 'n' }))
    const { fetchImpl } = makeFetch({ body: all })
    const res = await new JiraClient(dcCfg()).searchProjects()
    if (res.ok) expect(res.data.length).toBe(50)
  })

  it('propagates an error result from /project', async () => {
    const { fetchImpl } = makeFetch({ status: 500, ok: false, body: 'oops' })
    const res = await new JiraClient(dcCfg()).searchProjects('x')
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('server')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// searchJql
// ───────────────────────────────────────────────────────────────────────────

describe('searchJql (cloud v3)', () => {
  it('POSTs /search/jql with jql, fields and default maxResults', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { issues: [], isLast: true } })
    await new JiraClient(cloudCfg()).searchJql({ jql: 'project = X', fields: ['summary', 'status'] })
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/search/jql')
    expect(requests[0].body).toEqual({
      jql: 'project = X',
      fields: ['summary', 'status'],
      maxResults: 100,
    })
  })

  it('passes nextPageToken through (not converted to startAt)', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { issues: [], nextPageToken: 'tok-2' } })
    const res = await new JiraClient(cloudCfg()).searchJql({
      jql: 'project = X',
      fields: ['summary'],
      nextPageToken: 'tok-1',
      maxResults: 25,
    })
    expect(requests[0].body).toEqual({
      jql: 'project = X',
      fields: ['summary'],
      maxResults: 25,
      nextPageToken: 'tok-1',
    })
    expect(requests[0].body.startAt).toBeUndefined()
    if (res.ok) expect(res.data.nextPageToken).toBe('tok-2')
  })

  it('passes reconcileIssues through when supplied', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { issues: [] } })
    await new JiraClient(cloudCfg()).searchJql({
      jql: 'project = X',
      fields: ['summary'],
      reconcileIssues: ['10001', '10002'],
    })
    expect(requests[0].body.reconcileIssues).toEqual(['10001', '10002'])
  })

  it('omits reconcileIssues and nextPageToken when not supplied', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { issues: [] } })
    await new JiraClient(cloudCfg()).searchJql({ jql: 'x', fields: ['summary'] })
    expect('reconcileIssues' in requests[0].body).toBe(false)
    expect('nextPageToken' in requests[0].body).toBe(false)
  })
})

describe('searchJql (dc v2)', () => {
  it('POSTs the classic /search with startAt derived from nextPageToken', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { issues: [] } })
    await new JiraClient(dcCfg()).searchJql({
      jql: 'project = Y',
      fields: ['summary'],
      nextPageToken: '50',
    })
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toBe('https://jira.internal.example.com/rest/api/2/search')
    expect(requests[0].body).toEqual({
      jql: 'project = Y',
      fields: ['summary'],
      maxResults: 100,
      startAt: 50,
    })
  })

  it('defaults startAt to 0 when nextPageToken is absent', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { issues: [] } })
    await new JiraClient(dcCfg()).searchJql({ jql: 'q', fields: ['summary'], maxResults: 10 })
    expect(requests[0].body.startAt).toBe(0)
    expect(requests[0].body.maxResults).toBe(10)
  })

  it('coerces a non-numeric nextPageToken to startAt 0', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { issues: [] } })
    await new JiraClient(dcCfg()).searchJql({ jql: 'q', fields: ['summary'], nextPageToken: 'abc' })
    expect(requests[0].body.startAt).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// getIssue
// ───────────────────────────────────────────────────────────────────────────

describe('getIssue', () => {
  it('GETs /issue/{id} with no fields query when fields omitted', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'PROJ-1', fields: {} } })
    await new JiraClient(cloudCfg()).getIssue('PROJ-1')
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1')
  })

  it('appends a URL-encoded comma-joined fields query when fields provided', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'PROJ-1', fields: {} } })
    await new JiraClient(cloudCfg()).getIssue('PROJ-1', ['summary', 'status', 'updated'])
    expect(requests[0].url).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/PROJ-1?fields=summary%2Cstatus%2Cupdated'
    )
  })

  it('URL-encodes the issue id', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P/1', fields: {} } })
    await new JiraClient(cloudCfg()).getIssue('P/1')
    expect(requests[0].url).toContain('/issue/P%2F1')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// getTransitions
// ───────────────────────────────────────────────────────────────────────────

describe('getTransitions', () => {
  it('GETs transitions with the expand query', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { transitions: [] } })
    await new JiraClient(cloudCfg()).getTransitions('PROJ-1')
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe(
      'https://acme.atlassian.net/rest/api/3/issue/PROJ-1/transitions?expand=transitions.fields'
    )
  })

  it('URL-encodes the issue id', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { transitions: [] } })
    await new JiraClient(cloudCfg()).getTransitions('A B')
    expect(requests[0].url).toContain('/issue/A%20B/transitions')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// transitionIssue
// ───────────────────────────────────────────────────────────────────────────

describe('transitionIssue', () => {
  it('POSTs only the transition id when no fields given', async () => {
    const { fetchImpl, requests } = makeFetch({ status: 204, ok: true, body: undefined })
    await new JiraClient(cloudCfg()).transitionIssue('PROJ-1', '31')
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/transitions')
    expect(requests[0].body).toEqual({ transition: { id: '31' } })
  })

  it('includes fields when a non-empty fields object is given', async () => {
    const { fetchImpl, requests } = makeFetch({ status: 204, ok: true, body: undefined })
    await new JiraClient(cloudCfg()).transitionIssue('PROJ-1', '31', {
      resolution: { name: 'Done' },
    })
    expect(requests[0].body).toEqual({
      transition: { id: '31' },
      fields: { resolution: { name: 'Done' } },
    })
  })

  it('omits fields when an empty fields object is given', async () => {
    const { fetchImpl, requests } = makeFetch({ status: 204, ok: true, body: undefined })
    await new JiraClient(cloudCfg()).transitionIssue('PROJ-1', '31', {})
    expect(requests[0].body).toEqual({ transition: { id: '31' } })
    expect('fields' in requests[0].body).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// createIssue
// ───────────────────────────────────────────────────────────────────────────

describe('createIssue', () => {
  it('POSTs /issue with the minimal required fields', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '10001', key: 'PROJ-5' } })
    const res = await new JiraClient(cloudCfg()).createIssue({
      projectKey: 'PROJ',
      issueType: 'Task',
      summary: 'A summary',
    })
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue')
    expect(requests[0].body).toEqual({
      fields: {
        project: { key: 'PROJ' },
        issuetype: { name: 'Task' },
        summary: 'A summary',
      },
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ id: '10001', key: 'PROJ-5' })
  })

  it('truncates the summary to 250 chars', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(cloudCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Task',
      summary: 'z'.repeat(300),
    })
    expect((requests[0].body.fields.summary as string).length).toBe(250)
  })

  it('renders an ADF description on cloud', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(cloudCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Task',
      summary: 's',
      description: 'line one\nline two',
    })
    const desc = requests[0].body.fields.description
    expect(desc).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'line one' },
            { type: 'hardBreak' },
            { type: 'text', text: 'line two' },
          ],
        },
      ],
    })
  })

  it('renders markdown descriptions as rich ADF on cloud', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(cloudCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Task',
      summary: 's',
      description: '## Scope\n\n- First\n- **Second**',
    })
    const desc = requests[0].body.fields.description
    expect(desc.content[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } })
    expect(desc.content[2]).toMatchObject({ type: 'bulletList' })
    expect(desc.content[2].content[1].content[0].content).toContainEqual({
      type: 'text',
      text: 'Second',
      marks: [{ type: 'strong' }],
    })
  })

  it('renders a plain-string description on dc', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(dcCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Task',
      summary: 's',
      description: 'wiki *bold* text',
    })
    expect(requests[0].body.fields.description).toBe('wiki *bold* text')
  })

  it('omits description when it is an empty string (falsy)', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(cloudCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Task',
      summary: 's',
      description: '',
    })
    expect('description' in requests[0].body.fields).toBe(false)
  })

  it('includes labels when a non-empty array is given', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(cloudCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Task',
      summary: 's',
      labels: ['spec', 'auto'],
    })
    expect(requests[0].body.fields.labels).toEqual(['spec', 'auto'])
  })

  it('omits labels when given an empty array', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(cloudCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Task',
      summary: 's',
      labels: [],
    })
    expect('labels' in requests[0].body.fields).toBe(false)
  })

  it('includes a priority object when priority is given', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(cloudCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Task',
      summary: 's',
      priority: 'High',
    })
    expect(requests[0].body.fields.priority).toEqual({ name: 'High' })
  })

  it('omits priority when not given', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(cloudCfg()).createIssue({ projectKey: 'P', issueType: 'Task', summary: 's' })
    expect('priority' in requests[0].body.fields).toBe(false)
  })

  it('combines description + labels + priority in one create', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: '1', key: 'P-1' } })
    await new JiraClient(dcCfg()).createIssue({
      projectKey: 'P',
      issueType: 'Bug',
      summary: 's',
      description: 'desc',
      labels: ['x'],
      priority: 'Low',
    })
    expect(requests[0].body.fields).toEqual({
      project: { key: 'P' },
      issuetype: { name: 'Bug' },
      summary: 's',
      description: 'desc',
      labels: ['x'],
      priority: { name: 'Low' },
    })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// addComment
// ───────────────────────────────────────────────────────────────────────────

describe('addComment', () => {
  it('POSTs an ADF body on cloud', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: 'c1' } })
    const res = await new JiraClient(cloudCfg()).addComment('PROJ-1', 'hello\nworld')
    expect(requests[0].method).toBe('POST')
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/comment')
    expect(requests[0].body.body).toEqual({
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'hardBreak' },
            { type: 'text', text: 'world' },
          ],
        },
      ],
    })
    if (res.ok) expect(res.data).toEqual({ id: 'c1' })
  })

  it('POSTs a plain-string body on dc', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: 'c2' } })
    await new JiraClient(dcCfg()).addComment('PROJ-1', 'plain comment')
    expect(requests[0].url).toBe(
      'https://jira.internal.example.com/rest/api/2/issue/PROJ-1/comment'
    )
    expect(requests[0].body.body).toBe('plain comment')
  })

  it('URL-encodes the issue id', async () => {
    const { fetchImpl, requests } = makeFetch({ body: { id: 'c3' } })
    await new JiraClient(cloudCfg()).addComment('A/B', 'x')
    expect(requests[0].url).toContain('/issue/A%2FB/comment')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// getComments
// ───────────────────────────────────────────────────────────────────────────

describe('getComments', () => {
  it('GETs /issue/{id}/comment with pagination params (single page)', async () => {
    const comments = [{ id: '1', body: 'a' }]
    const { fetchImpl, requests } = makeFetch({ body: { comments, total: 1, startAt: 0 } })
    const res = await new JiraClient(cloudCfg()).getComments('PROJ-1')
    expect(requests[0].method).toBe('GET')
    expect(requests[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue/PROJ-1/comment?expand=properties&startAt=0&maxResults=100')
    if (res.ok) expect(res.data.comments).toEqual(comments)
  })

  it('pages through all comments until total is reached', async () => {
    // First page returns 100 (of 150), second returns the rest.
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: String(i), body: 'x' }))
    const page2 = Array.from({ length: 50 }, (_, i) => ({ id: String(100 + i), body: 'y' }))
    const { requests } = makeFetch((req) =>
      req.url.includes('startAt=0')
        ? { body: { comments: page1, total: 150, startAt: 0 } }
        : { body: { comments: page2, total: 150, startAt: 100 } },
    )
    const res = await new JiraClient(cloudCfg()).getComments('PROJ-1')
    expect(requests.length).toBe(2)
    expect(requests[1].url).toContain('startAt=100')
    if (res.ok) expect(res.data.comments).toHaveLength(150)
  })
})
