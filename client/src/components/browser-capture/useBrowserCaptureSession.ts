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
  setBrowserPopupView,
  BrowserSessionLimitError,
  BrowserLaunchFailedError,
  type BrowserInputEvent,
  type BreadcrumbSegment,
  type CaptureRect,
  type CaptureResult,
  type ElementProbe,
} from '../../lib/browser-capture'
import {
  createFramePipeline,
  isBrowserPerfDebugEnabled,
  startFrameStatsReporter,
} from '../../lib/browser-frame-pipeline'

export type SessionStatus = 'connecting' | 'ready' | 'error'

/** State of the session's popup stack (OAuth login windows). Null = no popups. */
export interface PopupState {
  count: number
  /** True while the screencast + input show the TOP popup (vs the root page). */
  active: boolean
  /** Current URL of the top popup (for the "Login window — <origin>" label). */
  url: string | null
}

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
  /** Live popup stack, null when none are open. */
  popup: PopupState | null
  /** Recoverable view-switch failure; the live page remains usable. */
  popupError: string | null
}

export interface UseBrowserCaptureSession extends BrowserSessionState {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  forwardInput: (e: BrowserInputEvent) => void
  navigate: (action: 'goto' | 'back' | 'forward' | 'reload', url?: string) => Promise<void>
  capture: (rect: CaptureRect, pendingSpecId: string, opts?: { captureNetwork?: boolean }) => Promise<CaptureResult>
  /** Capture the same selection at several viewport sizes (responsive reference). */
  captureBreakpoints: (rect: CaptureRect, anchorPoint: { x: number; y: number }, pendingSpecId: string, breakpoints?: Record<string, { width: number; height: number }>) => Promise<CaptureResult>
  setViewport: (width: number, height: number, deviceScaleFactor?: number) => void
  /** Bridge the host clipboard to the page (copy/cut → returns selection; paste → inject). */
  clipboard: (action: 'copy' | 'paste' | 'cut', text?: string) => Promise<{ text: string }>
  /** Step the breadcrumb to a parent/child/self element; null when can't step. */
  navigateElement: (selector: string, direction: 'parent' | 'child' | 'self') => Promise<ElementProbe | null>
  /** Ask the server which element is at a viewport point (hover-to-select). */
  probe: (point: { x: number; y: number }) => void
  /** Clear the current hover highlight. */
  clearHover: () => void
  /** Switch the viewed page between the root page and the top popup. */
  setPopupView: (target: 'root' | 'popup') => Promise<void>
}

/**
 * Owns one embedded-browser session: creates it over REST, streams its screencast
 * over the dedicated WS onto a canvas (via the latest-frame-wins pipeline in
 * `lib/browser-frame-pipeline.ts`), forwards input, tracks the popup stack, and
 * tears the session down (DELETE) on unmount/close. Excluded from coverage —
 * WebSocket binary frames + createImageBitmap + canvas drawing are not
 * exercisable under jsdom; the pure logic it relies on (coordinates, input
 * coalescing, frame pipeline) lives in `lib/` and is unit-tested there.
 */
export function useBrowserCaptureSession(opts: {
  projectId: string
  open: boolean
  initialUrl?: string
}): UseBrowserCaptureSession {
  const { projectId, open, initialUrl } = opts
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const sessionRef = useRef<{ id: string; projectId: string } | null>(null)
  const popupRevisionRef = useRef(0)
  const popupRequestRef = useRef(0)
  // The measured surface usually exists before the REST session / WS handshake.
  // Retain its latest size and replay it for each new socket, rather than losing
  // an early resize and browsing forever at Chromium's default 1280×800.
  const desiredViewportRef = useRef<{ width: number; height: number; deviceScaleFactor: number } | null>(null)
  const sentViewportRef = useRef<typeof desiredViewportRef.current>(null)
  const flushViewport = useCallback(() => {
    const viewport = desiredViewportRef.current
    const sent = sentViewportRef.current
    const ws = wsRef.current
    if (!viewport || !ws || ws.readyState !== WebSocket.OPEN) return
    if (sent && sent.width === viewport.width && sent.height === viewport.height && sent.deviceScaleFactor === viewport.deviceScaleFactor) return
    try {
      ws.send(JSON.stringify({ type: 'input', event: { type: 'resize', ...viewport } }))
      sentViewportRef.current = viewport
    } catch { /* Retain the desired size for the next open/ready notification. */ }
  }, [])
  // Count capture POSTs currently awaiting. The effect cleanup must NOT kill the
  // session out from under an in-flight capture (a transient effect re-run /
  // StrictMode double-invoke would otherwise 404 the capture).
  const capturesInFlightRef = useRef(0)
  // A project switch/unmount can happen while capture is awaiting. Retain every
  // exact owner/session pair and flush it when the final capture settles.
  const pendingKillsRef = useRef(new Map<string, { sessionId: string; projectId: string }>())

  const flushPendingKills = useCallback(() => {
    if (capturesInFlightRef.current !== 0 || pendingKillsRef.current.size === 0) return
    const pending = [...pendingKillsRef.current.values()]
    pendingKillsRef.current.clear()
    for (const session of pending) {
      void killBrowserSession(session.projectId, session.sessionId)
    }
  }, [])

  const [state, setState] = useState<BrowserSessionState>({
    status: 'connecting',
    errorMsg: null,
    url: null,
    title: null,
    viewport: { width: 1280, height: 800 },
    hoverRect: null,
    hoverSelector: null,
    hoverPath: null,
    popup: null,
    popupError: null,
  })

  useEffect(() => {
    if (!open || !projectId) return
    let cancelled = false
    let ownedSessionId: string | null = null
    sentViewportRef.current = null

    setState((s) => ({ ...s, status: 'connecting', errorMsg: null, popup: null, popupError: null }))

    // Latest-frame-wins decode + rAF-coalesced draw (see browser-frame-pipeline):
    // createImageBitmap decodes off the main thread; only the newest frame is
    // painted, so a decode backlog raises the drop count instead of the latency.
    const pipeline = createFramePipeline<ImageBitmap>({
      decode: (buf) => createImageBitmap(new Blob([buf], { type: 'image/jpeg' })),
      draw: (bitmap) => {
        const canvas = canvasRef.current
        if (!canvas) return
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      },
      release: (bitmap) => bitmap.close(),
    })
    // Dev-only perf probe: localStorage['specrails-desktop:browser-capture-debug']='1'
    const stopStats = isBrowserPerfDebugEnabled()
      ? startFrameStatsReporter(() => pipeline.stats())
      : null

    ;(async () => {
      try {
        const session = await createBrowserSession(projectId, initialUrl)
        if (cancelled) {
          void killBrowserSession(projectId, session.id)
          return
        }
        ownedSessionId = session.id
        sessionRef.current = { id: session.id, projectId }
        setState((s) => ({
          ...s,
          url: session.url,
          title: session.title,
          viewport: desiredViewportRef.current ?? { width: session.viewportWidth, height: session.viewportHeight },
        }))

        const ws = openBrowserWs(session.id, projectId)
        wsRef.current = ws
        ws.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data === 'string') {
            try {
              const msg = JSON.parse(ev.data) as { type: string; url?: string; title?: string; viewport?: { width: number; height: number }; rect?: CaptureRect | null; selector?: string | null; path?: BreadcrumbSegment[] | null; count?: number; active?: boolean }
              if (msg.type === 'ready') {
                setState((s) => ({ ...s, status: 'ready', url: msg.url ?? s.url, title: msg.title ?? s.title, viewport: desiredViewportRef.current ?? msg.viewport ?? s.viewport }))
                flushViewport()
              } else if (msg.type === 'nav') {
                setState((s) => ({ ...s, url: msg.url ?? s.url, title: msg.title ?? s.title }))
              } else if (msg.type === 'hover') {
                setState((s) => ({ ...s, hoverRect: msg.rect ?? null, hoverSelector: msg.selector ?? null, hoverPath: msg.path ?? null }))
              } else if (msg.type === 'popup') {
                const count = typeof msg.count === 'number' ? msg.count : 0
                popupRevisionRef.current += 1
                setState((s) => ({ ...s, popup: count > 0 ? { count, active: msg.active === true, url: msg.url ?? null } : null, popupError: null }))
              }
            } catch {
              /* ignore */
            }
            return
          }
          // binary screencast frame
          pipeline.push(ev.data as ArrayBuffer)
        }
        ws.onopen = () => {
          if (cancelled) return
          flushViewport()
          setState((s) => ({ ...s, status: 'ready' }))
        }
        ws.onerror = () => { if (!cancelled) setState((s) => ({ ...s, status: 'error', errorMsg: i18n.t('browser:session.connectionError') })) }
        ws.onclose = () => {
          // Unexpected drop (server restarted, session ended) — surface it so the
          // user knows to reopen instead of capturing against a dead session.
          if (!cancelled) setState((s) => ({ ...s, status: 'error', errorMsg: i18n.t('browser:session.lostConnection') }))
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
      stopStats?.()
      pipeline.dispose()
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
      const sid = ownedSessionId
      if (sid && sessionRef.current?.id === sid && sessionRef.current.projectId === projectId) {
        sessionRef.current = null
      }
      // Never kill a session with a capture in flight — a transient re-run/unmount
      // would otherwise make the awaiting POST hit a dead session (404). The
      // capture finally block performs the deferred kill deterministically.
      if (sid) {
        if (capturesInFlightRef.current > 0) {
          pendingKillsRef.current.set(`${projectId}\0${sid}`, { sessionId: sid, projectId })
        } else {
          void killBrowserSession(projectId, sid)
        }
      }
    }
  }, [open, projectId, initialUrl, flushPendingKills, flushViewport])

  const forwardInput = useCallback((event: BrowserInputEvent) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'input', event })) } catch { /* drop */ }
    }
  }, [])

  const navigate = useCallback(async (action: 'goto' | 'back' | 'forward' | 'reload', url?: string) => {
    const session = sessionRef.current
    if (!session) return
    try {
      const result = await navigateBrowser(session.projectId, session.id, action, url)
      if (sessionRef.current !== session) return
      // Popup metadata arrives through WS. A late HTTP result must neither
      // overwrite the opener's URL nor revive a popup that has already closed.
      if (result.target !== 'popup') setState((s) => ({ ...s, url: result.url, title: result.title }))
    } catch {
      /* nav failures are non-fatal */
    }
  }, [])

  const capture = useCallback(async (rect: CaptureRect, pendingSpecId: string, opts?: { captureNetwork?: boolean }): Promise<CaptureResult> => {
    const session = sessionRef.current
    if (!session) throw new Error('No active browser session')
    capturesInFlightRef.current += 1
    try {
      return await captureBrowserRegion(session.projectId, session.id, rect, pendingSpecId, opts)
    } finally {
      capturesInFlightRef.current = Math.max(0, capturesInFlightRef.current - 1)
      flushPendingKills()
    }
  }, [flushPendingKills])

  const captureBreakpoints = useCallback(async (rect: CaptureRect, anchorPoint: { x: number; y: number }, pendingSpecId: string, breakpoints?: Record<string, { width: number; height: number }>): Promise<CaptureResult> => {
    const session = sessionRef.current
    if (!session) throw new Error('No active browser session')
    capturesInFlightRef.current += 1
    try {
      return await captureBrowserBreakpoints(session.projectId, session.id, rect, anchorPoint, pendingSpecId, breakpoints)
    } finally {
      capturesInFlightRef.current = Math.max(0, capturesInFlightRef.current - 1)
      flushPendingKills()
    }
  }, [flushPendingKills])

  const clipboard = useCallback(async (action: 'copy' | 'paste' | 'cut', text?: string): Promise<{ text: string }> => {
    const session = sessionRef.current
    if (!session) return { text: '' }
    return browserClipboard(session.projectId, session.id, action, text)
  }, [])

  const setViewport = useCallback((width: number, height: number, deviceScaleFactor = window.devicePixelRatio || 1) => {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const scale = Number.isFinite(deviceScaleFactor) ? Math.min(2, Math.max(1, deviceScaleFactor)) : 1
    desiredViewportRef.current = { width: w, height: h, deviceScaleFactor: scale }
    setState((s) => s.viewport.width === w && s.viewport.height === h ? s : { ...s, viewport: { width: w, height: h } })
    flushViewport()
  }, [flushViewport])

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
    const session = sessionRef.current
    if (!session) return null
    return navigateBrowserElement(session.projectId, session.id, selector, direction)
  }, [])

  const setPopupView = useCallback(async (target: 'root' | 'popup') => {
    const session = sessionRef.current
    if (!session) return
    const revision = popupRevisionRef.current
    const request = ++popupRequestRef.current
    const isCurrent = () => sessionRef.current === session && popupRevisionRef.current === revision && popupRequestRef.current === request
    // Keep the visible state authoritative: a failed request must not enable
    // root-page capture while the image and input still belong to the login.
    try {
      await setBrowserPopupView(session.projectId, session.id, target)
      if (isCurrent()) setState((s) => ({ ...s, popupError: null }))
    } catch {
      if (isCurrent()) setState((s) => ({ ...s, popupError: i18n.t('browser:session.connectionError') }))
    }
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
    setPopupView,
  }
}
