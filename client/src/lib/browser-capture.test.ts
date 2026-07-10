import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setActiveProjectId } from './api'
import {
  isBrowserCaptureEnabled,
  mapPointToViewport,
  rectFromPoints,
  isUsableSelection,
  clampRectToViewport,
  mapRectToDisplay,
  domSummary,
  browserWsUrl,
  createBrowserSession,
  navigateBrowser,
  captureBrowserRegion,
  captureBrowserBreakpoints,
  browserClipboard,
  navigateBrowserElement,
  uploadCaptureImage,
  killBrowserSession,
  setBrowserPopupView,
  popupOriginLabel,
  createPointerInputCoalescer,
  BrowserSessionLimitError,
  BrowserLaunchFailedError,
  type BrowserInputEvent,
  type CapturedDom,
} from './browser-capture'

function mockFetch(impl: (url: string, init?: RequestInit) => { status?: number; ok?: boolean; body?: unknown }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const r = impl(url, init)
    const status = r.status ?? 200
    return {
      ok: r.ok ?? (status >= 200 && status < 300),
      status,
      json: async () => r.body ?? {},
    } as Response
  })
}

const dom: CapturedDom = {
  url: 'https://example.com/page',
  title: 'T',
  viewport: { width: 1280, height: 800 },
  rect: { x: 0, y: 0, width: 10, height: 10 },
  html: '<button>Hi</button>',
  htmlTruncated: true,
  nodes: [{ tag: 'button', role: 'button', text: 'Hi', rect: { x: 0, y: 0, width: 1, height: 1 }, attributes: {}, styles: {} }],
  capturedAt: '2026-06-07T00:00:00.000Z',
}

describe('browser-capture lib', () => {
  beforeEach(() => { setActiveProjectId('proj-1') })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

  describe('feature flag', () => {
    it('defaults ON when the build flag is unset', () => {
      // VITE_FEATURE_BROWSER_CAPTURE is unset in the test env → default ON.
      // (The opt-out branch mirrors the established FEATURE_CODE_EXPLORER pattern;
      // import.meta.env is per-module in vitest so it can't be toggled here.)
      expect(isBrowserCaptureEnabled()).toBe(true)
    })
  })

  describe('geometry', () => {
    it('maps a pointer into viewport space and clamps to bounds', () => {
      const canvas = { left: 100, top: 50, width: 640, height: 400 }
      const viewport = { width: 1280, height: 800 }
      expect(mapPointToViewport({ x: 100, y: 50 }, canvas, viewport)).toEqual({ x: 0, y: 0 })
      expect(mapPointToViewport({ x: 420, y: 250 }, canvas, viewport)).toEqual({ x: 640, y: 400 })
      // out of bounds clamps
      expect(mapPointToViewport({ x: 5000, y: 5000 }, canvas, viewport)).toEqual({ x: 1280, y: 800 })
      expect(mapPointToViewport({ x: -100, y: -100 }, canvas, viewport)).toEqual({ x: 0, y: 0 })
    })

    it('handles a zero-width canvas without dividing by zero', () => {
      expect(mapPointToViewport({ x: 10, y: 10 }, { left: 0, top: 0, width: 0, height: 0 }, { width: 100, height: 100 })).toEqual({ x: 0, y: 0 })
    })

    it('builds a normalised rect from two points in any direction', () => {
      expect(rectFromPoints({ x: 30, y: 40 }, { x: 10, y: 10 })).toEqual({ x: 10, y: 10, width: 20, height: 30 })
    })

    it('rejects tiny selections', () => {
      expect(isUsableSelection({ x: 0, y: 0, width: 4, height: 50 })).toBe(false)
      expect(isUsableSelection({ x: 0, y: 0, width: 20, height: 20 })).toBe(true)
    })

    describe('clampRectToViewport', () => {
      const vp = { width: 1280, height: 800 }

      it('leaves an in-bounds rect unchanged', () => {
        expect(clampRectToViewport({ x: 100, y: 50, width: 200, height: 120 }, vp)).toEqual({ x: 100, y: 50, width: 200, height: 120 })
      })

      it('clamps a negative origin to 0 while preserving the far edge (the 400 cause)', () => {
        // An element that starts above/left of the viewport: x=-40,y=-10 → 0,0 with
        // the right/bottom edge preserved. parseRect would have rejected x<0/y<0.
        expect(clampRectToViewport({ x: -40, y: -10, width: 240, height: 110 }, vp)).toEqual({ x: 0, y: 0, width: 200, height: 100 })
      })

      it('caps a rect that overflows the viewport to the far edge', () => {
        expect(clampRectToViewport({ x: 1200, y: 760, width: 400, height: 400 }, vp)).toEqual({ x: 1200, y: 760, width: 80, height: 40 })
      })

      it('always yields a positive size and non-negative origin', () => {
        const out = clampRectToViewport({ x: -5, y: -5, width: 2, height: 2 }, vp)
        expect(out.x).toBeGreaterThanOrEqual(0)
        expect(out.y).toBeGreaterThanOrEqual(0)
        expect(out.width).toBeGreaterThanOrEqual(1)
        expect(out.height).toBeGreaterThanOrEqual(1)
      })
    })

    it('maps a viewport rect back to displayed canvas coordinates (inverse of point map)', () => {
      const canvas = { left: 100, top: 50, width: 640, height: 400 }
      const viewport = { width: 1280, height: 800 }
      // viewport (640,400) sits at the centre → displayed centre (100+320, 50+200)
      expect(mapRectToDisplay({ x: 640, y: 400, width: 128, height: 80 }, canvas, viewport)).toEqual({
        left: 100 + 320, top: 50 + 200, width: 64, height: 40,
      })
    })

    it('mapRectToDisplay is safe with a zero-size viewport', () => {
      expect(mapRectToDisplay({ x: 1, y: 1, width: 1, height: 1 }, { left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 }))
        .toEqual({ left: 0, top: 0, width: 0, height: 0 })
    })

    it('summarises a captured DOM', () => {
      expect(domSummary(dom)).toEqual({ nodeCount: 1, htmlBytes: dom.html.length, truncated: true, networkCount: 0 })
    })

    it('counts captured network requests', () => {
      const withNet = { ...dom, networkRequests: [
        { method: 'GET', url: 'https://api.x/a', status: 200, resourceType: 'Fetch', mimeType: 'application/json', durationMs: 1, startedAt: 0 },
        { method: 'POST', url: 'https://api.x/b', status: 201, resourceType: 'Fetch', mimeType: 'application/json', durationMs: 2, startedAt: 1 },
      ] }
      expect(domSummary(withNet).networkCount).toBe(2)
    })
  })

  describe('ws url', () => {
    it('builds the dedicated browser ws url with projectId', () => {
      expect(browserWsUrl('sess-1', 'proj/x')).toBe('ws://localhost:4200/ws/browser/sess-1?projectId=proj%2Fx')
    })
  })

  describe('REST helpers', () => {
    it('createBrowserSession posts initialUrl and returns the session', async () => {
      global.fetch = mockFetch((url, init) => {
        expect(url).toContain('/api/projects/proj-1/browser/sessions')
        expect(JSON.parse(String(init?.body)).initialUrl).toBe('https://x.dev')
        return { status: 201, body: { session: { id: 's1' } } }
      }) as typeof fetch
      const s = await createBrowserSession('proj-1', 'https://x.dev')
      expect(s.id).toBe('s1')
    })

    it('routes session requests to their owner after the active project changes', async () => {
      setActiveProjectId('proj-b')
      global.fetch = mockFetch((url) => {
        expect(url).toContain('/api/projects/proj-a/browser/sessions')
        expect(url).not.toContain('/api/projects/proj-b/')
        return { status: 201, body: { session: { id: 's-a' } } }
      }) as typeof fetch

      await createBrowserSession('proj-a')
    })

    it('createBrowserSession maps 409 → limit, 502 → launch failure', async () => {
      global.fetch = mockFetch(() => ({ status: 409 })) as typeof fetch
      await expect(createBrowserSession('proj-1')).rejects.toBeInstanceOf(BrowserSessionLimitError)
      global.fetch = mockFetch(() => ({ status: 502 })) as typeof fetch
      await expect(createBrowserSession('proj-1')).rejects.toBeInstanceOf(BrowserLaunchFailedError)
    })

    it('navigateBrowser posts the action + url', async () => {
      global.fetch = mockFetch((url, init) => {
        expect(url).toContain('/browser/sessions/s1/navigate')
        const body = JSON.parse(String(init?.body))
        expect(body).toEqual({ action: 'goto', url: 'https://y.dev' })
        return { body: { url: 'https://y.dev', title: 'Y' } }
      }) as typeof fetch
      expect(await navigateBrowser('proj-1', 's1', 'goto', 'https://y.dev')).toEqual({ url: 'https://y.dev', title: 'Y' })
    })

    it('captureBrowserRegion posts rect + pendingSpecId and returns the result', async () => {
      global.fetch = mockFetch((url, init) => {
        expect(url).toContain('/browser/sessions/s1/capture')
        const body = JSON.parse(String(init?.body))
        expect(body.pendingSpecId).toBe('pend-1')
        expect(body.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 })
        return { body: { screenshot: { id: 'a1' }, domAttachment: { id: 'a2' }, dom } }
      }) as typeof fetch
      const r = await captureBrowserRegion('proj-1', 's1', { x: 1, y: 2, width: 3, height: 4 }, 'pend-1')
      expect(r.screenshot.id).toBe('a1')
      expect(r.domAttachment.id).toBe('a2')
    })

    it('captureBrowserRegion throws on non-ok', async () => {
      global.fetch = mockFetch(() => ({ status: 500 })) as typeof fetch
      await expect(captureBrowserRegion('proj-1', 's1', { x: 0, y: 0, width: 1, height: 1 }, 'p')).rejects.toThrow()
    })

    it('captureBrowserBreakpoints posts rect, anchor + breakpoints and returns the result', async () => {
      global.fetch = mockFetch((url, init) => {
        expect(url).toContain('/browser/sessions/s1/capture-breakpoints')
        const body = JSON.parse(String(init?.body))
        expect(body.pendingSpecId).toBe('pend-1')
        expect(body.anchorPoint).toEqual({ x: 5, y: 5 })
        expect(body.breakpoints.desktop).toEqual({ width: 1280, height: 800 })
        return { body: { screenshot: { id: 'b1' }, domAttachment: { id: 'b2' }, dom, screenshotDataUrl: 'data:image/png;base64,x', breakpoints: { desktop: { attachment: { id: 'b1' }, dataUrl: 'd', viewport: { width: 1280, height: 800 } } } } }
      }) as typeof fetch
      const r = await captureBrowserBreakpoints('proj-1', 's1', { x: 1, y: 2, width: 3, height: 4 }, { x: 5, y: 5 }, 'pend-1')
      expect(r.breakpoints!.desktop.attachment.id).toBe('b1')
    })

    it('uploadCaptureImage posts the blob as multipart and returns the attachment', async () => {
      global.fetch = mockFetch((url, init) => {
        expect(url).toContain('/api/projects/proj-1/tickets/pend-1/attachments')
        expect(init?.body).toBeInstanceOf(FormData)
        return { status: 201, body: { attachment: { id: 'an1' } } }
      }) as typeof fetch
      const att = await uploadCaptureImage('pend-1', new Blob(['x'], { type: 'image/png' }), 'annotated.png')
      expect(att.id).toBe('an1')
    })

    it('browserClipboard posts the action + text and returns the selection', async () => {
      global.fetch = mockFetch((url, init) => {
        expect(url).toContain('/browser/sessions/s1/clipboard')
        const body = JSON.parse(String(init?.body))
        expect(body).toEqual({ action: 'paste', text: 'hello' })
        return { body: { text: '' } }
      }) as typeof fetch
      expect(await browserClipboard('proj-1', 's1', 'paste', 'hello')).toEqual({ text: '' })
    })

    it('navigateBrowserElement posts selector + direction and returns the probe', async () => {
      global.fetch = mockFetch((url, init) => {
        expect(url).toContain('/browser/sessions/s1/element')
        const body = JSON.parse(String(init?.body))
        expect(body).toEqual({ selector: 'div.box', direction: 'parent' })
        return { body: { probe: { rect: { x: 0, y: 0, width: 1, height: 1 }, tag: 'section', selector: 'body', path: [] } } }
      }) as typeof fetch
      const p = await navigateBrowserElement('proj-1', 's1', 'div.box', 'parent')
      expect(p!.tag).toBe('section')
    })

    it('navigateBrowserElement returns null when the server reports no further step', async () => {
      global.fetch = mockFetch(() => ({ body: { probe: null } })) as typeof fetch
      expect(await navigateBrowserElement('proj-1', 's1', 'body', 'parent')).toBeNull()
    })

    it('killBrowserSession swallows errors', async () => {
      global.fetch = vi.fn(async () => { throw new Error('network') }) as unknown as typeof fetch
      await expect(killBrowserSession('proj-1', 's1')).resolves.toBeUndefined()
    })

    it('setBrowserPopupView posts the target and swallows errors', async () => {
      const fetchMock = mockFetch((url, init) => {
        expect(url).toBe('/api/projects/proj-1/browser/sessions/s1/popup-view')
        expect(JSON.parse(init?.body as string)).toEqual({ target: 'root' })
        return { body: { ok: true } }
      })
      global.fetch = fetchMock as unknown as typeof fetch
      await setBrowserPopupView('proj-1', 's1', 'root')
      expect(fetchMock).toHaveBeenCalledTimes(1)

      global.fetch = vi.fn(async () => { throw new Error('network') }) as unknown as typeof fetch
      await expect(setBrowserPopupView('proj-1', 's1', 'popup')).resolves.toBeUndefined()
    })
  })

  describe('popupOriginLabel', () => {
    it('extracts the hostname', () => {
      expect(popupOriginLabel('https://okta.example/login?x=1')).toBe('okta.example')
    })
    it('falls back to an ellipsis for blank/unparseable URLs', () => {
      expect(popupOriginLabel(null)).toBe('…')
      expect(popupOriginLabel(undefined)).toBe('…')
      expect(popupOriginLabel('about:blank')).toBe('…')
      expect(popupOriginLabel('not a url')).toBe('…')
    })
  })

  describe('createPointerInputCoalescer', () => {
    function harness() {
      const sent: BrowserInputEvent[] = []
      const ticks: Array<() => void> = []
      let cancelled: number[] = []
      const c = createPointerInputCoalescer(
        (e) => sent.push(e),
        (cb) => ticks.push(cb) && ticks.length, // id = 1-based index
        (id) => { cancelled.push(id) },
      )
      const tick = () => {
        const cbs = ticks.splice(0)
        for (const cb of cbs) cb()
      }
      return { c, sent, tick, cancelledIds: () => cancelled, resetCancelled: () => { cancelled = [] } }
    }

    it('sends only the newest move per frame', () => {
      const { c, sent, tick } = harness()
      c.move(1, 1)
      c.move(2, 2)
      c.move(3, 3)
      expect(sent).toHaveLength(0) // nothing until the frame tick
      tick()
      expect(sent).toEqual([{ type: 'mouse', action: 'move', x: 3, y: 3 }])
    })

    it('sums wheel deltas and keeps the latest position', () => {
      const { c, sent, tick } = harness()
      c.wheel(10, 10, 0, 40)
      c.wheel(12, 12, 5, 40)
      c.wheel(14, 14, 0, 40)
      tick()
      expect(sent).toEqual([{ type: 'wheel', x: 14, y: 14, deltaX: 5, deltaY: 120 }])
    })

    it('suppresses a standalone move to the same point as a pending wheel', () => {
      const { c, sent, tick } = harness()
      c.move(10, 10)
      c.wheel(10, 10, 0, 40)
      tick()
      expect(sent).toEqual([{ type: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: 40 }])
    })

    it('sends move THEN wheel when their positions differ', () => {
      const { c, sent, tick } = harness()
      c.wheel(10, 10, 0, 40)
      c.move(20, 20)
      tick()
      expect(sent).toEqual([
        { type: 'mouse', action: 'move', x: 20, y: 20 },
        { type: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: 40 },
      ])
    })

    it('flush() sends pending input synchronously and cancels the scheduled tick', () => {
      const { c, sent, tick, cancelledIds } = harness()
      c.move(5, 5)
      c.flush()
      expect(sent).toEqual([{ type: 'mouse', action: 'move', x: 5, y: 5 }])
      expect(cancelledIds()).toHaveLength(1)
      tick() // the cancelled tick must not double-send
      expect(sent).toHaveLength(1)
    })

    it('flush() with nothing pending sends nothing', () => {
      const { c, sent } = harness()
      c.flush()
      expect(sent).toHaveLength(0)
    })

    it('dispose() drops pending input and ignores later calls', () => {
      const { c, sent, tick } = harness()
      c.move(5, 5)
      c.dispose()
      tick()
      c.move(6, 6)
      c.wheel(1, 1, 0, 10)
      c.flush()
      tick()
      expect(sent).toHaveLength(0)
    })
  })
})
