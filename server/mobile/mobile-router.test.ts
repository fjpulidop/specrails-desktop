import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import http from 'http'
import request from 'supertest'
import { initDesktopDb } from '../desktop-db'
import type { DbInstance } from '../db'
import { createDevice, hashToken } from './mobile-devices'
import { createMobileRouter } from './mobile-router'

// A stand-in "internal server" the gateway forwards to. Captures the last body so
// we can assert narrowing, and echoes auth so we can assert the master token is
// injected.
let internal: http.Server
let internalPort = 0
let lastPatchBody: unknown = null
let lastAuth: string | undefined

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  // Exact GET /api/projects is served by the desktop router (mounted at /api).
  app.get('/api/projects', (req, res) => {
    lastAuth = req.headers['x-desktop-token'] as string | undefined
    res.json({ projects: [{ id: 'p1', name: 'P', slug: 's', path: '/Users/x/secret', db_path: '/d' }] })
  })
  app.get('/api/projects/:id/tickets', (_req, res) => res.json({ tickets: [{ id: 1, title: 'T' }] }))
  app.patch('/api/projects/:id/tickets/:tid', (req, res) => { lastPatchBody = req.body; res.json({ ok: true, received: req.body }) })
  app.get('/api/projects/:id/spending', (req, res) => res.json({ query: req.query }))
  // Generic echo for every other forwarded route (actions, other reads): returns
  // the method/path/body so tests can assert narrowing + reachability.
  app.use((req, res) => res.json({ echoed: true, method: req.method, route: req.path, body: req.body }))
  internal = http.createServer(app)
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r))
  internalPort = (internal.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise<void>((r) => internal.close(() => r()))
})

function buildApp(db: DbInstance): express.Express {
  const app = express()
  app.use(express.json())
  app.use(createMobileRouter({ db, desktopPort: internalPort, currentFingerprint: () => 'fp' }))
  return app
}

describe('mobile-router', () => {
  let db: DbInstance
  let app: express.Express
  beforeEach(() => {
    db = initDesktopDb(':memory:')
    createDevice(db, { name: 'A', platform: 'ios', tokenHash: hashToken('tok'), certFingerprint: 'fp' })
    app = buildApp(db)
    lastPatchBody = null
  })

  it('GET /v1/projects returns redacted projects with the master token injected', async () => {
    const res = await request(app).get('/v1/projects').set('Authorization', 'Bearer tok')
    expect(res.status).toBe(200)
    expect(res.body.projects[0].path).toBeUndefined()
    expect(res.body.projects[0].db_path).toBeUndefined()
    expect(res.body.projects[0].id).toBe('p1')
    // Master token injected via the x-desktop-token header (matches server/auth.ts).
    expect(lastAuth).toBeTruthy()
    expect(lastAuth!.length).toBeGreaterThan(0)
  })

  it('401 without a device token', async () => {
    const res = await request(app).get('/v1/projects')
    expect(res.status).toBe(401)
  })

  it('403 when a browser Origin header is present', async () => {
    const res = await request(app).get('/v1/projects').set('Authorization', 'Bearer tok').set('Origin', 'http://evil')
    expect(res.status).toBe(403)
  })

  it('400 on a param with a traversal/dot (regex guard)', async () => {
    const res = await request(app).get('/v1/projects/ba..d/tickets').set('Authorization', 'Bearer tok')
    expect(res.status).toBe(400)
  })

  it('narrows the PATCH body to {status,priority,title}', async () => {
    const res = await request(app)
      .patch('/v1/projects/p1/tickets/5')
      .set('Authorization', 'Bearer tok')
      .send({ status: 'done', evil: 'x', assignee: 'hacker' })
    expect(res.status).toBe(200)
    expect(lastPatchBody).toEqual({ status: 'done' })
  })

  it('forwards the query string on reads', async () => {
    const res = await request(app).get('/v1/projects/p1/spending?period=30d&surface=job').set('Authorization', 'Bearer tok')
    expect(res.status).toBe(200)
    expect(res.body.query).toEqual({ period: '30d', surface: 'job' })
  })

  it('chat: create conversation narrows kind/model/contextScope', async () => {
    const res = await request(app)
      .post('/v1/projects/p1/chat/conversations')
      .set('Authorization', 'Bearer tok')
      .send({ kind: 'explore', model: 'opus', evil: 1, contextScope: { specrails: true, full: true, bogus: 'x' } })
    expect(res.status).toBe(200)
    expect(res.body.body).toEqual({ kind: 'explore', model: 'opus', contextScope: { specrails: true, full: true } })
  })

  it('chat: send message narrows text/lightweight', async () => {
    const res = await request(app)
      .post('/v1/projects/p1/chat/conversations/abc-123/messages')
      .set('Authorization', 'Bearer tok')
      .send({ text: 'hi', evil: 1 })
    expect(res.body.body).toEqual({ text: 'hi', lightweight: true })
    expect(res.body.route).toBe('/api/projects/p1/chat/conversations/abc-123/messages')
  })

  it('chat: interrupt + spec-draft + default-spec-model reachable', async () => {
    expect((await request(app).delete('/v1/projects/p1/chat/conversations/abc-123/messages/stream').set('Authorization', 'Bearer tok')).status).toBe(200)
    expect((await request(app).get('/v1/projects/p1/chat/conversations/abc-123/spec-draft').set('Authorization', 'Bearer tok')).status).toBe(200)
    expect((await request(app).get('/v1/projects/p1/default-spec-model?provider=claude').set('Authorization', 'Bearer tok')).status).toBe(200)
  })

  it('from-draft narrows the commit body', async () => {
    const res = await request(app)
      .post('/v1/projects/p1/tickets/from-draft')
      .set('Authorization', 'Bearer tok')
      .send({ title: 'T', conversationId: 'c1', priority: 'high', labels: ['a', 2], acceptanceCriteria: ['x'], evil: 1 })
    expect(res.body.body).toEqual({ title: 'T', conversationId: 'c1', priority: 'high', labels: ['a'], acceptanceCriteria: ['x'] })
  })

  it('unknown gateway path → 404 JSON (never a SPA)', async () => {
    const res = await request(app).get('/v1/nope').set('Authorization', 'Bearer tok')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Not found')
  })

  it('rail launch narrows the body and reaches the internal route', async () => {
    const res = await request(app)
      .post('/v1/projects/p1/rails/0/launch')
      .set('Authorization', 'Bearer tok')
      .send({ mode: 'implement', profileName: 'default', evil: 'x' })
    expect(res.status).toBe(200)
    expect(res.body.body).toEqual({ mode: 'implement', profileName: 'default' })
    expect(res.body.route).toBe('/api/projects/p1/rails/0/launch')
  })

  it('rail stop, queue pause/resume, job delete, put rail tickets are reachable', async () => {
    expect((await request(app).post('/v1/projects/p1/rails/0/stop').set('Authorization', 'Bearer tok')).status).toBe(200)
    expect((await request(app).post('/v1/projects/p1/queue/pause').set('Authorization', 'Bearer tok')).status).toBe(200)
    expect((await request(app).post('/v1/projects/p1/queue/resume').set('Authorization', 'Bearer tok')).status).toBe(200)
    expect((await request(app).delete('/v1/projects/p1/jobs/job-1').set('Authorization', 'Bearer tok')).status).toBe(200)
    const put = await request(app).put('/v1/projects/p1/rails/0/tickets').set('Authorization', 'Bearer tok').send({ ticketIds: [1, 2, 'x'] })
    expect(put.status).toBe(200)
    expect(put.body.body).toEqual({ ticketIds: [1, 2] })
  })

  it('put rail name forwards a narrowed {name} body', async () => {
    const named = await request(app).put('/v1/projects/p1/rails/0/name').set('Authorization', 'Bearer tok').send({ name: 'Backend', evil: 1 })
    expect(named.status).toBe(200)
    expect(named.body.route).toBe('/api/projects/p1/rails/0/name')
    expect(named.body.body).toEqual({ name: 'Backend' })
    // Non-string name coerces to null (clear).
    const cleared = await request(app).put('/v1/projects/p1/rails/0/name').set('Authorization', 'Bearer tok').send({ name: 42 })
    expect(cleared.body.body).toEqual({ name: null })
  })

  it('generate-spec and from-prompt narrow their bodies', async () => {
    const gs = await request(app).post('/v1/projects/p1/tickets/generate-spec').set('Authorization', 'Bearer tok').send({ prompt: 'do x', evil: 1, contractRefine: true, contextScope: { specrails: true, full: false, bogus: 1 } })
    // prompt → idea, and the context scope is forwarded so the server injects specs + dedups.
    expect(gs.body.body).toEqual({ idea: 'do x', contractRefine: true, contextScope: { specrails: true, full: false } })
    const fp = await request(app).post('/v1/projects/p1/tickets/from-prompt').set('Authorization', 'Bearer tok').send({ prompt: 'p', title: 't', evil: 1 })
    expect(fp.body.body).toEqual({ description: 'p', title: 't' }) // prompt → description (server contract)
  })

  it('reads: jobs/:jid, tickets/:tid, spending-summary, state, activity, stats', async () => {
    for (const p of [
      '/v1/projects/p1/jobs/job-1',
      '/v1/projects/p1/tickets/5',
      '/v1/projects/p1/tickets/5/spending-summary',
      '/v1/projects/p1/state',
      '/v1/projects/p1/activity',
      '/v1/projects/p1/stats',
      '/v1/projects/p1/rails',
      '/v1/projects/p1/jobs',
      '/v1/projects/p1/queue',
    ]) {
      const res = await request(app).get(p).set('Authorization', 'Bearer tok')
      expect(res.status, p).toBe(200)
    }
  })

  it('502 when the internal server is unreachable', async () => {
    const a = express()
    a.use(express.json())
    // Point at a port nothing is listening on.
    a.use(createMobileRouter({ db, desktopPort: 9, currentFingerprint: () => 'fp' }))
    const res = await request(a).get('/v1/projects').set('Authorization', 'Bearer tok')
    expect(res.status).toBe(502)
  })
})
