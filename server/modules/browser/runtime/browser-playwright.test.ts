import { describe, it, expect, afterEach, vi } from 'vitest'
import { isNavigableUrl, normalizeUrl, chromiumLaunchArgs, screencastParams, PlaywrightPageHandle } from './browser-playwright'
import { EventEmitter } from 'node:events'

// Pure-helper tests for the navigation SSRF/scheme guard (BUG-BROWSER-01) and the
// platform-gated sandbox args (BUG-BROWSER-04). The Playwright/CDP wiring itself
// needs a live Chromium and is excluded from coverage (see vitest.config.ts), but
// these exported helpers are deterministic and fully unit-testable.

describe('isNavigableUrl', () => {
  it('allows plain http(s) hosts', () => {
    expect(isNavigableUrl('https://example.com')).toBe(true)
    expect(isNavigableUrl('http://example.com/path?q=1')).toBe(true)
    expect(isNavigableUrl('https://sub.example.co.uk:8443/x')).toBe(true)
  })

  it('allows about:blank but no other about: target', () => {
    expect(isNavigableUrl('about:blank')).toBe(true)
    expect(isNavigableUrl('about:config')).toBe(false)
  })

  it('rejects the file:// scheme (regression: file:///etc/passwd)', () => {
    expect(isNavigableUrl('file:///etc/passwd')).toBe(false)
    expect(isNavigableUrl('FILE:///etc/passwd')).toBe(false)
  })

  it('rejects non-http(s) schemes', () => {
    expect(isNavigableUrl('data:text/html,<h1>x</h1>')).toBe(false)
    expect(isNavigableUrl('javascript:alert(1)')).toBe(false)
    expect(isNavigableUrl('chrome://settings')).toBe(false)
    expect(isNavigableUrl('ftp://example.com/x')).toBe(false)
  })

  it('blocks loopback hosts', () => {
    expect(isNavigableUrl('http://localhost/x')).toBe(false)
    expect(isNavigableUrl('http://app.localhost/x')).toBe(false)
    expect(isNavigableUrl('http://127.0.0.1/x')).toBe(false)
    expect(isNavigableUrl('http://127.5.6.7:9000/x')).toBe(false)
    expect(isNavigableUrl('http://[::1]/x')).toBe(false)
  })

  it('blocks link-local 169.254.0.0/16 (cloud metadata)', () => {
    expect(isNavigableUrl('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(isNavigableUrl('http://169.254.0.1/x')).toBe(false)
  })

  it('blocks RFC1918 private ranges', () => {
    expect(isNavigableUrl('http://10.0.0.5/x')).toBe(false)
    expect(isNavigableUrl('http://172.16.0.1/x')).toBe(false)
    expect(isNavigableUrl('http://172.31.255.255/x')).toBe(false)
    expect(isNavigableUrl('http://192.168.1.1/x')).toBe(false)
    expect(isNavigableUrl('http://0.0.0.0/x')).toBe(false)
  })

  it('does NOT block a public IP that merely starts with private-looking octets', () => {
    expect(isNavigableUrl('http://172.32.0.1/x')).toBe(true) // 172.32 is public
    expect(isNavigableUrl('http://11.0.0.1/x')).toBe(true) // 11.x is public
  })

  it('blocks IPv6 unique-local and link-local', () => {
    expect(isNavigableUrl('http://[fc00::1]/x')).toBe(false)
    expect(isNavigableUrl('http://[fd12:3456::1]/x')).toBe(false)
    expect(isNavigableUrl('http://[fe80::1]/x')).toBe(false)
  })

  it('blocks IPv4-mapped IPv6 loopback/private', () => {
    expect(isNavigableUrl('http://[::ffff:127.0.0.1]/x')).toBe(false)
    expect(isNavigableUrl('http://[::ffff:10.0.0.1]/x')).toBe(false)
  })

  it('rejects empty / garbage input', () => {
    expect(isNavigableUrl('')).toBe(false)
    expect(isNavigableUrl('   ')).toBe(false)
    expect(isNavigableUrl('not a url')).toBe(false)
    // @ts-expect-error — exercising the runtime null guard
    expect(isNavigableUrl(null)).toBe(false)
  })
})

describe('normalizeUrl', () => {
  it('upgrades a bare host to https', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
  })

  it('returns about:blank for empty input', () => {
    expect(normalizeUrl('')).toBe('about:blank')
    expect(normalizeUrl('   ')).toBe('about:blank')
  })

  it('passes through a valid http(s) URL untouched', () => {
    expect(normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })

  it('collapses a blocked URL to about:blank instead of forwarding it to Chromium', () => {
    expect(normalizeUrl('file:///etc/passwd')).toBe('about:blank')
    expect(normalizeUrl('http://169.254.169.254/latest/')).toBe('about:blank')
    expect(normalizeUrl('http://127.0.0.1:9000/admin')).toBe('about:blank')
    expect(normalizeUrl('javascript:alert(1)')).toBe('about:blank')
  })

  it('still allows about:blank passthrough', () => {
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })
})

describe('chromiumLaunchArgs (BUG-BROWSER-04)', () => {
  const original = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: original })
    vi.restoreAllMocks()
  })

  function setPlatform(p: NodeJS.Platform) {
    Object.defineProperty(process, 'platform', { value: p })
  }

  it('keeps the sandbox enabled on macOS (no --no-sandbox)', () => {
    setPlatform('darwin')
    const args = chromiumLaunchArgs()
    expect(args).not.toContain('--no-sandbox')
    expect(args).toContain('--disable-dev-shm-usage')
  })

  it('keeps the sandbox enabled on Windows (no --no-sandbox)', () => {
    setPlatform('win32')
    expect(chromiumLaunchArgs()).not.toContain('--no-sandbox')
  })

  it('falls back to --no-sandbox on Linux only', () => {
    setPlatform('linux')
    expect(chromiumLaunchArgs()).toContain('--no-sandbox')
  })

  it('allows acceleration by default with an explicit software-rendering opt-out', () => {
    expect(chromiumLaunchArgs({})).not.toContain('--disable-gpu')
    expect(chromiumLaunchArgs({ SPECRAILS_BROWSER_DISABLE_GPU: 'true' })).toContain('--disable-gpu')
    expect(chromiumLaunchArgs({ SPECRAILS_BROWSER_DISABLE_GPU: 'false' })).not.toContain('--disable-gpu')
  })
})

describe('PlaywrightPageHandle CDP lifecycle', () => {
  function session() {
    const listeners = new Map<string, (event: any) => void>()
    return { send: vi.fn(async (_method: string, _params?: unknown): Promise<any> => ({})), detach: vi.fn(async () => {}), on: vi.fn((type: string, cb: (event: any) => void) => listeners.set(type, cb)), listeners }
  }
  function setup(sessions = [session()]) {
    const newCDPSession = vi.fn()
    for (const cdp of sessions) newCDPSession.mockResolvedValueOnce(cdp)
    const page = { context: () => ({ newCDPSession }), setViewportSize: vi.fn(async () => {}), close: vi.fn(async () => {}), screenshot: vi.fn(async () => Buffer.from('fallback')) }
    return { page, newCDPSession, handle: new PlaywrightPageHandle(page) }
  }

  it('cleans up a failed start and can start again, ignoring old-session frames', async () => {
    const failed = session(), live = session()
    failed.send.mockImplementation(async (method) => { if (method === 'Page.startScreencast') throw new Error('transient'); return {} })
    const { handle } = setup([failed, live])
    const onFrame = vi.fn()
    await expect(handle.startScreencast(onFrame)).rejects.toThrow('transient')
    expect(failed.detach).toHaveBeenCalledOnce()
    await handle.startScreencast(onFrame)
    const frame = { data: Buffer.from('jpeg').toString('base64'), sessionId: 1, metadata: { deviceWidth: 10, deviceHeight: 20 } }
    failed.listeners.get('Page.screencastFrame')!(frame)
    expect(onFrame).not.toHaveBeenCalled()
    live.listeners.get('Page.screencastFrame')!(frame)
    expect(onFrame).toHaveBeenCalledWith({ data: Buffer.from('jpeg'), width: 10, height: 20 })
    await handle.stopScreencast()
    expect(live.detach).toHaveBeenCalledOnce()
  })

  it('a CDP session-creation failure does not poison future starts', async () => {
    const live = session()
    const { handle, newCDPSession } = setup([])
    newCDPSession.mockRejectedValueOnce(new Error('attach failed')).mockResolvedValueOnce(live)
    await expect(handle.startScreencast(vi.fn())).rejects.toThrow('attach failed')
    await handle.startScreencast(vi.fn())
    expect(live.send).toHaveBeenCalledWith('Page.startScreencast', expect.any(Object))
    await handle.close()
  })

  it('close waits for an in-flight start and detaches its eventual session', async () => {
    const live = session()
    let resolve!: (cdp: typeof live) => void
    const { handle, newCDPSession, page } = setup([])
    newCDPSession.mockReturnValue(new Promise((done) => { resolve = done }))
    const start = handle.startScreencast(vi.fn())
    const close = handle.close()
    resolve(live)
    await Promise.all([start, close])
    expect(live.detach).toHaveBeenCalledOnce()
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('keeps the interactive viewport unchanged and renders Retina crops with CSS scroll coordinates', async () => {
    const cdp = session()
    cdp.send.mockImplementation(async (method) => method === 'Page.getLayoutMetrics'
      ? { cssVisualViewport: { pageX: 10, pageY: 400 } }
      : { data: Buffer.from('PNG').toString('base64') })
    const { handle, page, newCDPSession } = setup([cdp])
    await handle.setViewport(1280, 800, 2)
    expect(newCDPSession).not.toHaveBeenCalled()
    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 800 })
    expect(await handle.screenshotClip({ x: 20, y: 30, width: 100, height: 50 })).toEqual(Buffer.from('PNG'))
    expect(cdp.send).toHaveBeenCalledWith('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 30, y: 430, width: 100, height: 50, scale: 2 } })
    // Temporary responsive-breakpoint resizing keeps the display's density.
    await handle.setViewport(375, 667)
    await handle.screenshotClip({ x: 0, y: 0, width: 10, height: 10 })
    expect(cdp.send).toHaveBeenLastCalledWith('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 10, y: 400, width: 10, height: 10, scale: 2 } })
    expect(cdp.send.mock.calls.every(([method]) => !method.startsWith('Emulation.'))).toBe(true)
    await handle.close()
  })

  it('releases a failed capture session and retries without changing the interactive viewport', async () => {
    const failed = session(), live = session()
    failed.send.mockRejectedValue(new Error('capture failed'))
    live.send.mockResolvedValue({ data: Buffer.from('recovered PNG').toString('base64') })
    const { handle, page } = setup([failed, live])
    await handle.setViewport(1000, 600, 2)
    await expect(handle.screenshotClip({ x: 0, y: 0, width: 10, height: 10 })).rejects.toThrow('capture failed')
    expect(failed.detach).toHaveBeenCalledOnce()
    expect(page.setViewportSize).toHaveBeenCalledExactlyOnceWith({ width: 1000, height: 600 })
    expect(await handle.screenshotClip({ x: 0, y: 0, width: 10, height: 10 })).toEqual(Buffer.from('recovered PNG'))
    await handle.close()
  })

  it('serializes resize and conflates intermediate dimensions while preserving the newest DPR', async () => {
    const cdp = session()
    const { handle, page } = setup([cdp])
    let release!: () => void
    page.setViewportSize.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    const first = handle.setViewport(1280, 800, 2)
    const intermediate = handle.setViewport(1000, 700, 2)
    const newest = handle.setViewport(900, 600, 1)
    release()
    await Promise.all([first, intermediate, newest])
    expect(page.setViewportSize.mock.calls).toEqual([[{ width: 1280, height: 800 }], [{ width: 900, height: 600 }]])
    expect(cdp.send).not.toHaveBeenCalled()
    expect(await handle.screenshotClip({ x: 0, y: 0, width: 10, height: 10 })).toEqual(Buffer.from('fallback'))
    await handle.close()
  })
})

describe('PlaywrightPageHandle popup lifecycle', () => {
  function setup() {
    const context = Object.assign(new EventEmitter(), { pages: () => pages })
    const pages: any[] = []
    const makePage = (opener?: any) => {
      const page = Object.assign(new EventEmitter(), {
        context: () => context,
        opener: vi.fn(async () => opener ?? null),
        isClosed: vi.fn(() => false),
        url: () => 'about:blank',
      })
      pages.push(page)
      return page
    }
    const page = makePage()
    return { page, context, makePage, handle: new PlaywrightPageHandle(page) }
  }

  it('recovers children created before their opener listener is attached, without adopting another session', async () => {
    const { page, context, makePage, handle } = setup()
    const existing = makePage(page)
    const otherRoot = makePage()
    makePage(otherRoot)
    const onPopup = vi.fn()
    handle.onPopup(onPopup)
    await vi.waitFor(() => expect(onPopup).toHaveBeenCalledOnce())
    context.emit('page', existing)
    page.emit('popup', existing)
    await Promise.resolve()
    expect(onPopup).toHaveBeenCalledOnce()
  })

  it('ignores closed popups and an opener lookup completed after the opener closed', async () => {
    const { page, context, makePage, handle } = setup()
    const onPopup = vi.fn()
    handle.onPopup(onPopup)
    const closed = makePage(page)
    closed.isClosed.mockReturnValue(true)
    page.emit('popup', closed)
    const late = makePage(page)
    let resolve!: (value: any) => void
    late.opener.mockReturnValue(new Promise((done) => { resolve = done }))
    context.emit('page', late)
    page.emit('close')
    resolve(page)
    await Promise.resolve()
    expect(onPopup).not.toHaveBeenCalled()
    expect(context.listenerCount('page')).toBe(0)
    expect(page.listenerCount('popup')).toBe(0)
  })

  it('delivers a close registered after window.close exactly once', async () => {
    const { page, handle } = setup()
    page.isClosed.mockReturnValue(true)
    const onClose = vi.fn()
    handle.onClose(onClose)
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce())
    page.emit('close')
    expect(onClose).toHaveBeenCalledOnce()
  })
})

describe('screencastParams', () => {
  it('defaults to JPEG q70, every frame, with guard caps', () => {
    const p = screencastParams({})
    expect(p).toEqual({ format: 'jpeg', quality: 70, everyNthFrame: 1, maxWidth: 3840, maxHeight: 2400 })
  })

  it('honours SPECRAILS_BROWSER_SCREENCAST_QUALITY', () => {
    expect(screencastParams({ SPECRAILS_BROWSER_SCREENCAST_QUALITY: '55' }).quality).toBe(55)
  })

  it('clamps quality into [1, 100] and rounds', () => {
    expect(screencastParams({ SPECRAILS_BROWSER_SCREENCAST_QUALITY: '0' }).quality).toBe(1)
    expect(screencastParams({ SPECRAILS_BROWSER_SCREENCAST_QUALITY: '-10' }).quality).toBe(1)
    expect(screencastParams({ SPECRAILS_BROWSER_SCREENCAST_QUALITY: '250' }).quality).toBe(100)
    expect(screencastParams({ SPECRAILS_BROWSER_SCREENCAST_QUALITY: '64.6' }).quality).toBe(65)
  })

  it('falls back to the default on a non-numeric or empty value', () => {
    expect(screencastParams({ SPECRAILS_BROWSER_SCREENCAST_QUALITY: 'high' }).quality).toBe(70)
    expect(screencastParams({ SPECRAILS_BROWSER_SCREENCAST_QUALITY: '' }).quality).toBe(70)
  })
})
