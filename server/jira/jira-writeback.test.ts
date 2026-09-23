// Jira field write-back: editing a Jira-backed spec + Save pushes the edited
// fields (summary/description/labels/priority) to the issue via an 'update'
// outbox op, and the id is frozen so the inbound poll won't revert the edit.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

import { initDb, type DbInstance } from '../db'
import { readStore, resolveTicketStoragePath, mutateStore, type Ticket } from '../modules/specs/runtime/ticket-store'
import { setSecretStore } from './jira-credential-store'
import { upsertConnection, insertLinkWithId, listOutbox, getLinkByLocalId } from './jira-db'
import type { FetchImpl } from './jira-client'
import { JiraSyncManager, type JiraSyncManagerOpts } from './jira-sync-manager'

interface FakeSpec { status: number; body?: unknown }
function makeFakeFetch() {
  const queues = new Map<string, FakeSpec[]>()
  const calls: Array<{ method: string; url: string; body?: any }> = []
  function on(method: string, substring: string, ...specs: FakeSpec[]) {
    const key = `${method} ${substring}`
    queues.set(key, [...(queues.get(key) ?? []), ...specs])
  }
  const fetchImpl: FetchImpl = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined })
    let best: { key: string; len: number } | null = null
    for (const key of queues.keys()) {
      if (!key.startsWith(`${method} `)) continue
      const sub = key.slice(method.length + 1)
      if (url.includes(sub) && (queues.get(key)?.length ?? 0) > 0 && (!best || sub.length > best.len)) best = { key, len: sub.length }
    }
    if (!best) throw new Error(`fake-fetch: no queued response for ${method} ${url}`)
    const spec = queues.get(best.key)!.shift()!
    return {
      status: spec.status,
      ok: spec.status >= 200 && spec.status < 300,
      headers: { get: () => null },
      text: async () => (spec.body === undefined ? '' : JSON.stringify(spec.body)),
      json: async () => spec.body,
    }
  }
  return { fetchImpl, on, calls }
}

const PROJECT_ID = 'proj-wb'
const CLOUD_BASE = 'https://acme.atlassian.net'
let db: DbInstance
let projectPath: string

beforeEach(() => {
  db = initDb(':memory:')
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-wb-'))
  setSecretStore({ encrypt: (s: string) => 'enc:' + s, decrypt: (s: string) => s.slice(4) })
  upsertConnection(db, {
    projectId: PROJECT_ID, baseUrl: CLOUD_BASE, deployment: 'cloud', apiVersion: '3',
    authScheme: 'basic', accountEmail: 'me@acme.com', jiraProjectKey: 'ACME', jiraProjectId: '10000',
    token: 'tok', enabled: true, statusMap: null,
  })
})
afterEach(() => {
  setSecretStore(null)
  fs.rmSync(projectPath, { recursive: true, force: true })
  vi.useRealTimers()
})

function makeManager(fetchImpl: FetchImpl, opts: Partial<JiraSyncManagerOpts> = {}) {
  return new JiraSyncManager({ db, projectId: PROJECT_ID, projectPath, broadcast: () => {}, fetchImpl, startTimers: false, ...opts })
}

function seedLinked(localId: number, jiraIssueId: string, over: Partial<Ticket> = {}) {
  insertLinkWithId(db, { localId, jiraIssueId, jiraKey: `ACME-${localId}`, jiraProjectId: '10000', deployment: 'cloud' })
  mutateStore(resolveTicketStoragePath(projectPath), (s) => {
    s.tickets[String(localId)] = {
      id: localId, title: `Ticket ${localId}`, description: '', status: 'todo', priority: 'medium',
      labels: [], assignee: null, prerequisites: [], metadata: {}, comments: [], origin_conversation_id: null,
      is_epic: false, parent_epic_id: null, execution_order: null, short_summary: null,
      created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z', created_by: 'jira', source: 'jira',
      jira_key: `ACME-${localId}`, jira_url: `${CLOUD_BASE}/browse/ACME-${localId}`, ...over,
    } as Ticket
    if (s.next_id <= localId) s.next_id = localId + 1
  })
}

const updateOps = () => listOutbox(db, {}).filter((o) => o.opType === 'update')

/** Let the fire-and-forget drain that onSpecEdited kicks off run to completion. */
async function flush() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r))
}

describe('onSpecEdited — enqueue', () => {
  it('no-op when the connection is disabled (not active)', () => {
    const mgr = makeManager(makeFakeFetch().fetchImpl)
    mgr.setEnabled(false)
    seedLinked(1, 'I-1')
    mgr.onSpecEdited(1, { title: 'New' })
    expect(updateOps()).toHaveLength(0)
  })

  it('no-op when the spec has no Jira link', () => {
    const mgr = makeManager(makeFakeFetch().fetchImpl)
    mgr.onSpecEdited(99, { title: 'New' })
    expect(updateOps()).toHaveLength(0)
  })

  it('no-op when there are no mappable changes', () => {
    const mgr = makeManager(makeFakeFetch().fetchImpl)
    seedLinked(1, 'I-1')
    mgr.onSpecEdited(1, {})
    mgr.onSpecEdited(1, { priority: null })
    expect(updateOps()).toHaveLength(0)
  })

  it('enqueues an update op with summary/description/labels/priority mapped', () => {
    const { fetchImpl, on } = makeFakeFetch()
    on('PUT', '/issue/I-1', { status: 204 })
    const mgr = makeManager(fetchImpl)
    seedLinked(1, 'I-1')
    mgr.onSpecEdited(1, { title: '  New title  ', description: 'line1\nline2', labels: ['a', 'b'], priority: 'critical' })
    const ops = updateOps()
    expect(ops).toHaveLength(1)
    const payload = JSON.parse(ops[0].payload)
    expect(payload.jiraIssueId).toBe('I-1')
    expect(payload.fields.summary).toBe('New title')
    expect(payload.fields.labels).toEqual(['a', 'b'])
    expect(payload.fields.priority).toEqual({ name: 'Highest' })
    // Cloud description is rendered to ADF (not a raw string).
    expect(payload.fields.description).toMatchObject({ type: 'doc' })
  })
})

describe('executeUpdate — drain', () => {
  it('PUTs the issue fields and marks the op done', async () => {
    const fake = makeFakeFetch()
    fake.on('PUT', '/issue/I-2', { status: 204 })
    const mgr = makeManager(fake.fetchImpl)
    seedLinked(2, 'I-2')
    mgr.onSpecEdited(2, { title: 'X' })
    await flush()
    expect(listOutbox(db, { state: 'done' }).filter((o) => o.opType === 'update')).toHaveLength(1)
    const put = fake.calls.find((c) => c.method === 'PUT' && c.url.includes('/issue/I-2'))
    expect(put?.body).toEqual({ fields: { summary: 'X' } })
  })

  it('retries without priority when the instance rejects the priority name', async () => {
    const fake = makeFakeFetch()
    fake.on('PUT', '/issue/I-3', { status: 400, body: 'unknown priority' }, { status: 204 })
    const mgr = makeManager(fake.fetchImpl)
    seedLinked(3, 'I-3')
    mgr.onSpecEdited(3, { title: 'X', priority: 'low' })
    await flush()
    const puts = fake.calls.filter((c) => c.method === 'PUT' && c.url.includes('/issue/I-3'))
    expect(puts).toHaveLength(2)
    expect(puts[0].body.fields.priority).toEqual({ name: 'Low' })
    expect(puts[1].body.fields.priority).toBeUndefined()
    expect(puts[1].body.fields.summary).toBe('X')
    expect(listOutbox(db, { state: 'done' }).filter((o) => o.opType === 'update')).toHaveLength(1)
  })

  it('tombstones the link and dead-letters on 404', async () => {
    const fake = makeFakeFetch()
    fake.on('PUT', '/issue/I-4', { status: 404, body: 'gone' })
    const mgr = makeManager(fake.fetchImpl)
    seedLinked(4, 'I-4')
    mgr.onSpecEdited(4, { title: 'X' })
    await flush()
    expect(listOutbox(db, { state: 'dead' }).filter((o) => o.opType === 'update')).toHaveLength(1)
    expect(getLinkByLocalId(db, 4)?.tombstoned).toBe(true)
  })
})

describe('safety invariant: local-tickets.json changes never push to Jira', () => {
  it('the inbound poll materializes issues WITHOUT enqueuing any outbox op', async () => {
    const fake = makeFakeFetch()
    fake.on('POST', '/search/jql', {
      status: 200,
      body: { issues: [{ id: 'I-7', key: 'ACME-7', fields: { summary: 'From Jira', status: { statusCategory: { key: 'new' } } } }] },
    })
    const mgr = makeManager(fake.fetchImpl)
    await mgr.pollOnce(true)
    // The issue was written into the local store…
    const tickets = Object.values(readStore(resolveTicketStoragePath(projectPath)).tickets)
    expect(tickets.some((t) => t.jira_key === 'ACME-7')).toBe(true)
    // …and the sync enqueued ZERO outbound Jira writes.
    expect(listOutbox(db, {})).toHaveLength(0)
  })

  it('editing local-tickets.json directly does NOT enqueue a Jira write', () => {
    seedLinked(8, 'I-8')
    mutateStore(resolveTicketStoragePath(projectPath), (s) => {
      s.tickets['8'].title = 'Edited straight in the file (e.g. by specrails-core)'
    })
    // Nothing watches the file to push — only the explicit onSpecEdited path does.
    expect(listOutbox(db, {})).toHaveLength(0)
  })
})

describe('frozen guard — the poll does not revert a pending edit', () => {
  it('preserves the locally-edited title while an update op is pending', async () => {
    const fake = makeFakeFetch()
    // Update op stays pending (no PUT response queued → drain not called here).
    const mgr = makeManager(fake.fetchImpl)
    seedLinked(5, 'I-5', { title: 'Edited locally' })
    mgr.onSpecEdited(5, { title: 'Edited locally' })
    await flush() // let the internal drain attempt settle (op stays pending → frozen)
    // Inbound poll returns the OLD Jira title.
    fake.on('POST', '/search/jql', {
      status: 200,
      body: { issues: [{ id: 'I-5', key: 'ACME-5', fields: { summary: 'Old Jira title', status: { statusCategory: { key: 'new' } } } }] },
    })
    await mgr.pollOnce(true)
    const ticket = readStore(resolveTicketStoragePath(projectPath)).tickets['5']
    expect(ticket.title).toBe('Edited locally') // not reverted to 'Old Jira title'
  })
})
