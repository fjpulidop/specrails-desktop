import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initDb, type DbInstance } from '../db'
import { mutateStore, readStore, resolveTicketStoragePath, type Ticket } from '../modules/specs/runtime/ticket-store'
import { setSecretStore } from './jira-credential-store'
import { upsertConnection, getLinkByLocalId } from './jira-db'
import { JiraSyncManager } from './jira-sync-manager'
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
