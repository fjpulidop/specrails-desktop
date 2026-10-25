import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import express from 'express'
import http from 'http'
import request from 'supertest'
import { initDesktopDb, setDesktopSetting } from '../desktop-db'
import type { DbInstance } from '../db'
import { createDevice, hashToken, setAllowedProjects, _resetAclColumnCacheForTests } from './mobile-devices'
import { createMobileRouter } from './mobile-router'
import { companionTargetsFor } from './mobile-inbox'
import type { InboxItem } from '../modules/inbox'

// A stand-in desktop API: records every call the gateway forwards so each safe
// action can be asserted to hit the SAME route the desktop UI uses.
let internal: http.Server
let internalPort = 0
let calls: Array<{ method: string; path: string; body: unknown }> = []
let runState: Record<string, unknown> = {}

const item = (over: Partial<InboxItem>): InboxItem => ({
  id: 'p1:question:r1', projectId: 'p1', projectName: 'P1', kind: 'question', title: 'Run', detail: null,
  at: '2026-10-25T10:00:00.000Z', version: 'v', action: 'open-run', subjectId: 'r1', conversationId: null, diagnosis: null, ...over,
})
const diagnosis = (remedies: string[]): InboxItem['diagnosis'] => ({
  kind: 'provider_limit', confidence: 'high', phase: null, rounds: null, resetAt: null, detail: null, resumablePhase: null, source: 'test', remedies,
})

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.get('/api/inbox', (req, res) => {
    calls.push({ method: 'GET', path: req.path, body: null })
    res.json({
      items: [item({}), item({ id: 'p2:question:r9', projectId: 'p2', subjectId: 'r9', projectName: 'P2' })],
      projects: [{ projectId: 'p1', projectName: 'P1', count: 1 }, { projectId: 'p2', projectName: 'P2', count: 1 }],
      generatedAt: '2026-10-25T10:00:00.000Z',
    })
  })
  app.get('/api/projects/:id/agent-runtime/runs/:rid', (req, res) => {
    calls.push({ method: 'GET', path: req.path, body: null })
    res.json({ runs: [runState] })
  })
  app.use((req, res) => {
    calls.push({ method: req.method, path: req.path, body: req.body })
    if (req.path.endsWith('/pr-decision')) { res.json({ ok: true, decision: 'pr_draft', prUrl: 'https://x/pr/1', prState: 'draft', snapshot: { branches: ['/Users/x/secret'] } }); return }
    res.json({ ok: true })
  })
  internal = http.createServer(app)
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r))
  internalPort = (internal.address() as { port: number }).port
})
afterAll(async () => { await new Promise<void>((r) => internal.close(() => r())) })

describe('companion inbox decisions', () => {
  let db: DbInstance
  let app: express.Express
  const auth = { Authorization: 'Bearer tok' }
  beforeEach(() => {
    _resetAclColumnCacheForTests()
    db = initDesktopDb(':memory:')
    createDevice(db, { name: 'A', platform: 'ios', tokenHash: hashToken('tok'), certFingerprint: 'fp' })
    app = express()
    app.use(express.json())
    app.use(createMobileRouter({ db, desktopPort: internalPort, currentFingerprint: () => 'fp' }))
    calls = []
    runState = {}
  })

  describe('GET /v1/inbox', () => {
    it('projects the desktop read-model with the safe actions of each row', async () => {
      const res = await request(app).get('/v1/inbox').set(auth)
      expect(res.status).toBe(200)
      expect(calls).toEqual([{ method: 'GET', path: '/api/inbox', body: null }])
      expect(res.body.items).toHaveLength(2)
      expect(res.body.items[0].companion).toEqual({ actions: [{ id: 'answer', tier: 'write', enabled: true }], runId: 'r1' })
    })

    it('is filtered to the projects the device was granted (project isolation)', async () => {
      const [{ id }] = db.prepare('SELECT id FROM mobile_devices').all() as Array<{ id: string }>
      setAllowedProjects(db, id, ['p1'])
      const res = await request(app).get('/v1/inbox').set(auth)
      expect(res.body.items.map((i: InboxItem) => i.projectId)).toEqual(['p1'])
      expect(res.body.projects.map((p: { projectId: string }) => p.projectId)).toEqual(['p1'])
    })

    it('marks an action disabled when its permission tier is off', async () => {
      setDesktopSetting(db, 'mcp_tier_write', 'false')
      const res = await request(app).get('/v1/inbox').set(auth)
      expect(res.body.items[0].companion.actions).toEqual([{ id: 'answer', tier: 'write', enabled: false }])
    })

    it('needs a device token', async () => {
      expect((await request(app).get('/v1/inbox')).status).toBe(401)
    })
  })

  describe('which actions a row offers', () => {
    it('offers Answer for a question, Resume for a paused run, Create PR only while on review', () => {
      expect(companionTargetsFor(item({})).ids).toEqual(['answer'])
      expect(companionTargetsFor(item({ kind: 'budget', action: 'resume-run' })).ids).toEqual(['resume'])
      expect(companionTargetsFor(item({ kind: 'review', action: 'open-review', decision: 'on_review' })).ids).toEqual(['create-pr'])
      expect(companionTargetsFor(item({ kind: 'review', action: 'open-review', decision: 'pr_draft' })).ids).toEqual([])
    })

    it('offers Retry only when retry is the primary executable remedy, addressing the run or delivery', () => {
      const failedRun = item({ kind: 'failed', railIndex: 2, diagnosis: diagnosis(['open-logs', 'retry']) })
      expect(companionTargetsFor(failedRun)).toEqual({ ids: ['retry'], target: { sourceId: 'run:r1', railIndex: 2 } })
      const failedDelivery = item({ kind: 'failed', action: 'open-review', subjectId: 'd1', railIndex: 0, decision: 'implementation_failed', diagnosis: diagnosis(['retry']) })
      expect(companionTargetsFor(failedDelivery).target).toEqual({ sourceId: 'd1', railIndex: 0 })
      expect(companionTargetsFor(item({ kind: 'blocked', railIndex: 2, diagnosis: diagnosis(['fix-environment', 'retry']) })).ids).toEqual([])
      expect(companionTargetsFor(item({ kind: 'failed', diagnosis: diagnosis(['retry']) })).ids).toEqual([])
      expect(companionTargetsFor(item({ kind: 'failed', railIndex: 1, diagnosis: null })).ids).toEqual([])
    })

    it('leaves budget caps and Jira to the desktop', () => {
      expect(companionTargetsFor(item({ kind: 'budget', action: 'raise-cap' })).ids).toEqual([])
      expect(companionTargetsFor(item({ kind: 'jira', action: 'retry-jira' })).ids).toEqual([])
    })
  })

  describe('Answer', () => {
    it('shows the pending question', async () => {
      runState = { engineVersion: 2, pendingQuestion: { stepId: 's1', question: 'Which database?', requestedAt: 't' } }
      const res = await request(app).get('/v1/projects/p1/inbox/runs/r1/question').set(auth)
      expect(res.body).toEqual({ pending: true, question: 'Which database?', requestedAt: 't' })
    })

    it('answers a workflow run through the loop-run resume the desktop uses, pinned to the exact question', async () => {
      runState = { engineVersion: 2, pendingQuestion: { stepId: 's1', question: 'Which database?' } }
      const res = await request(app).post('/v1/projects/p1/inbox/answer').set(auth).send({ runId: 'r1', answer: '  SQLite  ', evil: 1 })
      expect(res.status).toBe(200)
      expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/projects/p1/loop-runs/r1/resume', body: { answer: 'SQLite', interruptId: 's1' } })
    })

    it('answers a v1 runtime run through the agent-runtime resume', async () => {
      runState = { engineVersion: 1, pendingQuestion: { stepId: 's1', question: 'Q?' } }
      await request(app).post('/v1/projects/p1/inbox/answer').set(auth).send({ runId: 'r1', answer: 'yes' })
      expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/projects/p1/agent-runtime/runs/r1/resume', body: { answer: 'yes' } })
    })

    it('refuses when nothing is pending, or on a malformed answer', async () => {
      runState = {}
      expect((await request(app).post('/v1/projects/p1/inbox/answer').set(auth).send({ runId: 'r1', answer: 'x' })).status).toBe(409)
      expect((await request(app).post('/v1/projects/p1/inbox/answer').set(auth).send({ runId: 'r1', answer: '   ' })).status).toBe(400)
      expect((await request(app).post('/v1/projects/p1/inbox/answer').set(auth).send({ runId: '../x', answer: 'x' })).status).toBe(400)
      expect(calls.some((c) => c.method === 'POST')).toBe(false)
    })
  })

  describe('Resume', () => {
    it('resumes through the desktop loop-run resume, addressed to the item project', async () => {
      await request(app).post('/v1/projects/p2/inbox/resume').set(auth).send({ runId: 'r9' })
      expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/projects/p2/loop-runs/r9/resume', body: {} })
    })

    it('carries the run-cap choice: ignore or raise, never both nor junk', async () => {
      await request(app).post('/v1/projects/p1/inbox/resume').set(auth).send({ runId: 'r1', runCap: 'ignore' })
      expect(calls.at(-1)!.body).toEqual({ runCap: 'ignore' })
      await request(app).post('/v1/projects/p1/inbox/resume').set(auth).send({ runId: 'r1', runCapUsd: 7.5 })
      expect(calls.at(-1)!.body).toEqual({ runCapUsd: 7.5 })
      const before = calls.length
      for (const body of [{ runCap: 'ignore', runCapUsd: 3 }, { runCapUsd: -1 }, { runCapUsd: 1e9 }, { runCap: 'always' }, { runCapUsd: '5' }]) {
        expect((await request(app).post('/v1/projects/p1/inbox/resume').set(auth).send({ runId: 'r1', ...body })).status).toBe(400)
      }
      expect(calls.length).toBe(before)
    })
  })

  describe('Retry', () => {
    it('relaunches the same source on its rail, the cockpit retry', async () => {
      await request(app).post('/v1/projects/p1/inbox/retry').set(auth).send({ sourceId: 'run:r1', railIndex: 2, mode: 'freestyle' })
      expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/projects/p1/rails/2/relaunch', body: { sourceId: 'run:r1' } })
    })

    it('rejects a bad source or rail', async () => {
      expect((await request(app).post('/v1/projects/p1/inbox/retry').set(auth).send({ sourceId: 'a/b', railIndex: 0 })).status).toBe(400)
      expect((await request(app).post('/v1/projects/p1/inbox/retry').set(auth).send({ sourceId: 'd1', railIndex: -1 })).status).toBe(400)
      expect((await request(app).post('/v1/projects/p1/inbox/retry').set(auth).send({ sourceId: 'd1', railIndex: '1' })).status).toBe(400)
    })
  })

  describe('Create draft PR', () => {
    it('is the PR decision create-pr, only from on_review, with a narrowed response', async () => {
      const res = await request(app).post('/v1/projects/p1/inbox/create-pr').set(auth).send({ prDeliveryId: 'd1', expectedDecision: 'on_review' })
      expect(calls.at(-1)).toEqual({ method: 'POST', path: '/api/projects/p1/rails/pr-decision', body: { prDeliveryId: 'd1', action: 'create-pr', expectedDecision: 'on_review' } })
      expect(res.body).toEqual({ ok: true, decision: 'pr_draft', prUrl: 'https://x/pr/1', prState: 'draft' })
    })

    it('refuses any other expected state', async () => {
      expect((await request(app).post('/v1/projects/p1/inbox/create-pr').set(auth).send({ prDeliveryId: 'd1', expectedDecision: 'pr_failed' })).status).toBe(400)
    })
  })

  describe('permission tiers', () => {
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ['answer', '/v1/projects/p1/inbox/answer', { runId: 'r1', answer: 'x' }, 'mcp_tier_write'],
      ['resume', '/v1/projects/p1/inbox/resume', { runId: 'r1' }, 'mcp_tier_ai_spawn'],
      ['retry', '/v1/projects/p1/inbox/retry', { sourceId: 'd1', railIndex: 0 }, 'mcp_tier_ai_spawn'],
      ['create-pr', '/v1/projects/p1/inbox/create-pr', { prDeliveryId: 'd1', expectedDecision: 'on_review' }, 'mcp_tier_destructive'],
    ]
    for (const [name, path, body, setting] of cases) {
      it(`${name} is refused with 403 tier_disabled while ${setting} is off, and nothing is forwarded`, async () => {
        setDesktopSetting(db, setting, 'false')
        const res = await request(app).post(path).set(auth).send(body)
        expect(res.status).toBe(403)
        expect(res.body.error).toBe('tier_disabled')
        expect(calls.filter((c) => c.method === 'POST')).toEqual([])
      })
    }
  })

  describe('risky actions stay on the desktop', () => {
    it('refuses merge, discard, publish, force-push, settings and delete by name', async () => {
      for (const action of ['merge', 'merge-local', 'discard', 'publish', 'force-push', 'settings', 'delete']) {
        const res = await request(app).post(`/v1/projects/p1/inbox/${action}`).set(auth).send({ prDeliveryId: 'd1' })
        expect(res.status, action).toBe(403)
        expect(res.body.error).toBe('action_not_allowed_for_companion')
      }
      expect(calls).toEqual([])
    })

    it('has no route to the raw PR decision, settings or project deletion for a companion token', async () => {
      const probes: Array<[string, string]> = [
        ['post', '/v1/projects/p1/rails/pr-decision'],
        ['post', '/v1/projects/p1/rails/pr-local-changes/restore'],
        ['put', '/v1/projects/p1/settings'],
        ['post', '/v1/projects/p1/loop-runs/r1/resume'],
        ['post', '/v1/projects/p1/loop-runs/r1/cancel'],
        ['delete', '/v1/projects/p1'],
        ['post', '/v1/settings'],
      ]
      for (const [method, path] of probes) {
        const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path).set(auth).send({ action: 'merge-local' })
        expect(res.status, `${method} ${path}`).toBe(404)
      }
      expect(calls).toEqual([])
    })
  })

  describe('project isolation', () => {
    it('refuses an action on a project the device was not granted', async () => {
      const [{ id }] = db.prepare('SELECT id FROM mobile_devices').all() as Array<{ id: string }>
      setAllowedProjects(db, id, ['p1'])
      for (const [path, body] of [
        ['/v1/projects/p2/inbox/resume', { runId: 'r9' }],
        ['/v1/projects/p2/inbox/answer', { runId: 'r9', answer: 'x' }],
        ['/v1/projects/p2/inbox/retry', { sourceId: 'd1', railIndex: 0 }],
        ['/v1/projects/p2/inbox/create-pr', { prDeliveryId: 'd1', expectedDecision: 'on_review' }],
      ] as Array<[string, Record<string, unknown>]>) {
        expect((await request(app).post(path).set(auth).send(body)).status).toBe(403)
      }
      expect(calls).toEqual([])
    })
  })
})
