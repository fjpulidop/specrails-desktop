import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import net from 'net'
import { initDesktopDb, setDesktopSetting, getDesktopSetting } from '../desktop-db'
import type { DbInstance } from '../db'
import type { WsMessage } from '../types'
import { createDevice, hashToken, listDevices } from './mobile-devices'
import { MobileGateway } from './mobile-gateway'

describe('MobileGateway', () => {
  let db: DbInstance
  let events: WsMessage[]
  let gw: MobileGateway

  beforeEach(() => {
    db = initDesktopDb(':memory:')
    events = []
    gw = new MobileGateway({
      desktopDb: db,
      desktopPort: 4200,
      broadcast: (m) => { events.push(m) },
      bindHost: '127.0.0.1',
      port: 0, // ephemeral
    })
  })

  afterEach(async () => {
    await gw.stop()
  })

  it('starts on an ephemeral port and reports status', async () => {
    expect(gw.running).toBe(false)
    const status = await gw.setEnabled(true)
    expect(status.running).toBe(true)
    expect(status.port).toBeGreaterThan(0)
    expect(status.certFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(getDesktopSetting(db, 'mobile.enabled')).toBe('true')
    // broadcast a gateway_state event
    expect(events.some((e) => e.type === 'mobile.gateway_state')).toBe(true)
  })

  it('start() is idempotent', async () => {
    await gw.start()
    const port = gw.status().port
    await gw.start()
    expect(gw.status().port).toBe(port)
  })

  it('a persisted device is revoked when rotateCert resets the identity', async () => {
    await gw.start()
    // The serverless WebRTC pairing path persists a device once paired; insert one
    // directly, then assert the identity reset revokes it.
    createDevice(db, { name: 'iPhone', platform: 'web', tokenHash: hashToken('tok'), certFingerprint: gw.status().certFingerprint! })

    let devices = listDevices(db)
    expect(devices).toHaveLength(1)
    expect(devices[0].revoked).toBe(false)

    const fpBefore = gw.status().certFingerprint
    await gw.rotateCert()
    devices = listDevices(db)
    expect(devices[0].revoked).toBe(true)
    expect(gw.status().certFingerprint).not.toBe(fpBefore)
  })

  it('disable stops the listener', async () => {
    await gw.setEnabled(true)
    expect(gw.running).toBe(true)
    await gw.setEnabled(false)
    expect(gw.running).toBe(false)
    expect(getDesktopSetting(db, 'mobile.enabled')).toBe('false')
  })

  it('isEnabledSetting reflects the persisted flag', () => {
    expect(gw.isEnabledSetting()).toBe(false)
    setDesktopSetting(db, 'mobile.enabled', 'true')
    expect(gw.isEnabledSetting()).toBe(true)
  })

  it('migrates the pre-rebrand instance-id/name setting keys on first read', async () => {
    // Legacy fallback — rows written by Specrails Hub (pre-rename) must keep the
    // stable instance UUID paired phones already know as `hubInstanceId`.
    setDesktopSetting(db, 'mobile.hub_instance_id', 'legacy-uuid-1')
    setDesktopSetting(db, 'mobile.hub_name', 'Legacy Mac')
    expect(gw.status().desktopName).toBe('Legacy Mac')
    await gw.start()
    // The WebRTC offer carries the desktop identity the companion pins.
    const offer = await gw.webrtcOffer()
    expect(offer!.hubInstanceId).toBe('legacy-uuid-1')
    expect(offer!.hubName).toBe('Legacy Mac')
    // The values were copied to the renamed keys.
    expect(getDesktopSetting(db, 'mobile.desktop_instance_id')).toBe('legacy-uuid-1')
    expect(getDesktopSetting(db, 'mobile.desktop_name')).toBe('Legacy Mac')
  })

  it('rejects start() when the port is already in use (no crash)', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    const gw2 = new MobileGateway({ desktopDb: db, desktopPort: 4200, broadcast: () => {}, bindHost: '127.0.0.1', port })
    await expect(gw2.start()).rejects.toThrow(/in use/i)
    await new Promise<void>((r) => blocker.close(() => r()))
  })
})
