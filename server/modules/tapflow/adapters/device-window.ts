/**
 * Device windows: a native Specrails window showing a Tapflow device, interactive, already signed in.
 *
 * Tapflow's device view lives in its dashboard (`/app-center/build?id=<build>&session=<session>&device=<id>`
 * resumes a session on that device) and needs its `tapflow_token` cookie, even on loopback. Cookies are
 * scoped by host, not port, so Specrails (also on 127.0.0.1) sets it: the window opens
 * `http://127.0.0.1:<specrails>/tapflow-window/<ticket>`, a single-use ticket (60 s) the authenticated API
 * issued; that route signs in to Tapflow with the account Specrails created, sets the cookie and
 * redirects to the device view. The person never sees a login.
 *
 * Closing the window releases the device: after a grace period (reopening cancels it) it is shut down,
 * since Tapflow keeps capturing a booted device's screen (~9 % CPU) until then (spike, 2026-11-28).
 */
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import type { Request, Response } from 'express'
import { adbPath } from './android-toolchain'
import { createTapflowSecrets } from './relay'

export interface DeviceTarget {
  deviceId: string
  sessionId: string
  buildId: number
  platform: 'ios' | 'android'
  name: string
}

const TICKET_TTL_MS = 60_000
/** Simulator UDIDs, session ids, and Tapflow's Android ids (`avd:<name>`, AVD names allow `_` and `.`). */
const ID = /^[A-Za-z0-9:._-]{1,128}$/

export function validDeviceTarget(value: unknown): DeviceTarget | null {
  const v = value as Partial<DeviceTarget> | null
  if (!v || typeof v !== 'object') return null
  if (typeof v.deviceId !== 'string' || !ID.test(v.deviceId) || v.deviceId.includes('..') || typeof v.sessionId !== 'string' || !ID.test(v.sessionId) || v.sessionId.includes('..')) return null
  if (typeof v.buildId !== 'number' || !Number.isInteger(v.buildId) || v.buildId < 1) return null
  if (v.platform !== 'ios' && v.platform !== 'android') return null
  const name = typeof v.name === 'string' && v.name.length <= 120 ? v.name : v.platform === 'ios' ? 'iOS Simulator' : 'Android Emulator'
  return { deviceId: v.deviceId, sessionId: v.sessionId, buildId: v.buildId, platform: v.platform, name }
}

/** Tapflow's interactive device view for a target. */
export function deviceViewerUrl(port: number, target: DeviceTarget): string {
  const url = new URL(`http://127.0.0.1:${port}/app-center/build`)
  url.searchParams.set('id', String(target.buildId))
  url.searchParams.set('session', target.sessionId)
  url.searchParams.set('device', target.deviceId)
  return url.toString()
}

export interface DeviceWindowDeps {
  secretsDir: string
  /** Tapflow's relay port when Specrails runs it, else null. */
  port: () => number | null
  fetchImpl?: typeof fetch
  now?: () => number
  /** Shuts a device down (after the grace period). */
  shutdown?: (target: DeviceTarget) => Promise<void>
  graceMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

const run = (cmd: string, args: string[]) => new Promise<string>((resolve) => {
  execFile(cmd, args, { timeout: 30_000 }, (err, stdout) => resolve(err ? '' : stdout))
})

/** Serials of the running emulators in `adb devices` output. */
export function emulatorSerials(adbDevices: string): string[] {
  return adbDevices.split('\n').map((line) => line.trim().split(/\s+/)).filter(([serial, state]) => /^emulator-\d+$/.test(serial ?? '') && state === 'device').map(([serial]) => serial!)
}

/**
 * iOS: `simctl shutdown` (no Tapflow session needed). Android: Tapflow names an emulator `avd:<name>`,
 * while adb knows it by serial (`emulator-5554`): find the serial whose `emu avd name` is that AVD, then
 * kill it through its console. Best effort.
 */
async function shutdownDevice(target: DeviceTarget): Promise<void> {
  if (target.platform === 'ios') { await run('xcrun', ['simctl', 'shutdown', target.deviceId]); return }
  const adb = adbPath()
  const avd = target.deviceId.replace(/^avd:/, '')
  for (const serial of emulatorSerials(await run(adb, ['devices']))) {
    const name = (await run(adb, ['-s', serial, 'emu', 'avd', 'name'])).split('\n')[0]?.trim()
    if (name === avd) { await run(adb, ['-s', serial, 'emu', 'kill']); return }
  }
}

export function createDeviceWindows(deps: DeviceWindowDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const tickets = new Map<string, { target: DeviceTarget; expires: number }>()
  const pendingShutdowns = new Map<string, unknown>()
  const setTimer = deps.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle })
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))

  async function signIn(port: number): Promise<string> {
    const admin = createTapflowSecrets(deps.secretsDir).admin()
    if (!admin) throw new Error('Tapflow has no Specrails account yet. Turn it off and on again in Plugins ▸ Tapflow.')
    const res = await fetchImpl(`http://127.0.0.1:${port}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(admin), signal: AbortSignal.timeout(10_000),
    })
    const cookie = res.headers.get('set-cookie')?.split(';')[0]
    if (res.status !== 200 || !cookie?.startsWith('tapflow_token=')) throw new Error(`Tapflow refused the sign-in (HTTP ${res.status}).`)
    return cookie.slice('tapflow_token='.length)
  }

  return {
    /** Issues the single-use ticket a device window opens with (authenticated API). */
    issue(target: DeviceTarget): string {
      for (const [ticket, entry] of tickets) if (entry.expires <= now()) tickets.delete(ticket)
      const ticket = crypto.randomBytes(24).toString('base64url')
      tickets.set(ticket, { target, expires: now() + TICKET_TTL_MS })
      // Reopening a device cancels its pending shutdown.
      const pending = pendingShutdowns.get(target.deviceId)
      if (pending !== undefined) { clearTimer(pending); pendingShutdowns.delete(target.deviceId) }
      return ticket
    },

    /** `GET /tapflow-window/:ticket` (loopback only, outside /api): sign in, set the cookie, redirect. */
    handler: async (req: Request, res: Response) => {
      const entry = tickets.get(String(req.params.ticket ?? ''))
      tickets.delete(String(req.params.ticket ?? ''))
      res.setHeader('cache-control', 'no-store')
      if (!entry || entry.expires <= now()) { res.status(410).type('text/plain').send('This device link expired. Open the device again from Specrails.'); return }
      const port = deps.port()
      if (port === null) { res.status(409).type('text/plain').send('Tapflow is off. Turn it on in Plugins ▸ Tapflow.'); return }
      try {
        const token = await signIn(port)
        // Host-only (127.0.0.1, every port), HttpOnly, Lax: what Tapflow itself sets.
        res.setHeader('set-cookie', `tapflow_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`)
        res.redirect(302, deviceViewerUrl(port, entry.target))
      } catch (err) {
        res.status(502).type('text/plain').send((err as Error).message)
      }
    },

    /** Shut the device down now (MCP `mobile_release_device` with `now`), cancelling a pending release. */
    shutdownNow(target: DeviceTarget): Promise<void> {
      const pending = pendingShutdowns.get(target.deviceId)
      if (pending !== undefined) { clearTimer(pending); pendingShutdowns.delete(target.deviceId) }
      return (deps.shutdown ?? shutdownDevice)(target).catch(() => undefined)
    },

    /** The window closed: shut the device down after the grace period unless it is reopened. */
    release(target: DeviceTarget): void {
      const previous = pendingShutdowns.get(target.deviceId)
      if (previous !== undefined) clearTimer(previous)
      pendingShutdowns.set(target.deviceId, setTimer(() => {
        pendingShutdowns.delete(target.deviceId)
        void (deps.shutdown ?? shutdownDevice)(target).catch(() => undefined)
      }, deps.graceMs ?? 60_000))
    },
  }
}
