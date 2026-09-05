import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, RotateCw, Globe, X, AlertTriangle, ExternalLink } from 'lucide-react'
import { Button } from '../ui/button'
import { NativeBrowserModal } from './NativeBrowserPane'
import { isNativeBrowserAvailable } from '../../lib/native-browser'
import { useBrowserCaptureSession } from './useBrowserCaptureSession'
import { useBrowserViewport } from './useBrowserViewport'
import {
  mapPointToViewport,
  createPointerInputCoalescer,
  popupOriginLabel,
  type BrowserInputEvent,
  type PointerInputCoalescer,
} from '../../lib/browser-capture'

interface WebViewModalProps {
  open: boolean
  /** URL to open. */
  url: string
  projectId: string
  onClose: () => void
}

/**
 * In-app browse surface router — the fallback ladder from the native-browser
 * design (openspec: native-embedded-browser):
 *   1. Tauri + flag + `browser_supported` → NativeBrowserModal (real child
 *      webview, zero streaming — the Cursor-class experience).
 *   2. Native probe/open failure → screencast variant for this session.
 *   3. Plain browser / kill switch → screencast variant, byte-identical legacy.
 *
 * Excluded from coverage like the other browser-capture components; the ladder
 * logic itself (`isNativeBrowserAvailable`) is unit-tested in lib/.
 */
export function WebViewModal({ open, url, projectId, onClose }: WebViewModalProps) {
  const [engine, setEngine] = useState<'probing' | 'native' | 'screencast'>('probing')

  useEffect(() => {
    if (!open || engine !== 'probing') return
    let alive = true
    void isNativeBrowserAvailable().then((ok) => {
      if (alive) setEngine(ok ? 'native' : 'screencast')
    })
    return () => {
      alive = false
    }
  }, [open, engine])

  const onNativeFallback = useCallback(() => setEngine('screencast'), [])

  if (!open) return null
  // Sub-frame decision; rendering nothing briefly avoids creating a server-side
  // screencast session that the native path would immediately orphan.
  if (engine === 'probing') return null
  if (engine === 'native') {
    return <NativeBrowserModal url={url} onClose={onClose} onFallback={onNativeFallback} />
  }
  return <ScreencastWebViewModal open={open} url={url} projectId={projectId} onClose={onClose} />
}

/**
 * Legacy read-only embedded-browser modal: opens a link inside the app reusing
 * the SAME headless-Chromium session machinery as "From a website" (screencast
 * over WS onto a canvas). Shares the global browser profile (cookies/logins)
 * via the SharedBrowserContextPool. Browse-only variant of BrowserCaptureModal
 * (no select / capture / annotate). Kept byte-identical as the fallback path.
 *
 * Excluded from coverage like the other browser-capture components (canvas + WS +
 * pointer input are not exercisable under jsdom).
 */
function ScreencastWebViewModal({ open, url, projectId, onClose }: WebViewModalProps) {
  const { t } = useTranslation('browser')
  const session = useBrowserCaptureSession({ projectId, open, initialUrl: url })
  const { canvasRef, viewport, status, errorMsg, url: pageUrl, title, popup, popupError, setViewport } = session
  const [addressValue, setAddressValue] = useState(url)
  const containerRef = useRef<HTMLDivElement | null>(null)
  useBrowserViewport(containerRef, setViewport, open)

  // Browse input coalescer (same rationale as BrowserCaptureModal): pointermove
  // newest-wins + wheel deltas summed, ≤1 of each per animation frame.
  const forwardInputRef = useRef(session.forwardInput)
  forwardInputRef.current = session.forwardInput
  const coalescerRef = useRef<PointerInputCoalescer | null>(null)
  const getCoalescer = useCallback((): PointerInputCoalescer => {
    if (coalescerRef.current == null) {
      coalescerRef.current = createPointerInputCoalescer((e: BrowserInputEvent) => forwardInputRef.current(e))
    }
    return coalescerRef.current
  }, [])
  useEffect(() => () => { coalescerRef.current?.dispose(); coalescerRef.current = null }, [])

  // Navigation controls and address refer to the page currently being viewed.
  const visibleUrl = popup?.active ? popup.url ?? 'about:blank' : pageUrl ?? ''
  useEffect(() => { setAddressValue(visibleUrl) }, [visibleUrl, popup?.active])

  // Esc closes the modal.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const toViewport = useCallback((clientX: number, clientY: number) => {
    const r = canvasRef.current?.getBoundingClientRect()
    if (!r) return { x: 0, y: 0 }
    return mapPointToViewport({ x: clientX, y: clientY }, { left: r.left, top: r.top, width: r.width, height: r.height }, viewport)
  }, [canvasRef, viewport])

  const buttonOf = (b: number): 'left' | 'middle' | 'right' => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left')

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const p = toViewport(e.clientX, e.clientY)
    getCoalescer().move(p.x, p.y)
  }, [toViewport, getCoalescer])
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const p = toViewport(e.clientX, e.clientY)
    const c = getCoalescer()
    c.move(p.x, p.y)
    c.flush()
    session.forwardInput({ type: 'mouse', action: 'down', x: p.x, y: p.y, button: buttonOf(e.button), clickCount: e.detail || 1 })
  }, [toViewport, session, getCoalescer])
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const p = toViewport(e.clientX, e.clientY)
    const c = getCoalescer()
    c.move(p.x, p.y)
    c.flush()
    session.forwardInput({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: buttonOf(e.button), clickCount: e.detail || 1 })
  }, [toViewport, session, getCoalescer])
  const onWheel = useCallback((e: React.WheelEvent) => {
    const p = toViewport(e.clientX, e.clientY)
    getCoalescer().wheel(p.x, p.y, e.deltaX, e.deltaY)
  }, [toViewport, getCoalescer])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return
    const meta = e.metaKey || e.ctrlKey
    if (meta && (e.key === 'c' || e.key === 'v' || e.key === 'x')) {
      e.preventDefault()
      const key = e.key
      void (async () => {
        try {
          if (key === 'v') {
            const text = await navigator.clipboard.readText()
            if (text) await session.clipboard('paste', text)
          } else {
            const { text } = await session.clipboard(key === 'x' ? 'cut' : 'copy')
            if (text) await navigator.clipboard.writeText(text)
          }
        } catch { /* clipboard unavailable — ignore */ }
      })()
      return
    }
    const ev: BrowserInputEvent = { type: 'key', action: 'down', key: e.key, code: e.code, text: !meta && e.key.length === 1 ? e.key : undefined }
    session.forwardInput(ev)
    if (e.key === 'Tab' || e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault()
  }, [session])
  const onKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') return
    session.forwardInput({ type: 'key', action: 'up', key: e.key, code: e.code })
  }, [session])

  const go = useCallback(() => { void session.navigate('goto', addressValue) }, [session, addressValue])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[80] bg-background-deep/60 backdrop-blur-md pointer-events-auto"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      data-testid="webview-modal"
    >
      {/* Large modal (visible app rim), matching BrowserCaptureModal's shell. */}
      <div
        className="absolute inset-x-[4%] inset-y-[3.5%] flex flex-col border border-border/70 rounded-2xl bg-background-deep overflow-hidden shadow-2xl ring-1 ring-black/20"
        role="dialog"
        aria-modal="true"
        aria-label={t('modal.dialogLabel')}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-surface/80 shrink-0">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('common:actions.back')} onClick={() => session.navigate('back')}><ArrowLeft className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.nav.forward')} onClick={() => session.navigate('forward')}><ArrowRight className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.nav.reload')} onClick={() => session.navigate('reload')}><RotateCw className="w-4 h-4" /></Button>
          </div>
          <form className="flex-1 flex items-center gap-2 min-w-0" onSubmit={(e) => { e.preventDefault(); go() }}>
            <div className="flex items-center gap-2 flex-1 min-w-0 rounded-md border border-border bg-background px-2.5 py-1">
              <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                value={addressValue}
                onChange={(e) => setAddressValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go() } }}
                placeholder={t('modal.address.placeholder')}
                aria-label={t('modal.address.label')}
                className="flex-1 min-w-0 bg-transparent outline-none text-sm"
              />
            </div>
            <Button type="submit" size="sm" variant="secondary" className="shrink-0" disabled={status === 'error'}>{t('modal.address.go')}</Button>
          </form>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.closeBrowser')} onClick={onClose}><X className="w-4 h-4" /></Button>
        </div>

        {/* Status line */}
        <div className="px-3 py-1 text-[11px] text-muted-foreground truncate shrink-0 flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full shrink-0 ${status === 'ready' ? 'bg-accent-success' : status === 'error' ? 'bg-destructive' : 'bg-accent-warning animate-pulse'}`}
            aria-hidden
          />
          <span className="truncate">
            {status === 'connecting' ? t('modal.status.connecting') : status === 'error' ? (errorMsg ?? t('modal.status.unavailable')) : popup?.active ? t('popup.loginWindow', { origin: popupOriginLabel(popup.url) }) : (title || '')}
          </span>
        </div>

        {/* Popup (OAuth login window) bar — mirrors BrowserCaptureModal. */}
        {popupError && <div role="alert" className="px-3 py-1.5 text-xs text-destructive border-b border-border/40 shrink-0">{popupError}</div>}
        {popup && (
          <div
            data-testid="webview-popup-bar"
            className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b shrink-0 ${popup.active ? 'bg-accent-info/10 border-accent-info/30 text-accent-info' : 'bg-surface/70 border-border/40 text-muted-foreground'}`}
          >
            <ExternalLink className="w-3.5 h-3.5 shrink-0" />
            {popup.active ? (
              <>
                <span className="truncate font-medium">{t('popup.loginWindow', { origin: popupOriginLabel(popup.url) })}</span>
                {popup.count > 1 && <span className="shrink-0 opacity-70">{t('popup.stacked', { count: popup.count - 1 })}</span>}
                <button
                  type="button"
                  onClick={() => session.setPopupView('root')}
                  className="ml-auto shrink-0 inline-flex items-center gap-1 h-6 px-2 rounded-md border border-current/30 hover:bg-card/60 transition-colors"
                >
                  <ArrowLeft className="w-3 h-3" />
                  {t('popup.backToPage')}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => session.setPopupView('popup')}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-md border border-border/50 hover:bg-card/60 hover:text-foreground transition-colors"
              >
                {t('popup.show')}
                {popup.count > 1 && <span className="opacity-70">{t('popup.stacked', { count: popup.count - 1 })}</span>}
              </button>
            )}
          </div>
        )}

        {/* Viewport (browse-only) */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div
          ref={containerRef}
          className="relative flex-1 min-h-0 overflow-hidden flex items-center justify-center outline-none"
          tabIndex={0}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
        >
          {status === 'error' ? (
            <div className="flex flex-col items-center gap-2 text-center max-w-md px-6">
              <AlertTriangle className="w-8 h-8 text-accent-warning" />
              <p className="text-sm text-foreground/90">{errorMsg ?? t('modal.error.unavailable')}</p>
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              style={{ maxWidth: `min(100%, ${viewport.width}px)`, maxHeight: `min(100%, ${viewport.height}px)` }}
              className="max-w-full max-h-full block shadow-2xl cursor-default"
              onPointerMove={onPointerMove}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onContextMenu={(e) => e.preventDefault()}
              onWheel={onWheel}
            />
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
