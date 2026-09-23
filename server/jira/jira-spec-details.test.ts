import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { initDb, type DbInstance } from '../db'
import { mutateStore, resolveTicketStoragePath, type Ticket } from '../modules/specs/runtime/ticket-store'
import { setSecretStore } from './jira-credential-store'
import { upsertConnection, insertLinkWithId, getLinkByLocalId, listLinks } from './jira-db'
import type { FetchImpl } from './jira-client'
import { JiraSyncManager, type JiraSyncManagerOpts } from './jira-sync-manager'

// ─── Fake fetch router (mirrors jira-discard.test.ts) ─────────────────────────
//
// Route by (method, urlSubstring) → queued responses. The longest registered
// substring matching the url wins so /rest/dev-status/1.0/issue/detail beats
// /rest/dev-status/1.0/issue/summary (distinct tails: 'detail' vs 'summary').

interface FakeResponseSpec {
  status: number
  body?: unknown
  retryAfter?: string
}

function makeFakeFetch() {
  const queues = new Map<string, FakeResponseSpec[]>()
  const calls: Array<{ method: string; url: string; body?: any }> = []

  function on(method: string, substring: string, ...specs: FakeResponseSpec[]) {
    const key = `${method} ${substring}`
    const q = queues.get(key) ?? []
    q.push(...specs)
    queues.set(key, q)
  }

  const fetchImpl: FetchImpl = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined })
    let best: { key: string; len: number } | null = null
    for (const key of queues.keys()) {
      if (!key.startsWith(`${method} `)) continue
      const sub = key.slice(method.length + 1)
      if (url.includes(sub) && (queues.get(key)?.length ?? 0) > 0) {
        if (!best || sub.length > best.len) best = { key, len: sub.length }
      }
    }
    if (!best) {
      throw new Error(`fake-fetch: no queued response for ${method} ${url}`)
    }
    const spec = queues.get(best.key)!.shift()!
    const text = spec.body === undefined ? '' : JSON.stringify(spec.body)
    return {
      status: spec.status,
      ok: spec.status >= 200 && spec.status < 300,
      headers: {
        get(name: string): string | null {
          if (name.toLowerCase() === 'retry-after' && spec.retryAfter) return spec.retryAfter
          return null
        },
      },
      text: async () => text,
      json: async () => spec.body,
    }
  }

  return { fetchImpl, on, calls, queues }
}

// ─── Shared harness ───────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-1'
const CLOUD_BASE = 'https://acme.atlassian.net'
const JIRA_KEY = 'ACME'
const JIRA_PROJECT_ID = '10000'

let db: DbInstance
let projectPath: string
let broadcasts: any[]

function collect(msg: any) {
  broadcasts.push(msg)
}

function typesOf(): string[] {
  return broadcasts.map((m) => m.type)
}

beforeEach(() => {
  db = initDb(':memory:')
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-spec-details-test-'))
  broadcasts = []
  // Deterministic secret store so getDecryptedToken round-trips.
  setSecretStore({ encrypt: (s: string) => 'enc:' + s, decrypt: (s: string) => s.slice(4) })
})

afterEach(() => {
  setSecretStore(null)
  fs.rmSync(projectPath, { recursive: true, force: true })
  vi.useRealTimers()
})

function makeManager(fetchImpl: FetchImpl, opts: Partial<JiraSyncManagerOpts> = {}): JiraSyncManager {
  return new JiraSyncManager({
    db,
    projectId: PROJECT_ID,
    projectPath,
    broadcast: collect,
    fetchImpl,
    startTimers: false,
    ...opts,
  })
}

/** Persist an enabled connection with a token directly (skips the connect() flow). */
function seedConnection(over: Partial<Parameters<typeof upsertConnection>[1]> = {}) {
  return upsertConnection(db, {
    projectId: PROJECT_ID,
    baseUrl: CLOUD_BASE,
    deployment: 'cloud',
    apiVersion: '3',
    authScheme: 'basic',
    accountEmail: 'me@acme.com',
    jiraProjectKey: JIRA_KEY,
    jiraProjectId: JIRA_PROJECT_ID,
    token: 'tok-123',
    enabled: true,
    statusMap: null,
    ...over,
  })
}

/** Seed a Jira link + a local ticket in the store for a given local id. */
function seedLinkedTicket(
  localId: number,
  jiraIssueId: string,
  over: Partial<Ticket> = {}
) {
  insertLinkWithId(db, {
    localId,
    jiraIssueId,
    jiraKey: `${JIRA_KEY}-${localId}`,
    jiraProjectId: JIRA_PROJECT_ID,
    deployment: 'cloud',
  })
  mutateStore(resolveTicketStoragePath(projectPath), (store) => {
    store.tickets[String(localId)] = {
      id: localId,
      title: `Ticket ${localId}`,
      description: '',
      status: 'todo',
      priority: 'medium',
      labels: [],
      assignee: null,
      prerequisites: [],
      metadata: {},
      comments: [],
      origin_conversation_id: null,
      is_epic: false,
      parent_epic_id: null,
      execution_order: null,
      short_summary: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      created_by: 'jira',
      source: 'jira',
      jira_key: `${JIRA_KEY}-${localId}`,
      jira_url: `${CLOUD_BASE}/browse/${JIRA_KEY}-${localId}`,
      ...over,
    }
    if (store.next_id <= localId) store.next_id = localId + 1
  })
}

// ─── Canned raw-issue + /field bodies ────────────────────────────────────────

/** A populated raw issue (fields=*all) covering several renderable shapes. */
function rawIssueBody(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    key: `${JIRA_KEY}-1`,
    fields: {
      summary: 'A summary',
      status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      issuetype: { name: 'Task' },
      reporter: { displayName: 'Jane Reporter' },
      assignee: { displayName: 'Joe Assignee' },
      // populated custom field with /field metadata → uses meta name.
      customfield_10050: 'High value',
      ...fields,
    },
  }
}

/** /field metadata that names customfield_10050. */
const FIELD_META = [
  { id: 'customfield_10050', name: 'Business Value', schema: { type: 'string' } },
]

/** A dev-status summary advertising a github applicationType for each key. */
function devSummaryBody() {
  return {
    summary: {
      pullrequest: { overall: { count: 1 }, byInstanceType: { github: { count: 1, name: 'GitHub' } } },
      branch: { overall: { count: 1 }, byInstanceType: { github: { count: 1, name: 'GitHub' } } },
      repository: { overall: { count: 1 }, byInstanceType: { github: { count: 1, name: 'GitHub' } } },
    },
  }
}

function devDetailPrBody() {
  return {
    detail: [
      {
        pullRequests: [
          {
            id: '#42',
            name: 'Add the thing',
            url: 'https://github.com/acme/repo/pull/42',
            status: 'OPEN',
            source: { branch: 'feature/thing' },
            destination: { branch: 'main' },
            author: { name: 'octocat' },
            lastUpdate: '2026-06-01T12:00:00.000Z',
          },
          // Dropped: no url.
          { id: '#43', name: 'No url PR', status: 'OPEN' },
        ],
      },
    ],
  }
}

function devDetailBranchBody() {
  return {
    detail: [
      {
        branches: [
          {
            name: 'feature/thing',
            url: 'https://github.com/acme/repo/tree/feature/thing',
            repository: { name: 'acme/repo', url: 'https://github.com/acme/repo' },
            lastCommit: {
              id: 'abcdef1234567890',
              displayId: 'abcdef1',
              message: 'commit msg',
              url: 'https://github.com/acme/repo/commit/abcdef1',
              author: { name: 'octocat' },
              authorTimestamp: '2026-06-01T12:00:00.000Z',
            },
          },
        ],
      },
    ],
  }
}

function devDetailRepoBody() {
  return {
    detail: [
      {
        repositories: [
          {
            name: 'acme/repo',
            url: 'https://github.com/acme/repo',
            commits: [
              {
                id: 'fedcba0987654321',
                displayId: 'fedcba0',
                message: 'another commit',
                url: 'https://github.com/acme/repo/commit/fedcba0',
                author: { name: 'octocat' },
                authorTimestamp: '2026-06-02T12:00:00.000Z',
              },
            ],
          },
        ],
      },
    ],
  }
}

/** Register the happy-path dev-status routes (summary + all three detail calls). */
function onHappyDevStatus(fake: ReturnType<typeof makeFakeFetch>) {
  fake.on('GET', '/rest/dev-status/1.0/issue/summary', { status: 200, body: devSummaryBody() })
  fake.on('GET', '/issue/detail?issueId=I-1&applicationType=github&dataType=pullrequest', {
    status: 200,
    body: devDetailPrBody(),
  })
  fake.on('GET', '/issue/detail?issueId=I-1&applicationType=github&dataType=branch', {
    status: 200,
    body: devDetailBranchBody(),
  })
  fake.on('GET', '/issue/detail?issueId=I-1&applicationType=github&dataType=repository', {
    status: 200,
    body: devDetailRepoBody(),
  })
}

// ─── 1. Happy path ─────────────────────────────────────────────────────────────

describe('getSpecDetails() happy path', () => {
  it('returns ok with populated fields + development PRs/branches/commits', async () => {
    seedConnection()
    seedLinkedTicket(1, 'I-1')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-1', { status: 200, body: rawIssueBody('I-1') })
    fake.on('GET', '/field', { status: 200, body: FIELD_META })
    onHappyDevStatus(fake)

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.getSpecDetails(1)

    expect(res.ok).toBe(true)
    if (!res.ok) return
    const { fields, development } = res.details

    // The custom field renders with its /field-derived label.
    const bv = fields.find((f) => f.label === 'Business Value')
    expect(bv?.value).toBe('High value')
    // System fields populated: issuetype + reporter render; assignee is in
    // SKIP_SYSTEM_FIELDS so it must NOT appear.
    expect(fields.find((f) => f.label === 'Issuetype')?.value).toBe('Task')
    expect(fields.some((f) => f.value === 'Jane Reporter')).toBe(true)
    expect(fields.some((f) => f.value === 'Joe Assignee')).toBe(false)

    // Development normalized: 1 PR (the url-less one dropped), 1 branch, 1 commit.
    expect(development.pullRequests).toHaveLength(1)
    expect(development.pullRequests[0]).toMatchObject({
      title: 'Add the thing',
      url: 'https://github.com/acme/repo/pull/42',
      status: 'OPEN',
      sourceBranch: 'feature/thing',
      destBranch: 'main',
      author: 'octocat',
    })
    expect(development.branches).toHaveLength(1)
    expect(development.branches[0]).toMatchObject({
      name: 'feature/thing',
      url: 'https://github.com/acme/repo/tree/feature/thing',
      repo: 'acme/repo',
    })
    expect(development.branches[0].lastCommit?.displayId).toBe('abcdef1')
    expect(development.commits).toHaveLength(1)
    expect(development.commits[0]).toMatchObject({
      displayId: 'fedcba0',
      message: 'another commit',
      url: 'https://github.com/acme/repo/commit/fedcba0',
      author: 'octocat',
    })
  })

  it('suppresses Epic Link/Name when the ticket already carries jira_epic_key', async () => {
    seedConnection()
    seedLinkedTicket(1, 'I-1', { jira_epic_key: 'ACME-99' })
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-1', {
      status: 200,
      body: rawIssueBody('I-1', { customfield_10014: 'ACME-99' }),
    })
    fake.on('GET', '/field', {
      status: 200,
      body: [
        ...FIELD_META,
        { id: 'customfield_10014', name: 'Epic Link', schema: { type: 'string', custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
      ],
    })
    fake.on('GET', '/rest/dev-status/1.0/issue/summary', { status: 200, body: { summary: {} } })

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.getSpecDetails(1)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The DEDICATED Epic Link row (the one with an href to the browse URL) is
    // suppressed by alreadyShown.hasEpicKey — no field row links to ACME-99.
    expect(res.details.fields.some((f) => f.href && f.href.includes('ACME-99'))).toBe(false)
  })
})

// ─── 2. Dev-status summary failures → fields present, development all-empty ────

describe('getSpecDetails() resilient dev-status', () => {
  for (const status of [403, 400, 404, 500]) {
    it(`dev-status summary ${status} → fields present, development empty`, async () => {
      seedConnection()
      seedLinkedTicket(1, 'I-1')
      const fake = makeFakeFetch()
      fake.on('GET', '/issue/I-1', { status: 200, body: rawIssueBody('I-1') })
      fake.on('GET', '/field', { status: 200, body: FIELD_META })
      fake.on('GET', '/rest/dev-status/1.0/issue/summary', { status, body: {} })

      const mgr = makeManager(fake.fetchImpl)
      const res = await mgr.getSpecDetails(1)

      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.details.fields.length).toBeGreaterThan(0)
      expect(res.details.development).toEqual({ pullRequests: [], branches: [], commits: [] })
    })
  }

  it('summary advertises github but detail is wrong/empty → that dataType empty', async () => {
    seedConnection()
    seedLinkedTicket(1, 'I-1')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-1', { status: 200, body: rawIssueBody('I-1') })
    fake.on('GET', '/field', { status: 200, body: FIELD_META })
    fake.on('GET', '/rest/dev-status/1.0/issue/summary', { status: 200, body: devSummaryBody() })
    // PR detail returns 200 but an EMPTY detail[] → no PRs.
    fake.on('GET', '/issue/detail?issueId=I-1&applicationType=github&dataType=pullrequest', {
      status: 200,
      body: { detail: [] },
    })
    // Branch detail comes back with the wrong shape (no branches array) → empty.
    fake.on('GET', '/issue/detail?issueId=I-1&applicationType=github&dataType=branch', {
      status: 200,
      body: { detail: [{ pullRequests: [] }] },
    })
    // Repository detail still good → 1 commit.
    fake.on('GET', '/issue/detail?issueId=I-1&applicationType=github&dataType=repository', {
      status: 200,
      body: devDetailRepoBody(),
    })

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.getSpecDetails(1)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.details.development.pullRequests).toEqual([])
    expect(res.details.development.branches).toEqual([])
    expect(res.details.development.commits).toHaveLength(1)
  })
})

// ─── 3. /field failure → fields present with humanized labels ─────────────────

describe('getSpecDetails() /field failure', () => {
  it('/field 500 → fields still returned with humanized custom-field labels', async () => {
    seedConnection()
    seedLinkedTicket(1, 'I-1')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-1', {
      status: 200,
      body: rawIssueBody('I-1', { customfield_10099: 'sweep me' }),
    })
    // /field metadata unavailable.
    fake.on('GET', '/field', { status: 500, body: {} })
    fake.on('GET', '/rest/dev-status/1.0/issue/summary', { status: 200, body: { summary: {} } })

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.getSpecDetails(1)
    expect(res.ok).toBe(true)
    if (!res.ok) return
    // The system reporter row still renders (no /field needed).
    expect(res.details.fields.some((f) => f.value === 'Jane Reporter')).toBe(true)
    // The generic-sweep custom field falls back to a humanized key label.
    const swept = res.details.fields.find((f) => f.value === 'sweep me')
    expect(swept).toBeTruthy()
    expect(swept!.label).toBe('Customfield 10099')
  })
})

// ─── 4. getIssueRaw 404 → issue-error + link tombstoned ───────────────────────

describe('getSpecDetails() issue fetch 404', () => {
  it('returns {ok:false, reason:issue-error} AND tombstones the link', async () => {
    seedConnection()
    seedLinkedTicket(1, 'I-1')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-1', { status: 404, body: {} })

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.getSpecDetails(1)

    expect(res).toMatchObject({ ok: false, reason: 'issue-error', status: 404 })
    // The link is tombstoned.
    expect(getLinkByLocalId(db, 1)?.tombstoned).toBe(true)
    expect(listLinks(db).find((l) => l.localId === 1)?.tombstoned).toBe(true)
  })
})

// ─── 5. getIssueRaw 401 → onAuth401 broadcast ─────────────────────────────────

describe('getSpecDetails() issue fetch 401', () => {
  it('returns issue-error and broadcasts jira.auth_expired (onAuth401)', async () => {
    seedConnection()
    seedLinkedTicket(1, 'I-1')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-1', { status: 401, body: {} })

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.getSpecDetails(1)

    expect(res).toMatchObject({ ok: false, reason: 'issue-error', status: 401 })
    expect(typesOf()).toContain('jira.auth_expired')
    // 401 must NOT tombstone the link (only 404 does).
    expect(getLinkByLocalId(db, 1)?.tombstoned).toBe(false)
  })
})

// ─── 6. not-active / no-link gating ───────────────────────────────────────────

describe('getSpecDetails() gating', () => {
  it('not-active when the connection is disabled', async () => {
    seedConnection({ enabled: false } as any)
    seedLinkedTicket(1, 'I-1')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    const res = await mgr.getSpecDetails(1)
    expect(res).toEqual({ ok: false, reason: 'not-active' })
  })

  it('no-link when the local id is not linked', async () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    const res = await mgr.getSpecDetails(999)
    expect(res).toEqual({ ok: false, reason: 'no-link' })
  })

  it('no-link when the link is tombstoned', async () => {
    seedConnection()
    seedLinkedTicket(5, 'I-5')
    // Tombstone via a 404 on the issue fetch path used elsewhere — here drive it
    // directly through a prior getSpecDetails that 404s.
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-5', { status: 404, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.getSpecDetails(5) // tombstones I-5
    expect(getLinkByLocalId(db, 5)?.tombstoned).toBe(true)

    // A second call now short-circuits to no-link (no HTTP).
    const res = await mgr.getSpecDetails(5)
    expect(res).toEqual({ ok: false, reason: 'no-link' })
  })
})
