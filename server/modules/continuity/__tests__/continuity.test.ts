import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTurnContinuity, emptyContinuityState, offerStillValid, parseContinuityState, type MissionView, type TurnMarker } from '../index'
import { createFileContinuityStore } from '../adapters/file-store'
import { registerContinuityRoutes } from '../adapters/http'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sr-continuity-')) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const live = (overrides: Partial<MissionView> = {}): MissionView => ({ exists: true, archived: false, provider: 'claude', sessionId: 'sess-1', turnActive: false, ...overrides })

function boot(file: string, missions: Record<string, MissionView> = {}, runs: Array<{ projectId: string; runId: string }> = [], clock = { t: Date.parse('2026-11-18T10:00:00Z') }) {
  return createTurnContinuity({ store: createFileContinuityStore(file), mission: (id) => missions[id] ?? null, runningRuns: () => runs, now: () => clock.t, log: () => {} })
}

describe('restart continuity', () => {
  it('a quit leaves a quit marker that becomes an offer on the next start', () => {
    const file = path.join(dir, 'state.json')
    const first = boot(file, {}, [{ projectId: 'p1', runId: 'r1' }])
    first.recoverAtStartup()
    first.turnStarted('c1', { provider: 'claude', sessionId: 'sess-1' })
    first.turnStarted('c2', { provider: 'claude', sessionId: null })
    first.turnSettled('c2', 'terminal')
    first.recordShutdown()
    // The teardown interrupts the turn: its marker is kept.
    first.turnSettled('c1', 'interrupted')
    expect((fs.statSync(file).mode & 0o777)).toBe(0o600)

    const second = boot(file, { c1: live() })
    expect(second.recoverAtStartup()).toBe(1)
    expect(second.offers()).toEqual([expect.objectContaining({ conversationId: 'c1', trigger: 'quit', sessionId: 'sess-1' })])
    expect(second.interruptedRuns()).toEqual([{ projectId: 'p1', runId: 'r1' }])
  })

  it('an update restart is recorded as update; no shutdown at all is a crash', () => {
    const file = path.join(dir, 'state.json')
    const a = boot(file)
    a.turnStarted('c1', { provider: 'claude', sessionId: 's' })
    a.noteUpdateRestart()
    a.recordShutdown()
    const b = boot(file, { c1: live({ sessionId: 's' }), c3: live({ sessionId: null }) })
    b.recoverAtStartup()
    expect(b.offers()[0]!.trigger).toBe('update')
    // Process b crashes mid-turn (no recordShutdown).
    b.turnStarted('c3', { provider: 'claude', sessionId: null })
    const c = boot(file, { c3: live({ sessionId: 'born-later' }) })
    c.recoverAtStartup()
    expect(c.offers().map((o) => [o.conversationId, o.trigger])).toEqual([['c3', 'crash']])
  })

  it('drops offers once the mission moved on, and on the person\'s decision', () => {
    const file = path.join(dir, 'state.json')
    const missions: Record<string, MissionView> = { a: live(), b: live(), c: live(), d: live(), e: live() }
    const a = boot(file, missions)
    for (const id of Object.keys(missions)) a.turnStarted(id, { provider: 'claude', sessionId: 'sess-1' })
    a.recordShutdown()
    const b = boot(file, { a: live(), b: live({ archived: true }), c: live({ sessionId: 'other' }), d: live({ provider: 'codex' }), e: live() })
    b.recoverAtStartup()
    expect(b.offers().map((o) => o.conversationId)).toEqual(['a', 'e'])
    // A new turn in a mission supersedes its offer.
    b.turnStarted('e', { provider: 'claude', sessionId: 'sess-1' })
    expect(b.offers().map((o) => o.conversationId)).toEqual(['a'])
    expect(b.settleOffers(['a'])).toBe(1)
    expect(b.offers()).toEqual([])
    expect(parseContinuityState(fs.readFileSync(file, 'utf8')).offers).toEqual({})
  })

  it('reads junk state as empty and validates offers by session root', () => {
    expect(parseContinuityState('nope')).toEqual(emptyContinuityState())
    expect(parseContinuityState(JSON.stringify({ markers: { x: { conversationId: '../x', startedAt: 'now', trigger: 'quit' } } })).markers).toEqual({})
    const offer: TurnMarker = { conversationId: 'c', startedAt: '2026-11-18T10:00:00Z', stoppedAt: '2026-11-18T10:00:00Z', provider: 'claude', sessionId: null, trigger: 'quit' }
    expect(offerStillValid(offer, live({ sessionId: 'new' }))).toBe(true)
    expect(offerStillValid({ ...offer, sessionId: 's' }, live({ sessionId: null }))).toBe(false)
    expect(offerStillValid(offer, live({ turnActive: true }))).toBe(false)
    expect(offerStillValid(offer, null)).toBe(false)
  })

  it('serves offers, settles them and reports active work over HTTP', async () => {
    const file = path.join(dir, 'state.json')
    const a = boot(file)
    a.turnStarted('c1', { provider: 'claude', sessionId: 's' })
    a.recordShutdown()
    const continuity = boot(file, { c1: live({ sessionId: 's' }) })
    continuity.recoverAtStartup()
    const app = express()
    app.use(express.json())
    const router = express.Router()
    registerContinuityRoutes(router, { continuity, bootedAt: '2026-11-18T10:00:00Z', missionTitle: () => 'Fix login', activeWork: () => ({ missions: 1, runs: 2 }) })
    app.use('/api', router)
    const offers = await request(app).get('/api/continuity/resume-offers')
    expect(offers.body.offers).toEqual([expect.objectContaining({ conversationId: 'c1', title: 'Fix login', trigger: 'quit' })])
    expect((await request(app).get('/api/continuity/active-work')).body).toEqual({ missions: 1, runs: 2, total: 3 })
    expect((await request(app).post('/api/continuity/shutdown-intent').send({ trigger: 'quit' })).status).toBe(400)
    expect((await request(app).post('/api/continuity/shutdown-intent').send({ trigger: 'update' })).status).toBe(200)
    expect((await request(app).post('/api/continuity/resume-offers/settle').send({ conversationIds: 'c1' })).status).toBe(400)
    expect((await request(app).post('/api/continuity/resume-offers/settle').send({ conversationIds: ['c1'], runs: true })).body).toEqual({ settled: 1 })
    expect((await request(app).get('/api/continuity/resume-offers')).body.offers).toEqual([])
  })
})
