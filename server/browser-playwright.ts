// Real Playwright/CDP implementation of the browser-capture abstractions.
//
// This is the ONLY module that imports `playwright`. It is excluded from coverage
// (see vitest.config.ts) because every branch requires a live Chromium — the unit
// tests drive `BrowserCaptureManager` through a fake `ContextLauncher` instead.
//
// Screencast uses CDP (`Page.startScreencast`) since Playwright exposes no
// screencast API; input + screenshot + DOM use Playwright's high-level page API.

import type {
  BrowserContextHandle,
  BrowserPageHandle,
  BrowserInputEvent,
  CaptureRect,
  CapturedDom,
  ContextLauncher,
  ElementProbe,
  ScreencastFrame,
} from './browser-capture-types'
import { resolveBundledChromiumExecutable } from './chromium-resolver'
import { NetworkRingBuffer, sketchJsonShape } from './browser-network'

/**
 * Centralized SSRF / scheme guard for EVERY navigation path (WS `navigate`, REST
 * `navigate`, REST create `initialUrl`). Returns true only for an `http`/`https`
 * URL whose host is NOT a private / loopback / link-local address. `about:blank`
 * is always allowed (the harmless empty page). Everything else — `file://`,
 * `data:`, `chrome://`, link-local `169.254.0.0/16`, loopback `127.0.0.0/8` /
 * `::1`, RFC1918 `10/8` / `172.16/12` / `192.168/16` — is rejected.
 *
 * This is intentionally conservative: a host that fails to parse, or a literal
 * IP in a blocked range, is rejected. DNS-name hosts that *resolve* to a private
 * IP are out of scope here (we don't resolve at navigate time); the loopback
 * server bind + token-gated upgrade are the primary control — this is the
 * defense-in-depth scheme + literal-IP block called out in BUG-BROWSER-01.
 */
export function isNavigableUrl(raw: string): boolean {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return false
  if (trimmed === 'about:blank') return true
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
  if (isBlockedHost(host)) return false
  return true
}

/** True when a literal host string is a loopback / private / link-local address. */
function isBlockedHost(host: string): boolean {
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  // IPv6 loopback + IPv4-mapped/embedded forms.
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') return true
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/i.test(host)) return true
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — fall through to the IPv4 check on the tail.
  // The WHATWG URL parser also normalises the dotted tail into hex
  // (`::ffff:7f00:1`), so decode that hextet form back to dotted quads too.
  const mappedDotted = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i)
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  let ipv4 = host
  if (mappedDotted) {
    ipv4 = mappedDotted[1]
  } else if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127) return true // 127.0.0.0/8 loopback
    if (a === 10) return true // 10.0.0.0/8
    if (a === 169 && b === 254) return true // 169.254.0.0/16 link-local
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true // 192.168.0.0/16
    if (a === 0) return true // 0.0.0.0/8 "this host"
  }
  return false
}

/**
 * CDP `Page.startScreencast` parameters, centralised and env-tunable.
 *
 * - `quality` (JPEG, default 70) can be tuned via
 *   `SPECRAILS_BROWSER_SCREENCAST_QUALITY` (clamped to [1, 100]; non-numeric
 *   values fall back to the default). Lower = smaller frames = higher fps on
 *   slow links; higher = crisper at more bandwidth/decode cost.
 * - `everyNthFrame: 1` — never skip source frames; the client-side pipeline
 *   drops stale frames instead (newest-wins), which keeps latency minimal.
 * - `maxWidth`/`maxHeight` are a GUARD, not a scaler: the session viewport is
 *   sized to the displayed canvas (fit mode) or a device preset, so frames are
 *   already ≤ display size. The caps only prevent a pathological viewport from
 *   producing multi-megabyte frames. Chromium preserves aspect when clamping.
 */
export function screencastParams(env: NodeJS.ProcessEnv = process.env): {
  format: 'jpeg'
  quality: number
  everyNthFrame: number
  maxWidth: number
  maxHeight: number
} {
  let quality = 70
  const raw = env.SPECRAILS_BROWSER_SCREENCAST_QUALITY
  if (raw !== undefined && raw !== '') {
    const n = Number(raw)
    if (Number.isFinite(n)) quality = Math.min(100, Math.max(1, Math.round(n)))
  }
  return { format: 'jpeg', quality, everyNthFrame: 1, maxWidth: 3840, maxHeight: 2400 }
}

/**
 * Normalize a user-supplied address into a safe, navigable URL. A bare host
 * (`example.com`) is upgraded to `https://`. The result is then validated by
 * `isNavigableUrl`; anything that fails the SSRF/scheme guard collapses to
 * `about:blank` so a blocked navigation never reaches Chromium.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return 'about:blank'
  let candidate: string
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('about:')) {
    candidate = trimmed
  } else {
    candidate = `https://${trimmed}`
  }
  return isNavigableUrl(candidate) ? candidate : 'about:blank'
}

class PlaywrightPageHandle implements BrowserPageHandle {
  // `page` and `cdp` are deliberately `any` — we don't want a hard type-level
  // dependency on playwright's exported types leaking through the abstraction.
  private cdp: any = null
  private screencastHandler: ((frame: ScreencastFrame) => void) | null = null
  // A dedicated, long-lived CDP session for the Network domain — kept SEPARATE
  // from `cdp` (which is attached/detached around screencast) so request capture
  // survives screencast toggles.
  private netCdp: any = null
  private netEnabled = false
  private readonly netBuffer = new NetworkRingBuffer()
  // Last position the page's virtual mouse was moved to. Lets the wheel path skip
  // the redundant `mouse.move` a scroll gesture would otherwise re-issue for
  // every tick at the same cursor position (halves the CDP commands per wheel).
  private lastMouse: { x: number; y: number } | null = null

  constructor(private readonly page: any) {}

  private async navResult(): Promise<{ url: string; title: string }> {
    let title = ''
    try { title = await this.page.title() } catch { /* about:blank etc */ }
    return { url: this.page.url(), title }
  }

  async goto(url: string): Promise<{ url: string; title: string }> {
    try {
      await this.page.goto(normalizeUrl(url), { waitUntil: 'domcontentloaded', timeout: 30_000 })
    } catch {
      // A failed navigation (bad host, timeout) should not crash the session — the
      // user just sees whatever the page settled on.
    }
    return this.navResult()
  }

  async goBack(): Promise<{ url: string; title: string }> {
    try { await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 30_000 }) } catch { /* no history */ }
    return this.navResult()
  }

  async goForward(): Promise<{ url: string; title: string }> {
    try { await this.page.goForward({ waitUntil: 'domcontentloaded', timeout: 30_000 }) } catch { /* no history */ }
    return this.navResult()
  }

  async reload(): Promise<{ url: string; title: string }> {
    try { await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }) } catch { /* ignore */ }
    return this.navResult()
  }

  currentUrl(): string {
    return this.page.url()
  }

  async currentTitle(): Promise<string> {
    try { return await this.page.title() } catch { return '' }
  }

  async setViewport(width: number, height: number): Promise<void> {
    try { await this.page.setViewportSize({ width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) }) } catch { /* ignore */ }
  }

  async dispatchInput(event: BrowserInputEvent): Promise<void> {
    try {
      if (event.type === 'mouse') {
        if (event.action === 'move') {
          this.lastMouse = { x: event.x, y: event.y }
          await this.page.mouse.move(event.x, event.y)
        } else if (event.action === 'down') {
          await this.page.mouse.down({ button: event.button ?? 'left', clickCount: event.clickCount ?? 1 })
        } else {
          await this.page.mouse.up({ button: event.button ?? 'left', clickCount: event.clickCount ?? 1 })
        }
      } else if (event.type === 'wheel') {
        // Scroll fast-path: skip the redundant reposition when the cursor hasn't
        // moved since the last event (the common case mid-gesture), and dispatch
        // move+wheel back-to-back without a sequential await gap — the Playwright
        // driver sends commands in call order, so Chromium still sees move→wheel,
        // but a concurrent wheel can no longer interleave between the two.
        const ops: Promise<unknown>[] = []
        if (!this.lastMouse || this.lastMouse.x !== event.x || this.lastMouse.y !== event.y) {
          this.lastMouse = { x: event.x, y: event.y }
          ops.push(this.page.mouse.move(event.x, event.y))
        }
        ops.push(this.page.mouse.wheel(event.deltaX, event.deltaY))
        await Promise.all(ops)
      } else if (event.type === 'key') {
        if (event.action === 'down') {
          if (event.text && event.text.length >= 1 && [...event.text].length === 1) {
            await this.page.keyboard.insertText(event.text)
          } else {
            await this.page.keyboard.down(event.key)
          }
        } else {
          // Only release named (non-text) keys — text was inserted on down.
          if (!event.text) await this.page.keyboard.up(event.key)
        }
      } else if (event.type === 'resize') {
        await this.setViewport(event.width, event.height)
      }
    } catch {
      // Input on a navigating/closed page can throw; never let it bubble.
    }
  }

  async startScreencast(onFrame: (frame: ScreencastFrame) => void): Promise<void> {
    if (this.screencastHandler) return
    this.screencastHandler = onFrame
    const ctx = this.page.context()
    this.cdp = await ctx.newCDPSession(this.page)
    this.cdp.on('Page.screencastFrame', (evt: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } }) => {
      // Ack FIRST, fire-and-forget: Chromium throttles the screencast on unacked
      // frames, so acking before the fan-out lets it capture+compress the next
      // frame while this one is being delivered (pipeline overlap → higher fps,
      // lower frame age). The frames are independent JPEGs, so there is no
      // ordering hazard in acking early.
      try { this.cdp?.send('Page.screencastFrameAck', { sessionId: evt.sessionId })?.catch?.(() => { /* ignore */ }) } catch { /* ignore */ }
      try {
        this.screencastHandler?.({
          data: Buffer.from(evt.data, 'base64'),
          width: evt.metadata?.deviceWidth ?? 0,
          height: evt.metadata?.deviceHeight ?? 0,
        })
      } catch { /* never let a handler error kill the CDP session */ }
    })
    await this.cdp.send('Page.startScreencast', screencastParams())
  }

  async stopScreencast(): Promise<void> {
    this.screencastHandler = null
    if (this.cdp) {
      try { await this.cdp.send('Page.stopScreencast') } catch { /* ignore */ }
      try { await this.cdp.detach() } catch { /* ignore */ }
      this.cdp = null
    }
  }

  async screenshotClip(rect: CaptureRect): Promise<Buffer> {
    const clip = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    }
    return this.page.screenshot({ clip, type: 'png' })
  }

  async extractDom(rect: CaptureRect, htmlByteCap: number): Promise<CapturedDom> {
    // We can't pass `domExtractScript` directly to page.evaluate: under tsx/esbuild
    // `keepNames` the compiled function body references a module-local `__name`
    // helper that doesn't exist in the page context (→ "ReferenceError: __name is
    // not defined"). Serialise the function to source and run it inside a wrapper
    // that defines a no-op `__name`, so it works under both tsx (dev) and the
    // esbuild sidecar bundle. Args are JSON-inlined (no external refs needed).
    const arg = { rect, htmlByteCap }
    const src = `(() => { const __name = (f) => f; return (${domExtractScript.toString()})(${JSON.stringify(arg)}); })()`
    const raw = (await this.page.evaluate(src)) as ReturnType<typeof domExtractScript>
    return {
      url: this.page.url(),
      title: await this.currentTitle(),
      viewport: raw.viewport,
      rect,
      html: raw.html,
      htmlTruncated: raw.htmlTruncated,
      css: raw.css,
      cssTruncated: raw.cssTruncated,
      nodes: raw.nodes,
      designTokens: raw.designTokens,
      capturedAt: new Date().toISOString(),
    }
  }

  async probeElementAt(point: { x: number; y: number }): Promise<ElementProbe | null> {
    return this.runProbe({ point })
  }

  async navigateElement(selector: string, direction: 'parent' | 'child' | 'self'): Promise<ElementProbe | null> {
    return this.runProbe({ selector, direction })
  }

  private async runProbe(arg: { point?: { x: number; y: number }; selector?: string; direction?: 'parent' | 'child' | 'self' }): Promise<ElementProbe | null> {
    try {
      // Serialise with the `__name` shim (same pattern as extractDom) so the inner
      // const-arrow helpers survive esbuild keepNames in the page context.
      const src = `(() => { const __name = (f) => f; return (${probeScript.toString()})(${JSON.stringify(arg)}); })()`
      return (await this.page.evaluate(src)) as ElementProbe | null
    } catch {
      return null
    }
  }

  async enableNetwork(): Promise<void> {
    if (this.netEnabled) return
    this.netEnabled = true
    try {
      const ctx = this.page.context()
      this.netCdp = await ctx.newCDPSession(this.page)
      await this.netCdp.send('Network.enable', { maxResourceBufferSize: 5_000_000, maxTotalBufferSize: 10_000_000 })
      this.netCdp.on('Network.requestWillBeSent', (e: any) => {
        try {
          this.netBuffer.start(e.requestId, {
            method: e.request?.method ?? 'GET',
            url: e.request?.url ?? '',
            resourceType: e.type ?? 'Other',
            startedAt: Date.now(),
            requestBodyShape: e.request?.postData ? sketchJsonShape(e.request.postData) : null,
          })
        } catch { /* never let a network event bubble */ }
      })
      this.netCdp.on('Network.responseReceived', (e: any) => {
        try {
          this.netBuffer.response(e.requestId, { status: e.response?.status ?? 0, mimeType: e.response?.mimeType ?? null })
        } catch { /* ignore */ }
      })
      this.netCdp.on('Network.loadingFinished', (e: any) => {
        try {
          this.netBuffer.finish(e.requestId, { finishedAt: Date.now() })
          // Sketch JSON response shapes only, body under a cap, fully guarded.
          if (this.netBuffer.wantsBodySketch(e.requestId)) void this.sketchResponseBody(e.requestId)
        } catch { /* ignore */ }
      })
      this.netCdp.on('Network.loadingFailed', (e: any) => {
        try { this.netBuffer.fail(e.requestId, { finishedAt: Date.now(), errorText: e.errorText }) } catch { /* ignore */ }
      })
    } catch {
      // Network capture is best-effort — a failure here never breaks the session.
      this.netEnabled = false
    }
  }

  private async sketchResponseBody(requestId: string): Promise<void> {
    if (!this.netCdp) return
    try {
      const res = await this.netCdp.send('Network.getResponseBody', { requestId })
      if (!res || res.base64Encoded) return // binary — skip
      const body = typeof res.body === 'string' ? res.body : ''
      const shape = sketchJsonShape(body)
      if (shape) this.netBuffer.setResponseShape(requestId, shape)
    } catch {
      // The body may already be evicted / unavailable — degrade to no shape.
    }
  }

  recentNetwork(sinceMs: number) {
    return this.netBuffer.recent(sinceMs)
  }

  async resolveAnchorSelector(point: { x: number; y: number }): Promise<string | null> {
    try {
      return await this.page.evaluate((p: { x: number; y: number }) => {
        const el = document.elementFromPoint(p.x, p.y)
        if (!el) return null
        const esc = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'))
        const target = el as HTMLElement
        if (target.id) return '#' + esc(target.id)
        const testid = target.getAttribute('data-testid')
        if (testid) return `[data-testid="${testid.replace(/"/g, '\\"')}"]`
        const parts: string[] = []
        let node: Element | null = el
        let depth = 0
        while (node && node.nodeType === 1 && node !== document.body && depth < 6) {
          const tag = node.tagName.toLowerCase()
          const parent: Element | null = node.parentElement
          if (!parent) { parts.unshift(tag); break }
          const sameTag = Array.from(parent.children).filter((c) => c.tagName === (node as Element).tagName)
          const idx = sameTag.indexOf(node) + 1
          parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${idx})` : tag)
          node = parent
          depth++
        }
        return parts.length ? parts.join(' > ') : null
      }, point)
    } catch {
      return null
    }
  }

  async resolveAnchorRect(selector: string): Promise<CaptureRect | null> {
    try {
      return await this.page.evaluate((sel: string) => {
        const el = document.querySelector(sel)
        if (!el) return null
        // Bring it into view so a below-the-fold element at this breakpoint yields
        // an on-screen rect (instant scroll → getBoundingClientRect reflects it).
        try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch { /* ignore */ }
        const b = el.getBoundingClientRect()
        if (b.width <= 0 || b.height <= 0) return null
        return { x: b.x, y: b.y, width: b.width, height: b.height }
      }, selector)
    } catch {
      return null
    }
  }

  async waitForStable(): Promise<void> {
    try {
      await this.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
    } catch { /* ignore */ }
    // A small extra settle for late reflow / lazy-loaded images / web fonts.
    try { await this.page.waitForTimeout?.(120) } catch { /* ignore */ }
  }

  onPopup(cb: (popup: BrowserPageHandle) => void): void {
    // Playwright fires 'popup' for pages this page opens (window.open,
    // target=_blank, OAuth login windows). The popup lives in the SAME browser
    // context — cookies and the window.opener/postMessage relationship are
    // intact, which is exactly what an OAuth redirect/popup flow needs.
    //
    // HARDENING (Okta-class IdPs): a popup opened from a cross-origin IFRAME
    // (out-of-process sign-in widgets) is attributed to the iframe's target,
    // and the page-level 'popup' event can miss it — the login window then
    // "never appears". So we ALSO watch the shared context for new pages whose
    // opener chain resolves to this page and adopt those. `seen` dedupes the
    // two doors; pages from other sessions have a different opener and are
    // ignored.
    try {
      const seen = new WeakSet<object>()
      const adopt = (p: any) => {
        if (seen.has(p)) return
        seen.add(p)
        try { cb(new PlaywrightPageHandle(p)) } catch { /* never break the event loop */ }
      }
      this.page.on('popup', adopt)
      const ctx = this.page.context?.()
      if (ctx?.on) {
        const onContextPage = (p: any) => {
          void (async () => {
            try {
              if (seen.has(p) || p === this.page) return
              const opener = await p.opener?.()
              if (opener === this.page) adopt(p)
            } catch { /* ignore */ }
          })()
        }
        ctx.on('page', onContextPage)
        // The shared context outlives this page — detach on page close so a
        // long-lived app never accumulates dead listeners.
        this.page.on('close', () => {
          try { ctx.off?.('page', onContextPage) } catch { /* ignore */ }
        })
      }
    } catch { /* ignore */ }
  }

  onClose(cb: () => void): void {
    try {
      this.page.on('close', () => {
        try { cb() } catch { /* ignore */ }
      })
    } catch { /* ignore */ }
  }

  onNavigated(cb: (url: string) => void): void {
    try {
      this.page.on('framenavigated', (frame: any) => {
        try {
          if (frame === this.page.mainFrame()) cb(frame.url())
        } catch { /* ignore */ }
      })
    } catch { /* ignore */ }
  }

  async getSelectionText(): Promise<string> {
    try {
      return await this.page.evaluate(() => window.getSelection()?.toString() ?? '')
    } catch {
      return ''
    }
  }

  async insertText(text: string): Promise<void> {
    try { await this.page.keyboard.insertText(text) } catch { /* ignore */ }
  }

  async deleteSelection(): Promise<void> {
    try { await this.page.keyboard.press('Delete') } catch { /* ignore */ }
  }

  async close(): Promise<void> {
    await this.stopScreencast()
    if (this.netCdp) {
      try { await this.netCdp.send('Network.disable') } catch { /* ignore */ }
      try { await this.netCdp.detach() } catch { /* ignore */ }
      this.netCdp = null
    }
    try { await this.page.close() } catch { /* ignore */ }
  }
}

// Serialised into the page via page.evaluate. Self-contained: no closures over
// Node scope. Returns the html + nodes; the Node side stamps url/title/time.
function domExtractScript(arg: { rect: CaptureRect; htmlByteCap: number }): {
  viewport: { width: number; height: number }
  html: string
  htmlTruncated: boolean
  css: string
  cssTruncated: boolean
  nodes: Array<{
    tag: string
    role: string | null
    text: string | null
    rect: { x: number; y: number; width: number; height: number }
    attributes: Record<string, string>
    styles: Record<string, string>
  }>
  designTokens?: {
    contractVersion: number
    anchor: Record<string, string>
    byTag: Record<string, Record<string, string>>
    palette: string[]
    fonts: string[]
  }
} {
  const { rect, htmlByteCap } = arg
  const NODE_CAP = 60
  const CSS_CAP = 60_000
  const TEXT_CAP = 240

  const implicitRole = (el: Element): string | null => {
    const tag = el.tagName.toLowerCase()
    const map: Record<string, string> = {
      a: (el as HTMLAnchorElement).getAttribute('href') ? 'link' : 'generic',
      button: 'button',
      nav: 'navigation',
      header: 'banner',
      footer: 'contentinfo',
      main: 'main',
      h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
      img: 'img',
      ul: 'list', ol: 'list', li: 'listitem',
      table: 'table', tr: 'row', td: 'cell', th: 'columnheader',
      select: 'combobox', textarea: 'textbox',
      form: 'form', label: 'label', section: 'region', article: 'article',
    }
    if (tag === 'input') {
      const t = (el as HTMLInputElement).type
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'button' || t === 'submit') return 'button'
      return 'textbox'
    }
    return el.getAttribute('role') || map[tag] || null
  }

  const collectAttrs = (el: Element): Record<string, string> => {
    const out: Record<string, string> = {}
    const keep = new Set(['id', 'class', 'name', 'href', 'src', 'type', 'placeholder', 'alt', 'title', 'value', 'aria-label'])
    for (const a of Array.from(el.attributes)) {
      if (keep.has(a.name) || a.name.startsWith('aria-') || a.name.startsWith('data-')) {
        out[a.name] = a.value.slice(0, 200)
      }
    }
    return out
  }

  const STYLE_KEYS = ['display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily', 'padding', 'margin', 'border', 'borderRadius', 'textAlign']
  const collectStyles = (el: Element): Record<string, string> => {
    const cs = window.getComputedStyle(el)
    const out: Record<string, string> = {}
    for (const k of STYLE_KEYS) {
      const v = cs.getPropertyValue(k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())) || (cs as unknown as Record<string, string>)[k]
      if (v) out[k] = String(v).slice(0, 120)
    }
    return out
  }

  // ─── Design tokens: exact computed values for "clone this UI" specs ───────────
  // getComputedStyle does not reliably populate the `border`/`borderRadius`/
  // `padding`/`margin` shorthands, so we read the longhands and recompose. All
  // helpers are `const` arrows (no inner named functions) so esbuild/tsx don't
  // inject the `__name` helper that breaks page.evaluate (see extractDom).
  const SIDES = ['top', 'right', 'bottom', 'left']
  const collapse4 = (vals: string[]): string => {
    const [t, r, b, l] = vals
    if (t === r && r === b && b === l) return t
    if (t === b && r === l) return `${t} ${r}`
    return vals.join(' ')
  }
  const tokenSetFor = (el: Element): Record<string, string> => {
    const cs = window.getComputedStyle(el)
    const g = (p: string): string => cs.getPropertyValue(p) || ''
    const out: Record<string, string> = {}
    const setIf = (k: string, v: string, drop: string[]) => {
      const t = String(v).trim()
      if (t && !drop.includes(t)) out[k] = t.slice(0, 240)
    }
    setIf('color', g('color'), ['rgba(0, 0, 0, 0)'])
    setIf('backgroundColor', g('background-color'), ['rgba(0, 0, 0, 0)', 'transparent'])
    setIf('fontFamily', g('font-family'), [])
    setIf('fontSize', g('font-size'), [])
    setIf('fontWeight', g('font-weight'), [])
    setIf('lineHeight', g('line-height'), ['normal'])
    setIf('letterSpacing', g('letter-spacing'), ['normal'])
    setIf('padding', collapse4(SIDES.map((s) => g('padding-' + s))), ['0px'])
    setIf('margin', collapse4(SIDES.map((s) => g('margin-' + s))), ['0px'])
    const bw = g('border-top-width')
    const bsStyle = g('border-top-style')
    const widthsUniform = SIDES.every((s) => g('border-' + s + '-width') === bw)
    const stylesUniform = SIDES.every((s) => g('border-' + s + '-style') === bsStyle)
    if (bsStyle && bsStyle !== 'none' && bw && bw !== '0px' && widthsUniform && stylesUniform) {
      setIf('border', `${bw} ${bsStyle} ${g('border-top-color')}`, [])
    }
    const radii = ['top-left', 'top-right', 'bottom-right', 'bottom-left'].map((c) => g('border-' + c + '-radius'))
    setIf('borderRadius', collapse4(radii), ['0px'])
    setIf('boxShadow', g('box-shadow'), ['none'])
    return out
  }
  const deriveDesignTokens = (anchorEl: Element, els: Element[]) => {
    const anchor = tokenSetFor(anchorEl)
    const tagCount: Record<string, number> = {}
    for (const el of els) { const t = el.tagName.toLowerCase(); tagCount[t] = (tagCount[t] || 0) + 1 }
    const topTags = Object.keys(tagCount).sort((a, b) => tagCount[b] - tagCount[a]).slice(0, 8)
    const byTag: Record<string, Record<string, string>> = {}
    for (const t of topTags) {
      const el = els.find((e) => e.tagName.toLowerCase() === t)
      if (el) byTag[t] = tokenSetFor(el)
    }
    const palette: string[] = []
    const fonts: string[] = []
    const consider = (ts: Record<string, string>) => {
      for (const v of [ts.color, ts.backgroundColor]) {
        if (v && !palette.includes(v) && palette.length < 12) palette.push(v)
      }
      if (ts.fontFamily && !fonts.includes(ts.fontFamily) && fonts.length < 6) fonts.push(ts.fontFamily)
    }
    consider(anchor)
    for (const t of Object.keys(byTag)) consider(byTag[t])
    return { contractVersion: 1, anchor, byTag, palette, fonts }
  }

  // Sample a grid of points across the selection to discover candidate elements.
  const candidates = new Set<Element>()
  const cols = 5, rows = 5
  for (let i = 0; i <= cols; i++) {
    for (let j = 0; j <= rows; j++) {
      const px = rect.x + (rect.width * i) / cols
      const py = rect.y + (rect.height * j) / rows
      const stack = document.elementsFromPoint(px, py)
      if (stack && stack.length > 0) candidates.add(stack[0])
    }
  }

  // Container = smallest element whose box contains the whole selection rect.
  const rectRight = rect.x + rect.width
  const rectBottom = rect.y + rect.height
  let container: Element = document.body
  let containerArea = Infinity
  const seedSet = candidates.size > 0 ? candidates : new Set<Element>([document.body])
  for (const seed of seedSet) {
    let el: Element | null = seed
    while (el) {
      const b = el.getBoundingClientRect()
      if (b.left <= rect.x + 1 && b.top <= rect.y + 1 && b.right >= rectRight - 1 && b.bottom >= rectBottom - 1) {
        const area = b.width * b.height
        if (area < containerArea) { containerArea = area; container = el }
        break
      }
      el = el.parentElement
    }
  }

  // Build node list: container + intersecting candidates (capped).
  const nodeEls: Element[] = []
  const pushUnique = (el: Element) => { if (!nodeEls.includes(el) && nodeEls.length < NODE_CAP) nodeEls.push(el) }
  pushUnique(container)
  for (const c of candidates) pushUnique(c)

  const nodes = nodeEls.map((el) => {
    const b = el.getBoundingClientRect()
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    return {
      tag: el.tagName.toLowerCase(),
      role: implicitRole(el),
      text: text ? text.slice(0, TEXT_CAP) : null,
      rect: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) },
      attributes: collectAttrs(el),
      styles: collectStyles(el),
    }
  })

  // Pretty-print the container subtree (scripts/styles/svg dropped) with one
  // element per line, indented by depth — readable in the panel AND clearer for
  // the AI than a single-line outerHTML. Element-with-only-text collapses to one
  // line; long attribute values (data: URIs etc.) are truncated.
  let html = ''
  let htmlTruncated = false
  try {
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
    const SKIP = new Set(['script', 'style', 'noscript', 'svg'])
    const ATTR_CAP = 200
    const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Escape < and > inside attribute values too so the client HTML tokenizer can
    // reliably split tags on '>' (a raw '>' in an attr value would break it).
    const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const lines: string[] = []
    const openTag = (el: Element) => {
      const attrs = Array.from(el.attributes).map((a) => {
        let v = a.value
        if (v.length > ATTR_CAP) v = v.slice(0, ATTR_CAP) + '…'
        return ` ${a.name}="${escAttr(v)}"`
      }).join('')
      return `<${el.tagName.toLowerCase()}${attrs}>`
    }
    const serialize = (node: Node, depth: number) => {
      const pad = '  '.repeat(depth)
      if (node.nodeType === 3) {
        const t = (node.textContent || '').replace(/\s+/g, ' ').trim()
        if (t) lines.push(pad + escText(t))
        return
      }
      if (node.nodeType !== 1) return
      const el = node as Element
      const tag = el.tagName.toLowerCase()
      if (SKIP.has(tag)) return
      if (VOID.has(tag)) { lines.push(pad + openTag(el)); return }
      const kids = Array.from(el.childNodes).filter(
        (c) => c.nodeType === 1 || (c.nodeType === 3 && !!(c.textContent || '').trim()),
      )
      if (kids.length === 0) { lines.push(`${pad}${openTag(el)}</${tag}>`); return }
      if (kids.length === 1 && kids[0].nodeType === 3) {
        const t = escText((el.textContent || '').replace(/\s+/g, ' ').trim())
        lines.push(`${pad}${openTag(el)}${t}</${tag}>`)
        return
      }
      lines.push(pad + openTag(el))
      for (const c of kids) serialize(c, depth + 1)
      lines.push(`${pad}</${tag}>`)
    }
    serialize(container, 0)
    html = lines.join('\n')
    if (html.length > htmlByteCap) {
      html = html.slice(0, htmlByteCap)
      // Trim back to the last complete tag so we never emit a half-written tag.
      const lastGt = html.lastIndexOf('>')
      if (lastGt > 0) html = html.slice(0, lastGt + 1)
      htmlTruncated = true
    }
  } catch {
    html = ''
  }

  // Collect the CSS rules that actually apply to the captured elements (plus
  // :root / html custom-property declarations for design tokens), so the AI can
  // replicate the styling instead of guessing. Same-origin stylesheets only —
  // cross-origin .cssRules access throws and is skipped. @media rules whose inner
  // rules match are kept whole. Capped.
  let css = ''
  let cssTruncated = false
  try {
    const targets = [container, ...nodeEls]
    const seen = new Set<string>()
    const out: string[] = []
    // Bound work on rule-heavy sites (matches() per target per rule).
    let budget = 12000
    const selCache = new Map<string, boolean>()
    const matchesAny = (selector: string): boolean => {
      for (const el of targets) {
        try { if (el.matches(selector)) return true } catch { /* invalid selector */ }
      }
      return false
    }
    // Memoise by selector text so repeated selectors don't re-run matches().
    const considerStyleRule = (r: CSSStyleRule): string | null => {
      const sel = r.selectorText
      if (!sel) return null
      let ok = selCache.get(sel)
      if (ok === undefined) {
        if (budget <= 0) return null
        budget--
        const isToken = /:root|(^|,)\s*html\b|(^|,)\s*\*(\s|,|$)/.test(sel)
        ok = isToken || matchesAny(sel)
        selCache.set(sel, ok)
      }
      return ok ? r.cssText : null
    }
    // The @-prefix for a conditional grouping rule (media/supports/container/layer),
    // feature-detected so we don't hard-reference constructors missing from older
    // lib typings or runtimes.
    const groupingPrefix = (rule: CSSRule): string | null => {
      const r = rule as unknown as { conditionText?: string; name?: string }
      const ctorName = (rule as { constructor?: { name?: string } }).constructor?.name
      if (ctorName === 'CSSMediaRule') return `@media ${r.conditionText ?? ''}`
      if (ctorName === 'CSSSupportsRule') return `@supports ${r.conditionText ?? ''}`
      if (ctorName === 'CSSContainerRule') return `@container ${r.conditionText ?? ''}`
      if (ctorName === 'CSSLayerBlockRule') return `@layer ${r.name ?? ''}`
      return null
    }
    const walk = (rules: CSSRuleList) => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSStyleRule) {
          const t = considerStyleRule(rule)
          if (t && !seen.has(t)) { seen.add(t); out.push(t) }
          continue
        }
        const inner = (rule as unknown as { cssRules?: CSSRuleList }).cssRules
        const prefix = groupingPrefix(rule)
        if (prefix && inner) {
          const innerMatched: string[] = []
          for (const sub of Array.from(inner)) {
            if (sub instanceof CSSStyleRule) {
              const t = considerStyleRule(sub)
              if (t) innerMatched.push(t)
            }
          }
          if (innerMatched.length > 0) {
            const block = `${prefix.trim()} {\n  ${innerMatched.join('\n  ')}\n}`
            if (!seen.has(block)) { seen.add(block); out.push(block) }
          }
        }
      }
    }
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | null = null
      try { rules = sheet.cssRules } catch { rules = null } // cross-origin — skipped
      if (rules) walk(rules)
    }
    css = out.join('\n')
    if (css.length > CSS_CAP) { css = css.slice(0, CSS_CAP); cssTruncated = true }
  } catch {
    css = ''
  }

  let designTokens
  try { designTokens = deriveDesignTokens(container, nodeEls) } catch { designTokens = undefined }

  return {
    viewport: { width: window.innerWidth, height: window.innerHeight },
    html,
    htmlTruncated,
    css,
    cssTruncated,
    nodes,
    designTokens,
  }
}

// Serialised into the page via page.evaluate (with a `__name` shim). Resolves an
// element by point or by selector (+optional parent/child step) and returns its
// rect, a stable-ish selector, and the ancestor breadcrumb root→element.
function probeScript(arg: {
  point?: { x: number; y: number }
  selector?: string
  direction?: 'parent' | 'child' | 'self'
}): {
  rect: { x: number; y: number; width: number; height: number }
  tag: string
  selector: string
  path: Array<{ label: string; selector: string }>
} | null {
  const { point, selector, direction } = arg
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])
  let el: Element | null = null
  if (point) {
    el = document.elementFromPoint(point.x, point.y)
  } else if (selector) {
    const base = document.querySelector(selector)
    if (base) {
      if (direction === 'parent') el = base.parentElement
      else if (direction === 'child') el = Array.from(base.children).find((c) => !SKIP.has(c.tagName)) ?? null
      else el = base
    }
  }
  if (el === document.documentElement) el = document.body
  if (!el || el.nodeType !== 1) return null

  const cssEsc = (s: string) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'))
  const partFor = (node: Element): string => {
    const tag = node.tagName.toLowerCase()
    const id = (node as HTMLElement).id
    if (id) return '#' + cssEsc(id)
    const parent = node.parentElement
    if (!parent) return tag
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName)
    return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag
  }
  const labelFor = (node: Element): string => {
    const tag = node.tagName.toLowerCase()
    const id = (node as HTMLElement).id
    if (id) return `${tag}#${id}`
    const cn = node.getAttribute('class')
    const first = cn ? cn.trim().split(/\s+/)[0] : ''
    return first ? `${tag}.${first}` : tag
  }

  const chain: Element[] = []
  let node: Element | null = el
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    chain.unshift(node)
    node = node.parentElement
  }
  const capped = new Set(chain.slice(Math.max(0, chain.length - 8)))
  const path: Array<{ label: string; selector: string }> = []
  let sel = ''
  for (const n of chain) {
    const part = partFor(n)
    sel = part.charAt(0) === '#' ? part : sel ? `${sel} > ${part}` : part
    if (capped.has(n)) path.push({ label: labelFor(n), selector: sel })
  }

  const b = el.getBoundingClientRect()
  return {
    rect: { x: b.x, y: b.y, width: b.width, height: b.height },
    tag: el.tagName.toLowerCase(),
    selector: sel,
    path,
  }
}

class PlaywrightContextHandle implements BrowserContextHandle {
  // A persistent context opens with one blank page. Consume it for the FIRST
  // session only; every later session gets its own fresh page. Reusing pages[0]
  // for every session made concurrent sessions (e.g. React StrictMode's
  // mount→unmount→mount double-create) share one page — killing the throwaway
  // first session then closed the page out from under the live second session.
  private usedInitial = false
  // Flipped false when the underlying Chromium dies, so the shared-context pool
  // drops this handle and re-launches instead of reusing a dead context.
  private alive = true
  constructor(private readonly context: any) {
    try { context.on('close', () => { this.alive = false }) } catch { /* ignore */ }
    try { context.browser()?.on('disconnected', () => { this.alive = false }) } catch { /* ignore */ }
  }
  isConnected(): boolean {
    return this.alive
  }
  async newPage(): Promise<BrowserPageHandle> {
    let page: any
    if (!this.usedInitial) {
      this.usedInitial = true
      const pages = this.context.pages()
      page = pages.length > 0 ? pages[0] : await this.context.newPage()
    } else {
      page = await this.context.newPage()
    }
    return new PlaywrightPageHandle(page)
  }
  async close(): Promise<void> {
    try { await this.context.close() } catch { /* ignore */ }
  }
}

/**
 * Chromium launch args. The renderer SANDBOX is kept ENABLED on macOS/Windows
 * (it works there and is the primary mitigation for navigating untrusted pages —
 * BUG-BROWSER-04). `--no-sandbox` is only added on Linux, where the namespace
 * sandbox frequently fails to initialise inside a packaged/headless app and would
 * otherwise refuse to launch. We never disable the sandbox where it functions.
 */
export function chromiumLaunchArgs(): string[] {
  const args = ['--disable-dev-shm-usage', '--disable-gpu']
  if (process.platform === 'linux') args.unshift('--no-sandbox')
  return args
}

/**
 * Build the real Playwright-backed launcher. Lazy-imports playwright so the
 * dependency is only loaded when the feature is actually used.
 */
export function createPlaywrightLauncher(): ContextLauncher {
  return async (opts) => {
    // Use CommonJS require (NOT dynamic import()): in the packaged pkg sidecar the
    // native-addon banner redirects require('playwright') to the externally-copied
    // package via _Module._load. A dynamic import() goes through Node's ESM resolver
    // instead, which can't find 'playwright' inside the /snapshot pkg vfs
    // ("Cannot find package 'playwright'"). require keeps it on the patched path.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { chromium } = require('playwright') as typeof import('playwright')
    const executablePath = opts.executablePath ?? (await resolveBundledChromiumExecutable()) ?? undefined
    const context = await chromium.launchPersistentContext(opts.userDataDir, {
      headless: true,
      executablePath,
      viewport: opts.viewport,
      args: chromiumLaunchArgs(),
    })
    return new PlaywrightContextHandle(context)
  }
}
