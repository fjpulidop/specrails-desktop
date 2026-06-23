import { useCallback, useEffect, useRef, useState } from 'react'
import i18n from '../../lib/i18n'
import {
  createBrowserSession,
  openBrowserWs,
  navigateBrowser,
  captureBrowserRegion,
  captureBrowserBreakpoints,
  browserClipboard,
  navigateBrowserElement,
  killBrowserSession,
  BrowserSessionLimitError,
  BrowserLaunchFailedError,
  type BrowserInputEvent,
  type BreadcrumbSegment,
  type CaptureRect,
  type CaptureResult,
  type ElementProbe,
} from '../../lib/browser-capture'

export type SessionStatus = 'connecting' | 'ready' | 'error'

export interface BrowserSessionState {
  status: SessionStatus
  errorMsg: string | null
  url: string | null
  title: string | null
  viewport: { width: number; height: number }
  /** Bounding box (viewport coords) of the element under the cursor in select
   *  mode — server-resolved via the hover probe; null when nothing is hovered. */
  hoverRect: CaptureRect | null
  /** Selector of the hovered element (for breadcrumb up/down navigation). */
  hoverSelector: string | null
  /** Ancestor breadcrumb (root→element) of the hovered element. */
  hoverPath: BreadcrumbSegment[] | null
}

export interface UseBrowserCaptureSession extends BrowserSessionState {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  forwardInput: (e: BrowserInputEvent) => void
  navigate: (action: 'goto' | 'back' | 'forward' | 'reload', url?: string) => Promise<void>
  capture: (rect: CaptureRect, pendingSpecId: string, opts?: { captureNetwork?: boolean }) => Promise<CaptureResult>
  /** Capture the same selection at several viewport sizes (responsive reference). */
  captureBreakpoints: (rect: CaptureRect, anchorPoint: { x: number; y: number }, pendingSpecId: string, breakpoints?: Record<string, { width: number; height: number }>) => Promise<CaptureResult>
  setViewport: (width: number, height: number) => void
  /** Bridge the host clipboard to the page (copy/cut → returns selection; paste → inject). */
  clipboard: (action: 'copy' | 'paste' | 'cut', text?: string) => Promise<{ text: string }>
  /** Step the breadcrumb to a parent/child/self element; null when can't step. */
  navigateElement: (selector: string, direction: 'parent' | 'child' | 'self') => Promise<ElementProbe | null>
  /** Ask the server which element is at a viewport point (hover-to-select). */
  probe: (point: { x: number; y: number }) => void
  /** Clear the current hover highlight. */
  clearHover: () => void
}

/**
 * Owns one embedded-browser session: creates it over REST, streams its screencast
 * over the dedicated WS onto a canvas, forwards input, and tears the session down
 * (DELETE) on unmount/close. Excluded from coverage — WebSocket binary frames +
 * createImageBitmap + canvas drawing are not exercisable under jsdom; the pure
 * coordinate logic it relies on lives in `lib/browser-capture.ts` and is tested.
 */
export function useBrowserCaptureSession(opts: {
  projectId: string
  open: boolean
  initialUrl?: string
}): UseBrowserCaptureSession {
  const { projectId, open, initialUrl } = opts
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const drawingRef = useRef(false)
  // True while a capture POST is awaiting. The effect cleanup must NOT kill the
  // session out from under an in-flight capture (a transient effect re-run /
  // StrictMode double-invoke would otherwise 404 the capture).
  const capturingRef = useRef(false)

  const [state, setState] = useState<BrowserSessionState>({
    status: 'connecting',
    errorMsg: null,
    url: null,
    title: null,
    viewport: { width: 1280, height: 800 },
    hoverRect: null,
    hoverSelector: null,
    hoverPath: null,
  })

  const drawFrame = useCallback(async (buf: ArrayBuffer) => {
    if (drawingRef.current) return
    const canvas = canvasRef.current
    if (!canvas) return
    drawingRef.current = true
    try {
      const blob = new Blob([buf], { type: 'image/jpeg' })
      const bitmap = await createImageBitmap(blob)
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      if (ctx) ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
    } catch {
      /* drop bad frame */
    } finally {
      drawingRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false

    setState((s) => ({ ...s, status: 'connecting', errorMsg: null }))

    ;(async () => {
      try {
        const session = await createBrowserSession(initialUrl)
        if (cancelled) {
          void killBrowserSession(session.id)
          return
        }
        sessionIdRef.current = session.id
        setState((s) => ({
          ...s,
          url: session.url,
          title: session.title,
          viewport: { width: session.viewportWidth, height: session.viewportHeight },
        }))

        const ws = openBrowserWs(session.id, projectId)
        wsRef.current = ws
        ws.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data) as { type: string; url?: string; title?: string; viewport?: { width: number; height: number }; rect?: CaptureRect | null; selector?: string | null; path?: BreadcrumbSegment[] | null }
              if (msg.type === 'ready') {
                setState((s) => ({ ...s, status: 'ready', url: msg.url ?? s.url, title: msg.title ?? s.title, viewport: msg.viewport ?? s.viewport }))
              } else if (msg.type === 'nav') {
                setState((s) => ({ ...s, url: msg.url ?? s.url, title: msg.title ?? s.title }))
              } else if (msg.type === 'hover') {
                setState((s) => ({ ...s, hoverRect: msg.rect ?? null, hoverSelector: msg.selector ?? null, hoverPath: msg.path ?? null }))
              }
            } catch {
              /* ignore */
            }
            return
          }
          // binary screencast frame
          void drawFrame(ev.data as ArrayBuffer)
        }
        ws.onopen = () => { if (!cancelled) setState((s) => ({ ...s, status: 'ready' })) }
        ws.onerror = () => { if (!cancelled) setState((s) => ({ ...s, status: 'error', errorMsg: i18n.t('browser:session.connectionError') })) }
        ws.onclose = () => {
          // Unexpected drop (server restarted, session ended) — surface it so the
          // user knows to reopen instead of capturing against a dead session.
          if (!cancelled) setState((s) => (s.status === 'ready' ? { ...s, status: 'error', errorMsg: i18n.t('browser:session.lostConnection') } : s))
        }
      } catch (err) {
        if (cancelled) return
        const msg =
          err instanceof BrowserSessionLimitError ? i18n.t('browser:session.tooManySessions')
            : err instanceof BrowserLaunchFailedError ? i18n.t('browser:session.launchFailed')
              : i18n.t('browser:session.openFailed')
        setState((s) => ({ ...s, status: 'error', errorMsg: msg }))
      }
    })()

    return () => {
      cancelled = true
      const ws = wsRef.current
      if (ws) {
        // Detach handlers before closing so no late frame/message/close touches
        // state after teardown (avoids React "update on unmounted" + stale closures
        // + a spurious "lost connection" error on intentional close).
        ws.onmessage = null
        ws.onopen = null
        ws.onerror = null
        ws.onclose = null
        try { ws.close() } catch { /* ignore */ }
      }
      wsRef.current = null
      const sid = sessionIdRef.current
      sessionIdRef.current = null
      // Never kill a session with a capture in flight — a transient re-run/unmount
      // would otherwise make the awaiting POST hit a dead session (404). The server
      // sweeps idle sessions, so deferring this kill is safe.
      if (sid && !capturingRef.current) void killBrowserSession(sid)
    }
  }, [open, projectId, initialUrl, drawFrame])

  const forwardInput = useCallback((event: BrowserInputEvent) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'input', event })) } catch { /* drop */ }
    }
  }, [])

  const navigate = useCallback(async (action: 'goto' | 'back' | 'forward' | 'reload', url?: string) => {
    const sid = sessionIdRef.current
    if (!sid) return
    try {
      const result = await navigateBrowser(sid, action, url)
      setState((s) => ({ ...s, url: result.url, title: result.title }))
    } catch {
      /* nav failures are non-fatal */
    }
  }, [])

  const capture = useCallback(async (rect: CaptureRect, pendingSpecId: string, opts?: { captureNetwork?: boolean }): Promise<CaptureResult> => {
    const sid = sessionIdRef.current
    if (!sid) throw new Error('No active browser session')
    capturingRef.current = true
    try {
      return await captureBrowserRegion(sid, rect, pendingSpecId, opts)
    } finally {
      capturingRef.current = false
    }
  }, [])

  const captureBreakpoints = useCallback(async (rect: CaptureRect, anchorPoint: { x: number; y: number }, pendingSpecId: string, breakpoints?: Record<string, { width: number; height: number }>): Promise<CaptureResult> => {
    const sid = sessionIdRef.current
    if (!sid) throw new Error('No active browser session')
    capturingRef.current = true
    try {
      return await captureBrowserBreakpoints(sid, rect, anchorPoint, pendingSpecId, breakpoints)
    } finally {
      capturingRef.current = false
    }
  }, [])

  const clipboard = useCallback(async (action: 'copy' | 'paste' | 'cut', text?: string): Promise<{ text: string }> => {
    const sid = sessionIdRef.current
    if (!sid) return { text: '' }
    return browserClipboard(sid, action, text)
  }, [])

  const setViewport = useCallback((width: number, height: number) => {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    setState((s) => ({ ...s, viewport: { width: w, height: h } }))
    forwardInput({ type: 'resize', width: w, height: h })
  }, [forwardInput])

  const probe = useCallback((point: { x: number; y: number }) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'probe', x: point.x, y: point.y })) } catch { /* drop */ }
    }
  }, [])

  const clearHover = useCallback(() => {
    setState((s) => (s.hoverRect || s.hoverPath ? { ...s, hoverRect: null, hoverSelector: null, hoverPath: null } : s))
  }, [])

  const navigateElement = useCallback(async (selector: string, direction: 'parent' | 'child' | 'self'): Promise<ElementProbe | null> => {
    const sid = sessionIdRef.current
    if (!sid) return null
    return navigateBrowserElement(sid, selector, direction)
  }, [])

  return {
    ...state,
    canvasRef,
    forwardInput,
    navigate,
    capture,
    captureBreakpoints,
    clipboard,
    navigateElement,
    setViewport,
    probe,
    clearHover,
  }
}
