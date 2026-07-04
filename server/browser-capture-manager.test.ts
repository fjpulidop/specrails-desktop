import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDb, type DbInstance } from './db'
import { BrowserCaptureManager, type BrowserWsClient } from './browser-capture-manager'
import { SharedBrowserContextPool } from './browser-context-pool'
import {
  BrowserLimitExceededError,
  BrowserLaunchError,
  type BrowserContextHandle,
  type BrowserPageHandle,
  type CaptureRect,
  type CapturedDom,
  type CapturedNetworkRequest,
  type ContextLauncher,
  type ScreencastFrame,
} from './browser-capture-types'
import type { Attachment } from './ticket-store'

// ─── Fakes ────────────────────────────────────────────────────────────────────

function makeDom(): CapturedDom {
  return {
    url: 'https://example.com',
    title: 'Example',
    viewport: { width: 1280, height: 800 },
    rect: { x: 0, y: 0, width: 10, height: 10 },
    html: '<button>Hi</button>',
    htmlTruncated: false,
    css: '.x{color:red}',
    cssTruncated: false,
    nodes: [{ tag: 'button', role: 'button', text: 'Hi', rect: { x: 0, y: 0, width: 10, height: 10 }, attributes: {}, styles: {} }],
    capturedAt: '2026-06-07T00:00:00.000Z',
  }
}

class FakePage implements BrowserPageHandle {
  url = 'about:blank'
  title = ''
  calls: string[] = []
  inputs: unknown[] = []
  frameCb: ((f: ScreencastFrame) => void) | null = null
  screencasting = false
  closed = false
  nextNav: { url: string; title: string } | null = null
  enabledNetwork = false
  network: CapturedNetworkRequest[] = []

  private nav(): { url: string; title: string } {
    if (this.nextNav) { this.url = this.nextNav.url; this.title = this.nextNav.title }
    return { url: this.url, title: this.title }
  }
  async goto(url: string) { this.calls.push(`goto:${url}`); if (!this.nextNav) { this.url = url; this.title = url === 'about:blank' ? '' : 'T' } ; return this.nav() }
  async goBack() { this.calls.push('back'); return this.nav() }
  async goForward() { this.calls.push('forward'); return this.nav() }
  async reload() { this.calls.push('reload'); return this.nav() }
  currentUrl() { return this.url }
  async currentTitle() { return this.title }
  async setViewport(w: number, h: number) { this.calls.push(`viewport:${w}x${h}`) }
  async dispatchInput(e: unknown) { this.inputs.push(e) }
  async startScreencast(cb: (f: ScreencastFrame) => void) { this.screencasting = true; this.frameCb = cb }
  async stopScreencast() { this.screencasting = false; this.frameCb = null }
  clips: CaptureRect[] = []
  async screenshotClip(rect: CaptureRect) { this.clips.push(rect); return Buffer.from('PNGDATA') }
  async extractDom() { return makeDom() }
  async probeElementAt(point: { x: number; y: number }) { return { rect: { x: point.x, y: point.y, width: 50, height: 20 }, tag: 'div', selector: 'div.box', path: [{ label: 'body', selector: 'body' }, { label: 'div.box', selector: 'div.box' }] } }
  async navigateElement(selector: string, direction: 'parent' | 'child' | 'self') {
    if (direction === 'parent' && selector === 'body') return null
    return { rect: { x: 0, y: 0, width: 10, height: 10 }, tag: direction === 'parent' ? 'section' : 'span', selector: `${selector} ${direction}`, path: [{ label: 'body', selector: 'body' }, { label: 'x', selector: `${selector} ${direction}` }] }
  }
  async enableNetwork() { this.enabledNetwork = true }
  recentNetwork() { return this.network }
  anchorSelector: string | null = '#el'
  anchorRect: CaptureRect | null = { x: 0, y: 0, width: 100, height: 40 }
  async resolveAnchorSelector() { this.calls.push('anchorSel'); return this.anchorSelector }
  async resolveAnchorRect() { return this.anchorRect }
  async waitForStable() { this.calls.push('stable') }
  selection = ''
  pasted: string[] = []
  deleted = 0
  async getSelectionText() { return this.selection }
  async insertText(t: string) { this.pasted.push(t) }
  async deleteSelection() { this.deleted++ }
  popupCb: ((p: BrowserPageHandle) => void) | null = null
  closeCb: (() => void) | null = null
  navCb: ((url: string) => void) | null = null
  onPopup(cb: (p: BrowserPageHandle) => void) { this.popupCb = cb }
  onClose(cb: () => void) { this.closeCb = cb }
  onNavigated(cb: (url: string) => void) { this.navCb = cb }
  /** Simulate this page opening a popup (window.open / OAuth login window). */
  emitPopup(): FakePage {
    const p = new FakePage()
    this.popupCb?.(p)
    return p
  }
  async close() { this.closed = true }
  emitFrame(data: Buffer) { this.frameCb?.({ data, width: 1280, height: 800 }) }
}

class FakeContext implements BrowserContextHandle {
  pages: FakePage[] = []
  closed = false
  async newPage() { const p = new FakePage(); this.pages.push(p); return p }
  async close() { this.closed = true }
}

function makeAttachments() {
  const uploads: Array<{ ticketKey: string | number; mime: string; name: string }> = []
  return {
    uploads,
    upload: vi.fn(async (opts: { slug: string; ticketKey: string | number; ticketStorePath: string | null; file: { buffer: Buffer; originalname: string; mimetype: string; size: number } }): Promise<Attachment> => {
      uploads.push({ ticketKey: opts.ticketKey, mime: opts.file.mimetype, name: opts.file.originalname })
      return {
        id: `att-${uploads.length}`,
        filename: opts.file.originalname,
        storedName: opts.file.originalname,
        mimeType: opts.file.mimetype,
        size: opts.file.size,
        addedAt: '2026-06-07T00:00:00.000Z',
      }
    }),
  }
}

function makeWs(): BrowserWsClient & { sent: Array<string | Buffer>; closed: boolean } {
  return {
    readyState: 1,
    sent: [],
    closed: false,
    send(d: string | Buffer) { this.sent.push(d) },
    close() { this.closed = true },
  } as BrowserWsClient & { sent: Array<string | Buffer>; closed: boolean }
}

function makeManager(opts: { launcher?: ContextLauncher; db?: DbInstance; attachments?: ReturnType<typeof makeAttachments> } = {}) {
  const db = opts.db ?? initDb(':memory:')
  const ctx = new FakeContext()
  const launcher: ContextLauncher = opts.launcher ?? vi.fn(async () => ctx)
  const attachments = opts.attachments ?? makeAttachments()
  const broadcast = vi.fn()
  const mgr = new BrowserCaptureManager({
    projectId: 'proj-1',
    projectSlug: 'proj',
    db,
    broadcast,
    launcher,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    attachments: attachments as any,
    profileDir: '/tmp/profile',
  })
  return { mgr, db, ctx, launcher, attachments, broadcast }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BrowserCaptureManager', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  it('creates a session navigating to about:blank with default viewport', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    expect(meta.projectId).toBe('proj-1')
    expect(meta.viewportWidth).toBe(1280)
    expect(meta.viewportHeight).toBe(800)
    expect(ctx.pages).toHaveLength(1)
    expect(ctx.pages[0].calls).toContain('goto:about:blank')
    expect(mgr.sessionCount()).toBe(1)
  })

  it('navigates to initialUrl and persists it as the last URL', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create({ initialUrl: 'https://example.com' })
    expect(meta.url).toBe('https://example.com')
    // The initial navigation completes in the background (create() no longer
    // blocks on goto) — flush it before asserting the persisted URL.
    await new Promise((r) => setTimeout(r, 0))
    expect(mgr.getLastUrl()).toBe('https://example.com')
  })

  it('create() does not block on the initial navigation; url/title land via a nav broadcast', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const page = new FakePage()
    const origGoto = page.goto.bind(page)
    page.goto = async (url: string) => { await gate; return origGoto(url) }
    const slowCtx: BrowserContextHandle = { newPage: async () => page, close: async () => {} }
    const { mgr } = makeManager({ db, launcher: vi.fn(async () => slowCtx) })

    const meta = await mgr.create({ initialUrl: 'https://slow.dev' })
    // create resolved while goto is still pending: optimistic URL, no lastUrl yet.
    expect(meta.url).toBe('https://slow.dev')
    expect(mgr.getLastUrl()).toBeNull()

    const ws = makeWs()
    await mgr.attach(meta.id, ws)
    release()
    await new Promise((r) => setTimeout(r, 0))

    const navs = ws.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as { type: string; url?: string })
      .filter((m) => m.type === 'nav')
    expect(navs).toHaveLength(1)
    expect(navs[0].url).toBe('https://slow.dev')
    expect(mgr.getLastUrl()).toBe('https://slow.dev')
    expect(mgr.getSession(meta.id)?.url).toBe('https://slow.dev')
  })

  it('ignores initial-navigation completion after the session was killed', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const page = new FakePage()
    const origGoto = page.goto.bind(page)
    page.goto = async (url: string) => { await gate; return origGoto(url) }
    const slowCtx: BrowserContextHandle = { newPage: async () => page, close: async () => {} }
    const { mgr } = makeManager({ db, launcher: vi.fn(async () => slowCtx) })

    const meta = await mgr.create({ initialUrl: 'https://slow.dev' })
    await mgr.kill(meta.id)
    release()
    await new Promise((r) => setTimeout(r, 0))
    // No state mutation / persistence for a dead session.
    expect(mgr.getLastUrl()).toBeNull()
  })

  it('reuses the persisted last URL on a fresh session', async () => {
    db.prepare('INSERT OR REPLACE INTO queue_state (key, value) VALUES (?, ?)').run('config.browser_last_url', 'https://saved.dev')
    const { mgr, ctx } = makeManager({ db })
    await mgr.create()
    expect(ctx.pages[0].calls).toContain('goto:https://saved.dev')
  })

  it('does not persist about:blank as last URL', async () => {
    const { mgr } = makeManager({ db })
    await mgr.create()
    expect(mgr.getLastUrl()).toBeNull()
  })

  it('enforces the per-project session cap', async () => {
    const { mgr } = makeManager({ db })
    await mgr.create(); await mgr.create(); await mgr.create(); await mgr.create()
    await expect(mgr.create()).rejects.toBeInstanceOf(BrowserLimitExceededError)
  })

  it('does not let concurrent create() calls race past the cap (BUG-BROWSER-02)', async () => {
    // A context whose newPage awaits a real async tick, so all creates interleave
    // their cap-check → await → insert windows (the classic TOCTOU).
    const pages: FakePage[] = []
    const slowCtx: BrowserContextHandle = {
      async newPage() {
        await new Promise((r) => setTimeout(r, 5))
        const p = new FakePage()
        pages.push(p)
        return p
      },
      async close() {},
    }
    const launcher: ContextLauncher = vi.fn(async () => slowCtx)
    const { mgr } = makeManager({ db, launcher })

    // Fire 10 creates at once; only MAX (4) may succeed.
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => mgr.create()))
    const ok = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(ok).toHaveLength(4)
    expect(rejected).toHaveLength(6)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BrowserLimitExceededError)
    }
    expect(mgr.sessionCount()).toBe(4)
    // Any extra pages created by a losing-racer's already-awaited newPage are torn down.
    const livePages = pages.filter((p) => !p.closed)
    expect(livePages.length).toBe(4)
  })

  it('releases the reservation when newPage fails so later creates still work', async () => {
    let attempt = 0
    const ctx: BrowserContextHandle = {
      async newPage() {
        attempt++
        if (attempt === 1) throw new Error('page boom')
        return new FakePage()
      },
      async close() {},
    }
    const launcher: ContextLauncher = vi.fn(async () => ctx)
    const { mgr } = makeManager({ db, launcher })
    await expect(mgr.create()).rejects.toThrow('page boom')
    // Reservation was released — a fresh create succeeds and the cap is intact.
    const meta = await mgr.create()
    expect(meta).toBeTruthy()
    expect(mgr.sessionCount()).toBe(1)
  })

  it('wraps launch failures and allows a retry', async () => {
    let attempt = 0
    const ctx = new FakeContext()
    const launcher: ContextLauncher = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('boom')
      return ctx
    })
    const { mgr } = makeManager({ db, launcher })
    await expect(mgr.create()).rejects.toBeInstanceOf(BrowserLaunchError)
    // second attempt succeeds (contextPromise was reset)
    const meta = await mgr.create()
    expect(meta).toBeTruthy()
    expect(launcher).toHaveBeenCalledTimes(2)
  })

  it('attaches a client: sends ready, starts screencast, fans out frames, replays last frame', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    const ws1 = makeWs()
    await mgr.attach(meta.id, ws1)
    // ready JSON sent
    expect(typeof ws1.sent[0]).toBe('string')
    expect(JSON.parse(ws1.sent[0] as string).type).toBe('ready')
    expect(ctx.pages[0].screencasting).toBe(true)

    // emit a frame → binary delivered + stored
    ctx.pages[0].emitFrame(Buffer.from('JPEG1'))
    expect(ws1.sent.some((s) => Buffer.isBuffer(s) && s.toString() === 'JPEG1')).toBe(true)

    // a second client gets the last frame immediately after ready
    const ws2 = makeWs()
    await mgr.attach(meta.id, ws2)
    expect(ws2.sent.some((s) => Buffer.isBuffer(s) && s.toString() === 'JPEG1')).toBe(true)
  })

  it('attach returns null for an unknown session', async () => {
    const { mgr } = makeManager({ db })
    expect(await mgr.attach('nope', makeWs())).toBeNull()
  })

  it('skips screencast frames for a client with a backed-up send buffer (conflation)', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    const fast = makeWs()
    const slow = makeWs()
    slow.bufferedAmount = 5_000_000 // way past the conflation threshold
    await mgr.attach(meta.id, fast)
    await mgr.attach(meta.id, slow)
    const slowSentBefore = slow.sent.length

    ctx.pages[0].emitFrame(Buffer.from('JPEG-NEW'))
    // The healthy client gets the frame; the backed-up one is skipped (newest-wins).
    expect(fast.sent.some((s) => Buffer.isBuffer(s) && s.toString() === 'JPEG-NEW')).toBe(true)
    expect(slow.sent.length).toBe(slowSentBefore)

    // lastFrame is still updated, so a recovering/late client replays the newest frame.
    const late = makeWs()
    await mgr.attach(meta.id, late)
    expect(late.sent.some((s) => Buffer.isBuffer(s) && s.toString() === 'JPEG-NEW')).toBe(true)
  })

  it('stops the screencast when the last client detaches', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    const ws = makeWs()
    await mgr.attach(meta.id, ws)
    expect(ctx.pages[0].screencasting).toBe(true)
    mgr.detach(meta.id, ws)
    // The stop transition is serialised on a per-session promise chain.
    await new Promise((r) => setTimeout(r, 0))
    expect(ctx.pages[0].screencasting).toBe(false)
  })

  it('serialises a rapid detach→attach so the screencast ends up running', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    const ws1 = makeWs()
    await mgr.attach(meta.id, ws1)
    mgr.detach(meta.id, ws1) // fires async stop
    const ws2 = makeWs()
    await mgr.attach(meta.id, ws2) // desires screencast again
    await new Promise((r) => setTimeout(r, 0))
    expect(ctx.pages[0].screencasting).toBe(true)
  })

  it('forwards input and tracks viewport on resize', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    await mgr.handleInput(meta.id, { type: 'resize', width: 640, height: 480 })
    await mgr.handleInput(meta.id, { type: 'mouse', action: 'down', x: 5, y: 5 })
    expect(ctx.pages[0].inputs).toHaveLength(2)
    expect(mgr.listSessions()[0].viewportWidth).toBe(640)
  })

  it('handleInput is a no-op for unknown sessions', async () => {
    const { mgr } = makeManager({ db })
    await expect(mgr.handleInput('nope', { type: 'resize', width: 1, height: 1 })).resolves.toBeUndefined()
  })

  it('navigates, updates state, persists URL and broadcasts to clients', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    const ws = makeWs()
    await mgr.attach(meta.id, ws)
    ctx.pages[0].nextNav = { url: 'https://navd.dev', title: 'Navd' }
    const result = await mgr.navigate(meta.id, 'goto', 'https://navd.dev')
    expect(result).toEqual({ url: 'https://navd.dev', title: 'Navd' })
    expect(mgr.getLastUrl()).toBe('https://navd.dev')
    expect(ws.sent.some((s) => typeof s === 'string' && JSON.parse(s).type === 'nav')).toBe(true)
    expect(mgr.getSession(meta.id)?.url).toBe('https://navd.dev')
  })

  it('navigate variants reach the page; unknown session returns null', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    await mgr.navigate(meta.id, 'back')
    await mgr.navigate(meta.id, 'forward')
    await mgr.navigate(meta.id, 'reload')
    expect(ctx.pages[0].calls).toEqual(expect.arrayContaining(['back', 'forward', 'reload']))
    expect(await mgr.navigate('nope', 'reload')).toBeNull()
  })

  it('captures a region: uploads screenshot + DOM attachments and returns them', async () => {
    const attachments = makeAttachments()
    const { mgr } = makeManager({ db, attachments })
    const meta = await mgr.create()
    const result = await mgr.capture(meta.id, { x: -5, y: -5, width: 100, height: 50 }, 'pending-1')
    expect(result).not.toBeNull()
    expect(result!.screenshot.mimeType).toBe('image/png')
    expect(result!.domAttachment.mimeType).toBe('application/json')
    expect(result!.screenshotDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(result!.dom.html).toContain('button')
    expect(attachments.uploads).toHaveLength(2)
    expect(attachments.uploads.every((u) => u.ticketKey === 'pending-1')).toBe(true)
    expect(attachments.uploads.map((u) => u.mime)).toEqual(['image/png', 'application/json'])
  })

  it('enables network capture on session create and folds requests into the DOM', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    expect(ctx.pages[0].enabledNetwork).toBe(true)
    ctx.pages[0].network = [
      { method: 'GET', url: 'https://api.x/items', status: 200, resourceType: 'Fetch', mimeType: 'application/json', requestBodyShape: null, responseShape: '{ items: [object] }', durationMs: 42, startedAt: 0 },
    ]
    const result = await mgr.capture(meta.id, { x: 0, y: 0, width: 10, height: 10 }, 'pend')
    expect(result!.dom.networkRequests).toHaveLength(1)
    expect(result!.dom.networkRequests![0].url).toBe('https://api.x/items')
    expect(result!.dom.networkRequests![0].responseShape).toBe('{ items: [object] }')
  })

  it('omits network requests when captureNetwork is false', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    ctx.pages[0].network = [
      { method: 'GET', url: 'https://api.x/items', status: 200, resourceType: 'Fetch', mimeType: 'application/json', durationMs: 1, startedAt: 0 } as CapturedNetworkRequest,
    ]
    const result = await mgr.capture(meta.id, { x: 0, y: 0, width: 10, height: 10 }, 'pend', { captureNetwork: false })
    expect(result!.dom.networkRequests).toBeUndefined()
  })

  it('capture returns null for an unknown session', async () => {
    const { mgr } = makeManager({ db })
    expect(await mgr.capture('nope', { x: 0, y: 0, width: 1, height: 1 }, 'p')).toBeNull()
  })

  const BPS = { desktop: { width: 1280, height: 800 }, tablet: { width: 768, height: 1024 }, mobile: { width: 375, height: 667 } }

  it('captureBreakpoints shoots the selection at every size and restores the live viewport', async () => {
    const attachments = makeAttachments()
    const { mgr, ctx } = makeManager({ db, attachments })
    const meta = await mgr.create()
    const result = await mgr.captureBreakpoints(meta.id, { x: 0, y: 0, width: 100, height: 50 }, { x: 50, y: 25 }, 'pend', BPS)
    expect(result).not.toBeNull()
    expect(Object.keys(result!.breakpoints!)).toEqual(['desktop', 'tablet', 'mobile'])
    expect(result!.breakpoints!.tablet.viewport).toEqual({ width: 768, height: 1024 })
    expect(result!.breakpoints!.mobile.attachment.mimeType).toBe('image/png')
    // canonical screenshot/dom point at the first (desktop) breakpoint
    expect(result!.screenshot.id).toBe(result!.breakpoints!.desktop.attachment.id)
    expect(result!.screenshotDataUrl.startsWith('data:image/png;base64,')).toBe(true)
    // 3 screenshots + 1 canonical DOM
    expect(attachments.uploads.filter((u) => u.mime === 'image/png')).toHaveLength(3)
    expect(attachments.uploads.filter((u) => u.mime === 'application/json')).toHaveLength(1)
    // viewport visited each size then restored to the live (default) viewport
    expect(ctx.pages[0].calls.filter((c) => c.startsWith('viewport:'))).toEqual([
      'viewport:1280x800', 'viewport:768x1024', 'viewport:375x667', 'viewport:1280x800',
    ])
    expect(mgr.getSession(meta.id)!.viewport).toEqual({ width: 1280, height: 800 })
  })

  it('captureBreakpoints clamps an out-of-bounds rect to each breakpoint viewport', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    // No selector → fall back to the (huge, desktop-sized) original rect, which
    // would sit outside a smaller viewport and make screenshot throw if unclamped.
    mgr.getSession(meta.id)!.page.resolveAnchorSelector = async () => null
    await mgr.captureBreakpoints(meta.id, { x: 1000, y: 700, width: 800, height: 600 }, { x: 5, y: 5 }, 'pend', { mobile: { width: 375, height: 667 } })
    const clip = ctx.pages[0].clips[0]
    expect(clip.x).toBeLessThan(375)
    expect(clip.x + clip.width).toBeLessThanOrEqual(375)
    expect(clip.y + clip.height).toBeLessThanOrEqual(667)
    expect(clip.width).toBeGreaterThanOrEqual(1)
    expect(clip.height).toBeGreaterThanOrEqual(1)
  })

  it('captureBreakpoints falls back to the original rect when no anchor selector resolves', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create()
    mgr.getSession(meta.id)!.page.resolveAnchorSelector = async () => null
    const result = await mgr.captureBreakpoints(meta.id, { x: 1, y: 2, width: 30, height: 40 }, { x: 5, y: 5 }, 'pend', { desktop: { width: 1280, height: 800 } })
    expect(result).not.toBeNull()
    expect(Object.keys(result!.breakpoints!)).toEqual(['desktop'])
  })

  it('captureBreakpoints returns null for unknown session, empty dims, or after shutdown', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create()
    expect(await mgr.captureBreakpoints('nope', { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0 }, 'p', BPS)).toBeNull()
    expect(await mgr.captureBreakpoints(meta.id, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0 }, 'p', {})).toBeNull()
    await mgr.shutdown()
    expect(await mgr.captureBreakpoints(meta.id, { x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 0 }, 'p', BPS)).toBeNull()
  })

  it('captureBreakpoints kills the session when the page dies mid-sequence', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create()
    mgr.getSession(meta.id)!.page.screenshotClip = async () => { throw new Error('Target page, context or browser has been closed') }
    const result = await mgr.captureBreakpoints(meta.id, { x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5 }, 'pend', BPS)
    expect(result).toBeNull()
    expect(mgr.getSession(meta.id)).toBeUndefined()
  })

  it('capture returns null (and kills the session) when the page is already closed', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create()
    const s = mgr.getSession(meta.id)!
    // Simulate the page dying mid-capture (dev server restart / page crash).
    s.page.screenshotClip = async () => { throw new Error('Target page, context or browser has been closed') }
    const result = await mgr.capture(meta.id, { x: 0, y: 0, width: 10, height: 10 }, 'pend')
    expect(result).toBeNull()
    expect(mgr.getSession(meta.id)).toBeUndefined()
  })

  it('clipboard copy returns the selection, paste injects, cut returns + deletes', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    const page = ctx.pages[0]
    page.selection = 'copied text'
    expect(await mgr.clipboard(meta.id, 'copy')).toEqual({ text: 'copied text' })
    await mgr.clipboard(meta.id, 'paste', 'pasted!')
    expect(page.pasted).toEqual(['pasted!'])
    const cut = await mgr.clipboard(meta.id, 'cut')
    expect(cut).toEqual({ text: 'copied text' })
    expect(page.deleted).toBe(1)
  })

  it('clipboard returns null for unknown session or after shutdown', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create()
    expect(await mgr.clipboard('nope', 'copy')).toBeNull()
    await mgr.shutdown()
    expect(await mgr.clipboard(meta.id, 'copy')).toBeNull()
  })

  it('probeElement returns the hovered element rect; null for unknown/disposed', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create()
    const probe = await mgr.probeElement(meta.id, { x: 12, y: 34 })
    expect(probe!.rect).toEqual({ x: 12, y: 34, width: 50, height: 20 })
    expect(probe!.tag).toBe('div')
    expect(probe!.path.map((p) => p.label)).toEqual(['body', 'div.box'])
    expect(await mgr.probeElement('nope', { x: 0, y: 0 })).toBeNull()
    await mgr.shutdown()
    expect(await mgr.probeElement(meta.id, { x: 0, y: 0 })).toBeNull()
  })

  it('navigateElement steps the breadcrumb to parent/child/self; null when it cannot', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create()
    const up = await mgr.navigateElement(meta.id, 'div.box', 'parent')
    expect(up!.selector).toBe('div.box parent')
    expect(up!.tag).toBe('section')
    expect(up!.path.length).toBeGreaterThan(0)
    const down = await mgr.navigateElement(meta.id, 'div.box', 'child')
    expect(down!.tag).toBe('span')
    expect(await mgr.navigateElement(meta.id, 'body', 'parent')).toBeNull() // can't go above body
    expect(await mgr.navigateElement('nope', 'div', 'self')).toBeNull()
  })

  it('kills a session, closing page + clients; unknown kill returns false', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    const ws = makeWs()
    await mgr.attach(meta.id, ws)
    expect(await mgr.kill(meta.id)).toBe(true)
    expect(ctx.pages[0].closed).toBe(true)
    expect(ws.closed).toBe(true)
    expect(mgr.getSession(meta.id)).toBeUndefined()
    expect(await mgr.kill(meta.id)).toBe(false)
  })

  it('shutdown tears down all sessions + the context and blocks further creates', async () => {
    const { mgr, ctx } = makeManager({ db })
    await mgr.create()
    await mgr.shutdown()
    expect(ctx.closed).toBe(true)
    expect(mgr.sessionCount()).toBe(0)
    await expect(mgr.create()).rejects.toBeInstanceOf(BrowserLaunchError)
    // idempotent
    await expect(mgr.shutdown()).resolves.toBeUndefined()
  })

  it('keeps the persistent context alive after killing the last session (StrictMode-safe)', async () => {
    const { mgr, ctx } = makeManager({ db })
    const meta = await mgr.create()
    await mgr.kill(meta.id)
    expect(mgr.sessionCount()).toBe(0)
    // Context is NOT closed on last-session-kill — that raced with StrictMode
    // double-mount in dev. It closes on shutdown() instead.
    expect(ctx.closed).toBe(false)
    // A subsequent create reuses the live context (no relaunch).
    await mgr.create()
    await mgr.shutdown()
    expect(ctx.closed).toBe(true)
  })

  it('shutdown closes a context whose launch was still in flight', async () => {
    let resolveCtx: (c: FakeContext) => void = () => {}
    const ctx = new FakeContext()
    const launcher: ContextLauncher = vi.fn(() => new Promise((res) => { resolveCtx = () => res(ctx) }))
    const { mgr } = makeManager({ db, launcher })
    const createPromise = mgr.create() // contextPromise now pending
    const shutdownPromise = mgr.shutdown()
    resolveCtx(ctx) // launch resolves AFTER shutdown began
    await Promise.allSettled([createPromise, shutdownPromise])
    expect(ctx.closed).toBe(true)
  })

  it('public methods are inert after shutdown', async () => {
    const { mgr } = makeManager({ db })
    const meta = await mgr.create()
    await mgr.shutdown()
    expect(await mgr.attach(meta.id, makeWs())).toBeNull()
    expect(await mgr.navigate(meta.id, 'reload')).toBeNull()
    expect(await mgr.capture(meta.id, { x: 0, y: 0, width: 5, height: 5 }, 'p')).toBeNull()
    await expect(mgr.handleInput(meta.id, { type: 'resize', width: 1, height: 1 })).resolves.toBeUndefined()
  })

  it('listSessions and getSession ignore closed sessions', async () => {
    const { mgr } = makeManager({ db })
    const a = await mgr.create()
    const b = await mgr.create()
    await mgr.kill(a.id)
    expect(mgr.listSessions().map((s) => s.id)).toEqual([b.id])
  })

  it('getLastUrl is resilient when the query fails', async () => {
    const closed = initDb(':memory:')
    closed.close()
    const { mgr } = makeManager({ db: closed })
    expect(mgr.getLastUrl()).toBeNull()
  })
})

// ─── Popup support (OAuth login windows) ───────────────────────────────────────

describe('BrowserCaptureManager popup support', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const popupMsgs = (ws: ReturnType<typeof makeWs>) =>
    ws.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as { type: string; count?: number; active?: boolean; url?: string | null })
      .filter((m) => m.type === 'popup')

  async function setup() {
    const made = makeManager({ db: initDb(':memory:') })
    const meta = await made.mgr.create()
    const ws = makeWs()
    await made.mgr.attach(meta.id, ws)
    await flush()
    return { ...made, meta, ws, root: made.ctx.pages[0] }
  }

  it('adopts a popup: inherits the viewport, reroutes the screencast, broadcasts state', async () => {
    const { mgr, meta, ws, root } = await setup()
    expect(root.screencasting).toBe(true)

    const popup = root.emitPopup()
    await flush()

    // Viewport inherited so coordinate mapping stays identical.
    expect(popup.calls).toContain('viewport:1280x800')
    // Screencast moved off the opener onto the popup (latest wins).
    expect(root.screencasting).toBe(false)
    expect(popup.screencasting).toBe(true)
    // Clients were told about the login window.
    const msgs = popupMsgs(ws)
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[msgs.length - 1]).toMatchObject({ count: 1, active: true })
    void mgr
    void meta
  })

  it('routes interactive input + clipboard to the popup; capture stays on the root page', async () => {
    const { mgr, meta, root } = await setup()
    const popup = root.emitPopup()
    await flush()

    await mgr.handleInput(meta.id, { type: 'mouse', action: 'down', x: 5, y: 5 })
    await mgr.handleInput(meta.id, { type: 'key', action: 'down', key: 'a', text: 'a' })
    expect(popup.inputs).toHaveLength(2)
    // Only the initial-resize-free root inputs: none were routed there.
    expect(root.inputs).toHaveLength(0)

    // Pasting credentials lands in the popup.
    await mgr.clipboard(meta.id, 'paste', 'hunter2')
    expect(popup.pasted).toEqual(['hunter2'])
    expect(root.pasted).toEqual([])

    // Region capture still shoots the ROOT page (the spec flow's page).
    await mgr.capture(meta.id, { x: 0, y: 0, width: 10, height: 10 }, 'pend')
    expect(root.clips).toHaveLength(1)
    expect(popup.clips).toHaveLength(0)
  })

  it('resize keeps root and popups at the same viewport', async () => {
    const { mgr, meta, root } = await setup()
    const popup = root.emitPopup()
    await flush()
    await mgr.handleInput(meta.id, { type: 'resize', width: 900, height: 600 })
    expect(root.inputs).toContainEqual({ type: 'resize', width: 900, height: 600 })
    expect(popup.inputs).toContainEqual({ type: 'resize', width: 900, height: 600 })
  })

  it('setPopupView toggles the viewed page between root and popup', async () => {
    const { mgr, meta, ws, root } = await setup()
    const popup = root.emitPopup()
    await flush()
    expect(popup.screencasting).toBe(true)

    // Back to the opener page while the popup stays alive.
    expect(mgr.setPopupView(meta.id, 'root')).toBe(true)
    await flush()
    expect(root.screencasting).toBe(true)
    expect(popup.screencasting).toBe(false)
    expect(popupMsgs(ws).pop()).toMatchObject({ count: 1, active: false })
    // Input follows the view.
    await mgr.handleInput(meta.id, { type: 'mouse', action: 'down', x: 1, y: 1 })
    expect(root.inputs).toHaveLength(1)

    // And back to the login window.
    expect(mgr.setPopupView(meta.id, 'popup')).toBe(true)
    await flush()
    expect(popup.screencasting).toBe(true)
    expect(popupMsgs(ws).pop()).toMatchObject({ count: 1, active: true })

    expect(mgr.setPopupView('nope', 'root')).toBe(false)
  })

  it('auto-returns to the opener when the popup closes (OAuth self-close)', async () => {
    const { meta, ws, root, mgr } = await setup()
    const popup = root.emitPopup()
    await flush()
    expect(popup.screencasting).toBe(true)

    popup.closeCb?.() // window.close()
    await flush()
    expect(root.screencasting).toBe(true)
    expect(popupMsgs(ws).pop()).toMatchObject({ count: 0, active: false })
    // Input is back on the root page.
    await mgr.handleInput(meta.id, { type: 'mouse', action: 'down', x: 1, y: 1 })
    expect(root.inputs).toHaveLength(1)
  })

  it('stacks popups latest-wins and falls back to the previous one on close', async () => {
    const { ws, root } = await setup()
    const p1 = root.emitPopup()
    await flush()
    const p2 = p1.emitPopup() // popups can open popups (chained IdP windows)
    await flush()

    expect(p2.screencasting).toBe(true)
    expect(p1.screencasting).toBe(false)
    expect(popupMsgs(ws).pop()).toMatchObject({ count: 2, active: true })

    p2.closeCb?.()
    await flush()
    expect(p1.screencasting).toBe(true)
    expect(popupMsgs(ws).pop()).toMatchObject({ count: 1, active: true })
  })

  it('rebroadcasts the popup URL as it walks its redirect chain', async () => {
    const { ws, root } = await setup()
    const popup = root.emitPopup()
    await flush()
    popup.url = 'https://okta.example/login'
    popup.navCb?.('https://okta.example/login')
    expect(popupMsgs(ws).pop()).toMatchObject({ count: 1, active: true, url: 'https://okta.example/login' })
  })

  it('tells a late-attaching client about the live popup', async () => {
    const { mgr, meta, root } = await setup()
    root.emitPopup()
    await flush()
    const ws2 = makeWs()
    await mgr.attach(meta.id, ws2)
    expect(popupMsgs(ws2).pop()).toMatchObject({ count: 1, active: true })
  })

  it('kill closes popups along with the session', async () => {
    const { mgr, meta, root } = await setup()
    const popup = root.emitPopup()
    await flush()
    await mgr.kill(meta.id)
    expect(popup.closed).toBe(true)
    expect(root.closed).toBe(true)
  })

  it('updates the URL bar on in-page navigation of the root page', async () => {
    const { mgr, meta, ws, root } = await setup()
    root.url = 'https://linked.dev/page'
    root.navCb?.('https://linked.dev/page')
    const navs = ws.sent
      .filter((s): s is string => typeof s === 'string')
      .map((s) => JSON.parse(s) as { type: string; url?: string })
      .filter((m) => m.type === 'nav')
    expect(navs.pop()).toMatchObject({ url: 'https://linked.dev/page' })
    expect(mgr.getSession(meta.id)?.url).toBe('https://linked.dev/page')
    expect(mgr.getLastUrl()).toBe('https://linked.dev/page')
  })
})

// ─── Shared global browser context (cookies shared across projects) ────────────

describe('BrowserCaptureManager with a shared context pool', () => {
  function makePooledManager(pool: SharedBrowserContextPool, projectSlug: string) {
    return new BrowserCaptureManager({
      projectId: `proj-${projectSlug}`,
      projectSlug,
      db: initDb(':memory:'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attachments: makeAttachments() as any,
      contextPool: pool,
    })
  }

  it('opens pages from TWO projects in the SAME shared context (shared cookies)', async () => {
    const shared = new FakeContext()
    const launcher: ContextLauncher = vi.fn(async () => shared)
    const pool = new SharedBrowserContextPool({ launcher, profileDir: '/tmp/global' })

    const mgrA = makePooledManager(pool, 'a')
    const mgrB = makePooledManager(pool, 'b')
    await mgrA.create()
    await mgrB.create()

    // One launch for the whole app, two pages in the one shared context.
    expect(launcher).toHaveBeenCalledTimes(1)
    expect(shared.pages).toHaveLength(2)
  })

  it('per-project shutdown closes only its pages, NOT the shared context', async () => {
    const shared = new FakeContext()
    const pool = new SharedBrowserContextPool({ launcher: vi.fn(async () => shared), profileDir: '/tmp/global' })

    const mgrA = makePooledManager(pool, 'a')
    const mgrB = makePooledManager(pool, 'b')
    const a = await mgrA.create()
    void a
    await mgrB.create()

    await mgrA.shutdown()
    // mgrA's page is closed; the shared context survives for mgrB + globally.
    expect(shared.closed).toBe(false)
    expect(shared.pages[0].closed).toBe(true)
    expect(shared.pages[1].closed).toBe(false)

    // The pool owner (registry) closes the shared context exactly once at the end.
    await pool.dispose()
    expect(shared.closed).toBe(true)
  })
})
