import os from 'os'
import path from 'path'
import { newId } from './ids'
import type { DbInstance } from './db'
import type { WsMessage } from './types'
import type { Attachment } from './ticket-store'
import { attachmentManager as defaultAttachmentManager, type AttachmentManager } from './attachment-manager'
import {
  BrowserLimitExceededError,
  BrowserLaunchError,
  type BrowserContextHandle,
  type BrowserInputEvent,
  type BrowserPageHandle,
  type BrowserSessionMeta,
  type CaptureRect,
  type CapturedDom,
  type ContextLauncher,
  type ElementProbe,
  type SharedBrowserContext,
} from './browser-capture-types'
import { createPlaywrightLauncher } from './browser-playwright'

const WS_OPEN = 1
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

/** Playwright throws this family when the page/context/browser died underneath an
 *  operation (server restart in dev, page crash, tab closed). */
function isTargetClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /target page, context or browser has been closed|target closed|has been closed/i.test(msg)
}
const MAX_SESSIONS_PER_PROJECT = 4
const DOM_HTML_BYTE_CAP = 100_000
const LAST_URL_KEY = 'config.browser_last_url'
/** How far back from capture time to include buffered network requests. */
const NETWORK_WINDOW_MS = 30_000

/** A minimal structural view of a `ws` WebSocket — keeps the manager decoupled
 *  from the `ws` package so tests can pass plain fakes. */
export interface BrowserWsClient {
  readyState: number
  send(data: string | Buffer): void
  close(code?: number, reason?: string): void
}

interface BrowserSession {
  id: string
  projectId: string
  page: BrowserPageHandle
  clients: Set<BrowserWsClient>
  lastFrame: Buffer | null
  url: string | null
  title: string | null
  viewport: { width: number; height: number }
  createdAt: number
  screencasting: boolean
  /** Desired screencast state; transitions are serialised via `screencastOp`. */
  screencastDesired: boolean
  screencastOp: Promise<void> | null
  closed: boolean
}

/** One per-breakpoint screenshot in a multi-breakpoint capture. */
export interface BreakpointCapture {
  attachment: Attachment
  dataUrl: string
  viewport: { width: number; height: number }
}

export interface CaptureResult {
  screenshot: Attachment
  domAttachment: Attachment
  dom: CapturedDom
  /** Inline preview of the screenshot so the client can render a thumbnail
   *  without a second authenticated request (an <img src> to the attachment GET
   *  endpoint would omit the X-Desktop-Token header and 401). */
  screenshotDataUrl: string
  /** Present only for a multi-breakpoint capture: the same element shot at each
   *  viewport. `screenshot`/`dom` above point at the first (canonical) entry. */
  breakpoints?: Record<string, BreakpointCapture>
}

export interface BrowserCaptureManagerOptions {
  projectId: string
  projectSlug: string
  db: DbInstance
  broadcast?: (msg: WsMessage) => void
  /** Injectable for tests — defaults to the real Playwright launcher. */
  launcher?: ContextLauncher
  /** Injectable for tests — defaults to the shared AttachmentManager. */
  attachments?: AttachmentManager
  /** Override the persistent-profile dir (tests). Ignored when `contextPool` is
   *  set — the global shared profile owns the dir. */
  profileDir?: string
  homeDir?: string
  /** App-wide shared persistent context (GLOBAL cookies/logins across projects).
   *  When provided, this manager opens pages in the shared context and never
   *  owns/closes it — only its own pages. When omitted, the manager keeps the
   *  legacy behaviour of launching + owning a per-project context (used by tests
   *  and any non-pooled caller). */
  contextPool?: SharedBrowserContext
}

/**
 * Per-project owner of an embedded Chromium browser used by the "Add Spec from
 * browser" feature. Holds ONE persistent Playwright context (cookies/login survive
 * restarts) keyed to `~/.specrails/projects/<slug>/browser-profile/`, with one page
 * per session. Screencast frames + control go over the dedicated `/ws/browser/:id`
 * socket; region capture (screenshot + rich DOM) is a REST call that persists both
 * artifacts as attachments so they ride the existing Add-Spec attachment pipeline.
 *
 * All Playwright contact is behind the injected `ContextLauncher`, so the class is
 * fully unit-testable with a fake launcher (no real browser).
 */
export class BrowserCaptureManager {
  private readonly projectId: string
  private readonly projectSlug: string
  private readonly db: DbInstance
  private readonly broadcast?: (msg: WsMessage) => void
  private readonly launcher: ContextLauncher
  private readonly attachments: AttachmentManager
  private readonly profileDir: string
  /** When set, pages are opened in this app-wide shared context (global cookies)
   *  and this manager never owns/closes the context — only its own pages. */
  private readonly contextPool: SharedBrowserContext | null

  private context: BrowserContextHandle | null = null
  private contextPromise: Promise<BrowserContextHandle> | null = null
  private readonly sessions = new Map<string, BrowserSession>()
  /** Count of in-flight `create()` calls that have reserved a slot but not yet
   *  committed their session — guards the cap against concurrent creates. */
  private _reserved = 0
  private disposed = false

  constructor(opts: BrowserCaptureManagerOptions) {
    this.projectId = opts.projectId
    this.projectSlug = opts.projectSlug
    this.db = opts.db
    this.broadcast = opts.broadcast
    this.launcher = opts.launcher ?? createPlaywrightLauncher()
    this.attachments = opts.attachments ?? defaultAttachmentManager
    this.contextPool = opts.contextPool ?? null
    this.profileDir =
      opts.profileDir ??
      path.join(opts.homeDir ?? os.homedir(), '.specrails', 'projects', opts.projectSlug, 'browser-profile')
  }

  // ─── Last-URL persistence (reuses the queue_state key/value table) ───────────

  getLastUrl(): string | null {
    try {
      const row = this.db.prepare('SELECT value FROM queue_state WHERE key = ?').get(LAST_URL_KEY) as
        | { value: string }
        | undefined
      return row?.value ?? null
    } catch {
      return null
    }
  }

  private setLastUrl(url: string): void {
    try {
      this.db.prepare('INSERT OR REPLACE INTO queue_state (key, value) VALUES (?, ?)').run(LAST_URL_KEY, url)
    } catch {
      /* non-fatal */
    }
  }

  // ─── Context lifecycle ──────────────────────────────────────────────────────

  private async ensureContext(): Promise<BrowserContextHandle> {
    if (this.disposed) throw new BrowserLaunchError('manager disposed')
    // Shared global profile: acquire the app-wide context (cookies/logins shared
    // across every project). Never cached as `this.context`, so shutdown()/kill()
    // close only this manager's pages and leave the shared context alive for the
    // other projects (it's disposed once, by the pool owner, at app shutdown).
    if (this.contextPool) return this.contextPool.acquire()
    if (this.context) return this.context
    if (this.contextPromise) return this.contextPromise
    this.contextPromise = (async () => {
      try {
        const ctx = await this.launcher({
          userDataDir: this.profileDir,
          viewport: DEFAULT_VIEWPORT,
        })
        this.context = ctx
        return ctx
      } catch (err) {
        this.contextPromise = null
        throw new BrowserLaunchError('failed to launch browser', err)
      }
    })()
    return this.contextPromise
  }

  // ─── Session CRUD ───────────────────────────────────────────────────────────

  private toMeta(s: BrowserSession): BrowserSessionMeta {
    return {
      id: s.id,
      projectId: s.projectId,
      url: s.url,
      title: s.title,
      viewportWidth: s.viewport.width,
      viewportHeight: s.viewport.height,
      createdAt: s.createdAt,
    }
  }

  listSessions(): BrowserSessionMeta[] {
    return [...this.sessions.values()].filter((s) => !s.closed).map((s) => this.toMeta(s))
  }

  getSession(sessionId: string): BrowserSession | undefined {
    const s = this.sessions.get(sessionId)
    return s && !s.closed ? s : undefined
  }

  async create(opts?: { initialUrl?: string; createdAtMs?: number }): Promise<BrowserSessionMeta> {
    // Reserve the slot SYNCHRONOUSLY before any await so N concurrent creates can't
    // all observe `< MAX` and race past the cap (BUG-BROWSER-02). `_reserved`
    // counts in-flight (not-yet-inserted) sessions; it's the only state that
    // mutates synchronously here.
    const live = [...this.sessions.values()].filter((s) => !s.closed).length
    if (live + this._reserved >= MAX_SESSIONS_PER_PROJECT) {
      throw new BrowserLimitExceededError(MAX_SESSIONS_PER_PROJECT)
    }
    this._reserved++

    let page: BrowserPageHandle
    try {
      const ctx = await this.ensureContext()
      page = await ctx.newPage()
    } catch (err) {
      this._reserved--
      throw err
    }

    // Re-check AFTER the awaits: another create that started before us may have
    // committed its session in the meantime. If the cap is now exceeded, tear the
    // extra page down and reject rather than silently exceeding the limit.
    const liveNow = [...this.sessions.values()].filter((s) => !s.closed).length
    if (liveNow >= MAX_SESSIONS_PER_PROJECT) {
      this._reserved--
      try { await page.close() } catch { /* ignore */ }
      throw new BrowserLimitExceededError(MAX_SESSIONS_PER_PROJECT)
    }

    const id = newId()
    const session: BrowserSession = {
      id,
      projectId: this.projectId,
      page,
      clients: new Set(),
      lastFrame: null,
      url: null,
      title: null,
      viewport: { ...DEFAULT_VIEWPORT },
      createdAt: opts?.createdAtMs ?? this.now(),
      screencasting: false,
      screencastDesired: false,
      screencastOp: null,
      closed: false,
    }
    this.sessions.set(id, session)
    // The reservation is now realised as a committed session — release it.
    this._reserved--

    // Start capturing the page's network requests before the first navigation so
    // XHR/fetch made during page load are available at capture time. Best-effort:
    // a handle that doesn't support it (or a failure) just yields no network data.
    try { await page.enableNetwork?.() } catch { /* network capture is best-effort */ }

    const target = opts?.initialUrl?.trim() || this.getLastUrl() || 'about:blank'
    const result = await page.goto(target)
    session.url = result.url
    session.title = result.title
    if (result.url && result.url !== 'about:blank') this.setLastUrl(result.url)
    return this.toMeta(session)
  }

  // ─── WS attach / detach + screencast fan-out ────────────────────────────────

  async attach(sessionId: string, ws: BrowserWsClient): Promise<BrowserSessionMeta | null> {
    if (this.disposed) return null
    const s = this.getSession(sessionId)
    if (!s) return null
    s.clients.add(ws)
    this.safeSend(ws, JSON.stringify({ type: 'ready', id: s.id, url: s.url, title: s.title, viewport: s.viewport }))
    if (s.lastFrame) this.safeSend(ws, s.lastFrame)
    s.screencastDesired = true
    await this.applyScreencast(s)
    return this.toMeta(s)
  }

  detach(sessionId: string, ws: BrowserWsClient): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.clients.delete(ws)
    if (s.clients.size === 0 && !s.closed) {
      s.screencastDesired = false
      void this.applyScreencast(s)
    }
  }

  /**
   * Serialise screencast start/stop transitions on a per-session promise chain so
   * a rapid detach→attach (stop fired async, then start) can't double-initialise
   * the CDP screencast. The chain always reconciles `screencasting` to
   * `screencastDesired`.
   */
  private applyScreencast(s: BrowserSession): Promise<void> {
    const prev = s.screencastOp ?? Promise.resolve()
    s.screencastOp = prev.then(async () => {
      if (s.closed) {
        if (s.screencasting) {
          s.screencasting = false
          try { await s.page.stopScreencast() } catch { /* ignore */ }
        }
        return
      }
      if (s.screencastDesired && !s.screencasting) {
        s.screencasting = true
        await s.page.startScreencast((frame) => {
          if (s.closed) return
          s.lastFrame = frame.data
          for (const client of s.clients) {
            if (client.readyState === WS_OPEN) {
              try { client.send(frame.data) } catch { /* drop */ }
            }
          }
        })
      } else if (!s.screencastDesired && s.screencasting) {
        s.screencasting = false
        try { await s.page.stopScreencast() } catch { /* ignore */ }
      }
    }).catch(() => { /* never let a screencast transition reject the chain */ })
    return s.screencastOp
  }

  private safeSend(ws: BrowserWsClient, data: string | Buffer): void {
    if (ws.readyState !== WS_OPEN) return
    try { ws.send(data) } catch { /* drop */ }
  }

  private broadcastControl(s: BrowserSession, msg: Record<string, unknown>): void {
    const data = JSON.stringify(msg)
    for (const client of s.clients) this.safeSend(client, data)
  }

  // ─── Interactions ───────────────────────────────────────────────────────────

  async probeElement(sessionId: string, point: { x: number; y: number }): Promise<ElementProbe | null> {
    if (this.disposed) return null
    const s = this.getSession(sessionId)
    if (!s) return null
    return s.page.probeElementAt(point)
  }

  /** Re-resolve an element by selector and step to parent/child/self (breadcrumb). */
  async navigateElement(sessionId: string, selector: string, direction: 'parent' | 'child' | 'self'): Promise<ElementProbe | null> {
    if (this.disposed) return null
    const s = this.getSession(sessionId)
    if (!s) return null
    return (await s.page.navigateElement?.(selector, direction)) ?? null
  }

  async handleInput(sessionId: string, event: BrowserInputEvent): Promise<void> {
    if (this.disposed) return
    const s = this.getSession(sessionId)
    if (!s) return
    if (event.type === 'resize') {
      s.viewport = {
        width: Math.max(1, Math.round(event.width)),
        height: Math.max(1, Math.round(event.height)),
      }
    }
    await s.page.dispatchInput(event)
  }

  async navigate(sessionId: string, action: 'goto' | 'back' | 'forward' | 'reload', url?: string): Promise<{ url: string; title: string } | null> {
    if (this.disposed) return null
    const s = this.getSession(sessionId)
    if (!s) return null
    let result: { url: string; title: string }
    if (action === 'goto') result = await s.page.goto(url ?? 'about:blank')
    else if (action === 'back') result = await s.page.goBack()
    else if (action === 'forward') result = await s.page.goForward()
    else result = await s.page.reload()
    s.url = result.url
    s.title = result.title
    if (result.url && result.url !== 'about:blank') this.setLastUrl(result.url)
    this.broadcastControl(s, { type: 'nav', url: result.url, title: result.title })
    return result
  }

  // ─── Capture: screenshot + rich DOM → attachments ───────────────────────────

  async capture(sessionId: string, rect: CaptureRect, pendingSpecId: string, opts?: { captureNetwork?: boolean }): Promise<CaptureResult | null> {
    if (this.disposed) return null
    const s = this.getSession(sessionId)
    if (!s) return null
    const safeRect: CaptureRect = {
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    }
    let png: Buffer
    let dom: CapturedDom
    try {
      ;[png, dom] = await Promise.all([
        s.page.screenshotClip(safeRect),
        s.page.extractDom(safeRect, DOM_HTML_BYTE_CAP),
      ])
    } catch (err) {
      // The page/context can vanish mid-capture (the dev server restarting,
      // a page crash, the tab being closed). Treat a closed target as a gone
      // session — tear it down and return null (→ 404) instead of a 500 stack.
      if (isTargetClosedError(err)) {
        await this.kill(sessionId)
        return null
      }
      throw err
    }

    // Snapshot the recent network requests into the DOM payload (rides the same
    // JSON attachment → spec prompt). ON unless the spec explicitly disabled it.
    if (opts?.captureNetwork !== false) {
      try {
        const reqs = s.page.recentNetwork?.(this.now() - NETWORK_WINDOW_MS) ?? []
        if (reqs.length > 0) dom.networkRequests = reqs
      } catch { /* network snapshot is best-effort */ }
    }

    const stamp = this.now()
    const screenshot = await this.attachments.upload({
      slug: this.projectSlug,
      ticketKey: pendingSpecId,
      ticketStorePath: null,
      file: {
        buffer: png,
        originalname: `screen-capture-${stamp}.png`,
        mimetype: 'image/png',
        size: png.length,
      },
    })
    const domJson = Buffer.from(JSON.stringify(dom, null, 2), 'utf-8')
    const domAttachment = await this.attachments.upload({
      slug: this.projectSlug,
      ticketKey: pendingSpecId,
      ticketStorePath: null,
      file: {
        buffer: domJson,
        originalname: `page-dom-${stamp}.json`,
        mimetype: 'application/json',
        size: domJson.length,
      },
    })
    return { screenshot, domAttachment, dom, screenshotDataUrl: `data:image/png;base64,${png.toString('base64')}` }
  }

  // ─── Clipboard bridge ───────────────────────────────────────────────────────

  /**
   * Bridge the host clipboard to the embedded (headless) page, which has no
   * access to the OS clipboard. `copy`/`cut` return the page's current selection
   * text for the client to write to the host clipboard; `paste` inserts the
   * host clipboard text (sent by the client) at the focused element.
   */
  async clipboard(sessionId: string, action: 'copy' | 'paste' | 'cut', text?: string): Promise<{ text: string } | null> {
    if (this.disposed) return null
    const s = this.getSession(sessionId)
    if (!s) return null
    if (action === 'paste') {
      if (text) await s.page.insertText?.(text)
      return { text: '' }
    }
    const sel = (await s.page.getSelectionText?.()) ?? ''
    if (action === 'cut' && sel) await s.page.deleteSelection?.()
    return { text: sel }
  }

  // ─── Multi-breakpoint capture ───────────────────────────────────────────────

  /**
   * Capture the SAME selection at several viewport sizes. The element occupies a
   * different rect at each breakpoint (a nav collapses on mobile), so we resolve
   * a stable anchor selector once at the live viewport and re-query its box per
   * breakpoint, falling back to the original rect when it can't be resolved. The
   * whole sequence is driven server-side (set viewport → settle → re-resolve →
   * shoot) so there is no fire-and-forget WS resize race; the live viewport is
   * always restored. One canonical DOM (the first breakpoint) is stored.
   */
  async captureBreakpoints(
    sessionId: string,
    rect: CaptureRect,
    anchorPoint: { x: number; y: number },
    pendingSpecId: string,
    dims: Record<string, { width: number; height: number }>,
  ): Promise<CaptureResult | null> {
    if (this.disposed) return null
    const s = this.getSession(sessionId)
    if (!s) return null
    const order = Object.keys(dims)
    if (order.length === 0) return null

    const stashed = { ...s.viewport }
    let selector: string | null = null
    try { selector = (await s.page.resolveAnchorSelector?.(anchorPoint)) ?? null } catch { selector = null }

    const captured: Record<string, { png: Buffer; dom: CapturedDom }> = {}
    try {
      for (const key of order) {
        const d = dims[key]
        await s.page.setViewport(d.width, d.height)
        s.viewport = { width: d.width, height: d.height }
        try { await s.page.waitForStable?.() } catch { /* settle is best-effort */ }
        let useRect = rect
        if (selector) {
          try {
            const r = await s.page.resolveAnchorRect?.(selector)
            if (r && r.width > 0 && r.height > 0) useRect = r
          } catch { /* fall back to the original rect */ }
        }
        // CLAMP to the current (breakpoint) viewport: a rect resolved at a larger
        // viewport — or the original-rect fallback when the element collapsed /
        // is hidden at this size — can sit outside the smaller viewport, which
        // makes page.screenshot throw "Clipped area is outside the image".
        const cx = Math.max(0, Math.min(useRect.x, d.width - 1))
        const cy = Math.max(0, Math.min(useRect.y, d.height - 1))
        const safeRect: CaptureRect = {
          x: cx,
          y: cy,
          width: Math.max(1, Math.min(useRect.width, d.width - cx)),
          height: Math.max(1, Math.min(useRect.height, d.height - cy)),
        }
        const [png, dom] = await Promise.all([
          s.page.screenshotClip(safeRect),
          s.page.extractDom(safeRect, DOM_HTML_BYTE_CAP),
        ])
        captured[key] = { png, dom }
      }
    } catch (err) {
      if (isTargetClosedError(err)) {
        await this.kill(sessionId)
        return null
      }
      throw err
    } finally {
      try { await s.page.setViewport(stashed.width, stashed.height) } catch { /* ignore */ }
      s.viewport = stashed
    }

    const stamp = this.now()
    const breakpoints: Record<string, BreakpointCapture> = {}
    for (const key of order) {
      const { png } = captured[key]
      const attachment = await this.attachments.upload({
        slug: this.projectSlug,
        ticketKey: pendingSpecId,
        ticketStorePath: null,
        file: { buffer: png, originalname: `screen-capture-${key}-${stamp}.png`, mimetype: 'image/png', size: png.length },
      })
      breakpoints[key] = { attachment, dataUrl: `data:image/png;base64,${png.toString('base64')}`, viewport: dims[key] }
    }

    // Canonical = the first breakpoint: only its DOM is persisted (avoid tripling
    // the DOM artifact / prompt cost). screenshot/dom point at it.
    const canonicalKey = order[0]
    const canonicalDom = captured[canonicalKey].dom
    const domJson = Buffer.from(JSON.stringify(canonicalDom, null, 2), 'utf-8')
    const domAttachment = await this.attachments.upload({
      slug: this.projectSlug,
      ticketKey: pendingSpecId,
      ticketStorePath: null,
      file: { buffer: domJson, originalname: `page-dom-${stamp}.json`, mimetype: 'application/json', size: domJson.length },
    })

    return {
      screenshot: breakpoints[canonicalKey].attachment,
      domAttachment,
      dom: canonicalDom,
      screenshotDataUrl: breakpoints[canonicalKey].dataUrl,
      breakpoints,
    }
  }

  // ─── Teardown ───────────────────────────────────────────────────────────────

  async kill(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId)
    if (!s) return false
    this.sessions.delete(sessionId)
    if (s.closed) return false
    s.closed = true
    s.screencastDesired = false
    for (const client of s.clients) {
      try { client.close(1000, 'session_closed') } catch { /* ignore */ }
    }
    s.clients.clear()
    try { await s.page.close() } catch { /* ignore */ }
    // NOTE: the persistent Chromium context is deliberately kept alive here even
    // when no sessions remain. Closing it on last-session-kill raced with React
    // StrictMode's mount→unmount→mount in dev: the throwaway first session is
    // killed (sessionCount→0 → context closed) WHILE the real second session is
    // still launching in that same context, breaking it. The context is closed
    // on manager.shutdown() / project removal instead — one idle headless browser
    // per project after use is an acceptable cost.
    return true
  }

  async shutdown(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const s of [...this.sessions.values()]) {
      s.closed = true
      for (const client of s.clients) {
        try { client.close(1000, 'shutdown') } catch { /* ignore */ }
      }
      s.clients.clear()
      try { await s.page.close() } catch { /* ignore */ }
    }
    this.sessions.clear()
    // Resolve the context even if its launch was still in flight when shutdown
    // raced in — otherwise a pending contextPromise settles after we exit and
    // leaks a headless Chromium that nothing will ever close.
    let ctx = this.context
    if (!ctx && this.contextPromise) {
      try { ctx = await this.contextPromise } catch { ctx = null }
    }
    if (ctx) {
      try { await ctx.close() } catch { /* ignore */ }
    }
    this.context = null
    this.contextPromise = null
  }

  sessionCount(): number {
    return [...this.sessions.values()].filter((s) => !s.closed).length
  }

  // Wall-clock indirection so tests can stay deterministic if needed.
  private now(): number {
    return Date.now()
  }
}
