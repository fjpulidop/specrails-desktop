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
  tombstoneLink,
} from './jira-db'
import type { FetchImpl } from './jira-client'
import { JiraSyncManager, type JiraSyncManagerOpts } from './jira-sync-manager'

// ─── Fake fetch router (mirrors jira-sync-manager.test.ts) ────────────────────
//
// Route by (method, urlSubstring) → queued responses. The longest registered
// substring matching the url wins so /issue/X/transitions beats /issue/X.

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
  projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-discard-test-'))
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

// ─── 1. connect() persists discardStatus ──────────────────────────────────────

describe('connect() discardStatus persistence', () => {
  it('persists discardStatus when supplied', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 200, body: { accountId: 'a1', displayName: 'Me' } })
    fake.on('GET', `/project/${JIRA_KEY}`, { status: 200, body: { id: JIRA_PROJECT_ID, key: JIRA_KEY, name: 'Acme' } })
    fake.on('GET', '/field', { status: 200, body: [] })
    fake.on('POST', '/search/jql', { status: 200, body: { issues: [] } })

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.connect({
      baseUrl: CLOUD_BASE,
      accountEmail: 'me@acme.com',
      token: 'tok-xyz',
      jiraProjectKey: JIRA_KEY,
      discardStatus: 'Cancelled',
    })
    mgr.stop()

    expect(res.ok).toBe(true)
    expect(getConnection(db, PROJECT_ID)?.discardStatus).toBe('Cancelled')
  })

  it('leaves discardStatus null when not supplied', async () => {
    const fake = makeFakeFetch()
    fake.on('GET', '/myself', { status: 200, body: { accountId: 'a1', displayName: 'Me' } })
    fake.on('GET', `/project/${JIRA_KEY}`, { status: 200, body: { id: JIRA_PROJECT_ID, key: JIRA_KEY, name: 'Acme' } })
    fake.on('GET', '/field', { status: 200, body: [] })
    fake.on('POST', '/search/jql', { status: 200, body: { issues: [] } })

    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.connect({
      baseUrl: CLOUD_BASE,
      accountEmail: 'me@acme.com',
      token: 'tok-xyz',
      jiraProjectKey: JIRA_KEY,
    })
    mgr.stop()

    expect(res.ok).toBe(true)
    expect(getConnection(db, PROJECT_ID)?.discardStatus).toBeNull()
  })
})

// ─── 2. setDiscardStatus round-trips ──────────────────────────────────────────

describe('setDiscardStatus', () => {
  it('sets a value that round-trips via getConnection', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.setDiscardStatus('Won\'t Do')
    expect(getConnection(db, PROJECT_ID)?.discardStatus).toBe('Won\'t Do')
  })

  it('clears the value with null', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.setDiscardStatus('Cancelled')
    expect(getConnection(db, PROJECT_ID)?.discardStatus).toBe('Cancelled')
    mgr.setDiscardStatus(null)
    expect(getConnection(db, PROJECT_ID)?.discardStatus).toBeNull()
  })
})

// ─── 3. listStatusesForConnection ─────────────────────────────────────────────

describe('listStatusesForConnection()', () => {
  it('ok path: de-dupes statuses across issue types and maps category', async () => {
    seedConnection()
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
    const res = await mgr.listStatusesForConnection()
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.statuses).toEqual([
        { id: '1', name: 'To Do', category: 'new' },
        { id: '3', name: 'Done', category: 'done' },
        { id: '4', name: 'NoCat', category: 'indeterminate' },
      ])
    }
  })

  it('error path: client returns !ok → ok:false', async () => {
    seedConnection()
    const fake = makeFakeFetch()
    fake.on('GET', `/project/${JIRA_KEY}/statuses`, { status: 404, body: {} })
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.listStatusesForConnection()
    expect(res.ok).toBe(false)
  })

  it('no-connection path → ok:false with a "No Jira connection" error', async () => {
    const fake = makeFakeFetch()
    const mgr = makeManager(fake.fetchImpl)
    const res = await mgr.listStatusesForConnection()
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/No Jira connection/)
  })
})

// ─── 4. discardSpec ───────────────────────────────────────────────────────────

describe('discardSpec()', () => {
  it('(a) returns not-active when the connection is disabled / no token', () => {
    // Disabled connection → isActive() is false.
    seedConnection({ enabled: false, discardStatus: 'Cancelled' } as any)
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    const res = mgr.discardSpec(1, null)
    expect(res).toEqual({ ok: false, reason: 'not-active' })
    expect(listOutbox(db, {}).length).toBe(0)
  })

  it('(b) returns no-link when the ticket has no jira_link', () => {
    seedConnection()
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.setDiscardStatus('Cancelled')
    const res = mgr.discardSpec(999, null)
    expect(res).toEqual({ ok: false, reason: 'no-link' })
    expect(listOutbox(db, {}).length).toBe(0)
  })

  it('(b) returns no-link when the link is tombstoned', () => {
    seedConnection()
    seedLinkedTicket(5, 'I-5', 'todo')
    tombstoneLink(db, 'I-5')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.setDiscardStatus('Cancelled')
    const res = mgr.discardSpec(5, null)
    expect(res).toEqual({ ok: false, reason: 'no-link' })
  })

  it('(c) returns not-configured when discardStatus is null', () => {
    seedConnection() // discardStatus defaults to null
    seedLinkedTicket(6, 'I-6', 'todo')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    const res = mgr.discardSpec(6, null)
    expect(res).toEqual({ ok: false, reason: 'not-configured' })
    expect(listOutbox(db, {}).length).toBe(0)
  })

  it('(d) success with a comment → enqueues comment + transition(cancelled) and flips local status', async () => {
    seedConnection()
    seedLinkedTicket(7, 'I-7', 'todo')
    const fake = makeFakeFetch()
    // discardSpec calls drainOnce() best-effort; satisfy the transition path so it
    // does not throw on a missing route (already in target → noop), and the comment
    // path (getComments empty → POST).
    fake.on('GET', '/issue/I-7?', { status: 200, body: { id: 'I-7', fields: { status: { statusCategory: { key: 'done' } } } } })
    fake.on('GET', '/issue/I-7/comment', { status: 200, body: { comments: [] } })
    fake.on('POST', '/issue/I-7/comment', { status: 201, body: { id: 'c1' } })
    const mgr = makeManager(fake.fetchImpl)
    mgr.setDiscardStatus('Cancelled')

    const res = mgr.discardSpec(7, '  no longer needed  ')
    expect(res).toEqual({ ok: true })

    const ops = listOutbox(db, {})
    const transitionOp = ops.find((o) => o.opType === 'transition')!
    const commentOp = ops.find((o) => o.opType === 'comment')!
    expect(transitionOp).toBeTruthy()
    expect(commentOp).toBeTruthy()

    const tPayload = JSON.parse(transitionOp.payload)
    expect(tPayload.targetStatus).toBe('Cancelled')
    expect(tPayload.logicalState).toBe('cancelled')

    // Comment carries the trimmed reason text.
    const cPayload = JSON.parse(commentOp.payload)
    expect(cPayload.text).toBe('no longer needed')

    // Local ticket flipped to cancelled.
    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['7'].status).toBe('cancelled')

    // Outbox-state broadcast fired.
    expect(typesOf()).toContain('jira.outbox_changed')

    // let the best-effort drain microtasks settle.
    await Promise.resolve()
  })

  it('(d) success with an EMPTY comment → enqueues ONLY the transition op (no comment)', () => {
    seedConnection()
    seedLinkedTicket(8, 'I-8', 'todo')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.setDiscardStatus('Cancelled')

    const res = mgr.discardSpec(8, '   ')
    expect(res).toEqual({ ok: true })

    const ops = listOutbox(db, {})
    expect(ops.map((o) => o.opType).sort()).toEqual(['transition'])
    expect(ops.some((o) => o.opType === 'comment')).toBe(false)

    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['8'].status).toBe('cancelled')
  })

  it('(d) success with a NULL comment → enqueues ONLY the transition op (no comment)', () => {
    seedConnection()
    seedLinkedTicket(9, 'I-9', 'todo')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    mgr.setDiscardStatus('Cancelled')

    const res = mgr.discardSpec(9, null)
    expect(res).toEqual({ ok: true })

    const ops = listOutbox(db, {})
    expect(ops.map((o) => o.opType)).toEqual(['transition'])
    expect(ops.some((o) => o.opType === 'comment')).toBe(false)
  })
})

// ─── 5. executeTransition honors payload.targetStatus over statusMap ──────────

describe('executeTransition honors payload.targetStatus', () => {
  it('applies the transition whose to.name === targetStatus, overriding statusMap', async () => {
    // statusMap maps cancelled → "Some Other Status"; the per-op targetStatus must win.
    seedConnection({ statusMap: { cancelled: 'Some Other Status' } } as any)
    seedLinkedTicket(10, 'I-10', 'in_progress')
    const fake = makeFakeFetch()
    // Drive a discard so the outbox carries a transition op with targetStatus.
    // Current category 'indeterminate', target category 'done' (cancelled).
    fake.on('GET', '/issue/I-10?', {
      status: 200,
      body: { id: 'I-10', fields: { status: { statusCategory: { key: 'indeterminate' } } } },
    })
    fake.on('GET', '/issue/I-10/transitions', {
      status: 200,
      body: {
        transitions: [
          // The statusMap target — must NOT be picked.
          { id: '40', name: 'Cancel via map', to: { id: '90', name: 'Some Other Status', statusCategory: { key: 'done' } } },
          // The per-op explicit target by name — must be picked.
          { id: '41', name: 'Move to discard', to: { id: '91', name: 'Cancelled', statusCategory: { key: 'done' } } },
        ],
      },
    })
    fake.on('POST', '/issue/I-10/transitions', { status: 204 })

    const mgr = makeManager(fake.fetchImpl)
    mgr.setDiscardStatus('Cancelled')
    const res = mgr.discardSpec(10, null)
    expect(res).toEqual({ ok: true })

    // discardSpec kicks a best-effort fire-and-forget drainOnce(). Let its async
    // work (claim → getIssue → getTransitions → transitionIssue) settle, then
    // drive a second drain in case the auto-drain hadn't claimed yet.
    await new Promise((r) => setTimeout(r, 0))
    await mgr.drainOnce()

    // The applied transition is id 41 (to.name === 'Cancelled'), NOT id 40.
    const transitionPost = fake.calls.find(
      (c) => c.method === 'POST' && c.url.includes('/issue/I-10/transitions')
    )
    expect(transitionPost).toBeTruthy()
    expect(transitionPost!.body.transition.id).toBe('41')

    // The transition op reached a terminal done state.
    const done = listOutbox(db, { state: 'done' }).filter((o) => o.opType === 'transition')
    expect(done.length).toBe(1)
  })
})

// ─── 6. moveSpecToStatus() (manual status selector) ──────────────────────────

describe('moveSpecToStatus()', () => {
  it('enqueues an explicit-target transition and optimistically flips local status + raw jira_status', () => {
    seedConnection({ statusMap: { done: 'Deployed' } as never })
    seedLinkedTicket(7, '20007', 'in_progress')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)

    const result = mgr.moveSpecToStatus(7, 'Deployed')
    expect(result).toEqual({ ok: true })

    const ops = listOutbox(db, {}).filter((o) => o.opType === 'transition')
    expect(ops).toHaveLength(1)
    const payload = JSON.parse(ops[0].payload as unknown as string) as { targetStatus?: string; logicalState?: string }
    expect(payload.targetStatus).toBe('Deployed')
    // statusMap reverse-maps Deployed → done.
    expect(payload.logicalState).toBe('done')

    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['7'].status).toBe('done')
    expect(store.tickets['7'].jira_status).toBe('Deployed')
    expect(typesOf()).toContain('ticket_updated')
  })

  it('unmapped raw status falls back to logical in_progress', () => {
    seedConnection()
    seedLinkedTicket(8, '20008', 'todo')
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)

    expect(mgr.moveSpecToStatus(8, 'Weird QA Column')).toEqual({ ok: true })
    const store = readStore(resolveTicketStoragePath(projectPath))
    expect(store.tickets['8'].status).toBe('in_progress')
    expect(store.tickets['8'].jira_status).toBe('Weird QA Column')
  })

  it('rejects unlinked specs and disabled connections', () => {
    seedConnection({ enabled: false })
    const { fetchImpl } = makeFakeFetch()
    const mgr = makeManager(fetchImpl)
    expect(mgr.moveSpecToStatus(9, 'Done')).toEqual({ ok: false, reason: 'not-active' })

    seedConnection({ enabled: true })
    expect(mgr.moveSpecToStatus(9, 'Done')).toEqual({ ok: false, reason: 'no-link' })
  })
})
