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
import { normalizeBrowserDeviceScaleFactor, normalizeBrowserViewport } from './browser-viewport'

const WS_OPEN = 1
const DEFAULT_VIEWPORT = { width: 1280, height: 800 }

/** Playwright throws this family when the page/context/browser died underneath an
 *  operation (server restart in dev, page crash, tab closed). */
function isTargetClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /target page, context or browser has been closed|target closed|has been closed/i.test(msg)
}
const MAX_SESSIONS_PER_PROJECT = 4
const DEFAULT_SESSION_IDLE_TTL_MS = 10 * 60_000
const DEFAULT_SESSION_SWEEP_INTERVAL_MS = 60_000
const DOM_HTML_BYTE_CAP = 100_000
const LAST_URL_KEY = 'config.browser_last_url'
/** Conflation threshold for the screencast fan-out: skip sending a frame to a
 *  client whose WS send-buffer already holds this many bytes. A slow consumer
 *  otherwise accumulates seconds of stale frames (ever-growing latency), which is
 *  what "sluggish" feels like. Every frame is an independent, complete JPEG, so
 *  dropping intermediates is lossless — the client simply paints the next fresh
 *  frame (newest-wins). `lastFrame` is still always updated. */
const MAX_CLIENT_BUFFERED_BYTES = 1_000_000
/** How far back from capture time to include buffered network requests. */
const NETWORK_WINDOW_MS = 30_000

/** A minimal structural view of a `ws` WebSocket — keeps the manager decoupled
 *  from the `ws` package so tests can pass plain fakes. */
export interface BrowserWsClient {
  readyState: number
  /** Bytes queued in the socket's send buffer (ws exposes this). Used to conflate
   *  screencast frames for slow consumers; treated as 0 when absent (test fakes). */
  bufferedAmount?: number
  send(data: string | Buffer): void
  close(code?: number, reason?: string): void
}

interface BrowserSession {
  id: string
  projectId: string
  /** The root/opener page — capture, probe and persisted session metadata target
   *  this page. Interactive navigation follows the visible page instead. */
  page: BrowserPageHandle
  /** Live popups opened by the page (window.open / target=_blank / OAuth login
   *  windows), in open order — the last one is the top of the stack. They share
   *  the browser context, so cookies + window.opener survive (OAuth completes). */
  popups: BrowserPageHandle[]
  /** True while the client views (and inputs into) the TOP popup; false = root.
   *  Auto-set true when a popup opens, auto-reset when the stack empties. */
  popupView: boolean
  clients: Set<BrowserWsClient>
  lastFrame: Buffer | null
  url: string | null
  title: string | null
  viewport: { width: number; height: number; deviceScaleFactor?: number }
  createdAt: number
  /** Last client/session activity used by the server-side orphan reaper. */
  lastActivityAt: number
  /** Operations that still depend on the page and must not be reaped midway. */
  activeOperations: number
  /** The page the screencast is currently running on (null = not running).
   *  Reconciled against `screencastDesired` + the active page by applyScreencast. */
  screencastPage: BrowserPageHandle | null
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
  /** Clock + TTL overrides keep idle-session expiry deterministic in tests. */
  now?: () => number
  sessionIdleTtlMs?: number
  sessionSweepIntervalMs?: number
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
  private readonly now: () => number
  private readonly sessionIdleTtlMs: number
  private idleSweepTimer: ReturnType<typeof setInterval> | null = null

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
    this.now = opts.now ?? Date.now
    const requestedIdleTtlMs = opts.sessionIdleTtlMs
    this.sessionIdleTtlMs = typeof requestedIdleTtlMs === 'number' && Number.isFinite(requestedIdleTtlMs) && requestedIdleTtlMs > 0
      ? requestedIdleTtlMs
      : DEFAULT_SESSION_IDLE_TTL_MS
    this.profileDir =
      opts.profileDir ??
      path.join(opts.homeDir ?? os.homedir(), '.specrails', 'projects', opts.projectSlug, 'browser-profile')
    const requestedSweepIntervalMs = opts.sessionSweepIntervalMs
    const sweepIntervalMs = typeof requestedSweepIntervalMs === 'number' && Number.isFinite(requestedSweepIntervalMs) && requestedSweepIntervalMs > 0
      ? requestedSweepIntervalMs
      : Math.min(DEFAULT_SESSION_SWEEP_INTERVAL_MS, this.sessionIdleTtlMs)
    this.idleSweepTimer = setInterval(() => { void this.sweepIdleSessions() }, sweepIntervalMs)
    this.idleSweepTimer.unref?.()
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

  private getSessionForActivity(sessionId: string): BrowserSession | undefined {
    const s = this.getSession(sessionId)
    if (s) s.lastActivityAt = this.now()
    return s
  }

  private beginOperation(s: BrowserSession): void {
    s.lastActivityAt = this.now()
    s.activeOperations += 1
  }

  private endOperation(s: BrowserSession): void {
    s.activeOperations = Math.max(0, s.activeOperations - 1)
    s.lastActivityAt = this.now()
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
    if (this.disposed) {
      this._reserved--
      try { await page.close() } catch { /* ignore */ }
      throw new BrowserLaunchError('manager disposed')
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
    const activityAt = this.now()
    const session: BrowserSession = {
      id,
      projectId: this.projectId,
      page,
      popups: [],
      popupView: false,
      clients: new Set(),
      lastFrame: null,
      url: null,
      title: null,
      viewport: { ...DEFAULT_VIEWPORT },
      createdAt: opts?.createdAtMs ?? activityAt,
      lastActivityAt: activityAt,
      activeOperations: 0,
      screencastPage: null,
      screencastDesired: false,
      screencastOp: null,
      closed: false,
    }
    this.sessions.set(id, session)
    // The reservation is now realised as a committed session — release it.
    this._reserved--

    // Adopt popups the page opens (OAuth login windows etc.) as secondary pages
    // of this session, and keep the client's URL bar live on in-page navigation
    // (link clicks / redirects the REST navigate path never sees).
    this.watchPopups(session, page)
    page.onNavigated?.((url) => {
      if (session.closed || this.disposed) return
      session.url = url
      if (url && url !== 'about:blank') this.setLastUrl(url)
      this.broadcastControl(session, { type: 'nav', url, title: session.title })
    })

    // Start capturing the page's network requests before the first navigation so
    // XHR/fetch made during page load are available at capture time. Best-effort:
    // a handle that doesn't support it (or a failure) just yields no network data.
    try { await page.enableNetwork?.() } catch { /* network capture is best-effort */ }

    // Kick the initial navigation WITHOUT blocking session creation. The old
    // `await page.goto(...)` here held the create POST — and therefore the whole
    // modal spinner — hostage to `domcontentloaded` (up to 30s on a slow site).
    // Returning immediately lets the client attach and start the screencast right
    // away, so the user watches the page paint progressively instead of staring
    // at "opening…". The URL is set optimistically to the target; the resolved
    // URL/title land via the `nav` control broadcast every client already handles.
    const target = opts?.initialUrl?.trim() || this.getLastUrl() || 'about:blank'
    session.url = target
    void this.runInitialNavigation(session, target)
    return this.toMeta(session)
  }

  /** Complete the initial `goto` in the background (see create()). Never throws;
   *  a session killed mid-navigation is simply left alone. */
  private async runInitialNavigation(s: BrowserSession, target: string): Promise<void> {
    let result: { url: string; title: string }
    try {
      result = await s.page.goto(target)
    } catch {
      return // the page keeps whatever it settled on; nav failures are non-fatal
    }
    if (s.closed || this.disposed) return
    s.url = result.url
    s.title = result.title
    if (result.url && result.url !== 'about:blank') this.setLastUrl(result.url)
    this.broadcastControl(s, { type: 'nav', url: result.url, title: result.title })
  }

  // ─── Popup support (OAuth login windows etc.) ───────────────────────────────

  private topPopup(s: BrowserSession): BrowserPageHandle | null {
    return s.popups.length > 0 ? s.popups[s.popups.length - 1] : null
  }

  /** The page the screencast + interactive input should target: the top popup
   *  while one is open and being viewed, else the root page. */
  private activePage(s: BrowserSession): BrowserPageHandle {
    return (s.popupView && this.topPopup(s)) || s.page
  }

  private watchPopups(s: BrowserSession, opener: BrowserPageHandle): void {
    opener.onPopup?.((popup) => this.adoptPopup(s, popup))
  }

  /** Register a popup as a secondary page of the session: inherit the viewport,
   *  reroute the screencast + input to it (latest-wins), and auto-return to the
   *  opener when it closes (the typical OAuth self-close). */
  private adoptPopup(s: BrowserSession, popup: BrowserPageHandle): void {
    if (s.closed || this.disposed) {
      void popup.close().catch(() => { /* ignore */ })
      return
    }
    s.popups.push(popup)
    s.popupView = true
    // Popups inherit the session viewport so coordinate mapping + screencast
    // dimensions stay identical to the root page.
    void popup.setViewport(s.viewport.width, s.viewport.height, s.viewport.deviceScaleFactor).catch(() => { /* ignore */ })
    popup.onClose?.(() => this.dropPopup(s, popup))
    popup.onNavigated?.(() => {
      // Keep the "Login window — <origin>" label fresh while the top popup
      // walks its redirect chain.
      if (!s.closed && this.topPopup(s) === popup) this.broadcastPopupState(s)
    })
    // Popups can themselves open popups (rare, but some IdPs chain windows).
    this.watchPopups(s, popup)
    this.broadcastPopupState(s)
    void this.applyScreencast(s)
  }

  private dropPopup(s: BrowserSession, popup: BrowserPageHandle): void {
    const i = s.popups.indexOf(popup)
    if (i === -1) return
    s.popups.splice(i, 1)
    if (s.popups.length === 0) s.popupView = false
    if (s.closed) return
    this.broadcastPopupState(s)
    // Re-routes the screencast to the next popup down or back to the opener;
    // startScreencast emits a frame immediately, so the switch paints at once.
    void this.applyScreencast(s)
  }

  private broadcastPopupState(s: BrowserSession): void {
    const top = this.topPopup(s)
    this.broadcastControl(s, {
      type: 'popup',
      count: s.popups.length,
      active: s.popupView && top != null,
      url: top ? top.currentUrl() : null,
    })
  }

  /** Switch the viewed page between the root page and the top popup ("back to
   *  page" / "show login window"). Returns false for an unknown session. */
  setPopupView(sessionId: string, target: 'root' | 'popup'): boolean {
    const s = this.getSessionForActivity(sessionId)
    if (!s) return false
    s.popupView = target === 'popup' && s.popups.length > 0
    this.broadcastPopupState(s)
    void this.applyScreencast(s)
    return true
  }

  // ─── WS attach / detach + screencast fan-out ────────────────────────────────

  async attach(sessionId: string, ws: BrowserWsClient): Promise<BrowserSessionMeta | null> {
    if (this.disposed) return null
    const s = this.getSessionForActivity(sessionId)
    if (!s) return null
    s.clients.add(ws)
    this.safeSend(ws, JSON.stringify({ type: 'ready', id: s.id, url: s.url, title: s.title, viewport: s.viewport }))
    if (s.lastFrame) this.safeSend(ws, s.lastFrame)
    // A (re)joining client must learn about a live popup immediately, or it
    // would render popup frames with the root-page chrome.
    if (s.popups.length > 0) {
      const top = this.topPopup(s)
      this.safeSend(ws, JSON.stringify({ type: 'popup', count: s.popups.length, active: s.popupView && top != null, url: top ? top.currentUrl() : null }))
    }
    s.screencastDesired = true
    await this.applyScreencast(s)
    return this.toMeta(s)
  }

  detach(sessionId: string, ws: BrowserWsClient): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    s.clients.delete(ws)
    s.lastActivityAt = this.now()
    if (s.clients.size === 0 && !s.closed) {
      s.screencastDesired = false
      void this.applyScreencast(s)
    }
  }

  /**
   * Serialise screencast start/stop transitions on a per-session promise chain so
   * a rapid detach→attach (stop fired async, then start) can't double-initialise
   * the CDP screencast. The chain reconciles the page the screencast runs on
   * (`screencastPage`) to the DESIRED page — the active page (top popup while one
   * is viewed, else the root page) when `screencastDesired`, or none. A popup
   * open/close/focus switch therefore stops the cast on the old page and starts
   * it on the new one; the same frame callback fans out to the same clients.
   */
  private applyScreencast(s: BrowserSession): Promise<void> {
    const prev = s.screencastOp ?? Promise.resolve()
    s.screencastOp = prev.then(async () => {
      const desired = !s.closed && s.screencastDesired ? this.activePage(s) : null
      if (s.screencastPage === desired) return
      if (s.screencastPage) {
        const old = s.screencastPage
        s.screencastPage = null
        try { await old.stopScreencast() } catch { /* ignore */ }
      }
      s.lastFrame = null // never replay a previous popup/root frame under new chrome
      if (desired) {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (s.closed || !s.screencastDesired || this.activePage(s) !== desired) return
          try {
            await desired.startScreencast((frame) => {
              if (s.closed || !s.screencastDesired || this.activePage(s) !== desired) return
              s.lastFrame = frame.data
              for (const client of s.clients) {
                if (client.readyState !== WS_OPEN) continue
                // Keep slow clients current instead of queueing stale JPEGs.
                if ((client.bufferedAmount ?? 0) > MAX_CLIENT_BUFFERED_BYTES) continue
                try { client.send(frame.data) } catch { /* drop */ }
              }
            })
            s.screencastPage = desired
            return
          } catch {
            // A rejected CDP start previously left this session permanently
            // marked as casting. Release partial resources before one retry.
            try { await desired.stopScreencast() } catch { /* ignore */ }
          }
        }
        // An OAuth window can self-close during the final failed CDP attach or
        // its cleanup. The queued transition will resume its opener; a failure
        // belonging to the old popup must not disconnect the whole session.
        if (s.closed || !s.screencastDesired || this.activePage(s) !== desired) return
        s.screencastDesired = false
        // Persistent failure must surface as a disconnected stream, not a ready
        // socket that displays a blank canvas forever. A later attach can retry.
        for (const client of s.clients) {
          try { client.close(1011, 'browser_stream_failed') } catch { /* ignore */ }
        }
        s.clients.clear()
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
    const s = this.getSessionForActivity(sessionId)
    if (!s) return null
    return s.page.probeElementAt(point)
  }

  /** Re-resolve an element by selector and step to parent/child/self (breadcrumb). */
  async navigateElement(sessionId: string, selector: string, direction: 'parent' | 'child' | 'self'): Promise<ElementProbe | null> {
    if (this.disposed) return null
    const s = this.getSessionForActivity(sessionId)
    if (!s) return null
    return (await s.page.navigateElement?.(selector, direction)) ?? null
  }

  async handleInput(sessionId: string, event: BrowserInputEvent): Promise<void> {
    if (this.disposed) return
    const s = this.getSessionForActivity(sessionId)
    if (!s) return
    if (event.type === 'resize') {
      const normalized = normalizeBrowserViewport(event.width, event.height, event.deviceScaleFactor ?? s.viewport.deviceScaleFactor)
      s.viewport = {
        width: normalized.width,
        height: normalized.height,
        ...(event.deviceScaleFactor !== undefined || s.viewport.deviceScaleFactor !== undefined
          ? { deviceScaleFactor: normalizeBrowserDeviceScaleFactor(event.deviceScaleFactor ?? s.viewport.deviceScaleFactor ?? 1) }
          : {}),
      }
      // Keep every page of the session (root + popups) at the same viewport so
      // switching between them never re-maps coordinates or resizes the canvas.
      const resize = { type: 'resize' as const, ...s.viewport }
      await s.page.dispatchInput(resize)
      for (const popup of s.popups) {
        try { await popup.dispatchInput(resize) } catch { /* ignore */ }
      }
      return
    }
    // Interactive input (mouse/wheel/keys) goes to the page being VIEWED — the
    // top popup during an OAuth login, else the root page.
    await this.activePage(s).dispatchInput(event)
  }

  async navigate(sessionId: string, action: 'goto' | 'back' | 'forward' | 'reload', url?: string): Promise<{ url: string; title: string; target?: 'popup' } | null> {
    if (this.disposed) return null
    const s = this.getSessionForActivity(sessionId)
    if (!s) return null
    // Snapshot before awaiting: an OAuth window can close, or the user can
    // switch views, while a navigation is in flight. Its result still belongs
    // to the page the user acted on, never to the newly visible opener.
    const page = this.activePage(s)
    const isPopup = page !== s.page
    this.beginOperation(s)
    try {
      let result: { url: string; title: string }
      if (action === 'goto') result = await page.goto(url ?? 'about:blank')
      else if (action === 'back') result = await page.goBack()
      else if (action === 'forward') result = await page.goForward()
      else result = await page.reload()
      if (isPopup) {
        if (!s.closed && !this.disposed && this.topPopup(s) === page) this.broadcastPopupState(s)
        // Popup redirect/callback URLs must never replace the project page's
        // remembered URL, title or nav events (nor the client's root state).
        return { ...result, target: 'popup' }
      }
      if (!s.closed && !this.disposed) {
        s.url = result.url
        s.title = result.title
        if (result.url && result.url !== 'about:blank') this.setLastUrl(result.url)
        this.broadcastControl(s, { type: 'nav', url: result.url, title: result.title })
      }
      return result
    } finally {
      this.endOperation(s)
    }
  }

  // ─── Capture: screenshot + rich DOM → attachments ───────────────────────────

  async capture(sessionId: string, rect: CaptureRect, pendingSpecId: string, opts?: { captureNetwork?: boolean }): Promise<CaptureResult | null> {
    if (this.disposed) return null
    const s = this.getSessionForActivity(sessionId)
    if (!s) return null
    const safeRect: CaptureRect = {
      x: Math.max(0, rect.x),
      y: Math.max(0, rect.y),
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    }
    let png: Buffer
    let dom: CapturedDom
    this.beginOperation(s)
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
    } finally {
      this.endOperation(s)
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
    const s = this.getSessionForActivity(sessionId)
    if (!s) return null
    // Clipboard follows the viewed page: pasting credentials into an OAuth
    // popup must land in the popup, not the opener behind it.
    const page = this.activePage(s)
    if (action === 'paste') {
      if (text) await page.insertText?.(text)
      return { text: '' }
    }
    const sel = (await page.getSelectionText?.()) ?? ''
    if (action === 'cut' && sel) await page.deleteSelection?.()
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
    const s = this.getSessionForActivity(sessionId)
    if (!s) return null
    const order = Object.keys(dims)
    if (order.length === 0) return null

    this.beginOperation(s)
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
      this.endOperation(s)
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

  /** Reap sessions abandoned by clients. A connected socket or page-dependent
   *  operation is authoritative activity and prevents expiry. `kill()` removes
   *  the map entry synchronously, so an attach cannot race between the final
   *  eligibility check and teardown on this event loop. */
  async sweepIdleSessions(): Promise<number> {
    if (this.disposed) return 0
    const expiresBefore = this.now() - this.sessionIdleTtlMs
    let reaped = 0
    for (const [id, s] of this.sessions) {
      if (s.closed || s.clients.size > 0 || s.activeOperations > 0 || s.lastActivityAt > expiresBefore) continue
      if (await this.kill(id)) reaped += 1
    }
    return reaped
  }

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
    for (const popup of s.popups.splice(0)) {
      try { await popup.close() } catch { /* ignore */ }
    }
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
    if (this.idleSweepTimer) {
      clearInterval(this.idleSweepTimer)
      this.idleSweepTimer = null
    }
    if (this.disposed) return
    this.disposed = true
    for (const s of [...this.sessions.values()]) {
      s.closed = true
      for (const client of s.clients) {
        try { client.close(1000, 'shutdown') } catch { /* ignore */ }
      }
      s.clients.clear()
      for (const popup of s.popups.splice(0)) {
        try { await popup.close() } catch { /* ignore */ }
      }
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
}
