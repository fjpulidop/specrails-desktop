import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeviceWindows, deviceViewerUrl, emulatorSerials, validDeviceTarget, type DeviceTarget } from '../adapters/device-window'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const target: DeviceTarget = { deviceId: 'A1B1366D-EDEF-4CB9-9355-9D2CDBB942F4', sessionId: 's-1', buildId: 2, platform: 'ios', name: 'iPhone 17' }

function setup(over: { admin?: boolean; port?: number | null; loginStatus?: number } = {}) {
  const secretsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tapflow-window-')); dirs.push(secretsDir)
  if (over.admin !== false) fs.writeFileSync(path.join(secretsDir, 'admin.json'), JSON.stringify({ email: 'specrails@localhost', password: 'x'.repeat(24) }))
  let clock = 1_000
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const shutdown = vi.fn(async () => {})
  const fetchImpl = vi.fn(async () => new Response('{}', { status: over.loginStatus ?? 200, headers: { 'set-cookie': 'tapflow_token=jwt.abc; Path=/; HttpOnly; SameSite=Lax' } })) as unknown as typeof fetch
  const windows = createDeviceWindows({ secretsDir, port: () => (over.port === undefined ? 4310 : over.port), fetchImpl, now: () => clock, shutdown, graceMs: 60_000,
    setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer }, clearTimer: (handle) => { (handle as { cleared: boolean }).cleared = true } })
  return { windows, timers, shutdown, fetchImpl, tick: (ms: number) => { clock += ms } }
}

function fakeRes() {
  const res: { statusCode: number; headers: Record<string, string>; body?: string; location?: string; status: (c: number) => typeof res; type: () => typeof res; send: (b: string) => void; setHeader: (k: string, v: string) => void; redirect: (c: number, l: string) => void } = {
    statusCode: 200, headers: {},
    status(code) { res.statusCode = code; return res }, type() { return res }, send(body) { res.body = body },
    setHeader(k, v) { res.headers[k.toLowerCase()] = v }, redirect(code, location) { res.statusCode = code; res.location = location },
  }
  return res
}
const req = (ticket: string) => ({ params: { ticket } }) as never

describe('device windows', () => {
  it('validates targets and builds Tapflow\'s interactive device URL', () => {
    expect(validDeviceTarget(target)).toEqual(target)
    expect(validDeviceTarget({ ...target, deviceId: '../x' })).toBeNull()
    expect(validDeviceTarget({ ...target, buildId: 0 })).toBeNull()
    expect(deviceViewerUrl(4310, target)).toBe('http://127.0.0.1:4310/app-center/build?id=2&session=s-1&device=A1B1366D-EDEF-4CB9-9355-9D2CDBB942F4')
  })

  it('redeems a ticket once: signs in, sets Tapflow\'s cookie for loopback and redirects to the device', async () => {
    const h = setup()
    const ticket = h.windows.issue(target)
    const res = fakeRes()
    await h.windows.handler(req(ticket), res as never)
    expect(res.statusCode).toBe(302)
    expect(res.location).toBe(deviceViewerUrl(4310, target))
    expect(res.headers['set-cookie']).toMatch(/^tapflow_token=jwt\.abc; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/)
    expect(res.headers['cache-control']).toBe('no-store')
    const again = fakeRes()
    await h.windows.handler(req(ticket), again as never)
    expect(again.statusCode).toBe(410)
  })

  it('refuses an expired ticket, Tapflow off, and a sign-in Tapflow refuses', async () => {
    const expired = setup(); const t1 = expired.windows.issue(target); expired.tick(61_000)
    const r1 = fakeRes(); await expired.windows.handler(req(t1), r1 as never); expect(r1.statusCode).toBe(410)
    const off = setup({ port: null }); const r2 = fakeRes(); await off.windows.handler(req(off.windows.issue(target)), r2 as never); expect(r2.statusCode).toBe(409)
    const refused = setup({ loginStatus: 401 }); const r3 = fakeRes(); await refused.windows.handler(req(refused.windows.issue(target)), r3 as never)
    expect(r3.statusCode).toBe(502); expect(r3.headers['set-cookie']).toBeUndefined()
    const noAccount = setup({ admin: false }); const r4 = fakeRes(); await noAccount.windows.handler(req(noAccount.windows.issue(target)), r4 as never)
    expect(r4.statusCode).toBe(502); expect(r4.body).toContain('no Specrails account')
  })

  it('shuts a released device down after the grace period, and reopening cancels it', () => {
    const h = setup()
    h.windows.release(target)
    expect(h.timers[0]).toMatchObject({ ms: 60_000, cleared: false })
    h.windows.issue(target)
    expect(h.timers[0]!.cleared).toBe(true)
    h.windows.release(target)
    h.timers[1]!.fn()
    expect(h.shutdown).toHaveBeenCalledWith(target)
  })
})

describe('Android release', () => {
  it('reads the running emulator serials from adb devices (Tapflow names them avd:<name>)', () => {
    expect(emulatorSerials('List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M\tdevice\n\n')).toEqual(['emulator-5554'])
    expect(validDeviceTarget({ deviceId: 'avd:tapflow-phone', sessionId: 's', buildId: 1, platform: 'android', name: 'tapflow-phone' })).toMatchObject({ deviceId: 'avd:tapflow-phone' })
    expect(validDeviceTarget({ deviceId: 'avd:../x', sessionId: 's', buildId: 1, platform: 'android', name: 'x' })).toBeNull()
  })
})
