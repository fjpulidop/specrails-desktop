import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { initDb, type DbInstance } from '../db'
import { readStore, resolveTicketStoragePath, mutateStore, type Ticket } from '../ticket-store'
import { setSecretStore } from './jira-credential-store'
import {
  upsertConnection,
  getConnection,
  insertLinkWithId,
  listOutbox,
  listLinks,
  enqueueMany,
  setHighWater,
  setDiscardStatus,
  tombstoneLink,
  getLinkByLocalId,
  claimDrainable,
} from './jira-db'
import { readBacklogConfig } from './jira-backlog-config'
import type { FetchImpl } from './jira-client'
import {
  JiraSyncManager,
  backoffMs,
  formatJqlDate,
  buildCompletionComment,
  buildRailReviewComment,
  buildPrMergedComment,
  buildRailCompletedComment,
  buildRailRefinedComment,
  type JiraSyncManagerOpts,
} from './jira-sync-manager'

// ─── Fake fetch router ────────────────────────────────────────────────────────
//
// Route by (method, urlSubstring) → queued responses. Each test registers the
// exact responses it needs; the router pops the first matching queued entry per
// (method, substring) key. The longest registered substring matching the url
// wins (so /issue/X/transitions beats /issue/X for a GET).

interface FakeResponseSpec {
  status: number
  body?: unknown
  retryAfter?: string
}

function makeFakeFetch() {
  // key = `${method} ${substring}` → queue of responses
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
    // Find the longest registered substring (for this method) that the url contains.
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

function lastOfType(t: string): any | undefined {
  return [...broadcasts].reverse().find((m) => m.type === t)
}

beforeEach(() => {
  db = initDb(':memory:')
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-sync-test-'))
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
function seedLinkedTicket(localId: number, jiraIssueId: string, status: Ticket['status'] = 'todo') {
  insertLinkWithId(db, { localId, jiraIssueId, jiraKey: `${JIRA_KEY}-${localId}`, jiraProjectId: JIRA_PROJECT_ID, deployment: 'cloud' })
  mutateStore(resolveTicketStoragePath(projectPath), (store) => {
    store.tickets[String(localId)] = {
      id: localId,
      title: `Ticket ${localId}`,
      description: '',
      status,
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
    }
    if (store.next_id <= localId) store.next_id = localId + 1
  })
}

function issue(over: Partial<any> = {}): any {
  return {
    id: over.id ?? '20001',
    key: over.key ?? `${JIRA_KEY}-1`,
    fields: {
      summary: 'An issue',
      labels: [],
      updated: '2025-06-01T10:00:00.000Z',
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      ...over.fields,
    },
    ...(over.id ? { id: over.id } : {}),
    ...(over.key ? { key: over.key } : {}),
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('backoffMs', () => {
  it('is deterministic and monotonic-ish, capped at 30s base', () => {
    expect(backoffMs(0)).toBe(2000) // 2000*1 + (0*137)%1000 = 2000
    expect(backoffMs(1)).toBe(4000 + 137)
    expect(backoffMs(2)).toBe(8000 + 274)
    // base caps at 30_000 once 2000*2**n exceeds it
    const big = backoffMs(10)
    expect(big).toBeGreaterThanOrEqual(30_000)
    expect(big).toBeLessThan(31_000)
    // deterministic: same input → same output
    expect(backoffMs(3)).toBe(backoffMs(3))
    // generally increases with attempts in the un-capped region
    expect(backoffMs(1)).toBeGreaterThan(backoffMs(0))
    expect(backoffMs(2)).toBeGreaterThan(backoffMs(1))
  })
})

describe('formatJqlDate', () => {
  it('formats epoch-ms as UTC "yyyy-MM-dd HH:mm"', () => {
    const ms = Date.UTC(2025, 5, 1, 9, 5) // 2025-06-01 09:05 UTC
    expect(formatJqlDate(ms)).toBe('2025-06-01 09:05')
  })
  it('zero-pads single-digit fields', () => {
    const ms = Date.UTC(2024, 0, 3, 4, 7)
    expect(formatJqlDate(ms)).toBe('2024-01-03 04:07')
  })
  it('clamps negative ms to epoch 0', () => {
    expect(formatJqlDate(-1000)).toBe('1970-01-01 00:00')
  })
})

describe('buildCompletionComment', () => {
  const base = { jobId: 'job-9', costUsd: 1.234, durationMs: 65_000 }
  it('needsReview short-circuits with a review message', () => {
    const text = buildCompletionComment({ status: 'completed', ...base }, 'ACME-1', true)
    expect(text).toContain('Specrails rail finished for ACME-1.')
    expect(text).toContain('Result: needs human review.')
    expect(text).toContain('Run: job-9')
    expect(text).toContain('Jira status: left unchanged for review.')
    expect(text).not.toMatch(/Cost:/)
  })
  it('completed -> explains Jira movement with run, cost, and duration', () => {
    const text = buildCompletionComment({ status: 'completed', ...base }, 'ACME-1', false)
    expect(text).toContain('Specrails rail finished for ACME-1.')
    expect(text).toContain('Result: completed successfully.')
    expect(text).toContain('Jira status: moving to Done.')
    expect(text).toContain('Run: job-9')
    expect(text).toContain('Cost: $1.23')
    expect(text).toContain('Duration: 1m 5s')
  })
  it('canceled -> explains backlog return', () => {
    const text = buildCompletionComment({ status: 'canceled', ...base }, 'ACME-1', false)
    expect(text).toContain('Result: cancelled before completion.')
    expect(text).toContain('Jira status: returning to the backlog.')
  })
  it('failed -> explains backlog return', () => {
    const text = buildCompletionComment({ status: 'failed', ...base }, 'ACME-1', false)
    expect(text).toContain('Result: failed before completion.')
    expect(text).toContain('Jira status: returning to the backlog.')
  })
  it('omits cost/duration when null and formats sub-minute as seconds', () => {
    const text = buildCompletionComment(
      { status: 'completed', jobId: 'j', costUsd: null, durationMs: 45_000 },
      null,
      false,
    )
    expect(text).toContain('Specrails rail finished for the linked Jira issue.')
    expect(text).not.toContain('Cost:')
    expect(text).toContain('Duration: 45s')
  })
  it('omits duration entirely when null', () => {
    const text = buildCompletionComment(
      { status: 'completed', jobId: 'j', costUsd: null, durationMs: null },
      null,
      false,
    )
    expect(text).toContain('Run: j')
    expect(text).not.toContain('Duration:')
  })
})

describe('buildRailReviewComment', () => {
  it('explains that the PR is ready for review and leaves a next action', () => {
    const text = buildRailReviewComment('ACME-21')
    expect(text).toContain('Specrails rail finished for ACME-21.')
    expect(text).toContain('Result: implementation ready for PR review.')
    expect(text).toContain('Jira status: moving to review')
    expect(text).toContain('Next step: review the Specrails PR card')
  })
})

describe('buildPrMergedComment', () => {
  it('appends the PR URL on its own line when present', () => {
    const text = buildPrMergedComment('https://github.com/acme/repo/pull/7')
    expect(text).toContain('Specrails delivery accepted.')
    expect(text).toContain('Result: PR merged into the integration branch.')
    expect(text).toContain('Jira status: moving to Done.')
    expect(text.endsWith('\nPR: https://github.com/acme/repo/pull/7')).toBe(true)
  })
  it('omits the URL line when prUrl is null', () => {
    const text = buildPrMergedComment(null)
    expect(text).toContain('Result: PR merged into the integration branch.')
    expect(text).not.toContain('PR:')
    expect(text).not.toContain('http')
  })
})

describe('no-change decision comments', () => {
  it('describes completion truthfully without claiming a PR', () => {
    const text = buildRailCompletedComment()
    expect(text).toContain('no code changes were required')
    expect(text).toContain('No pull request was created')
    expect(text).toContain('moving to Done')
    expect(text).not.toContain('PR merged')
  })

  it('describes refinement as a backlog return without claiming discard', () => {
    const text = buildRailRefinedComment()
    expect(text).toContain('returned for refinement')
    expect(text).toContain('No pull request was created')
    expect(text).toContain('returning to the backlog')
    expect(text).not.toMatch(/discard|cancel/i)
  })
})

// ─── Lifecycle: isActive / start / stop ───────────────────────────────────────

describe('isActive / start / stop', () => {
  it('false with no connection', () => {
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(mgr.isActive()).toBe(false)
  })
  it('true when an enabled connection has a token', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(mgr.isActive()).toBe(true)
  })
  it('false when the connection is disabled', () => {
    seedConnection({ enabled: false })
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(mgr.isActive()).toBe(false)
  })
  it('start() arms timers and stop() clears them (no leak)', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.start()
    // calling start again is a no-op (timers already armed)
    mgr.start()
    mgr.stop()
    // stop again is safe
    mgr.stop()
    expect(true).toBe(true)
  })
  it('constructor with startTimers !== false starts timers', () => {
    const { fetchImpl } = makeFakeFetch()
    const mgr = new JiraSyncManager({ db, projectId: PROJECT_ID, projectPath, broadcast: collect, fetchImpl })
    mgr.stop()
    expect(mgr.isActive()).toBe(false)
  })
})

// ─── connect() ────────────────────────────────────────────────────────────────

describe('connect()', () => {
  it('success persists connection + token + writes Jira backlog-config', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 200, body: { accountId: 'a1', displayName: 'Me' } })
    fake.on('GET', `/project/${JIRA_KEY}`, { status: 200, body: { id: JIRA_PROJECT_ID, key: JIRA_KEY, name: 'Acme' } })
    // connect kicks an immediate pollOnce → search/jql; return empty so it no-ops.
    fake.on('POST', '/search/jql', { status: 200, body: { issues: [] } })

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.connect({
      baseUrl: CLOUD_BASE + '/', // trailing slash trimmed on persist
      accountEmail: 'me@acme.com',
      token: 'tok-xyz',
      jiraProjectKey: JIRA_KEY,
    })
    mgr.stop()

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.connection.jiraProjectKey).toBe(JIRA_KEY)
      expect(res.connection.baseUrl).toBe(CLOUD_BASE) // no trailing slash
    }
    const conn = getConnection(db, PROJECT_ID)
    expect(conn?.enabled).toBe(true)
    const cfg = readBacklogConfig(projectPath)
    expect(cfg).toEqual({ provider: 'local', write_access: false, git_auto: false })
  })

  it('fails on bad credentials (401 /myself)', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 401, body: { message: 'nope' } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.connect({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 'bad', jiraProjectKey: JIRA_KEY })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/Invalid Jira credentials/)
      expect(res.status).toBe(401)
    }
    expect(getConnection(db, PROJECT_ID)).toBeNull()
  })

  it('fails on unreachable host (network /myself) with a connection-failed message', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 500, body: { message: 'boom' } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.connect({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 't', jiraProjectKey: JIRA_KEY })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Connection failed/)
  })

  it('fails on bad project (404 /project)', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 200, body: { accountId: 'a1' } })
    fake.on('GET', `/project/${JIRA_KEY}`, { status: 404, body: { message: 'no project' } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.connect({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 't', jiraProjectKey: JIRA_KEY })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toMatch(/not found or no access/)
      expect(res.status).toBe(404)
    }
    expect(getConnection(db, PROJECT_ID)).toBeNull()
  })

  it('fails on project check server error (non-404) with a generic message', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 200, body: {} })
    fake.on('GET', `/project/${JIRA_KEY}`, { status: 500, body: { message: 'oops' } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.connect({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 't', jiraProjectKey: JIRA_KEY })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/Project check failed/)
  })
})

// ─── Wizard probes ────────────────────────────────────────────────────────────

describe('probeCredentials', () => {
  it('success returns deployment + displayName', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 200, body: { displayName: 'Jane' } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.probeCredentials({ baseUrl: CLOUD_BASE, accountEmail: 'j@a.com', token: 't' })
    expect(res).toEqual({ ok: true, deployment: 'cloud', displayName: 'Jane' })
  })
  it('falls back to emailAddress when no displayName', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 200, body: { emailAddress: 'e@a.com' } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.probeCredentials({ baseUrl: CLOUD_BASE, accountEmail: null, token: 't' })
    expect(res).toEqual({ ok: true, deployment: 'cloud', displayName: 'e@a.com' })
  })
  it('auth error → "Invalid email or token"', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.probeCredentials({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 'bad' })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error).toBe('Invalid email or token')
      expect(res.status).toBe(401)
    }
  })
  it('non-auth error returns the raw client error', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 500, body: 'server down' })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.probeCredentials({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 't' })
    expect(res.ok).toBe(false)
  })
})

describe('discoverProjects', () => {
  it('success returns the project list (cloud /project/search)', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/project/search', {
      status: 200,
      body: { values: [{ id: '1', key: 'A', name: 'Alpha' }, { id: '2', key: 'B', name: 'Beta' }] },
    })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.discoverProjects({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 't' })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.projects.map((p) => p.key)).toEqual(['A', 'B'])
  })
  it('error path surfaces status + error', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/project/search', { status: 403, body: { message: 'forbidden' } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.discoverProjects({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 't' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(403)
  })
})

describe('discoverStatuses', () => {
  it('success de-dupes statuses across issue types and maps category key', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', `/project/${JIRA_KEY}/statuses`, {
      status: 200,
      body: [
        { name: 'Task', statuses: [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }] },
        {
          name: 'Bug',
          statuses: [
            { id: '1', name: 'To Do', statusCategory: { key: 'new' } }, // dup id 1 → ignored
            { id: '3', name: 'Done', statusCategory: { key: 'done' } },
            { id: '4', name: 'NoCat' }, // missing category → 'indeterminate'
          ],
        },
      ],
    })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.discoverStatuses({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 't', projectKey: JIRA_KEY })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.statuses).toEqual([
        { id: '1', name: 'To Do', category: 'new' },
        { id: '3', name: 'Done', category: 'done' },
        { id: '4', name: 'NoCat', category: 'indeterminate' },
      ])
    }
  })
  it('error path returns ok:false', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', `/project/${JIRA_KEY}/statuses`, { status: 404, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.discoverStatuses({ baseUrl: CLOUD_BASE, accountEmail: 'x', token: 't', projectKey: JIRA_KEY })
    expect(res.ok).toBe(false)
  })
})

// ─── setEnabled / disconnect ──────────────────────────────────────────────────

describe('setEnabled / disconnect', () => {
  it('setEnabled(true) writes Jira backlog config + re-enables', () => {
    seedConnection({ enabled: false })
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.setEnabled(true)
    mgr.stop()
    expect(getConnection(db, PROJECT_ID)?.enabled).toBe(true)
    expect(readBacklogConfig(projectPath)).toEqual({ provider: 'local', write_access: false, git_auto: false })
  })
  it('setEnabled(false) writes local (writable) backlog config', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.setEnabled(false)
    expect(getConnection(db, PROJECT_ID)?.enabled).toBe(false)
    expect(readBacklogConfig(projectPath)).toEqual({ provider: 'local', write_access: true, git_auto: false })
  })
  it('disconnect removes the connection + restores local config', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.disconnect()
    expect(getConnection(db, PROJECT_ID)).toBeNull()
    expect(readBacklogConfig(projectPath)).toEqual({ provider: 'local', write_access: true, git_auto: false })
  })
})

// ─── Regression: confirmed bugs (BUG-JIRA-SYNC-01..04) ────────────────────────

describe('BUG-JIRA-SYNC-01: re-entrant start() does not reset inflight ops', () => {
  it('a re-entrant start() (timers already armed) leaves inflight ops untouched', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    // Arm timers FIRST (this is the only crash-recovery reset). Then simulate a
    // drain going inflight while those timers are live.
    mgr.start()
    enqueueTransition('I-01', 'done', 'k-inflight-01')
    const claimed = claimDrainable(db, 8)
    expect(claimed.length).toBe(1)
    expect(listOutbox(db, { state: 'inflight' }).length).toBe(1)

    // A hot-swap re-enters start() while timers are armed and the op is inflight.
    mgr.start() // re-entrant — must bail before resetInflight
    mgr.stop()

    // The op stays inflight — it was NOT reset back to pending mid-drain.
    expect(listOutbox(db, { state: 'inflight' }).length).toBe(1)
    expect(listOutbox(db, { state: 'pending' }).length).toBe(0)
  })

  it('setEnabled(true) while timers are armed does not reset inflight ops', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.start() // arm timers (crash-recovery reset happens here, before inflight)
    enqueueTransition('I-01b', 'done', 'k-inflight-01b')
    claimDrainable(db, 8)
    expect(listOutbox(db, { state: 'inflight' }).length).toBe(1)

    mgr.setEnabled(true) // hot-swap toggle re-enters start()
    mgr.stop()

    expect(listOutbox(db, { state: 'inflight' }).length).toBe(1)
  })

  it('construction-path start() still recovers inflight ops left by a crash', () => {
    seedConnection()
    enqueueTransition('I-01c', 'done', 'k-inflight-01c')
    claimDrainable(db, 8) // orphaned inflight (no timers armed yet)
    expect(listOutbox(db, { state: 'inflight' }).length).toBe(1)

    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.start() // first start, no timers armed → crash-recovery resets it
    mgr.stop()

    expect(listOutbox(db, { state: 'inflight' }).length).toBe(0)
    expect(listOutbox(db, { state: 'pending' }).length).toBe(1)
  })
})

describe('BUG-JIRA-SYNC-02: paused poll does not re-spam jira.auth_expired', () => {
  it('a second pollOnce while authPaused returns null without re-broadcasting', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    // Two 401s queued, but only the first poll should reach the network.
    fake.on('POST', '/search/jql', { status: 401, body: {} }, { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)

    expect(await mgr.pollOnce()).toBeNull()
    expect(typesOf().filter((t) => t === 'jira.auth_expired').length).toBe(1)
    const callsAfterFirst = fake.calls.filter((c) => c.url.includes('/search/jql')).length
    expect(callsAfterFirst).toBe(1)

    // Second poll: paused → no network call, no re-broadcast.
    expect(await mgr.pollOnce()).toBeNull()
    expect(typesOf().filter((t) => t === 'jira.auth_expired').length).toBe(1)
    expect(fake.calls.filter((c) => c.url.includes('/search/jql')).length).toBe(1)
  })

  it('resumeAfterReauth clears the pause so a fresh 401 broadcasts again', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', { status: 401, body: {} }, { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)

    await mgr.pollOnce()
    expect(typesOf().filter((t) => t === 'jira.auth_expired').length).toBe(1)
    mgr.resumeAfterReauth() // clears authPaused (drain finds nothing)
    await mgr.pollOnce() // pause cleared → poll runs, hits the 2nd 401
    expect(typesOf().filter((t) => t === 'jira.auth_expired').length).toBe(2)
  })
})

describe('BUG-JIRA-SYNC-03: onSpecEdited idempotency key is collision-free', () => {
  it('two sub-ms edits of the same ticket enqueue two distinct update ops', () => {
    seedConnection()
    seedLinkedTicket(7, 'I-07', 'todo')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)

    // Pin the clock so both edits land on the identical millisecond — the old
    // Date.now()-only nonce would collide and INSERT OR IGNORE would drop #2.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T00:00:00.000Z'))
    mgr.onSpecEdited(7, { title: 'Edit one' })
    mgr.onSpecEdited(7, { title: 'Edit two' })
    vi.useRealTimers()

    const updates = listOutbox(db, {}).filter((o) => o.opType === 'update')
    expect(updates.length).toBe(2)
    const keys = new Set(updates.map((o) => o.idempotencyKey))
    expect(keys.size).toBe(2) // distinct keys → neither edit silently dropped
    const summaries = updates.map((o) => JSON.parse(o.payload).fields.summary).sort()
    expect(summaries).toEqual(['Edit one', 'Edit two'])
  })
})

describe('BUG-JIRA-SYNC-04: perpetual 429 eventually dead-letters', () => {
  it('a 429 op at the attempts cap is dead-lettered + broadcasts degraded', async () => {
    seedConnection()
    enqueueTransition('T-429cap', 'done', 'k-429cap')
    // Push attempts to one below the cap (MAX_OUTBOX_ATTEMPTS = 6) so the next
    // 429 exhausts retries instead of re-queuing forever.
    db.prepare('UPDATE jira_outbox SET attempts = 5 WHERE idempotency_key = ?').run('k-429cap')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-429cap?', { status: 429, body: {}, retryAfter: '5' })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()

    expect(listOutbox(db, { state: 'dead' }).length).toBe(1)
    expect(listOutbox(db, { state: 'pending' }).length).toBe(0)
    const dead = listOutbox(db, { state: 'dead' })[0]
    expect(dead.deadReason).toMatch(/exhausted retries/)
    expect(typesOf()).toContain('jira.degraded')
  })

  it('a 429 op below the cap still retries (back to pending, attempts incremented)', async () => {
    seedConnection()
    enqueueTransition('T-429ok', 'done', 'k-429ok')
    db.prepare('UPDATE jira_outbox SET attempts = 2 WHERE idempotency_key = ?').run('k-429ok')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-429ok?', { status: 429, body: {}, retryAfter: '5' })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()

    const pending = listOutbox(db, { state: 'pending' })
    expect(pending.length).toBe(1)
    expect(pending[0].attempts).toBe(3)
    expect(listOutbox(db, { state: 'dead' }).length).toBe(0)
  })
})

// ─── pollOnce() ───────────────────────────────────────────────────────────────

describe('pollOnce()', () => {
  it('returns null when there is no connection', async () => {
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(await mgr.pollOnce()).toBeNull()
  })

  it('returns null when the connection is disabled', async () => {
    seedConnection({ enabled: false })
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(await mgr.pollOnce()).toBeNull()
  })

  it('returns null when buildClient yields no token', async () => {
    // Connection row present but no token blob → getDecryptedToken null.
    seedConnection()
    db.prepare('UPDATE jira_connection SET encrypted_token = NULL WHERE project_id = ?').run(PROJECT_ID)
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(await mgr.pollOnce()).toBeNull()
  })

  it('materializes 2 issues into the store, advances high-water, broadcasts jira.synced', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', {
      status: 200,
      body: {
        issues: [
          issue({ id: '30001', key: 'ACME-101', fields: { summary: 'First', updated: '2025-06-01T10:00:00.000Z', status: { name: 'To Do', statusCategory: { key: 'new' } } } }),
          issue({ id: '30002', key: 'ACME-102', fields: { summary: 'Second', updated: '2025-06-02T11:00:00.000Z', status: { name: 'Done', statusCategory: { key: 'done' } } } }),
        ],
      },
    })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.pollOnce()
    expect(res).toEqual({ upserted: 2 })

    const store = readStore(resolveTicketStoragePath(projectPath))
    const titles = Object.values(store.tickets).map((t) => t.title).sort()
    expect(titles).toEqual(['First', 'Second'])

    // High-water advanced to the max updated timestamp.
    const conn = getConnection(db, PROJECT_ID)
    expect(conn?.highWaterMs).toBe(Date.parse('2025-06-02T11:00:00.000Z'))

    // jira.synced broadcast + per-ticket ticket_updated.
    expect(typesOf()).toContain('jira.synced')
    expect(lastOfType('jira.synced').upserted).toBe(2)
    expect(typesOf().filter((t) => t === 'ticket_updated').length).toBe(2)
  })

  it('uses the high-water JQL (updated >=) when a high-water mark exists', async () => {
    seedConnection()
    setHighWater(db, PROJECT_ID, Date.UTC(2025, 5, 1, 12, 0))
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', { status: 200, body: { issues: [] } })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.pollOnce()
    const sent = fake.calls.find((c) => c.url.includes('/search/jql'))
    expect(sent?.body.jql).toMatch(/updated >=/)
  })

  it('pollOnce(true) does a FULL sync (no updated >= clause) even with a high-water', async () => {
    seedConnection()
    setHighWater(db, PROJECT_ID, Date.UTC(2025, 5, 1, 12, 0))
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', { status: 200, body: { issues: [] } })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.pollOnce(true)
    const sent = fake.calls.find((c) => c.url.includes('/search/jql'))
    expect(sent?.body.jql).not.toMatch(/updated >=/)
  })

  it('discovers the sprint field, requests it in search, and resets the high-water to back-fill', async () => {
    seedConnection()
    setHighWater(db, PROJECT_ID, Date.UTC(2025, 5, 1, 12, 0))
    const fake = makeFakeFetch()
    fake.on('GET', '/field', {
      status: 200,
      body: [
        { id: 'summary', name: 'Summary' },
        { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
      ],
    })
    fake.on('POST', '/search/jql', { status: 200, body: { issues: [] } })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.pollOnce()
    // Field id cached.
    expect(getConnection(db, PROJECT_ID)?.sprintFieldId).toBe('customfield_10020')
    // Requested in the search.
    const sent = fake.calls.find((c) => c.url.includes('/search/jql'))
    expect(sent?.body.fields).toContain('customfield_10020')
    // High-water reset → this poll did a full sync (no updated >= clause).
    expect(sent?.body.jql).not.toMatch(/updated >=/)
  })

  it('caches "none" when the instance has no sprint field (and keeps the high-water)', async () => {
    seedConnection()
    setHighWater(db, PROJECT_ID, Date.UTC(2025, 5, 1, 12, 0))
    const fake = makeFakeFetch()
    fake.on('GET', '/field', { status: 200, body: [{ id: 'summary', name: 'Summary' }] })
    fake.on('POST', '/search/jql', { status: 200, body: { issues: [] } })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.pollOnce()
    expect(getConnection(db, PROJECT_ID)?.sprintFieldId).toBe('none')
    const sent = fake.calls.find((c) => c.url.includes('/search/jql'))
    expect(sent?.body.jql).toMatch(/updated >=/) // not reset
  })

  it('401 → onAuth401 broadcasts jira.auth_expired and returns null', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    expect(await mgr.pollOnce()).toBeNull()
    expect(typesOf()).toContain('jira.auth_expired')
  })

  it('non-auth error → jira.sync_error broadcast and null', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', { status: 500, body: 'down' })
    const mgr = makeManager(fake.fetchImpl)
    expect(await mgr.pollOnce()).toBeNull()
    expect(typesOf()).toContain('jira.sync_error')
  })

  it('paginates via nextPageToken then stops on the last page', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql',
      { status: 200, body: { issues: [issue({ id: '40001', key: 'ACME-201', fields: { updated: '2025-06-01T00:00:00.000Z' } })], nextPageToken: 'p2' } },
      { status: 200, body: { issues: [issue({ id: '40002', key: 'ACME-202', fields: { updated: '2025-06-01T01:00:00.000Z' } })] } },
    )
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.pollOnce()
    expect(res).toEqual({ upserted: 2 })
    // Two /search/jql calls happened.
    expect(fake.calls.filter((c) => c.url.includes('/search/jql')).length).toBe(2)
  })

  it('empty result set does not broadcast jira.synced and does not advance high-water', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', { status: 200, body: { issues: [] } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.pollOnce()
    expect(res).toEqual({ upserted: 0 })
    expect(typesOf()).not.toContain('jira.synced')
    expect(getConnection(db, PROJECT_ID)?.highWaterMs).toBeNull()
  })

  it('freezes status for local ids with a pending transition outbox op', async () => {
    seedConnection()
    // Link + ticket at local id 5, currently in_progress locally.
    seedLinkedTicket(5, '50005', 'in_progress')
    enqueueMany(db, [
      {
        jiraIssueId: '50005',
        opType: 'transition',
        idempotencyKey: 'job:5:transition:in_progress',
        payload: { localId: 5, jiraIssueId: '50005', logicalState: 'in_progress' },
      },
    ])
    const fake = makeFakeFetch()
    // Inbound says the issue is back to "To Do" (new), but the frozen id must keep in_progress.
    fake.on('POST', '/search/jql', {
      status: 200,
      body: { issues: [issue({ id: '50005', key: 'ACME-5', fields: { summary: 'Frozen', updated: '2025-06-03T00:00:00.000Z', status: { name: 'To Do', statusCategory: { key: 'new' } } } })] },
    })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.pollOnce()
    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['5'].status).toBe('in_progress')
  })
})

// ─── Watcher-echo suppression (notifyLocalWrite) ──────────────────────────────

describe('notifyLocalWrite (watcher-echo suppression)', () => {
  it('pollOnce that materializes a NEW issue calls notifyLocalWrite with a revision number', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', {
      status: 200,
      body: {
        issues: [
          issue({ id: '60001', key: 'ACME-601', fields: { summary: 'Fresh', updated: '2025-06-04T10:00:00.000Z', status: { name: 'To Do', statusCategory: { key: 'new' } } } }),
        ],
      },
    })
    const notifyLocalWrite = vi.fn()
    const mgr = makeManager(fake.fetchImpl, { notifyLocalWrite })
    const res = await mgr.pollOnce()
    expect(res).toEqual({ upserted: 1 })

    expect(notifyLocalWrite).toHaveBeenCalledTimes(1)
    expect(typeof notifyLocalWrite.mock.calls[0][0]).toBe('number')
  })

  it('re-polling IDENTICAL issues does not notify, broadcast jira.synced, or ticket_updated the second time', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    const identical = {
      status: 200,
      body: {
        issues: [
          issue({ id: '61001', key: 'ACME-611', fields: { summary: 'Stable', updated: '2025-06-04T10:00:00.000Z', status: { name: 'To Do', statusCategory: { key: 'new' } } } }),
        ],
      },
    }
    // Queue the SAME response twice — first materializes, second is a byte-identical no-op.
    fake.on('POST', '/search/jql', identical, identical)
    const notifyLocalWrite = vi.fn()
    const mgr = makeManager(fake.fetchImpl, { notifyLocalWrite })

    // First poll materializes.
    await mgr.pollOnce()
    expect(notifyLocalWrite).toHaveBeenCalledTimes(1)
    expect(typesOf()).toContain('jira.synced')
    expect(typesOf().filter((t) => t === 'ticket_updated').length).toBe(1)

    // Reset capture, then poll the identical payload again.
    notifyLocalWrite.mockClear()
    broadcasts = []
    const res2 = await mgr.pollOnce()
    expect(res2).toEqual({ upserted: 0 })

    // wrote:false → no notify, no jira.synced, no ticket_updated on the second poll.
    expect(notifyLocalWrite).not.toHaveBeenCalled()
    expect(typesOf()).not.toContain('jira.synced')
    expect(typesOf()).not.toContain('ticket_updated')
  })

  it('onRailLaunch on a linked ticket calls notifyLocalWrite (writeLocalStatus wrote in_progress)', () => {
    seedConnection()
    seedLinkedTicket(71, '71007', 'todo')
    const { fetchImpl } = makeFakeFetch()
    const notifyLocalWrite = vi.fn()
    const mgr = makeManager(fetchImpl, { notifyLocalWrite })
    mgr.onRailLaunch([71], 'job-71')

    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['71'].status).toBe('in_progress')
    expect(notifyLocalWrite).toHaveBeenCalledTimes(1)
    expect(typeof notifyLocalWrite.mock.calls[0][0]).toBe('number')
  })

  it('setLocalWriteNotifier late-binds the notifier so a subsequent write calls it', () => {
    seedConnection()
    seedLinkedTicket(72, '72007', 'todo')
    const { fetchImpl } = makeFakeFetch()
    // Construct WITHOUT the opt, then bind late.
    const mgr = makeManager(fetchImpl)
    const notifyLocalWrite = vi.fn()
    mgr.setLocalWriteNotifier(notifyLocalWrite)

    mgr.onRailLaunch([72], 'job-72')
    expect(notifyLocalWrite).toHaveBeenCalledTimes(1)
    expect(typeof notifyLocalWrite.mock.calls[0][0]).toBe('number')
  })
})

// ─── onRailLaunch() ───────────────────────────────────────────────────────────

describe('onRailLaunch()', () => {
  it('no-op when not active', () => {
    // No connection → not active.
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailLaunch([1], 'job-1')
    expect(listOutbox(db, {}).length).toBe(0)
    expect(broadcasts.length).toBe(0)
  })

  it('no-op when ticket is unlinked', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailLaunch([999], 'job-1')
    expect(listOutbox(db, {}).length).toBe(0)
  })

  it('enqueues a transition outbox row AND writes in_progress to the local store', () => {
    seedConnection()
    seedLinkedTicket(7, '70007', 'todo')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailLaunch([7], 'job-77')

    const ops = listOutbox(db, {})
    expect(ops.length).toBe(1)
    expect(ops[0].opType).toBe('transition')
    expect(ops[0].idempotencyKey).toBe('job-77:7:transition:in_progress')
    expect(JSON.parse(ops[0].payload).logicalState).toBe('in_progress')

    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['7'].status).toBe('in_progress')

    // outbox_changed + ticket_updated broadcasts.
    expect(typesOf()).toContain('jira.outbox_changed')
    expect(typesOf()).toContain('ticket_updated')
  })

  it('skips tombstoned links', () => {
    seedConnection()
    seedLinkedTicket(8, '80008', 'todo')
    tombstoneLink(db, '80008')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailLaunch([8], 'job-8')
    expect(listOutbox(db, {}).length).toBe(0)
  })
})

// ─── onJobOutcome() ───────────────────────────────────────────────────────────

describe('onJobOutcome()', () => {
  it('no-op when not active', () => {
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onJobOutcome({ ticketIds: [1], status: 'completed', jobId: 'j', costUsd: null, durationMs: null })
    expect(listOutbox(db, {}).length).toBe(0)
  })

  it('completed → enqueues comment + transition(done)', async () => {
    seedConnection()
    seedLinkedTicket(11, 'I-11', 'in_progress')
    const fake = makeFakeFetch()
    // onJobOutcome calls drainOnce; provide a getIssue that is already done so the
    // transition no-ops, and getComments empty so the comment posts.
    fake.on('GET', '/issue/I-11/comment', { status: 200, body: { comments: [] } })
    fake.on('POST', '/issue/I-11/comment', { status: 201, body: { id: 'c1' } })
    fake.on('GET', '/issue/I-11?', { status: 200, body: { id: 'I-11', key: 'ACME-11', fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } })
    const mgr = makeManager(fake.fetchImpl)
    mgr.onJobOutcome({ ticketIds: [11], status: 'completed', jobId: 'job-c', costUsd: 1, durationMs: 1000 })

    const ops = listOutbox(db, {})
    const types = ops.map((o) => o.opType).sort()
    expect(types).toEqual(['comment', 'transition'])
    const commentOp = ops.find((o) => o.opType === 'comment')!
    const cPayload = JSON.parse(commentOp.payload)
    expect(cPayload.text).toContain('Specrails rail finished for ACME-11.')
    expect(cPayload.text).toContain('Result: completed successfully.')
    expect(cPayload.text).toContain('Jira status: moving to Done.')
    expect(cPayload.text).toContain('Run: job-c')
    expect(cPayload.text).toContain('Duration: 1s')
    expect(cPayload.text).toContain('Cost: $1.00')
    const transitionOp = ops.find((o) => o.opType === 'transition')!
    expect(JSON.parse(transitionOp.payload).logicalState).toBe('done')
    // drain ran (best-effort); give microtasks a chance.
    await Promise.resolve()
  })

  it('failed → enqueues comment + transition(todo)', () => {
    seedConnection()
    seedLinkedTicket(12, 'I-12', 'in_progress')
    const fake = makeFakeFetch()
    // Make drain a no-op by not enabling any responses except what it needs — but
    // drain may throw on missing routes; it swallows errors. We only assert the queue.
    fake.on('GET', '/issue/I-12/comment', { status: 200, body: { comments: [] } })
    fake.on('POST', '/issue/I-12/comment', { status: 201, body: { id: 'c' } })
    fake.on('GET', '/issue/I-12?', { status: 200, body: { id: 'I-12', key: 'ACME-12', fields: { status: { name: 'To Do', statusCategory: { key: 'new' } } } } })
    const mgr = makeManager(fake.fetchImpl)
    mgr.onJobOutcome({ ticketIds: [12], status: 'failed', jobId: 'job-f', costUsd: null, durationMs: null })
    const commentOp = listOutbox(db, {}).find((o) => o.opType === 'comment')!
    const cPayload = JSON.parse(commentOp.payload)
    expect(cPayload.text).toContain('Result: failed before completion.')
    expect(cPayload.text).toContain('Jira status: returning to the backlog.')
    const transitionOp = listOutbox(db, {}).find((o) => o.opType === 'transition')!
    expect(JSON.parse(transitionOp.payload).logicalState).toBe('todo')
  })

  it('needs_review id → comment only, no transition', () => {
    seedConnection()
    seedLinkedTicket(13, 'I-13', 'in_progress')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-13/comment', { status: 200, body: { comments: [] } })
    fake.on('POST', '/issue/I-13/comment', { status: 201, body: { id: 'c' } })
    const mgr = makeManager(fake.fetchImpl)
    mgr.onJobOutcome({
      ticketIds: [13],
      status: 'completed',
      jobId: 'job-r',
      costUsd: null,
      durationMs: null,
      needsReviewIds: [13],
    })
    const ops = listOutbox(db, {})
    expect(ops.map((o) => o.opType)).toEqual(['comment'])
    const cPayload = JSON.parse(ops[0].payload)
    expect(cPayload.text).toContain('Result: needs human review.')
    expect(cPayload.text).toContain('Jira status: left unchanged for review.')
  })

  it('skips unlinked + tombstoned tickets, no enqueue', () => {
    seedConnection()
    seedLinkedTicket(14, 'I-14', 'in_progress')
    tombstoneLink(db, 'I-14')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onJobOutcome({ ticketIds: [14, 999], status: 'completed', jobId: 'j', costUsd: null, durationMs: null })
    expect(listOutbox(db, {}).length).toBe(0)
  })
})

// ─── onRailReview() ───────────────────────────────────────────────────────────

describe('onRailReview()', () => {
  it('no-op when not active (no connection)', () => {
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailReview([1], 'pd-1')
    expect(listOutbox(db, {}).length).toBe(0)
    expect(broadcasts.length).toBe(0)
  })

  it('no-op when the connection is disabled', () => {
    seedConnection({ enabled: false })
    seedLinkedTicket(20, 'I-20', 'todo')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailReview([20], 'pd-20')
    expect(listOutbox(db, {}).length).toBe(0)
  })

  it('enqueues an on_review transition per LINKED ticket, outbox-only (no local write)', () => {
    seedConnection()
    seedLinkedTicket(21, 'I-21', 'todo')
    const fake = makeFakeFetch()
    // Best-effort drain: no statusMap.on_review configured and the issue is
    // already indeterminate → the walk noops and the op completes cleanly.
    fake.on('GET', '/issue/I-21?', { status: 200, body: { id: 'I-21', key: 'ACME-21', fields: { status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } } } })
    const mgr = makeManager(fake.fetchImpl)
    mgr.onRailReview([21, 999], 'pd-21')

    const ops = listOutbox(db, {})
    expect(ops.map((o) => o.opType).sort()).toEqual(['comment', 'transition'])
    const comment = ops.find((o) => o.opType === 'comment')!
    expect(comment.idempotencyKey).toBe('pd-21:21:comment:on-review')
    const cPayload = JSON.parse(comment.payload)
    expect(cPayload.text).toContain('Specrails rail finished for ACME-21.')
    expect(cPayload.text).toContain('Result: implementation ready for PR review.')
    expect(cPayload.text).toContain('Jira status: moving to review')
    expect(cPayload.marker).toBe('[specrails:rail-review=pd-21:ticket=21]')
    const transition = ops.find((o) => o.opType === 'transition')!
    expect(transition.idempotencyKey).toBe('pd-21:21:transition:on_review')
    expect(JSON.parse(transition.payload)).toMatchObject({ localId: 21, jiraIssueId: 'I-21', logicalState: 'on_review' })

    // NO local-cache write: the ticket store already parked the ticket before
    // this hook fires (unlike onRailLaunch) — status untouched, no ticket_updated.
    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['21'].status).toBe('todo')
    expect(typesOf()).toContain('jira.outbox_changed')
    expect(typesOf()).not.toContain('ticket_updated')
  })

  it('skips tombstoned links (no enqueue, no broadcast)', () => {
    seedConnection()
    seedLinkedTicket(22, 'I-22', 'todo')
    tombstoneLink(db, 'I-22')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailReview([22], 'pd-22')
    expect(listOutbox(db, {}).length).toBe(0)
    expect(broadcasts.length).toBe(0)
  })
})

// ─── onRailMerged() ───────────────────────────────────────────────────────────

describe('onRailMerged()', () => {
  it('no-op when not active', () => {
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(mgr.onRailMerged([1], 'pd-1', 'https://github.com/acme/repo/pull/7')).toBe(true)
    expect(listOutbox(db, {}).length).toBe(0)
  })

  it('enqueues a "PR merged" comment (with URL + marker) and a done transition per linked ticket', () => {
    seedConnection()
    seedLinkedTicket(31, 'I-31', 'on_review')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/I-31/comment', { status: 200, body: { comments: [] } })
    fake.on('POST', '/issue/I-31/comment', { status: 201, body: { id: 'c' } })
    fake.on('GET', '/issue/I-31?', { status: 200, body: { id: 'I-31', key: 'ACME-31', fields: { status: { name: 'Done', statusCategory: { key: 'done' } } } } })
    const mgr = makeManager(fake.fetchImpl)
    expect(mgr.onRailMerged([31], 'pd-31', 'https://github.com/acme/repo/pull/7')).toBe(true)

    const ops = listOutbox(db, {})
    expect(ops.map((o) => o.opType).sort()).toEqual(['comment', 'transition'])
    const comment = ops.find((o) => o.opType === 'comment')!
    expect(comment.idempotencyKey).toBe('pd-31:31:comment:pr-merged')
    const cPayload = JSON.parse(comment.payload)
    expect(cPayload.jiraIssueId).toBe('I-31')
    expect(cPayload.text).toContain('Specrails delivery accepted.')
    expect(cPayload.text).toContain('Result: PR merged into the integration branch.')
    expect(cPayload.text).toContain('Jira status: moving to Done.')
    expect(cPayload.text).toContain('https://github.com/acme/repo/pull/7')
    expect(cPayload.marker).toBe('[specrails:pr-merged=pd-31:ticket=31]')
    const transition = ops.find((o) => o.opType === 'transition')!
    expect(transition.idempotencyKey).toBe('pd-31:31:transition:done')
    expect(JSON.parse(transition.payload)).toMatchObject({ localId: 31, jiraIssueId: 'I-31', logicalState: 'done' })

    // Outbox-only: the local on_review→done write belongs to the caller.
    expect(readStore(resolveTicketStoragePath(projectPath)).tickets['31'].status).toBe('on_review')
    expect(typesOf()).not.toContain('ticket_updated')
  })

  it('returns false when the durable Jira-outbox handoff fails', () => {
    seedConnection()
    seedLinkedTicket(34, 'I-34', 'on_review')
    db.exec(`DROP TABLE jira_outbox`)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { fetchImpl } = makeFakeFetch()
      const mgr = makeManager(fetchImpl)
      expect(mgr.onRailMerged([34], 'pd-34', null)).toBe(false)
      expect(error).toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })

  it('omits the URL from the comment when prUrl is null', () => {
    seedConnection()
    seedLinkedTicket(32, 'I-32', 'on_review')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailMerged([32], 'pd-32', null)
    const comment = listOutbox(db, {}).find((o) => o.opType === 'comment')!
    const cPayload = JSON.parse(comment.payload)
    expect(cPayload.text).toContain('Result: PR merged into the integration branch.')
    expect(cPayload.text).not.toContain('http')
  })

  it('skips unlinked + tombstoned tickets, no enqueue', () => {
    seedConnection()
    seedLinkedTicket(33, 'I-33', 'on_review')
    tombstoneLink(db, 'I-33')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailMerged([33, 999], 'pd-33', null)
    expect(listOutbox(db, {}).length).toBe(0)
  })
})

// ─── no-change terminal hooks ────────────────────────────────────────────────

describe('onRailCompleted()', () => {
  it('enqueues a truthful no-PR comment and Done transition idempotently', () => {
    seedConnection()
    seedLinkedTicket(35, 'I-35', 'on_review')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)

    expect(mgr.onRailCompleted([35], 'pd-35')).toBe(true)
    expect(mgr.onRailCompleted([35], 'pd-35')).toBe(true)

    const ops = listOutbox(db, {})
    expect(ops).toHaveLength(2)
    const comment = ops.find((op) => op.opType === 'comment')!
    expect(comment.idempotencyKey).toBe('pd-35:35:comment:completed')
    expect(JSON.parse(comment.payload)).toMatchObject({
      jiraIssueId: 'I-35',
      marker: '[specrails:rail-completed=pd-35:ticket=35]',
    })
    expect(JSON.parse(comment.payload).text).toContain('No pull request was created.')
    expect(JSON.parse(comment.payload).text).not.toContain('PR merged')
    const transition = ops.find((op) => op.opType === 'transition')!
    expect(transition.idempotencyKey).toBe('pd-35:35:transition:completed')
    expect(JSON.parse(transition.payload)).toMatchObject({
      localId: 35, jiraIssueId: 'I-35', logicalState: 'done',
    })
  })
})

describe('onRailRefined()', () => {
  it('returns to todo and never uses configured discardStatus/cancelled', () => {
    seedConnection()
    setDiscardStatus(db, PROJECT_ID, 'Discarded')
    seedLinkedTicket(36, 'I-36', 'on_review')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)

    expect(mgr.onRailRefined([36], 'pd-36')).toBe(true)
    expect(mgr.onRailRefined([36], 'pd-36')).toBe(true)

    const ops = listOutbox(db, {})
    expect(ops).toHaveLength(2)
    const comment = ops.find((op) => op.opType === 'comment')!
    expect(comment.idempotencyKey).toBe('pd-36:36:comment:refine')
    expect(JSON.parse(comment.payload)).toMatchObject({
      jiraIssueId: 'I-36',
      marker: '[specrails:rail-refined=pd-36:ticket=36]',
    })
    expect(JSON.parse(comment.payload).text).toContain('returned for refinement')
    const transition = ops.find((op) => op.opType === 'transition')!
    expect(transition.idempotencyKey).toBe('pd-36:36:transition:refine')
    const payload = JSON.parse(transition.payload)
    expect(payload).toMatchObject({ localId: 36, jiraIssueId: 'I-36', logicalState: 'todo' })
    expect(payload.targetStatus).toBeUndefined()
  })
})

describe('onRailBacklog()', () => {
  it('recovers ambiguous historical discards with a neutral todo transition only', () => {
    seedConnection()
    setDiscardStatus(db, PROJECT_ID, 'Discarded')
    seedLinkedTicket(37, 'I-37', 'on_review')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)

    expect(mgr.onRailBacklog([37], 'pd-37')).toBe(true)
    expect(mgr.onRailBacklog([37], 'pd-37')).toBe(true)

    const ops = listOutbox(db, {})
    expect(ops).toHaveLength(1)
    expect(ops[0].opType).toBe('transition')
    expect(ops[0].idempotencyKey).toBe('pd-37:37:transition:backlog')
    const payload = JSON.parse(ops[0].payload)
    expect(payload).toMatchObject({ localId: 37, jiraIssueId: 'I-37', logicalState: 'todo' })
    expect(payload.targetStatus).toBeUndefined()
  })
})

// ─── onRailDiscard() ──────────────────────────────────────────────────────────

describe('onRailDiscard()', () => {
  it('no-op when not active', () => {
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(mgr.onRailDiscard([1], 'pd-1')).toBe(true)
    expect(listOutbox(db, {}).length).toBe(0)
  })

  it('uses the configured discardStatus (cancelled transition with explicit targetStatus)', () => {
    seedConnection()
    setDiscardStatus(db, PROJECT_ID, 'Discarded')
    seedLinkedTicket(41, 'I-41', 'on_review')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailDiscard([41], 'pd-41')

    const ops = listOutbox(db, {})
    expect(ops).toHaveLength(1)
    expect(ops[0].opType).toBe('transition')
    expect(ops[0].idempotencyKey).toBe('pd-41:41:transition:discard')
    expect(JSON.parse(ops[0].payload)).toMatchObject({
      localId: 41,
      jiraIssueId: 'I-41',
      logicalState: 'cancelled',
      targetStatus: 'Discarded',
    })
    // Outbox-only: no local write, no ticket_updated.
    expect(readStore(resolveTicketStoragePath(projectPath)).tickets['41'].status).toBe('on_review')
    expect(typesOf()).not.toContain('ticket_updated')
  })

  it('falls back to a plain todo transition when no discardStatus is configured (never throws)', () => {
    seedConnection() // discardStatus null
    seedLinkedTicket(42, 'I-42', 'on_review')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(() => mgr.onRailDiscard([42], 'pd-42')).not.toThrow()

    const ops = listOutbox(db, {})
    expect(ops).toHaveLength(1)
    expect(ops[0].idempotencyKey).toBe('pd-42:42:transition:discard')
    const payload = JSON.parse(ops[0].payload)
    expect(payload).toMatchObject({ localId: 42, jiraIssueId: 'I-42', logicalState: 'todo' })
    expect(payload.targetStatus).toBeUndefined()
  })

  it('skips unlinked + tombstoned tickets, no enqueue', () => {
    seedConnection()
    seedLinkedTicket(43, 'I-43', 'on_review')
    tombstoneLink(db, 'I-43')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.onRailDiscard([43, 999], 'pd-43')
    expect(listOutbox(db, {}).length).toBe(0)
  })
})

// ─── drainOnce() ──────────────────────────────────────────────────────────────

function enqueueTransition(jiraIssueId: string, logicalState: string, key: string, localId = 1) {
  enqueueMany(db, [
    { jiraIssueId, opType: 'transition', idempotencyKey: key, payload: { localId, jiraIssueId, logicalState } },
  ])
}
function enqueueComment(jiraIssueId: string, text: string, marker: string, key: string) {
  enqueueMany(db, [
    { jiraIssueId, opType: 'comment', idempotencyKey: key, payload: { jiraIssueId, text, marker } },
  ])
}

describe('drainOnce()', () => {
  it('coalesces overlapping drain requests into one in-flight loop', async () => {
    seedConnection()
    enqueueTransition('SERIAL-1', 'done', 'serial-drain')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/SERIAL-1?', {
      status: 200,
      body: { id: 'SERIAL-1', fields: { status: { statusCategory: { key: 'done' } } } },
    })
    const mgr = makeManager(fake.fetchImpl)

    const first = mgr.drainOnce()
    const overlapping = mgr.drainOnce()

    expect(overlapping).toBe(first)
    await first
    expect(fake.calls.filter((call) => call.url.includes('/issue/SERIAL-1?'))).toHaveLength(1)
  })

  it('no-op while auth-paused', async () => {
    seedConnection()
    enqueueTransition('A-1', 'done', 'k1')
    const fake = makeFakeFetch()
    // Trip authPaused via a poll 401 first.
    fake.on('POST', '/search/jql', { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.pollOnce()
    broadcasts = []
    await mgr.drainOnce()
    // No client calls for the drain (paused) → no outbox_changed broadcast.
    expect(typesOf()).not.toContain('jira.outbox_changed')
    expect(listOutbox(db, { state: 'pending' }).length).toBe(1)
  })

  it('no-op when no connection / disabled / no batch', async () => {
    const fake = makeFakeFetch()
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce() // no connection
    seedConnection({ enabled: false })
    await mgr.drainOnce() // disabled
    // enabled but empty outbox → claimDrainable returns []
    seedConnection({ enabled: true })
    await mgr.drainOnce()
    expect(broadcasts.length).toBe(0)
  })

  it('transition: issue already in target category → noop → done', async () => {
    seedConnection()
    enqueueTransition('T-1', 'done', 'k-noop')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-1?', { status: 200, body: { id: 'T-1', fields: { status: { statusCategory: { key: 'done' } } } } })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'done' }).length).toBe(1)
    expect(typesOf()).toContain('jira.outbox_changed')
  })

  it('transition: getTransitions + transitionIssue succeed → applied → done', async () => {
    seedConnection()
    enqueueTransition('T-2', 'done', 'k-applied')
    const fake = makeFakeFetch()
    // current category is 'new', target done.
    fake.on('GET', '/issue/T-2?', { status: 200, body: { id: 'T-2', fields: { status: { statusCategory: { key: 'new' } } } } })
    fake.on('GET', '/issue/T-2/transitions', {
      status: 200,
      body: { transitions: [{ id: '31', name: 'Done', to: { id: '5', name: 'Done', statusCategory: { key: 'done' } } }] },
    })
    fake.on('POST', '/issue/T-2/transitions', { status: 204 })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'done' }).length).toBe(1)
  })

  it('transition: honors statusMap.done="On Review" over a Discarded edge (reported bug)', async () => {
    // The user configured Done → "On Review"; both On Review and Discarded are
    // done-category. The drained transition must land on On Review, never Discarded.
    seedConnection({ statusMap: { done: 'On Review' } })
    enqueueTransition('T-rev', 'done', 'k-onreview')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-rev?', { status: 200, body: { id: 'T-rev', fields: { status: { statusCategory: { key: 'indeterminate' } } } } })
    fake.on('GET', '/issue/T-rev/transitions', {
      status: 200,
      body: {
        transitions: [
          { id: '90', name: 'Discard', to: { id: 's-disc', name: 'Discarded', statusCategory: { key: 'done' } } },
          { id: '32', name: 'Review', to: { id: 's-rev', name: 'On Review', statusCategory: { key: 'done' } } },
        ],
      },
    })
    fake.on('POST', '/issue/T-rev/transitions', { status: 204 })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    const post = fake.calls.find((c) => c.method === 'POST' && c.url.includes('/issue/T-rev/transitions'))
    expect(post?.body?.transition?.id).toBe('32') // On Review, not '90' Discarded
    expect(listOutbox(db, { state: 'done' }).length).toBe(1)
  })

  it('transition: success dead-letters instead of moving to Discarded when no ship/On Review edge', async () => {
    // No statusMap; the only done edge is a reject status. A completed job must
    // NOT be auto-discarded — it dead-letters for a manual move.
    seedConnection()
    enqueueTransition('T-disc', 'done', 'k-disc-only')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-disc?', { status: 200, body: { id: 'T-disc', fields: { status: { statusCategory: { key: 'indeterminate' } } } } })
    fake.on('GET', '/issue/T-disc/transitions', {
      status: 200,
      body: { transitions: [{ id: '90', name: 'Discard', to: { id: 's-disc', name: 'Discarded', statusCategory: { key: 'done' } } }] },
    })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    const post = fake.calls.find((c) => c.method === 'POST' && c.url.includes('/issue/T-disc/transitions'))
    expect(post).toBeUndefined() // never applied the Discarded transition
    expect(listOutbox(db, { state: 'dead' }).length).toBe(1)
    expect(typesOf()).toContain('jira.degraded')
  })

  it('transition: no path to target → dead + jira.degraded', async () => {
    seedConnection()
    enqueueTransition('T-3', 'done', 'k-nopath')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-3?', { status: 200, body: { id: 'T-3', fields: { status: { statusCategory: { key: 'new' } } } } })
    // Only a transition that stays in 'new' → no forward edge toward 'done'.
    fake.on('GET', '/issue/T-3/transitions', {
      status: 200,
      body: { transitions: [{ id: '1', name: 'Reopen', to: { id: '2', name: 'To Do', statusCategory: { key: 'new' } } }] },
    })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'dead' }).length).toBe(1)
    expect(typesOf()).toContain('jira.degraded')
  })

  it('transition: 404 on getIssue → tombstones link + dead + degraded', async () => {
    seedConnection()
    seedLinkedTicket(20, 'T-404', 'in_progress')
    enqueueTransition('T-404', 'done', 'k-404', 20)
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-404?', { status: 404, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'dead' }).length).toBe(1)
    expect(getLinkByLocalId(db, 20)?.tombstoned).toBe(true)
    expect(typesOf()).toContain('jira.degraded')
  })

  it('transition: 429 on getIssue → retry (back to pending with next_attempt_at)', async () => {
    seedConnection()
    enqueueTransition('T-429', 'done', 'k-429')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-429?', { status: 429, body: {}, retryAfter: '5' })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    const pending = listOutbox(db, { state: 'pending' })
    expect(pending.length).toBe(1)
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].nextAttemptAt).not.toBeNull()
  })

  it('transition: 401 during getIssue → auth pause + jira.auth_expired, op parked pending', async () => {
    seedConnection()
    enqueueTransition('T-401', 'done', 'k-401')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-401?', { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(typesOf()).toContain('jira.auth_expired')
    // Parked back to pending (replays after re-auth).
    expect(listOutbox(db, { state: 'pending' }).length).toBe(1)
  })

  it('transition: 403 during getTransitions → permission dead + degraded', async () => {
    seedConnection()
    enqueueTransition('T-403', 'done', 'k-403')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-403?', { status: 200, body: { id: 'T-403', fields: { status: { statusCategory: { key: 'new' } } } } })
    fake.on('GET', '/issue/T-403/transitions', { status: 403, body: 'forbidden' })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'dead' }).length).toBe(1)
    expect(typesOf()).toContain('jira.degraded')
  })

  it('comment: dedup when an existing comment already carries the marker → done (no post)', async () => {
    seedConnection()
    const marker = '[specrails:job=jX:ticket=1]'
    enqueueComment('C-1', 'done body', marker, 'k-comment-dup')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/C-1/comment', {
      status: 200,
      body: { comments: [{ id: '1', body: `prior text ${marker}` }] },
    })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'done' }).length).toBe(1)
    // No POST comment call happened.
    expect(fake.calls.some((c) => c.method === 'POST' && c.url.includes('/comment'))).toBe(false)
  })

  it('comment: posts when no marker present → done', async () => {
    seedConnection()
    enqueueComment('C-2', 'hello', '[specrails:job=jY:ticket=2]', 'k-comment-post')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/C-2/comment', { status: 200, body: { comments: [] } })
    fake.on('POST', '/issue/C-2/comment', { status: 201, body: { id: 'new' } })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'done' }).length).toBe(1)
    const post = fake.calls.find((c) => c.method === 'POST' && c.url.includes('/comment'))
    expect(post).toBeTruthy()
  })

  it('comment: getComments 401 → auth pause, op parked pending', async () => {
    seedConnection()
    enqueueComment('C-3', 'x', 'm', 'k-comment-401')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/C-3/comment', { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(typesOf()).toContain('jira.auth_expired')
    expect(listOutbox(db, { state: 'pending' }).length).toBe(1)
  })

  it('comment: addComment server error → retry with backoff', async () => {
    seedConnection()
    enqueueComment('C-4', 'x', 'm4', 'k-comment-500')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/C-4/comment', { status: 200, body: { comments: [] } })
    fake.on('POST', '/issue/C-4/comment', { status: 500, body: 'down' })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    const pending = listOutbox(db, { state: 'pending' })
    expect(pending.length).toBe(1)
    expect(pending[0].attempts).toBe(1)
  })

  it('unsupported op type → dead', async () => {
    seedConnection()
    enqueueMany(db, [{ jiraIssueId: 'X-1', opType: 'create', idempotencyKey: 'k-create', payload: {} }])
    const fake = makeFakeFetch()
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    const dead = listOutbox(db, { state: 'dead' })
    expect(dead.length).toBe(1)
    expect(dead[0].deadReason).toMatch(/unsupported op type create/)
  })

  it('transition: validation error (400) on getTransitions → dead (not retried)', async () => {
    seedConnection()
    enqueueTransition('T-400', 'done', 'k-400')
    const fake = makeFakeFetch()
    fake.on('GET', '/issue/T-400?', { status: 200, body: { id: 'T-400', fields: { status: { statusCategory: { key: 'new' } } } } })
    fake.on('GET', '/issue/T-400/transitions', { status: 400, body: 'bad' })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'dead' }).length).toBe(1)
  })
})

// ─── createSpec() ─────────────────────────────────────────────────────────────

describe('createSpec()', () => {
  it('error when no connection configured', async () => {
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    const res = await mgr.createSpec({ title: 'X' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/No Jira connection/)
  })

  it('error when connection present but no token', async () => {
    seedConnection()
    db.prepare('UPDATE jira_connection SET encrypted_token = NULL WHERE project_id = ?').run(PROJECT_ID)
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    const res = await mgr.createSpec({ title: 'X' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/No Jira credentials/)
  })

  it('createIssue ok → link minted + ticket_created broadcast', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/issue', { status: 201, body: { id: '90001', key: 'ACME-900' } })
    // getIssue for the full record after create.
    fake.on('GET', '/issue/90001?', {
      status: 200,
      body: { id: '90001', key: 'ACME-900', fields: { summary: 'New spec', labels: ['a'], status: { name: 'To Do', statusCategory: { key: 'new' } } } },
    })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.createSpec({ title: 'New spec', description: 'desc', labels: ['a'] })
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.jiraKey).toBe('ACME-900')
      expect(res.localId).toBeGreaterThan(0)
      // Link minted.
      const links = listLinks(db)
      expect(links.some((l) => l.jiraIssueId === '90001')).toBe(true)
      // Ticket materialized into the store.
      const store = readStore(resolveTicketStoragePath(projectPath))
      expect(store.tickets[String(res.localId)].title).toBe('New spec')
    }
    expect(typesOf()).toContain('ticket_created')
  })

  it('createIssue ok but getIssue fails → falls back to the minimal issue shape', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/issue', { status: 201, body: { id: '90002', key: 'ACME-901' } })
    fake.on('GET', '/issue/90002?', { status: 500, body: 'down' })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.createSpec({ title: 'Fallback spec', labels: ['z'] })
    expect(res.ok).toBe(true)
    if (res.ok) {
      const store = readStore(resolveTicketStoragePath(projectPath))
      expect(store.tickets[String(res.localId)].title).toBe('Fallback spec')
    }
  })

  it('createIssue 400 → error returned with status', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/issue', { status: 400, body: { errorMessages: ['bad issue type'] } })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.createSpec({ title: 'X' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(400)
  })

  it('createIssue 401 → onAuth401 triggered (jira.auth_expired) + error', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('POST', '/issue', { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.createSpec({ title: 'X' })
    expect(res.ok).toBe(false)
    expect(typesOf()).toContain('jira.auth_expired')
  })
})

// ─── resumeAfterReauth ────────────────────────────────────────────────────────

describe('resumeAfterReauth', () => {
  it('clears auth-pause and drains the parked outbox', async () => {
    seedConnection()
    enqueueTransition('R-1', 'done', 'k-resume')
    const fake = makeFakeFetch()
    // First trip auth pause via poll 401.
    fake.on('POST', '/search/jql', { status: 401, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.pollOnce()
    expect(typesOf()).toContain('jira.auth_expired')

    // Now allow the drain to succeed (already-done noop).
    fake.on('GET', '/issue/R-1?', { status: 200, body: { id: 'R-1', fields: { status: { statusCategory: { key: 'done' } } } } })
    mgr.resumeAfterReauth()
    await new Promise((r) => setTimeout(r, 0))
    expect(listOutbox(db, { state: 'done' }).length).toBe(1)
  })
})

// ─── Read helpers ─────────────────────────────────────────────────────────────

describe('read helpers', () => {
  it('listLinks / listOutbox / outboxCounts proxy the db layer', () => {
    seedConnection()
    seedLinkedTicket(30, 'L-30', 'todo')
    enqueueTransition('L-30', 'done', 'k-read', 30)
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(mgr.listLinks().some((l) => l.jiraIssueId === 'L-30')).toBe(true)
    expect(mgr.listOutbox('pending').length).toBe(1)
    expect(mgr.listOutbox().length).toBe(1)
    expect(mgr.outboxCounts().pending).toBe(1)
  })
})
