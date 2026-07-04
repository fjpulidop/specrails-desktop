import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDb, type DbInstance } from './db'
import { createJiraRouter } from './jira-router'
import {
  upsertConnection,
  enqueueOutbox,
  markOutboxDead,
} from './jira/jira-db'
import { setSecretStore, type SecretStore } from './jira/jira-credential-store'
import type { ProjectContext } from './project-registry'

// Deterministic, in-memory secret store so tests never touch the real keyfile.
const fakeSecretStore: SecretStore = {
  encrypt: (plaintext: string) => `enc:${plaintext}`,
  decrypt: (blob: string) => blob.replace(/^enc:/, ''),
}

const PROJECT_ID = 'p1'

type JiraSyncManagerStub = {
  probeCredentials: ReturnType<typeof vi.fn>
  discoverProjects: ReturnType<typeof vi.fn>
  discoverStatuses: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  setEnabled: ReturnType<typeof vi.fn>
  setStatusMap: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
  resumeAfterReauth: ReturnType<typeof vi.fn>
  pollOnce: ReturnType<typeof vi.fn>
  listOutbox: ReturnType<typeof vi.fn>
  outboxCounts: ReturnType<typeof vi.fn>
  drainOnce: ReturnType<typeof vi.fn>
  createSpec: ReturnType<typeof vi.fn>
  listLinks: ReturnType<typeof vi.fn>
}

let db: DbInstance
let app: express.Express
let syncStub: JiraSyncManagerStub

function makeStub(): JiraSyncManagerStub {
  return {
    probeCredentials: vi.fn(),
    discoverProjects: vi.fn(),
    discoverStatuses: vi.fn(),
    connect: vi.fn(),
    setEnabled: vi.fn(),
    setStatusMap: vi.fn(),
    disconnect: vi.fn(),
    resumeAfterReauth: vi.fn(),
    pollOnce: vi.fn(),
    listOutbox: vi.fn(() => []),
    outboxCounts: vi.fn(() => ({ pending: 0, inflight: 0, done: 0, dead: 0 })),
    drainOnce: vi.fn(() => Promise.resolve()),
    createSpec: vi.fn(),
    listLinks: vi.fn(() => []),
  }
}

/** Insert a real connection row so getConnectionPublic returns a populated shape. */
function seedConnection(): void {
  upsertConnection(db, {
    projectId: PROJECT_ID,
    baseUrl: 'https://acme.atlassian.net',
    deployment: 'cloud',
    apiVersion: '3',
    authScheme: 'basic',
    accountEmail: 'pm@acme.com',
    jiraProjectKey: 'PROJ',
    jiraProjectId: '10001',
    token: 'secret-token',
    enabled: true,
    statusMap: null,
  })
}

function mountApp(): void {
  syncStub = makeStub()
  app = express()
  app.use(express.json())
  const ctx = {
    project: { id: PROJECT_ID },
    db,
    jiraSyncManager: syncStub,
  } as unknown as ProjectContext
  app.use(
    '/jira',
    (req, _res, next) => {
      ;(req as unknown as { projectCtx: ProjectContext }).projectCtx = ctx
      next()
    },
    createJiraRouter()
  )
}

beforeEach(() => {
  setSecretStore(fakeSecretStore)
  db = initDb(':memory:')
  mountApp()
})

afterEach(() => {
  setSecretStore(null)
  vi.clearAllMocks()
})

// ─── Feature flag gate ─────────────────────────────────────────────────────────

describe('feature flag gate', () => {
  it('404s every route when SPECRAILS_JIRA_SECTION=false', async () => {
    process.env.SPECRAILS_JIRA_SECTION = 'false'
    try {
      const res = await request(app).get('/jira/connection')
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('Jira integration disabled')
    } finally {
      delete process.env.SPECRAILS_JIRA_SECTION
    }
  })
})

// ─── GET /connection ───────────────────────────────────────────────────────────

describe('GET /connection', () => {
  it('returns connected:false when no connection is configured', async () => {
    const res = await request(app).get('/jira/connection')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ connected: false })
  })

  it('returns connected:true with the redacted connection and outbox counts', async () => {
    seedConnection()
    syncStub.outboxCounts.mockReturnValue({ pending: 2, inflight: 1, done: 3, dead: 0 })
    const res = await request(app).get('/jira/connection')
    expect(res.status).toBe(200)
    expect(res.body.connected).toBe(true)
    expect(res.body.connection.jiraProjectKey).toBe('PROJ')
    expect(res.body.connection.hasToken).toBe(true)
    // Token is never returned to the client.
    expect(res.body.connection.encrypted_token).toBeUndefined()
    expect(res.body.connection.token).toBeUndefined()
    expect(res.body.outbox).toEqual({ pending: 2, inflight: 1, done: 3, dead: 0 })
    expect(syncStub.outboxCounts).toHaveBeenCalled()
  })
})

// ─── POST /test ────────────────────────────────────────────────────────────────

describe('POST /test', () => {
  it('400s when baseUrl or token is missing', async () => {
    const res = await request(app).post('/jira/test').send({ baseUrl: 'https://x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('baseUrl and token are required')
    expect(syncStub.probeCredentials).not.toHaveBeenCalled()
  })

  it('200s and returns the probe result on success', async () => {
    syncStub.probeCredentials.mockResolvedValue({ ok: true, deployment: 'cloud', displayName: 'PM' })
    const res = await request(app)
      .post('/jira/test')
      .send({ baseUrl: ' https://acme.atlassian.net ', accountEmail: ' pm@acme.com ', token: 'tok' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, deployment: 'cloud', displayName: 'PM' })
    expect(syncStub.probeCredentials).toHaveBeenCalledWith({
      baseUrl: 'https://acme.atlassian.net',
      accountEmail: 'pm@acme.com',
      token: 'tok',
    })
  })

  it('401s when the probe fails with auth', async () => {
    syncStub.probeCredentials.mockResolvedValue({ ok: false, error: 'Invalid email or token', status: 401 })
    const res = await request(app)
      .post('/jira/test')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid email or token')
  })

  it('400s when the probe fails non-auth (and passes accountEmail null)', async () => {
    syncStub.probeCredentials.mockResolvedValue({ ok: false, error: 'boom', status: 500 })
    const res = await request(app)
      .post('/jira/test')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('boom')
    expect(syncStub.probeCredentials).toHaveBeenCalledWith({
      baseUrl: 'https://acme.atlassian.net',
      accountEmail: null,
      token: 'tok',
    })
  })
})

// ─── POST /discover-projects ─────────────────────────────────────────────────────

describe('POST /discover-projects', () => {
  it('400s when baseUrl or token is missing', async () => {
    const res = await request(app).post('/jira/discover-projects').send({ token: 'tok' })
    expect(res.status).toBe(400)
    expect(syncStub.discoverProjects).not.toHaveBeenCalled()
  })

  it('200s and returns projects, trimming the query', async () => {
    syncStub.discoverProjects.mockResolvedValue({
      ok: true,
      projects: [{ id: '1', key: 'PROJ', name: 'Project' }],
    })
    const res = await request(app)
      .post('/jira/discover-projects')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok', query: '  pro  ' })
    expect(res.status).toBe(200)
    expect(res.body.projects).toHaveLength(1)
    expect(syncStub.discoverProjects).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'pro', accountEmail: null })
    )
  })

  it('400s when discovery fails', async () => {
    syncStub.discoverProjects.mockResolvedValue({ ok: false, error: 'nope', status: 400 })
    const res = await request(app)
      .post('/jira/discover-projects')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('nope')
  })
})

// ─── POST /discover-statuses ─────────────────────────────────────────────────────

describe('POST /discover-statuses', () => {
  it('400s when projectKey is missing', async () => {
    const res = await request(app)
      .post('/jira/discover-statuses')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('baseUrl, token and projectKey are required')
    expect(syncStub.discoverStatuses).not.toHaveBeenCalled()
  })

  it('200s and returns statuses', async () => {
    syncStub.discoverStatuses.mockResolvedValue({
      ok: true,
      statuses: [{ id: '1', name: 'To Do', category: 'new' }],
    })
    const res = await request(app)
      .post('/jira/discover-statuses')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok', projectKey: ' PROJ ' })
    expect(res.status).toBe(200)
    expect(res.body.statuses).toHaveLength(1)
    expect(syncStub.discoverStatuses).toHaveBeenCalledWith(
      expect.objectContaining({ projectKey: 'PROJ' })
    )
  })

  it('400s when discovery fails', async () => {
    syncStub.discoverStatuses.mockResolvedValue({ ok: false, error: 'bad project' })
    const res = await request(app)
      .post('/jira/discover-statuses')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok', projectKey: 'PROJ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('bad project')
  })
})

// ─── POST /connect ───────────────────────────────────────────────────────────────

describe('POST /connect', () => {
  it('400s when required fields are missing', async () => {
    const res = await request(app)
      .post('/jira/connect')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('baseUrl, token and jiraProjectKey are required')
    expect(syncStub.connect).not.toHaveBeenCalled()
  })

  it('201s and returns the persisted connection on success', async () => {
    // connect() resolution succeeds; the row is read back from the real DB.
    syncStub.connect.mockImplementation(async () => {
      seedConnection()
      return { ok: true, connection: {} }
    })
    const res = await request(app)
      .post('/jira/connect')
      .send({
        baseUrl: 'https://acme.atlassian.net',
        accountEmail: 'pm@acme.com',
        token: 'tok',
        jiraProjectKey: ' PROJ ',
        statusMap: { todo: '  To Do  ', bogus: 'x', done: '' },
      })
    expect(res.status).toBe(201)
    expect(res.body.connection.jiraProjectKey).toBe('PROJ')
    expect(res.body.connection.hasToken).toBe(true)
    // statusMap was sanitized: only the non-empty known key survives.
    expect(syncStub.connect).toHaveBeenCalledWith(
      expect.objectContaining({ jiraProjectKey: 'PROJ', statusMap: { todo: 'To Do' } })
    )
  })

  it('passes statusMap null when no valid keys remain', async () => {
    syncStub.connect.mockResolvedValue({ ok: true, connection: {} })
    await request(app)
      .post('/jira/connect')
      .send({
        baseUrl: 'https://acme.atlassian.net',
        token: 'tok',
        jiraProjectKey: 'PROJ',
        statusMap: { bogus: 'x' },
      })
    expect(syncStub.connect).toHaveBeenCalledWith(expect.objectContaining({ statusMap: null }))
  })

  it('keeps statusMap.on_review through sanitize (round-trips to connect)', async () => {
    syncStub.connect.mockResolvedValue({ ok: true, connection: {} })
    await request(app)
      .post('/jira/connect')
      .send({
        baseUrl: 'https://acme.atlassian.net',
        token: 'tok',
        jiraProjectKey: 'PROJ',
        statusMap: { todo: 'To Do', on_review: ' In Review ' },
      })
    expect(syncStub.connect).toHaveBeenCalledWith(
      expect.objectContaining({ statusMap: { todo: 'To Do', on_review: 'In Review' } })
    )
  })

  it('401s when connect fails with auth', async () => {
    syncStub.connect.mockResolvedValue({ ok: false, error: 'Invalid Jira credentials', status: 401 })
    const res = await request(app)
      .post('/jira/connect')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok', jiraProjectKey: 'PROJ' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Invalid Jira credentials')
  })

  it('400s when connect fails non-auth', async () => {
    syncStub.connect.mockResolvedValue({ ok: false, error: 'not found', status: 404 })
    const res = await request(app)
      .post('/jira/connect')
      .send({ baseUrl: 'https://acme.atlassian.net', token: 'tok', jiraProjectKey: 'PROJ' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('not found')
  })
})

// ─── PATCH /connection ───────────────────────────────────────────────────────────

describe('PATCH /connection', () => {
  it('404s when no connection is configured', async () => {
    const res = await request(app).patch('/jira/connection').send({ enabled: false })
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('No Jira connection configured')
    expect(syncStub.setEnabled).not.toHaveBeenCalled()
  })

  it('200s and toggles enabled when a boolean is provided', async () => {
    seedConnection()
    const res = await request(app).patch('/jira/connection').send({ enabled: false })
    expect(res.status).toBe(200)
    expect(res.body.connection.jiraProjectKey).toBe('PROJ')
    expect(syncStub.setEnabled).toHaveBeenCalledWith(false)
  })

  it('200s without toggling when enabled is not a boolean', async () => {
    seedConnection()
    const res = await request(app).patch('/jira/connection').send({ enabled: 'yes' })
    expect(res.status).toBe(200)
    expect(syncStub.setEnabled).not.toHaveBeenCalled()
  })

  it('sanitizes and forwards a statusMap that includes on_review', async () => {
    seedConnection()
    const res = await request(app)
      .patch('/jira/connection')
      .send({ statusMap: { on_review: ' In Review ', bogus: 'x', done: '' } })
    expect(res.status).toBe(200)
    expect(syncStub.setStatusMap).toHaveBeenCalledWith({ on_review: 'In Review' })
  })

  it('does not touch the statusMap when the field is absent', async () => {
    seedConnection()
    const res = await request(app).patch('/jira/connection').send({ enabled: true })
    expect(res.status).toBe(200)
    expect(syncStub.setStatusMap).not.toHaveBeenCalled()
  })
})

// ─── DELETE /connection ──────────────────────────────────────────────────────────

describe('DELETE /connection', () => {
  it('disconnects and returns connected:false', async () => {
    const res = await request(app).delete('/jira/connection')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ connected: false })
    expect(syncStub.disconnect).toHaveBeenCalled()
  })
})

// ─── POST /resume ────────────────────────────────────────────────────────────────

describe('POST /resume', () => {
  it('resumes after re-auth and returns ok', async () => {
    const res = await request(app).post('/jira/resume')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(syncStub.resumeAfterReauth).toHaveBeenCalled()
  })
})

// ─── POST /sync ──────────────────────────────────────────────────────────────────

describe('POST /sync', () => {
  it('triggers a poll and reports the upserted count', async () => {
    syncStub.pollOnce.mockResolvedValue({ upserted: 7 })
    const res = await request(app).post('/jira/sync')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, upserted: 7 })
  })

  it('defaults upserted to 0 when pollOnce returns null', async () => {
    syncStub.pollOnce.mockResolvedValue(null)
    const res = await request(app).post('/jira/sync')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, upserted: 0 })
  })
})

// ─── GET /outbox ─────────────────────────────────────────────────────────────────

describe('GET /outbox', () => {
  it('lists all ops when no state filter is given', async () => {
    syncStub.listOutbox.mockReturnValue([{ id: 1 }])
    syncStub.outboxCounts.mockReturnValue({ pending: 1, inflight: 0, done: 0, dead: 0 })
    const res = await request(app).get('/jira/outbox')
    expect(res.status).toBe(200)
    expect(res.body.ops).toEqual([{ id: 1 }])
    expect(res.body.counts.pending).toBe(1)
    expect(syncStub.listOutbox).toHaveBeenCalledWith(undefined)
  })

  it('passes a valid state filter through', async () => {
    await request(app).get('/jira/outbox?state=dead')
    expect(syncStub.listOutbox).toHaveBeenCalledWith('dead')
  })

  it('ignores an invalid state filter', async () => {
    await request(app).get('/jira/outbox?state=bogus')
    expect(syncStub.listOutbox).toHaveBeenCalledWith(undefined)
  })
})

// ─── POST /outbox/:id/retry ──────────────────────────────────────────────────────

describe('POST /outbox/:id/retry', () => {
  function seedDeadOp(): number {
    const id = enqueueOutbox(db, {
      jiraIssueId: '10001',
      opType: 'transition',
      idempotencyKey: 'job:1:transition:done',
      payload: { logicalState: 'done' },
    })
    markOutboxDead(db, id, 'exhausted retries')
    return id
  }

  it('400s on a non-numeric id', async () => {
    const res = await request(app).post('/jira/outbox/abc/retry')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('Invalid op id')
  })

  it('404s when the op is not found or not dead', async () => {
    const res = await request(app).post('/jira/outbox/9999/retry')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Op not found or not in dead state')
    expect(syncStub.drainOnce).not.toHaveBeenCalled()
  })

  it('200s and kicks a drain when a dead op is re-queued', async () => {
    const id = seedDeadOp()
    const res = await request(app).post(`/jira/outbox/${id}/retry`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(syncStub.drainOnce).toHaveBeenCalled()
    // The row was flipped back to pending.
    const row = db.prepare('SELECT state FROM jira_outbox WHERE id = ?').get(id) as { state: string }
    expect(row.state).toBe('pending')
  })
})

// ─── POST /specs ─────────────────────────────────────────────────────────────────

describe('POST /specs', () => {
  it('400s when title is missing', async () => {
    const res = await request(app).post('/jira/specs').send({ description: 'x' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('title is required')
    expect(syncStub.createSpec).not.toHaveBeenCalled()
  })

  it('201s with localId and jiraKey on success, filtering non-string labels', async () => {
    syncStub.createSpec.mockResolvedValue({ ok: true, localId: 42, jiraKey: 'PROJ-42' })
    const res = await request(app)
      .post('/jira/specs')
      .send({
        title: '  Build it  ',
        description: 'desc',
        labels: ['a', 1, 'b'],
        priority: 'High',
        issueType: 'Bug',
      })
    expect(res.status).toBe(201)
    expect(res.body).toEqual({ localId: 42, jiraKey: 'PROJ-42' })
    expect(syncStub.createSpec).toHaveBeenCalledWith({
      title: 'Build it',
      description: 'desc',
      labels: ['a', 'b'],
      priority: 'High',
      issueType: 'Bug',
    })
  })

  it('passes undefined for missing optional fields', async () => {
    syncStub.createSpec.mockResolvedValue({ ok: true, localId: 1, jiraKey: 'PROJ-1' })
    await request(app).post('/jira/specs').send({ title: 'Title', labels: 'not-array' })
    expect(syncStub.createSpec).toHaveBeenCalledWith({
      title: 'Title',
      description: undefined,
      labels: undefined,
      priority: undefined,
      issueType: undefined,
    })
  })

  it('401s when createSpec fails with auth', async () => {
    syncStub.createSpec.mockResolvedValue({ ok: false, error: 'auth gone', status: 401 })
    const res = await request(app).post('/jira/specs').send({ title: 'Title' })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('auth gone')
  })

  it('400s when createSpec fails non-auth', async () => {
    syncStub.createSpec.mockResolvedValue({ ok: false, error: 'create failed', status: 400 })
    const res = await request(app).post('/jira/specs').send({ title: 'Title' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('create failed')
  })
})

// ─── GET /links ──────────────────────────────────────────────────────────────────

describe('GET /links', () => {
  it('returns the spec↔issue map', async () => {
    syncStub.listLinks.mockReturnValue([{ localId: 1, jiraKey: 'PROJ-1' }])
    const res = await request(app).get('/jira/links')
    expect(res.status).toBe(200)
    expect(res.body.links).toEqual([{ localId: 1, jiraKey: 'PROJ-1' }])
  })
})
