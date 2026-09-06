import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe,
  X,
  ExternalLink,
  Wrench,
  ZoomIn,
  ZoomOut,
  Camera,
  MousePointer2,
} from 'lucide-react'
import { Button } from '../ui/button'
import { ImageAnnotationEditor } from './AnnotationEditor'
import {
  nativeBrowser,
  normalizeAddress,
  rectToBounds,
  type NativeBrowserEvent,
  type NativeBrowserCapture,
  type NativeBrowserSelection,
  type PaneBounds,
} from '../../lib/native-browser'
import { openExternalUrl } from '../../lib/tauri-shell'

// A supplied owner survives renderer handoff. Effect cleanup must not close a
// newer StrictMode/re-mounted lease of that same native webview.
const paneLeases = new Map<string, symbol>()
const paneOperations = new Map<string, Promise<unknown>>()
function sequencePaneOperation<T>(ownerId: string, operation: () => Promise<T>): Promise<T> {
  const next = (paneOperations.get(ownerId) ?? Promise.resolve()).catch(() => {}).then(operation)
  paneOperations.set(ownerId, next)
  void next.finally(() => { if (paneOperations.get(ownerId) === next) paneOperations.delete(ownerId) }).catch(() => {})
  return next
}

interface NativeBrowserModalProps {
  ownerId?: string
  leaseRevision?: number
  onBusyChange?: (busy: boolean) => void
  transferError?: string | null
  /** URL to open. */
  url: string
  onClose: () => void
  /** Called when the native pane fails to open — the parent falls back to the
   *  screencast variant for this session. */
  onFallback: () => void
  onUrlChange?: (url: string) => void
  onCaptured?: (capture: NativeBrowserCapture) => Promise<void>
  confirmLabel?: string
  selectLabel?: string
}

/**
 * Native embedded browser modal. React renders
 * ONLY the chrome (toolbar + status line) plus a measured "hole" div; the page
 * itself is a Tauri child webview (WKWebView / WebView2) composited by the OS
 * inside that hole — no screencast, no input round-trips, real cookies.
 *
 * The child webview is a separate native surface: app HTML can never render
 * above its rectangle, which is why this pane only exists inside this topmost
 * full-screen modal (z-[80]) and the chrome lives outside the hole rect.
 *
 * Lifecycle and geometry are exercised with IPC fakes; actual native rendering
 * and Retina snapshots are checked in the macOS smoke fixture.
 */
export function NativeBrowserModal({ ownerId: suppliedOwnerId, leaseRevision = 0, onBusyChange, transferError, url, onClose, onFallback, onUrlChange, onCaptured, confirmLabel, selectLabel }: NativeBrowserModalProps) {
  const { t } = useTranslation('browser')
  const holeRef = useRef<HTMLDivElement | null>(null)
  const addressFocusedRef = useRef(false)
  const [addressValue, setAddressValue] = useState(url)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [title, setTitle] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selection, setSelection] = useState<NativeBrowserSelection | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [preview, setPreview] = useState<NativeBrowserCapture | null>(null)
  useEffect(() => {
    onBusyChange?.(selecting || selection !== null || capturing || preview !== null)
    return () => { onBusyChange?.(false) }
  }, [onBusyChange, selecting, selection, capturing, preview])
  const zoomRef = useRef(1)
  const ownerRef = useRef<string | null>(null)
  const readyRef = useRef(false)
  const capturingRef = useRef(false)
  const previewRef = useRef(false)
  const lastBounds = useRef<PaneBounds | null>(null)
  const requestedUrl = useRef(url)
  const propsRef = useRef({ url, onFallback, onUrlChange })
  propsRef.current = { url, onFallback, onUrlChange }
  previewRef.current = preview !== null

  const run = useCallback(async (operation: (ownerId: string) => Promise<unknown>) => {
    const ownerId = ownerRef.current
    if (!ownerId || !readyRef.current) return
    setError(null)
    try { await operation(ownerId) } catch (cause) {
      if (ownerRef.current === ownerId) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // Pane lifecycle: subscribe → open at the hole's rect → sync bounds → close.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    let raf = 0
    let observer: ResizeObserver | null = null
    // Each effect lifetime needs its own owner, including StrictMode replay.
    const ownerId = suppliedOwnerId ?? crypto.randomUUID()
    const lease = Symbol(ownerId)
    paneLeases.set(ownerId, lease)
    const release = () => {
      void sequencePaneOperation(ownerId, async () => {
        if (paneLeases.get(ownerId) !== lease) return
        paneLeases.delete(ownerId)
        await nativeBrowser.close(ownerId)
      }).catch(() => {})
    }
    ownerRef.current = ownerId
    readyRef.current = false
    setReady(false)

    const scheduleBounds = () => {
      if (disposed || raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        if (!readyRef.current || previewRef.current || capturingRef.current) return
        const rect = holeRef.current?.getBoundingClientRect()
        if (!rect || rect.width <= 0 || rect.height <= 0) return
        const bounds = rectToBounds(rect)
        if (JSON.stringify(bounds) === JSON.stringify(lastBounds.current)) return
        lastBounds.current = bounds
        void nativeBrowser.setBounds(ownerId, bounds).catch(() => { lastBounds.current = null })
      })
    }

    ;(async () => {
      try {
        const disposeListener = await nativeBrowser.onEvent(ownerId, (e: NativeBrowserEvent) => {
          if (disposed) return
          if (e.kind === 'resume') {
            // A parked session is visible only when its matching UI is still
            // mounted. Otherwise it must stay hidden behind the workspace.
            if (!previewRef.current && !capturingRef.current) void sequencePaneOperation(ownerId, async () => {
              if (disposed || paneLeases.get(ownerId) !== lease || previewRef.current || capturingRef.current) return
              const rect = holeRef.current?.getBoundingClientRect()
              if (rect) await nativeBrowser.open(ownerId, e.url ?? requestedUrl.current, rectToBounds(rect))
            }).catch(cause => { if (!disposed) setError(String(cause)) })
            return
          }
          if (e.kind === 'nav' && e.url) {
            setCurrentUrl(e.url)
            propsRef.current.onUrlChange?.(e.url)
            setSelection(null)
            setSelecting(false)
            if (!addressFocusedRef.current) setAddressValue(e.url)
          } else if (e.kind === 'title') {
            setTitle(e.title ?? null)
          } else if (e.kind === 'load-started') {
            setLoading(true)
          } else if (e.kind === 'load-finished') {
            setLoading(false)
            if (e.url && !addressFocusedRef.current) setAddressValue(e.url)
          } else if (e.kind === 'popup-error') {
            setError(t('popup.openFailed'))
          } else if (e.kind === 'popup-opened') {
            setError(null)
          }
        })
        if (disposed) { disposeListener(); return }
        unlisten = disposeListener
        const rect = holeRef.current?.getBoundingClientRect()
        if (!rect) throw new Error('hole not measurable')
        requestedUrl.current = normalizeAddress(propsRef.current.url) ?? 'about:blank'
        lastBounds.current = rectToBounds(rect)
        const bounds = lastBounds.current
        const opened = await sequencePaneOperation(ownerId, async () => {
          if (disposed || paneLeases.get(ownerId) !== lease) return false
          await nativeBrowser.open(ownerId, requestedUrl.current, bounds)
          return true
        })
        if (!opened) return
        if (disposed) { release(); return }
        readyRef.current = true
        setReady(true)
        observer = new ResizeObserver(scheduleBounds)
        if (holeRef.current) observer.observe(holeRef.current)
        window.addEventListener('resize', scheduleBounds)
        window.addEventListener('scroll', scheduleBounds, true)
        window.visualViewport?.addEventListener('resize', scheduleBounds)
        window.visualViewport?.addEventListener('scroll', scheduleBounds)
        scheduleBounds()
      } catch {
        if (!disposed) propsRef.current.onFallback()
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleBounds)
      window.removeEventListener('scroll', scheduleBounds, true)
      window.visualViewport?.removeEventListener('resize', scheduleBounds)
      window.visualViewport?.removeEventListener('scroll', scheduleBounds)
      unlisten?.()
      if (ownerRef.current === ownerId) { ownerRef.current = null; readyRef.current = false }
      release()
    }
    // URL changes navigate the same pane; only identity changes replace it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suppliedOwnerId, leaseRevision])

  useEffect(() => {
    const normalized = normalizeAddress(url) ?? 'about:blank'
    if (!ready || normalized === requestedUrl.current) return
    requestedUrl.current = normalized
    setAddressValue(normalized)
    void run(ownerId => nativeBrowser.navigate(ownerId, normalized))
  }, [url, ready, run])

  const capture = useCallback(async (selectionOnly: boolean) => {
    const ownerId = ownerRef.current
    if (!ownerId || !readyRef.current || capturingRef.current) return
    capturingRef.current = true
    setCapturing(true)
    setError(null)
    try {
      const result = await nativeBrowser.capture(ownerId, selectionOnly)
      if (ownerRef.current !== ownerId) return
      // Native child surfaces render above HTML. Hide the exact captured pane
      // before mounting the annotation editor, preserving its page and cookies.
      await nativeBrowser.hide(ownerId)
      if (ownerRef.current !== ownerId) return
      previewRef.current = true
      setSelecting(false)
      setPreview(result)
    } catch (cause) {
      if (ownerRef.current === ownerId) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      capturingRef.current = false
      if (ownerRef.current === ownerId) setCapturing(false)
    }
  }, [])

  // Poll only while selecting, with at most one native query in flight. Page
  // content has no application IPC; the host reads the fixed picker's result.
  useEffect(() => {
    if (!selecting || !ready) return
    const ownerId = ownerRef.current!
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const picked = await nativeBrowser.selection(ownerId)
        if (disposed || ownerRef.current !== ownerId) return
        if (picked) {
          await nativeBrowser.setSelectMode(ownerId, false)
          if (disposed || ownerRef.current !== ownerId) return
          setSelection(picked)
          setSelecting(false)
          // Picking an element completes selection. Do not require an extra
          // Capture selection click before the expected annotation step.
          await capture(true)
          return
        }
      } catch (cause) {
        if (disposed || ownerRef.current !== ownerId) return
        setError(String(cause))
        // The native picker has an input shield. Never tell the user it is off
        // until WebKit confirms removal; failed polling must also release it.
        // If cleanup fails, keep the active toggle available for a manual retry.
        try {
          await nativeBrowser.setSelectMode(ownerId, false)
          if (!disposed && ownerRef.current === ownerId) setSelecting(false)
        } catch (cleanupCause) {
          if (!disposed && ownerRef.current === ownerId) setError(String(cleanupCause))
        }
        return
      }
      if (!disposed) timer = setTimeout(poll, 200)
    }
    void poll()
    return () => { disposed = true; clearTimeout(timer) }
  }, [selecting, ready, capture])

  const toggleSelection = async () => {
    await run(async ownerId => {
      await nativeBrowser.setSelectMode(ownerId, !selecting)
      setSelection(null)
      setSelecting(!selecting)
    })
  }

  const returnToPage = async () => {
    setPreview(null)
    await run(async ownerId => {
      // React restores the same measured hole; the page itself was never closed.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const rect = holeRef.current?.getBoundingClientRect()
      if (rect && rect.width > 0 && rect.height > 0) {
        lastBounds.current = rectToBounds(rect)
        await nativeBrowser.setBounds(ownerId, lastBounds.current)
      }
      await nativeBrowser.show(ownerId)
    })
  }

  // Esc closes the modal (the native pane owns keyboard focus while browsing,
  // but Esc reaches us whenever the chrome has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !previewRef.current) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const go = useCallback(() => {
    const normalized = normalizeAddress(addressValue)
    if (!normalized) return
    setAddressValue(normalized)
    void run(ownerId => nativeBrowser.navigate(ownerId, normalized))
  }, [addressValue, run])

  const setZoom = useCallback((factor: number) => {
    zoomRef.current = Math.min(3, Math.max(0.25, factor))
    void run(ownerId => nativeBrowser.zoom(ownerId, zoomRef.current))
  }, [run])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[80] bg-background-deep/60 backdrop-blur-md pointer-events-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget && !preview) onClose()
      }}
      data-testid="native-browser-modal"
    >
      {/* Large modal (visible app rim), matching BrowserCaptureModal's shell.
          The native child webview only covers the hole div, so the rim + chrome
          stay interactive. */}
      <div
        className="absolute inset-x-[4%] inset-y-[3.5%] flex flex-col border border-border/70 rounded-2xl bg-background-deep overflow-hidden shadow-2xl ring-1 ring-black/20"
        role="dialog"
        aria-modal="true"
        aria-label={t('modal.dialogLabel')}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Toolbar */}
        {!preview && <>
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-surface/80 shrink-0">
          <div className="flex items-center gap-1">
            <Button disabled={!ready} variant="ghost" size="icon" className="h-7 w-7" aria-label={t('common:actions.back')} onClick={() => void run(nativeBrowser.back)}><ArrowLeft className="w-4 h-4" /></Button>
            <Button disabled={!ready} variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.nav.forward')} onClick={() => void run(nativeBrowser.forward)}><ArrowRight className="w-4 h-4" /></Button>
            <Button disabled={!ready} variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.nav.reload')} onClick={() => void run(nativeBrowser.reload)}><RotateCw className="w-4 h-4" /></Button>
          </div>
          <form
            className="flex-1 flex items-center gap-2 min-w-0"
            onSubmit={(e) => {
              e.preventDefault()
              go()
            }}
          >
            <div className="flex items-center gap-2 flex-1 min-w-0 rounded-md border border-border bg-background px-2.5 py-1">
              <Globe className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
              <input
                value={addressValue}
                onChange={(e) => setAddressValue(e.target.value)}
                onFocus={() => { addressFocusedRef.current = true }}
                onBlur={() => { addressFocusedRef.current = false }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    go()
                  }
                }}
                placeholder={t('modal.address.placeholder')}
                aria-label={t('modal.address.label')}
                className="flex-1 min-w-0 bg-transparent outline-none text-sm"
              />
            </div>
            <Button type="submit" size="sm" variant="secondary" className="shrink-0">{t('modal.address.go')}</Button>
          </form>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('native.zoomOut')} title={t('native.zoomOut')} onClick={() => setZoom(zoomRef.current - 0.1)}><ZoomOut className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('native.zoomIn')} title={t('native.zoomIn')} onClick={() => setZoom(zoomRef.current + 0.1)}><ZoomIn className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('native.devtools')} title={t('native.devtools')} onClick={() => void run(nativeBrowser.devtools)}><Wrench className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('native.openExternal')} title={t('native.openExternal')} onClick={() => void openExternalUrl(currentUrl)}><ExternalLink className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.closeBrowser')} onClick={onClose}><X className="w-4 h-4" /></Button>
          </div>
        </div>

        {/* Status line */}
        <div className="px-3 py-1 text-[11px] text-muted-foreground truncate shrink-0 flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full shrink-0 ${loading ? 'bg-accent-warning animate-pulse' : 'bg-accent-success'}`}
            aria-hidden
          />
          <span className="truncate">{title || currentUrl}</span>
          <span className="ml-auto shrink-0 rounded-full border border-accent-success/30 bg-accent-success/10 text-accent-success px-2 py-px text-[10px] font-medium">
            {t('native.badge')}
          </span>
        </div>
        {onCaptured && (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-2 shrink-0">
            <Button variant={selecting ? 'secondary' : 'ghost'} size="sm" disabled={!ready || capturing} aria-pressed={selecting} onClick={() => void toggleSelection()}>
              <MousePointer2 className="mr-1.5 h-3.5 w-3.5" />{selectLabel ?? t('native.selectElement')}
            </Button>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {selecting ? t('native.selectHint') : selection?.selector}
            </span>
            <Button variant="secondary" size="sm" disabled={!ready || capturing || selecting || currentUrl === 'about:blank'} onClick={() => void capture(selection !== null)}>
              <Camera className="mr-1.5 h-3.5 w-3.5" />{capturing ? t('native.capturing') : selection ? t('native.captureSelection') : t('native.capturePage')}
            </Button>
          </div>
        )}
        </>}
        {(error || transferError) && <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive shrink-0">{error || transferError}</div>}

        {preview && onCaptured && (
          <ImageAnnotationEditor
            screenshotDataUrl={preview.screenshotDataUrl}
            confirmLabel={confirmLabel}
            onConfirm={async result => { await onCaptured({ ...preview, screenshotDataUrl: result.screenshotDataUrl }) }}
            onReselect={() => { void returnToPage() }}
            onCancel={onClose}
          />
        )}

        {/* Hole — the native child webview is composited exactly over this div. */}
        <div ref={holeRef} className={preview ? 'hidden' : 'relative flex-1 min-h-0 overflow-hidden'}>
          {loading && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              {t('modal.status.opening')}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
