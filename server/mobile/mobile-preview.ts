import { Router, type Request, type Response } from 'express'
import type { DbInstance } from '../db'
import type { BrowserInputEvent, BrowserSessionMeta, BrowserSessionOwner } from '../modules/browser/runtime/browser-capture-types'
import { BrowserLimitExceededError, BrowserNavigationRejectedError } from '../modules/browser/runtime/browser-capture-types'
import type { BrowserWsClient } from '../modules/browser/runtime/browser-capture-manager'
import type { PreviewTarget } from '../modules/browser/runtime/preview-targets'
import { previewOrigin } from '../modules/browser/domain/preview-origins'
import { getAgentConversation } from '../modules/agents/runtime/agent-store'
import type { MobileAuthedRequest } from './mobile-auth'
import { MISSION_ACCESS_REASON, mobileCapabilities } from './mobile-missions'
import {
  PREVIEW_CHANNEL_PREFIX,
  PreviewChannelClient,
  PreviewInboundLimiter,
  parsePreviewInbound,
  type PreviewChannelLike,
} from './mobile-preview-channel'

/** The slice of a project's BrowserCaptureManager the preview use cases drive. */
export interface PreviewBrowser {
  create(opts: { initialUrl: string; owner: BrowserSessionOwner; viewport?: { width: number; height: number; deviceScaleFactor?: number } }): Promise<BrowserSessionMeta>
  sessionOwner(sessionId: string): BrowserSessionOwner | null
  attach(sessionId: string, client: BrowserWsClient): Promise<BrowserSessionMeta | null>
  detach(sessionId: string, client: BrowserWsClient): void
  handleInput(sessionId: string, event: BrowserInputEvent): Promise<void>
  navigateAsDevice(sessionId: string, deviceId: string, action: 'goto' | 'back' | 'forward' | 'reload', url?: string): Promise<{ url: string; title: string } | null>
  kill(sessionId: string): Promise<boolean>
  killDeviceSessions(deviceId: string): Promise<number>
  listSessions(): BrowserSessionMeta[]
}

/** A live device-owned session, as Settings ▸ Mobile lists it on Desktop. */
export interface DevicePreviewSession {
  projectId: string
  sessionId: string
  deviceId: string
  deviceName: string
  url: string | null
  title: string | null
  createdAt: number
}

export interface MobilePreviewDeps {
  /** Browser capture enabled on Desktop (the feature flag). */
  enabled(): boolean
  browserFor(projectId: string): PreviewBrowser | null
  allBrowsers(): PreviewBrowser[]
  targets: {
    list(projectId: string): PreviewTarget[]
    forProcess(projectId: string, processId: string): PreviewTarget | null
  }
  /** Open a DataChannel on the device's live WebRTC peer; null when the device
   *  is not connected over WebRTC (e.g. the legacy LAN WSS transport). */
  openChannel(deviceId: string, label: string): PreviewChannelLike | null
  /** A preview opened or ended (Desktop refreshes its indicator). */
  onChange?: () => void
  now?: () => number
}

export class PreviewError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'PreviewError'
  }
}

type Device = { id: string; name: string }
type Viewport = { width: number; height: number; deviceScaleFactor?: number }

interface Binding {
  projectId: string
  deviceId: string
  channel: PreviewChannelLike
  client: PreviewChannelClient
}

/**
 * Companion app-preview use cases. Owns only the channel bindings; sessions,
 * budgets and the origin policy live in BrowserCaptureManager, targets in the
 * process-log source. A binding is replaced on re-attach (new peer after a
 * Wi-Fi drop) and detached — never killed — when its channel closes, so the
 * idle sweep reclaims abandoned previews.
 */
export class MobilePreviewService {
  private readonly bindings = new Map<string, Binding>()
  private readonly now: () => number

  constructor(private readonly deps: MobilePreviewDeps) {
    this.now = deps.now ?? Date.now
  }

  available(): boolean {
    return this.deps.enabled()
  }

  /** Targets of a mission's running processes. */
  targetsForMission(projectId: string, chatId: string): PreviewTarget[] {
    if (!this.available()) return []
    return this.deps.targets.list(projectId).filter((target) => target.chatId === chatId)
  }

  async open(device: Device, projectId: string, input: { chatId: string; processId: string; url: string; viewport?: Viewport }): Promise<{ sessionId: string; channel: string; url: string }> {
    const browser = this.requireBrowser(projectId)
    const target = this.deps.targets.forProcess(projectId, input.processId)
    if (!target || target.chatId !== input.chatId) throw new PreviewError(404, 'preview_target_gone', 'This process is no longer running or announced no URL.')
    const origin = previewOrigin(input.url)
    if (!origin || !target.urls.some((url) => previewOrigin(url) === origin)) {
      throw new PreviewError(400, 'preview_url_not_announced', 'Only URLs announced by this process can be previewed.')
    }
    let meta: BrowserSessionMeta
    try {
      meta = await browser.create({ initialUrl: input.url, owner: { kind: 'device', deviceId: device.id, deviceName: device.name }, viewport: input.viewport })
    } catch (err) {
      throw translateBrowserError(err)
    }
    try {
      const opened = { sessionId: meta.id, channel: this.bind(projectId, device.id, browser, meta.id), url: input.url }
      this.changed()
      return opened
    } catch (err) {
      await browser.kill(meta.id)
      throw err
    }
  }

  /** Re-attach a live session after the peer reconnected. */
  attach(device: Device, projectId: string, sessionId: string): { sessionId: string; channel: string } {
    const browser = this.requireBrowser(projectId)
    this.requireOwner(browser, device.id, sessionId)
    return { sessionId, channel: this.bind(projectId, device.id, browser, sessionId) }
  }

  async navigate(device: Device, projectId: string, sessionId: string, action: 'goto' | 'back' | 'forward' | 'reload', url?: string): Promise<{ url: string; title: string }> {
    const browser = this.requireBrowser(projectId)
    this.requireOwner(browser, device.id, sessionId)
    try {
      const result = await browser.navigateAsDevice(sessionId, device.id, action, url)
      if (!result) throw new PreviewError(404, 'preview_session_closed', 'This preview session has ended.')
      return { url: result.url, title: result.title }
    } catch (err) {
      throw translateBrowserError(err)
    }
  }

  async close(device: Device, projectId: string, sessionId: string): Promise<void> {
    const browser = this.requireBrowser(projectId)
    this.requireOwner(browser, device.id, sessionId)
    this.unbind(sessionId)
    await browser.kill(sessionId)
    this.changed()
  }

  /** Live device-owned sessions across projects (Desktop indicator). */
  listDeviceSessions(): DevicePreviewSession[] {
    if (!this.available()) return []
    const sessions: DevicePreviewSession[] = []
    for (const browser of this.deps.allBrowsers()) {
      for (const meta of browser.listSessions()) {
        if (meta.owner.kind !== 'device') continue
        sessions.push({ projectId: meta.projectId, sessionId: meta.id, deviceId: meta.owner.deviceId, deviceName: meta.owner.deviceName,
          url: meta.url, title: meta.title, createdAt: meta.createdAt })
      }
    }
    return sessions.sort((a, b) => b.createdAt - a.createdAt)
  }

  /** The Desktop user ends a phone's preview; the viewer shows "session closed". */
  async endFromDesktop(projectId: string, sessionId: string): Promise<boolean> {
    const browser = this.deps.browserFor(projectId)
    if (!browser || browser.sessionOwner(sessionId)?.kind !== 'device') return false
    // Kill first so the attached channel client receives `closed` before the
    // binding is dropped.
    const killed = await browser.kill(sessionId)
    this.unbind(sessionId)
    if (killed) this.changed()
    return killed
  }

  /** Device revoked/unpaired: end every preview it owns, in every project. */
  async closeForDevice(deviceId: string): Promise<void> {
    for (const [sessionId, binding] of [...this.bindings]) if (binding.deviceId === deviceId) this.unbind(sessionId)
    for (const browser of this.deps.allBrowsers()) {
      try { await browser.killDeviceSessions(deviceId) } catch { /* best-effort per project */ }
    }
    this.changed()
  }

  private changed(): void {
    try { this.deps.onChange?.() } catch { /* a notification failure never fails the use case */ }
  }

  private requireBrowser(projectId: string): PreviewBrowser {
    if (!this.available()) throw new PreviewError(404, 'preview_unavailable', 'App preview requires browser capture to be enabled on Desktop.')
    const browser = this.deps.browserFor(projectId)
    if (!browser) throw new PreviewError(404, 'unknown_project', 'Unknown project')
    return browser
  }

  private requireOwner(browser: PreviewBrowser, deviceId: string, sessionId: string): void {
    const owner = browser.sessionOwner(sessionId)
    // A session of another device or of Desktop is indistinguishable from a
    // missing one: never confirm its existence to this device.
    if (!owner || owner.kind !== 'device' || owner.deviceId !== deviceId) {
      throw new PreviewError(404, 'preview_session_closed', 'This preview session has ended.')
    }
  }

  private bind(projectId: string, deviceId: string, browser: PreviewBrowser, sessionId: string): string {
    const label = `${PREVIEW_CHANNEL_PREFIX}${sessionId}`
    const channel = this.deps.openChannel(deviceId, label)
    if (!channel) throw new PreviewError(409, 'preview_requires_webrtc', 'Reconnect Companion to Desktop to preview apps.')
    this.unbind(sessionId)
    const client = new PreviewChannelClient(channel)
    const binding: Binding = { projectId, deviceId, channel, client }
    this.bindings.set(sessionId, binding)
    const limiter = new PreviewInboundLimiter(this.now)
    const current = () => this.bindings.get(sessionId) === binding
    channel.onOpen(() => {
      if (!current()) return
      void browser.attach(sessionId, client).then((meta) => {
        if (!meta) client.close(1000, 'session_closed')
      })
    })
    channel.onMessage((data) => {
      if (!current() || !limiter.take()) return
      const msg = parsePreviewInbound(typeof data === 'string' ? data : data.toString('utf8'))
      if (!msg) return
      if (msg.type === 'input') {
        void browser.handleInput(sessionId, msg.event).catch(() => { /* page went away */ })
      } else {
        void browser.navigateAsDevice(sessionId, deviceId, msg.action, msg.url).catch(() => {
          // A rejected or failed navigation keeps the current page; tell the
          // viewer so it can restore its address field.
          try { channel.send(JSON.stringify({ type: 'nav_rejected' })) } catch { /* ignore */ }
        })
      }
    })
    channel.onClose(() => {
      browser.detach(sessionId, client)
      if (current()) this.bindings.delete(sessionId)
    })
    return label
  }

  private unbind(sessionId: string): void {
    const binding = this.bindings.get(sessionId)
    if (!binding) return
    this.bindings.delete(sessionId)
    try { binding.channel.close() } catch { /* ignore */ }
  }
}

function translateBrowserError(err: unknown): Error {
  if (err instanceof PreviewError) return err
  if (err instanceof BrowserNavigationRejectedError) return new PreviewError(400, 'preview_url_not_announced', 'Only URLs announced by this project can be opened in a preview.')
  if (err instanceof BrowserLimitExceededError) return new PreviewError(429, 'preview_limit', `Up to ${err.limit} phones can preview this project at once. Close another preview and retry.`)
  return new PreviewError(502, 'preview_failed', 'Desktop could not open the preview. Retry in a moment.')
}

const ID = /^[A-Za-z0-9_-]{1,160}$/
const ACTIONS = new Set(['goto', 'back', 'forward', 'reload'])

function viewportFrom(raw: unknown): Viewport | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
  if (!ok(v.width) || !ok(v.height)) return undefined
  return { width: v.width, height: v.height, ...(ok(v.deviceScaleFactor) ? { deviceScaleFactor: v.deviceScaleFactor } : {}) }
}

/**
 * Gateway routes. Preview targets come from mission processes, so they follow
 * the mission rule: an all-projects device grant (`mobile-mission-control`).
 */
export function createMobilePreviewRouter({ db, preview }: { db: DbInstance; preview: MobilePreviewService }): Router {
  const router = Router()
  const segment = (value: unknown) => typeof value === 'string' ? value : ''
  const device = (req: Request): Device => {
    const row = (req as MobileAuthedRequest).mobileDevice!
    return { id: row.id, name: row.name }
  }
  const fail = (res: Response, err: unknown) => {
    if (err instanceof PreviewError) { res.status(err.status).json({ error: err.message, code: err.code }); return }
    res.status(500).json({ error: 'Preview failed', code: 'preview_failed' })
  }
  const gate = (req: Request, res: Response): string | null => {
    const pid = segment(req.params.pid)
    if (!ID.test(pid)) { res.status(400).json({ error: 'Invalid parameter' }); return null }
    if (!mobileCapabilities(db, device(req).id).features.missions) { res.status(403).json({ error: MISSION_ACCESS_REASON }); return null }
    if (!preview.available()) { res.status(404).json({ error: 'App preview is unavailable on Desktop.', code: 'preview_unavailable' }); return null }
    return pid
  }
  const mission = (res: Response, pid: string, cid: string): boolean => {
    if (!ID.test(cid)) { res.status(400).json({ error: 'Invalid mission identity' }); return false }
    const conversation = getAgentConversation(db, cid)
    if (!conversation || conversation.pinned_project_id !== pid) { res.status(404).json({ error: 'Mission not found in this project' }); return false }
    return true
  }

  router.get('/projects/:pid/missions/:cid/preview-targets', (req, res) => {
    const pid = gate(req, res); if (!pid) return
    const cid = segment(req.params.cid)
    if (!mission(res, pid, cid)) return
    res.json({ targets: preview.targetsForMission(pid, cid).map(({ processId, urls }) => ({ processId, urls })) })
  })

  router.post('/projects/:pid/preview-sessions', async (req, res) => {
    const pid = gate(req, res); if (!pid) return
    const body = (req.body ?? {}) as Record<string, unknown>
    const cid = segment(body.missionId), processId = segment(body.processId), url = segment(body.url)
    if (!mission(res, pid, cid)) return
    if (!ID.test(processId) || !url || url.length > 2048) { res.status(400).json({ error: 'processId and url are required' }); return }
    try { res.status(201).json(await preview.open(device(req), pid, { chatId: cid, processId, url, viewport: viewportFrom(body.viewport) })) }
    catch (err) { fail(res, err) }
  })

  router.post('/projects/:pid/preview-sessions/:sid/attach', (req, res) => {
    const pid = gate(req, res); if (!pid) return
    const sid = segment(req.params.sid)
    if (!ID.test(sid)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    try { res.json(preview.attach(device(req), pid, sid)) } catch (err) { fail(res, err) }
  })

  router.post('/projects/:pid/preview-sessions/:sid/navigate', async (req, res) => {
    const pid = gate(req, res); if (!pid) return
    const sid = segment(req.params.sid)
    const body = (req.body ?? {}) as Record<string, unknown>
    const action = segment(body.action) || 'goto'
    const url = typeof body.url === 'string' ? body.url : undefined
    if (!ID.test(sid) || !ACTIONS.has(action) || (action === 'goto' && (!url || url.length > 2048))) { res.status(400).json({ error: 'Invalid navigation' }); return }
    try { res.json(await preview.navigate(device(req), pid, sid, action as 'goto', url)) } catch (err) { fail(res, err) }
  })

  router.delete('/projects/:pid/preview-sessions/:sid', async (req, res) => {
    const pid = gate(req, res); if (!pid) return
    const sid = segment(req.params.sid)
    if (!ID.test(sid)) { res.status(400).json({ error: 'Invalid parameter' }); return }
    try { await preview.close(device(req), pid, sid); res.json({ ok: true }) } catch (err) { fail(res, err) }
  })

  return router
}
