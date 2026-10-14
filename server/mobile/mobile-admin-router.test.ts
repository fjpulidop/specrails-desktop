import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { initDesktopDb } from '../desktop-db'
import type { DbInstance } from '../db'
import type { WsMessage } from '../types'
import { createDevice, hashToken } from './mobile-devices'
import { MobileGateway } from './mobile-gateway'
import { createMobileAdminRouter } from './mobile-admin-router'

describe('mobile-admin-router', () => {
  let db: DbInstance
  let gw: MobileGateway
  let app: express.Express
  let events: WsMessage[]

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    events = []
    gw = new MobileGateway({ desktopDb: db, desktopPort: 4200, broadcast: (m) => events.push(m), bindHost: '127.0.0.1', port: 0 })
    app = express()
    app.use(express.json())
    app.use('/api/mobile', createMobileAdminRouter({ gateway: gw, desktopDb: db, broadcast: (m) => events.push(m) }))
  })

  afterEach(async () => { await gw.stop() })

  it('lists and ends Companion app previews with project names', async () => {
    const owners = new Map<string, { kind: 'device'; deviceId: string; deviceName: string } | { kind: 'desktop' }>([
      ['s1', { kind: 'device', deviceId: 'd1', deviceName: 'iPhone' }],
      ['desk', { kind: 'desktop' }],
    ])
    const browser = {
      listSessions: () => [...owners].map(([id, owner]) => ({ id, projectId: 'p1', url: 'http://localhost:5173/', title: 'App', viewportWidth: 1, viewportHeight: 1, createdAt: 1, owner })),
      sessionOwner: (id: string) => owners.get(id) ?? null,
      kill: async (id: string) => owners.delete(id),
    }
    const withPreview = new MobileGateway({
      desktopDb: db, desktopPort: 4200, broadcast: (m) => events.push(m), bindHost: '127.0.0.1', port: 0,
      preview: {
        enabled: () => true,
        browserFor: (pid) => (pid === 'p1' ? browser : null) as never,
        allBrowsers: () => [browser] as never,
        targets: { list: () => [], forProcess: () => null },
      },
    })
    const previewApp = express()
    previewApp.use(express.json())
    previewApp.use('/api/mobile', createMobileAdminRouter({ gateway: withPreview, desktopDb: db, broadcast: (m) => events.push(m) }))
    const listed = await request(previewApp).get('/api/mobile/previews')
    expect(listed.body.previews).toEqual([expect.objectContaining({ projectId: 'p1', projectName: 'p1', sessionId: 's1', deviceName: 'iPhone' })])
    expect((await request(previewApp).delete('/api/mobile/previews/p1/desk')).body).toEqual({ ok: false })
    expect((await request(previewApp).delete('/api/mobile/previews/p1/s1')).body).toEqual({ ok: true })
    expect(events.some((e) => e.type === 'mobile.previews_changed')).toBe(true)
    expect((await request(previewApp).delete('/api/mobile/previews/p1/..%2Fx')).status).toBe(400)
    expect((await request(app).get('/api/mobile/previews')).body).toEqual({ previews: [] })
  })

  it('status → enable → status running', async () => {
    let res = await request(app).get('/api/mobile/status')
    expect(res.status).toBe(200)
    expect(res.body.running).toBe(false)

    res = await request(app).post('/api/mobile/enable')
    expect(res.status).toBe(200)
    expect(res.body.running).toBe(true)
    expect(res.body.port).toBeGreaterThan(0)
  })

  it('end-to-end: enable, register a device, list, revoke', async () => {
    await request(app).post('/api/mobile/enable')

    // The serverless WebRTC pairing path persists the device once the QR exchange
    // completes; do that directly here, then exercise the admin list/revoke.
    const row = createDevice(db, { name: 'iPhone', platform: 'web', tokenHash: hashToken('tok'), certFingerprint: 'fp' })

    const devices = await request(app).get('/api/mobile/devices')
    expect(devices.body.devices).toHaveLength(1)
    expect(devices.body.devices[0].id).toBe(row.id)

    const del = await request(app).delete(`/api/mobile/devices/${row.id}`)
    expect(del.status).toBe(200)
    expect(del.body.ok).toBe(true)
    expect(events.some((e) => e.type === 'mobile.device_revoked')).toBe(true)
  })

  it('rejects an invalid device id', async () => {
    const res = await request(app).delete('/api/mobile/devices/has spaces!')
    expect(res.status).toBe(400)
  })

  it('cert rotate + disable', async () => {
    await request(app).post('/api/mobile/enable')
    const rot = await request(app).post('/api/mobile/cert/rotate')
    expect(rot.status).toBe(200)
    expect(rot.body.certFingerprint).toMatch(/^[0-9a-f]{64}$/)
    const dis = await request(app).post('/api/mobile/disable')
    expect(dis.status).toBe(200)
    expect(dis.body.running).toBe(false)
  })
})
