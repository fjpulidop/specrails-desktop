import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { initDb } from '../../../db'
import { registerMobileTestRoutes } from '../adapters/http'
import { createMobileRunsStore } from '../adapters/mobile-runs-store'

function app() {
  const db = initDb(':memory:')
  const store = createMobileRunsStore(db)
  store.create({ runId: 'r-1', projectId: 'p1', platforms: ['android'], targetPath: '/w', targetKind: 'checkout', deliveryId: null, conversationId: null })
  store.create({ runId: 'r-building', projectId: 'p1', platforms: ['ios'], targetPath: '/w', targetKind: 'checkout', deliveryId: null, conversationId: null })
  store.finish('r-1', 'launched', { summary: 'Android on tapflow-phone', devices: [{ platform: 'android', name: 'tapflow-phone', id: 'avd:tapflow-phone', sessionId: 's1', buildId: 8 }] })
  const broadcast = vi.fn()
  const releaseDevice = vi.fn()
  const server = express()
  server.use(express.json())
  server.use((req, _res, next) => { (req as unknown as { projectCtx: unknown }).projectCtx = { db, project: { id: 'p1' }, broadcast }; next() })
  const router = express.Router()
  registerMobileTestRoutes(router, { tapflowReady: async () => true, releaseDevice })
  server.use(router)
  return { server, broadcast, releaseDevice }
}

describe('mobile test device routes (MCP control)', () => {
  it('[spec:mobile-device-testing/mcp-control] asks the main window to open a launched run\'s device, and refuses a run with none', async () => {
    const { server, broadcast } = app()
    const res = await request(server).post('/runs/r-1/open-device').send({})
    expect(res.status).toBe(200)
    expect(broadcast).toHaveBeenCalledWith({ type: 'mobile_test.open_device', projectId: 'p1', target: { deviceId: 'avd:tapflow-phone', sessionId: 's1', buildId: 8, platform: 'android', name: 'tapflow-phone' } })
    expect((await request(server).post('/runs/r-building/open-device').send({})).body).toMatchObject({ code: 'no_device' })
    expect((await request(server).post('/runs/r-1/open-device').send({ platform: 'ios' })).status).toBe(409)
  })

  it('releases a run\'s device after the grace period, or now', async () => {
    const { server, releaseDevice } = app()
    expect((await request(server).post('/runs/r-1/release-device').send({})).body).toMatchObject({ ok: true, now: false })
    expect((await request(server).post('/runs/r-1/release-device').send({ now: true })).body).toMatchObject({ ok: true, now: true })
    expect(releaseDevice.mock.calls.map(([target, now]) => [target.deviceId, now])).toEqual([['avd:tapflow-phone', false], ['avd:tapflow-phone', true]])
  })
})
