/**
 * Desktop app updates over HTTP (`/api/desktop-updates/*`), for clients that
 * never open the window (MCP: `specrails_system(updates)`).
 *
 * The Tauri updater lives in the app window: only it can download, verify the
 * signature, install and restart. This shim therefore:
 * - checks the selected channel's updater manifest itself (the same URL the
 *   native `check_app_update` command reads, `update-channel.ts`);
 * - relays an install request to the window as the `desktop.update_command`
 *   WebSocket event, which runs the app's own install flow
 *   (`client/src/hooks/useDesktopUpdateRemote.ts`);
 * - keeps the window's latest report (`POST /desktop-updates/report`), so a
 *   status read says whether a window is there and how the install is going.
 *
 * Nothing here installs on its own, and nothing restarts without the window.
 */
import type { Router } from 'express'
import { randomUUID } from 'crypto'
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import { getUpdateChannel } from './desktop-db'
import { appUpdaterManifestUrl, type UpdateChannel } from './update-channel'
import { isNewer, isValidVersion } from './semver-lite'
import { readDesktopVersion } from './core-compat'

export const DESKTOP_UPDATE_COMMAND = 'desktop.update_command'
/** A window that reported within this window counts as present. */
export const RENDERER_TTL_MS = 6 * 60 * 1000
const CHECK_TIMEOUT_MS = 10_000
const PHASES = ['idle', 'checking', 'available', 'downloading', 'installing', 'ready', 'waiting', 'restarting', 'error'] as const
export type DesktopUpdatePhase = (typeof PHASES)[number]
export type RestartPolicy = 'when_idle' | 'now' | 'never'

export interface DesktopUpdateRelease { version: string; pubDate: string | null; notes: string | null }

export interface DesktopUpdateStatus {
  currentVersion: string
  channel: UpdateChannel
  latest: DesktopUpdateRelease | null
  available: boolean
  checkedAt: string | null
  checkError: string | null
  window: { connected: boolean; seenAt: string | null; phase: DesktopUpdatePhase; progress: number | null; version: string | null; error: string | null; requestId: string | null }
}

export interface DesktopUpdateDeps {
  desktopDb: DbInstance
  broadcast: (msg: WsMessage) => void
  fetchImpl?: typeof fetch
  currentVersion?: () => string
  now?: () => number
}

interface WindowReport { seenAtMs: number; phase: DesktopUpdatePhase; progress: number | null; version: string | null; error: string | null; requestId: string | null }

/** The update state for one server process (exported for tests). */
export function createDesktopUpdates(deps: DesktopUpdateDeps) {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? fetch
  const currentVersion = deps.currentVersion ?? readDesktopVersion
  let latest: DesktopUpdateRelease | null = null
  let checkedAtMs: number | null = null
  let checkError: string | null = null
  let windowReport: WindowReport | null = null

  const channel = (): UpdateChannel => getUpdateChannel(deps.desktopDb)

  function status(): DesktopUpdateStatus {
    const current = currentVersion()
    const connected = windowReport !== null && now() - windowReport.seenAtMs <= RENDERER_TTL_MS
    return {
      currentVersion: current,
      channel: channel(),
      latest,
      available: latest !== null && isValidVersion(current) && isNewer(latest.version, current),
      checkedAt: checkedAtMs ? new Date(checkedAtMs).toISOString() : null,
      checkError,
      window: {
        connected,
        seenAt: windowReport ? new Date(windowReport.seenAtMs).toISOString() : null,
        phase: windowReport?.phase ?? 'idle',
        progress: windowReport?.progress ?? null,
        version: windowReport?.version ?? null,
        error: windowReport?.error ?? null,
        requestId: windowReport?.requestId ?? null,
      },
    }
  }

  async function check(): Promise<DesktopUpdateStatus> {
    checkedAtMs = now()
    try {
      const res = await fetchImpl(appUpdaterManifestUrl(channel()), { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(res.status === 404 && channel() === 'stable' ? 'stable-channel-unavailable' : `manifest HTTP ${res.status}`)
      const body = await res.json() as { version?: unknown; pub_date?: unknown; notes?: unknown }
      const version = typeof body.version === 'string' ? body.version.replace(/^v/, '') : ''
      if (!isValidVersion(version)) throw new Error('manifest has no valid version')
      latest = { version, pubDate: typeof body.pub_date === 'string' ? body.pub_date : null, notes: typeof body.notes === 'string' ? body.notes.slice(0, 4000) : null }
      checkError = null
    } catch (err) {
      checkError = err instanceof Error ? err.message : String(err)
    }
    return status()
  }

  /** Asks the window to install `version` (the version the person confirmed). */
  function apply(input: { version?: unknown; restart?: unknown }): { status: number; body: Record<string, unknown> } {
    const current = status()
    if (!current.latest || !current.available) return { status: 409, body: { error: 'no_update', message: 'No newer version is known. Run a check first.', status: current } }
    if (input.version !== undefined && input.version !== current.latest.version) {
      return { status: 409, body: { error: 'version_changed', message: `The available version is ${current.latest.version}.`, status: current } }
    }
    if (!current.window.connected) {
      return { status: 409, body: { error: 'no_window', message: 'The Specrails window is not open; desktop updates install from the app window.', status: current } }
    }
    if (['downloading', 'installing', 'restarting'].includes(current.window.phase)) {
      return { status: 409, body: { error: 'in_progress', message: 'An update is already installing.', status: current } }
    }
    const restart: RestartPolicy = input.restart === 'now' || input.restart === 'never' ? input.restart : 'when_idle'
    const requestId = randomUUID()
    deps.broadcast({ type: DESKTOP_UPDATE_COMMAND, op: 'apply', version: current.latest.version, restart, requestId } as unknown as WsMessage)
    return { status: 202, body: { accepted: true, requestId, version: current.latest.version, restart } }
  }

  function report(input: Record<string, unknown>): DesktopUpdateStatus {
    const phase = (PHASES as readonly string[]).includes(String(input.phase)) ? input.phase as DesktopUpdatePhase : 'idle'
    const progress = typeof input.progress === 'number' && Number.isFinite(input.progress) ? Math.max(0, Math.min(100, Math.round(input.progress))) : null
    const text = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
    windowReport = { seenAtMs: now(), phase, progress, version: text(input.version, 64), error: text(input.error, 500), requestId: text(input.requestId, 64) }
    return status()
  }

  return { status, check, apply, report }
}

export type DesktopUpdates = ReturnType<typeof createDesktopUpdates>

export function registerDesktopUpdateRoutes(router: Router, deps: DesktopUpdateDeps, updates: DesktopUpdates = createDesktopUpdates(deps)): DesktopUpdates {
  router.get('/desktop-updates/status', (_req, res) => { res.json(updates.status()) })
  router.post('/desktop-updates/check', (_req, res) => {
    void updates.check().then((status) => res.json(status))
  })
  router.post('/desktop-updates/apply', (req, res) => {
    const outcome = updates.apply((req.body ?? {}) as Record<string, unknown>)
    res.status(outcome.status).json(outcome.body)
  })
  router.post('/desktop-updates/report', (req, res) => {
    res.json(updates.report((req.body ?? {}) as Record<string, unknown>))
  })
  return updates
}
