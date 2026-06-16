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
