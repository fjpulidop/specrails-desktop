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
import { createTapflowSecrets } from './relay'

export interface DeviceTarget {
  deviceId: string
  sessionId: string
  buildId: number
  platform: 'ios' | 'android'
  name: string
}

const TICKET_TTL_MS = 60_000
const ID = /^[A-Za-z0-9-]{1,128}$/

export function validDeviceTarget(value: unknown): DeviceTarget | null {
  const v = value as Partial<DeviceTarget> | null
  if (!v || typeof v !== 'object') return null
  if (typeof v.deviceId !== 'string' || !ID.test(v.deviceId) || typeof v.sessionId !== 'string' || !ID.test(v.sessionId)) return null
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

/** iOS: `simctl` (no Tapflow session needed). Android: the emulator console via adb. Best effort. */
const shutdownDevice = (target: DeviceTarget) => new Promise<void>((resolve) => {
  const [cmd, args] = target.platform === 'ios' ? ['xcrun', ['simctl', 'shutdown', target.deviceId]] : ['adb', ['-s', target.deviceId, 'emu', 'kill']]
  execFile(cmd, args, { timeout: 30_000 }, () => resolve())
})

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
