import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from '../db'
import { mutateStore, readStore, resolveTicketStoragePath, type Ticket } from '../modules/specs/runtime/ticket-store'
import { setSecretStore } from './jira-credential-store'
import { upsertConnection, getLinkByLocalId, listOutbox, insertLinkWithId, enqueueMany } from './jira-db'
import { JiraSyncManager, pendingCreateIssueId } from './jira-sync-manager'
import type { FetchImpl } from './jira-client'

// ── Helpers ────────────────────────────────────────────────────────────────────

function fakeResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
    json: async () => body,
  }
}

/** Routes (method, urlSubstring) → response. Records calls. */
function makeFetch(routes: Array<{ match: (url: string, method: string) => boolean; res: ReturnType<typeof fakeResponse> }>) {
  const calls: Array<{ url: string; method: string }> = []
  const impl: FetchImpl = async (url: string, init?: any) => {
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const route = routes.find((r) => r.match(url, method))
    if (!route) return fakeResponse(404, { error: 'no route' }) as any
    return route.res as any
  }
  return { impl, calls }
}

function seedTicket(projectPath: string, id: number, title: string): void {
  mutateStore(resolveTicketStoragePath(projectPath), (s) => {
    s.tickets[String(id)] = {
      id,
      title,
      description: 'a body',
      status: 'todo',
      priority: 'medium',
      labels: ['area:x'],
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
      created_by: 'test',
      source: 'free-prompt',
    } as Ticket
    if (s.next_id <= id) s.next_id = id + 1
  })
}

function connect(db: DbInstance, projectId: string): void {
  upsertConnection(db, {
    projectId,
    baseUrl: 'https://acme.atlassian.net',
    deployment: 'cloud',
    apiVersion: '3',
    authScheme: 'basic',
    accountEmail: 'a@b.com',
    jiraProjectKey: 'PROJ',
    jiraProjectId: '1',
    token: 'tok',
    enabled: true,
  })
}

describe('promoteTicketToJira', () => {
  let db: DbInstance
  let projectPath: string

  beforeEach(() => {
    db = initDb(':memory:')
    setSecretStore({ encrypt: (s) => `e:${s}`, decrypt: (s) => s.slice(2) })
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-promote-'))
  })

  afterEach(() => {
    setSecretStore(null)
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  function manager(fetchImpl: FetchImpl, broadcast: (m: unknown) => void = () => {}) {
    return new JiraSyncManager({ db, projectId: 'p1', projectPath, broadcast: broadcast as any, fetchImpl, startTimers: false })
  }

  it('creates a Jira issue, links the SAME local id, and flips the ticket to source:jira', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 5, 'Add CSV export')
    const { impl, calls } = makeFetch([
      { match: (u, m) => m === 'POST' && u.endsWith('/issue'), res: fakeResponse(201, { id: '10001', key: 'PROJ-7' }) },
    ])
    const msgs: any[] = []
    const r = await manager(impl, (m) => msgs.push(m)).promoteTicketToJira(5)

    expect(r.ok).toBe(true)
    if (r.ok) expect(r.jiraKey).toBe('PROJ-7')
    // Linked on the SAME local id (no new id minted).
    const link = getLinkByLocalId(db, 5)
    expect(link?.jiraIssueId).toBe('10001')
    expect(link?.jiraKey).toBe('PROJ-7')
    // Cache ticket flipped to source:jira with key/url.
    const t = readStore(resolveTicketStoragePath(projectPath)).tickets['5']
    expect(t.source).toBe('jira')
    expect(t.jira_key).toBe('PROJ-7')
    expect(t.jira_url).toContain('/browse/PROJ-7')
    // Broadcast a ticket_updated.
    expect(msgs.some((m) => m.type === 'ticket_updated')).toBe(true)
    // Exactly one create call.
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issue'))).toHaveLength(1)
  })

  it('is idempotent — a second promote is a no-op (no duplicate issue)', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 5, 'Add CSV export')
    const { impl, calls } = makeFetch([
      { match: (u, m) => m === 'POST' && u.endsWith('/issue'), res: fakeResponse(201, { id: '10001', key: 'PROJ-7' }) },
    ])
    const mgr = manager(impl)
    await mgr.promoteTicketToJira(5)
    const second = await mgr.promoteTicketToJira(5)
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.alreadyLinked).toBe(true)
    expect(calls.filter((c) => c.url.endsWith('/issue'))).toHaveLength(1)
  })

  it('keeps the ticket local on a Jira create failure', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 6, 'Local stays local')
    const { impl } = makeFetch([
      { match: (u, m) => m === 'POST' && u.endsWith('/issue'), res: fakeResponse(400, { errors: { summary: 'bad' } }) },
    ])
    const r = await manager(impl).promoteTicketToJira(6)
    expect(r.ok).toBe(false)
    const t = readStore(resolveTicketStoragePath(projectPath)).tickets['6']
    expect(t.source).toBe('free-prompt')
    expect(getLinkByLocalId(db, 6)).toBeNull()
  })

  it('emits jira.auth_expired and stays local on a 401', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 7, 'Auth fails')
    const { impl } = makeFetch([
      { match: (u, m) => m === 'POST' && u.endsWith('/issue'), res: fakeResponse(401, { error: 'unauthorized' }) },
    ])
    const msgs: any[] = []
    const r = await manager(impl, (m) => msgs.push(m)).promoteTicketToJira(7)
    expect(r.ok).toBe(false)
    expect(msgs.some((m) => m.type === 'jira.auth_expired')).toBe(true)
  })

  it('returns not-active when there is no connection', async () => {
    seedTicket(projectPath, 8, 'no conn')
    const { impl } = makeFetch([])
    const r = await manager(impl).promoteTicketToJira(8)
    expect(r.ok).toBe(false)
  })

  it('returns ticket-not-found when the local id is absent', async () => {
    connect(db, 'p1')
    const { impl } = makeFetch([
      { match: (u, m) => m === 'POST' && u.endsWith('/issue'), res: fakeResponse(201, { id: 'x', key: 'PROJ-1' }) },
    ])
    const r = await manager(impl).promoteTicketToJira(999)
    expect(r.ok).toBe(false)
  })
})

describe('durable create outbox op (enqueuePromote)', () => {
  let db: DbInstance
  let projectPath: string

  beforeEach(() => {
    db = initDb(':memory:')
    setSecretStore({ encrypt: (s) => `e:${s}`, decrypt: (s) => s.slice(2) })
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-create-op-'))
  })

  afterEach(() => {
    setSecretStore(null)
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  function manager(fetchImpl: FetchImpl, broadcast: (m: unknown) => void = () => {}) {
    return new JiraSyncManager({ db, projectId: 'p1', projectPath, broadcast: broadcast as any, fetchImpl, startTimers: false })
  }
  const createRoute = (status: number, body: unknown) => ({ match: (u: string, m: string) => m === 'POST' && u.endsWith('/issue'), res: fakeResponse(status, body) })

  it('creates, links the same local id and flips the ticket like promote', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 5, 'Add CSV export')
    const { impl, calls } = makeFetch([createRoute(201, { id: '10001', key: 'PROJ-7' })])
    const msgs: any[] = []
    const mgr = manager(impl, (m) => msgs.push(m))
    expect(mgr.enqueuePromote(5, 'flow:f1:create')).toBe('enqueued')
    await mgr.drainOnce()

    const done = listOutbox(db, { state: 'done' })
    expect(done).toHaveLength(1)
    expect(done[0]).toMatchObject({ opType: 'create', jiraIssueId: pendingCreateIssueId(5), idempotencyKey: 'flow:f1:create' })
    expect(getLinkByLocalId(db, 5)).toMatchObject({ jiraIssueId: '10001', jiraKey: 'PROJ-7' })
    const t = readStore(resolveTicketStoragePath(projectPath)).tickets['5']
    expect(t).toMatchObject({ source: 'jira', jira_key: 'PROJ-7' })
    expect(msgs.some((m) => m.type === 'ticket_updated')).toBe(true)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issue'))).toHaveLength(1)
  })

  it('is idempotent: same key enqueues once, linked tickets are a no-op', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 5, 'Add CSV export')
    const { impl, calls } = makeFetch([createRoute(201, { id: '10001', key: 'PROJ-7' })])
    const mgr = manager(impl)
    mgr.enqueuePromote(5, 'k1')
    mgr.enqueuePromote(5, 'k1')
    await mgr.drainOnce()
    expect(listOutbox(db)).toHaveLength(1)
    expect(mgr.enqueuePromote(5, 'k2')).toBe('already_linked')

    // Replayed op whose ticket was linked after enqueue (e.g. a concurrent
    // promote, or a crash after linking) → done, no second issue.
    seedTicket(projectPath, 6, 'Other')
    insertLinkWithId(db, { localId: 6, jiraIssueId: '10002', jiraKey: 'PROJ-8', jiraProjectId: '1', deployment: 'cloud' })
    enqueueMany(db, [{ jiraIssueId: pendingCreateIssueId(6), opType: 'create', idempotencyKey: 'k3', payload: { localTicketId: 6 } }])
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'done' })).toHaveLength(2)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issue'))).toHaveLength(1)
  })

  it('retries server errors with backoff and keeps the ticket local', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 7, 'Flaky')
    const { impl } = makeFetch([createRoute(500, { error: 'down' })])
    const mgr = manager(impl)
    mgr.enqueuePromote(7, 'k-retry')
    await mgr.drainOnce()
    const pending = listOutbox(db, { state: 'pending' })
    expect(pending).toHaveLength(1)
    expect(pending[0].attempts).toBe(1)
    expect(pending[0].nextAttemptAt).not.toBeNull()
    expect(getLinkByLocalId(db, 7)).toBeNull()
    expect(readStore(resolveTicketStoragePath(projectPath)).tickets['7'].source).toBe('free-prompt')
  })

  it('dead-letters validation errors and missing tickets; parks on auth', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 8, 'Invalid')
    const bad = manager(makeFetch([createRoute(400, { errors: { summary: 'bad' } })]).impl)
    bad.enqueuePromote(8, 'k-400')
    bad.enqueuePromote(999, 'k-missing')
    await bad.drainOnce()
    const dead = listOutbox(db, { state: 'dead' })
    expect(dead.map((op) => op.deadReason).sort()).toEqual([expect.stringMatching(/^local ticket not found$/), expect.stringMatching(/^validation error/)].sort())

    seedTicket(projectPath, 9, 'Auth')
    const msgs: any[] = []
    const auth = manager(makeFetch([createRoute(401, {})]).impl, (m) => msgs.push(m))
    auth.enqueuePromote(9, 'k-401')
    await auth.drainOnce()
    expect(msgs.some((m) => m.type === 'jira.auth_expired')).toBe(true)
    expect(listOutbox(db, { state: 'pending' }).map((op) => op.idempotencyKey)).toEqual(['k-401'])
  })

  it('never pushes a spec held by an active or paused Flow (promote refuses, the outbox retries)', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 12, 'In Flow')
    mutateStore(resolveTicketStoragePath(projectPath), (s) => {
      s.tickets['12'].metadata.flow = { conversationId: 'c', flowId: 'f', worktreeId: 'f', startedAt: 't', state: 'active' }
    })
    const { impl, calls } = makeFetch([
      createRoute(201, { id: '10009', key: 'PROJ-9' }),
      { match: (u: string, m: string) => m === 'POST' && u.includes('/search'), res: fakeResponse(200, { issues: [] }) },
    ])
    const mgr = manager(impl)
    expect(await mgr.promoteTicketToJira(12)).toMatchObject({ ok: false, error: expect.stringContaining('still in Flow') })
    mgr.enqueuePromote(12, 'flow:f:create')
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'pending' })).toEqual([expect.objectContaining({ idempotencyKey: 'flow:f:create', attempts: 1 })])
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issue'))).toHaveLength(0)
    expect(getLinkByLocalId(db, 12)).toBeNull()

    // Once the Flow settles (delivered) the same op creates the issue.
    mutateStore(resolveTicketStoragePath(projectPath), (s) => { s.tickets['12'].metadata.flow!.state = 'delivered' })
    db.prepare('UPDATE jira_outbox SET next_attempt_at = NULL').run()
    await mgr.drainOnce()
    expect(getLinkByLocalId(db, 12)).toMatchObject({ jiraKey: 'PROJ-9' })

    // An op that never sees the Flow settle eventually dead-letters.
    seedTicket(projectPath, 13, 'Stuck in Flow')
    mutateStore(resolveTicketStoragePath(projectPath), (s) => {
      s.tickets['13'].metadata.flow = { conversationId: 'c', flowId: 'g', worktreeId: 'g', startedAt: 't', state: 'paused' }
    })
    mgr.enqueuePromote(13, 'flow:g:create')
    await mgr.drainOnce()
    db.prepare("UPDATE jira_outbox SET attempts = 5, next_attempt_at = NULL WHERE idempotency_key = 'flow:g:create'").run()
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'dead' }).map((op) => op.deadReason)).toContain('the spec is still in Flow')
  })

  it('reports inactive without a connection', () => {
    seedTicket(projectPath, 10, 'no conn')
    expect(manager(makeFetch([]).impl).enqueuePromote(10, 'k')).toBe('inactive')
    expect(listOutbox(db)).toHaveLength(0)
  })

  describe('lost create response recovery', () => {
    const marker = (id: number) => `[specrails:project=p1:ticket=${id}]`
    const makeDue = () => db.prepare('UPDATE jira_outbox SET next_attempt_at = NULL').run()

    it('stamps the issue with the creation marker property', async () => {
      connect(db, 'p1')
      seedTicket(projectPath, 11, 'Marked')
      const bodies: any[] = []
      const impl: FetchImpl = async (url: string, init?: any) => {
        if (init?.method === 'POST' && url.endsWith('/issue')) {
          bodies.push(JSON.parse(init.body))
          return fakeResponse(201, { id: '20011', key: 'PROJ-11' }) as any
        }
        return fakeResponse(404, {}) as any
      }
      const mgr = manager(impl)
      mgr.enqueuePromote(11, 'k-mark')
      await mgr.drainOnce()
      expect(bodies[0].properties).toEqual([{ key: 'sh.specrails.created-from', value: { marker: marker(11) } }])
      expect(getLinkByLocalId(db, 11)?.jiraKey).toBe('PROJ-11')
    })

    it('first attempt creates but the response is lost; the retry finds the marker and links without a second issue', async () => {
      connect(db, 'p1')
      seedTicket(projectPath, 12, 'Lost response')
      let creates = 0
      let issueExists = false
      const calls: string[] = []
      const impl: FetchImpl = async (url: string, init?: any) => {
        const method = init?.method ?? 'GET'
        calls.push(`${method} ${url}`)
        if (method === 'POST' && url.endsWith('/issue')) {
          creates++
          issueExists = true
          return fakeResponse(502, { error: 'gateway lost the response' }) as any
        }
        if (method === 'POST' && url.includes('/search')) {
          return fakeResponse(200, { issues: issueExists ? [{ id: '30001', key: 'PROJ-30', fields: { summary: 'Lost response' } }, { id: '30000', key: 'PROJ-29', fields: { summary: 'Other' } }] : [] }) as any
        }
        if (url.includes('/issue/30001/properties/sh.specrails.created-from')) {
          return fakeResponse(200, { key: 'sh.specrails.created-from', value: { marker: marker(12) } }) as any
        }
        return fakeResponse(404, {}) as any
      }
      const mgr = manager(impl)
      mgr.enqueuePromote(12, 'k-lost')
      await mgr.drainOnce()
      expect(listOutbox(db, { state: 'pending' })[0].attempts).toBe(1)
      expect(getLinkByLocalId(db, 12)).toBeNull()

      makeDue()
      await mgr.drainOnce()
      expect(creates).toBe(1)
      expect(listOutbox(db, { state: 'done' })).toHaveLength(1)
      expect(getLinkByLocalId(db, 12)).toMatchObject({ jiraIssueId: '30001', jiraKey: 'PROJ-30' })
      expect(readStore(resolveTicketStoragePath(projectPath)).tickets['12']).toMatchObject({ source: 'jira', jira_key: 'PROJ-30' })
      const search = calls.find((c) => c.includes('/search'))
      expect(search).toBeTruthy()
    })

    it('a retry that finds no marked issue creates it; an unconfirmed search never creates', async () => {
      connect(db, 'p1')
      seedTicket(projectPath, 13, 'Never created')
      let creates = 0
      let searchStatus = 503
      const impl: FetchImpl = async (url: string, init?: any) => {
        const method = init?.method ?? 'GET'
        if (method === 'POST' && url.endsWith('/issue')) {
          creates++
          return creates === 1 ? fakeResponse(500, {}) as any : fakeResponse(201, { id: '40001', key: 'PROJ-40' }) as any
        }
        if (method === 'POST' && url.includes('/search')) return fakeResponse(searchStatus, { issues: [] }) as any
        return fakeResponse(404, {}) as any
      }
      const mgr = manager(impl)
      mgr.enqueuePromote(13, 'k-none')
      await mgr.drainOnce()
      makeDue()
      await mgr.drainOnce() // search unavailable → retry later, no blind create
      expect(creates).toBe(1)
      expect(listOutbox(db, { state: 'pending' })[0].attempts).toBe(2)

      searchStatus = 200
      makeDue()
      await mgr.drainOnce()
      expect(creates).toBe(2)
      expect(getLinkByLocalId(db, 13)?.jiraKey).toBe('PROJ-40')
    })

    it('falls back to a plain create when the instance rejects create-time properties', async () => {
      connect(db, 'p1')
      seedTicket(projectPath, 14, 'Old instance')
      const bodies: any[] = []
      const impl: FetchImpl = async (url: string, init?: any) => {
        if (init?.method === 'POST' && url.endsWith('/issue')) {
          const body = JSON.parse(init.body)
          bodies.push(body)
          return body.properties ? fakeResponse(400, { errors: { properties: 'unsupported' } }) as any : fakeResponse(201, { id: '50001', key: 'PROJ-50' }) as any
        }
        return fakeResponse(404, {}) as any
      }
      const r = await manager(impl).promoteTicketToJira(14)
      expect(r).toMatchObject({ ok: true, jiraKey: 'PROJ-50' })
      expect(bodies.map((b) => Boolean(b.properties))).toEqual([true, false])
    })
  })
})


describe('durable update of a linked spec (enqueueSpecUpdate, Flow from an existing spec)', () => {
  let db: DbInstance
  let projectPath: string

  beforeEach(() => {
    db = initDb(':memory:')
    setSecretStore({ encrypt: (s) => `e:${s}`, decrypt: (s) => s.slice(2) })
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-update-op-'))
  })

  afterEach(() => {
    setSecretStore(null)
    fs.rmSync(projectPath, { recursive: true, force: true })
  })

  it('updates the existing issue with the rewritten spec, once per key, and never creates an issue', async () => {
    connect(db, 'p1')
    seedTicket(projectPath, 5, 'Rewritten title')
    insertLinkWithId(db, { localId: 5, jiraIssueId: '10001', jiraKey: 'PROJ-7', jiraProjectId: '1', deployment: 'cloud' })
    const { impl, calls } = makeFetch([{ match: (u: string, m: string) => m === 'PUT' && u.includes('/issue/10001'), res: fakeResponse(204, {}) }])
    const mgr = new JiraSyncManager({ db, projectId: 'p1', projectPath, broadcast: (() => {}) as any, fetchImpl: impl, startTimers: false })
    expect(mgr.enqueueSpecUpdate(5, 'flow:f1:update')).toBe('enqueued')
    expect(mgr.enqueueSpecUpdate(5, 'flow:f1:update')).toBe('enqueued')
    expect(listOutbox(db)).toHaveLength(1)
    expect(listOutbox(db)[0]).toMatchObject({ opType: 'update', jiraIssueId: '10001', idempotencyKey: 'flow:f1:update' })
    const raw = (listOutbox(db)[0] as unknown as { payload: unknown }).payload
    const payload = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { fields: { summary: string } }
    expect(payload.fields.summary).toBe('Rewritten title')
    await mgr.drainOnce()
    expect(listOutbox(db, { state: 'done' })).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'PUT' && c.url.includes('/issue/10001'))).toHaveLength(1)
    expect(calls.filter((c) => c.method === 'POST' && c.url.endsWith('/issue'))).toHaveLength(0)
    seedTicket(projectPath, 6, 'Unlinked')
    expect(mgr.enqueueSpecUpdate(6, 'flow:f2:update')).toBe('not_linked')
  })
})
