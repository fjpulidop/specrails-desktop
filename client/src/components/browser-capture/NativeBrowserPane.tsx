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
} from 'lucide-react'
import { Button } from '../ui/button'
import {
  nativeBrowser,
  normalizeAddress,
  rectToBounds,
  type NativeBrowserEvent,
} from '../../lib/native-browser'
import { openExternalUrl } from '../../lib/tauri-shell'

interface NativeBrowserModalProps {
  /** URL to open. */
  url: string
  onClose: () => void
  /** Called when the native pane fails to open — the parent falls back to the
   *  screencast variant for this session. */
  onFallback: () => void
}

/**
 * Native embedded browser modal: the Cursor-class experience. React renders
 * ONLY the chrome (toolbar + status line) plus a measured "hole" div; the page
 * itself is a Tauri child webview (WKWebView / WebView2) composited by the OS
 * inside that hole — no screencast, no input round-trips, real cookies.
 *
 * The child webview is a separate native surface: app HTML can never render
 * above its rectangle, which is why this pane only exists inside this topmost
 * full-screen modal (z-[80]) and the chrome lives outside the hole rect.
 *
 * Excluded from coverage like the other browser-capture components — Tauri IPC,
 * ResizeObserver and the native view are structurally unreachable under jsdom;
 * the pure logic (normalization, scheme policy, bounds mapping, probe) lives in
 * `lib/native-browser.ts` and is unit-tested there.
 */
export function NativeBrowserModal({ url, onClose, onFallback }: NativeBrowserModalProps) {
  const { t } = useTranslation('browser')
  const holeRef = useRef<HTMLDivElement | null>(null)
  const addressFocusedRef = useRef(false)
  const [addressValue, setAddressValue] = useState(url)
  const [currentUrl, setCurrentUrl] = useState(url)
  const [title, setTitle] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const zoomRef = useRef(1)

  // Pane lifecycle: subscribe → open at the hole's rect → sync bounds → close.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | null = null
    let raf = 0
    let observer: ResizeObserver | null = null

    const scheduleBounds = () => {
      if (disposed) return
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const rect = holeRef.current?.getBoundingClientRect()
        if (!rect) return
        void nativeBrowser.setBounds(rectToBounds(rect)).catch(() => {})
      })
    }

    ;(async () => {
      try {
        unlisten = await nativeBrowser.onEvent((e: NativeBrowserEvent) => {
          if (disposed) return
          if (e.kind === 'nav' && e.url) {
            setCurrentUrl(e.url)
            if (!addressFocusedRef.current) setAddressValue(e.url)
          } else if (e.kind === 'title') {
            setTitle(e.title ?? null)
          } else if (e.kind === 'load-started') {
            setLoading(true)
          } else if (e.kind === 'load-finished') {
            setLoading(false)
            if (e.url && !addressFocusedRef.current) setAddressValue(e.url)
          }
        })
        if (disposed) return
        const rect = holeRef.current?.getBoundingClientRect()
        if (!rect) throw new Error('hole not measurable')
        await nativeBrowser.open(url, rectToBounds(rect))
        if (disposed) {
          void nativeBrowser.close().catch(() => {})
          return
        }
        observer = new ResizeObserver(scheduleBounds)
        if (holeRef.current) observer.observe(holeRef.current)
        window.addEventListener('resize', scheduleBounds)
      } catch {
        if (!disposed) onFallback()
      }
    })()

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer?.disconnect()
      window.removeEventListener('resize', scheduleBounds)
      unlisten?.()
      void nativeBrowser.close().catch(() => {})
    }
    // The pane is opened once per modal mount; `url` changes remount via key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Esc closes the modal (the native pane owns keyboard focus while browsing,
  // but Esc reaches us whenever the chrome has focus).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const go = useCallback(() => {
    const normalized = normalizeAddress(addressValue)
    if (!normalized) return
    setAddressValue(normalized)
    void nativeBrowser.navigate(normalized).catch(() => {})
  }, [addressValue])

  const setZoom = useCallback((factor: number) => {
    zoomRef.current = Math.min(3, Math.max(0.25, factor))
    void nativeBrowser.zoom(zoomRef.current).catch(() => {})
  }, [])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[80] bg-background-deep/60 backdrop-blur-md pointer-events-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
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
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-surface/80 shrink-0">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('common:actions.back')} onClick={() => void nativeBrowser.back().catch(() => {})}><ArrowLeft className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.nav.forward')} onClick={() => void nativeBrowser.forward().catch(() => {})}><ArrowRight className="w-4 h-4" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.nav.reload')} onClick={() => void nativeBrowser.reload().catch(() => {})}><RotateCw className="w-4 h-4" /></Button>
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
            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('native.devtools')} title={t('native.devtools')} onClick={() => void nativeBrowser.devtools().catch(() => {})}><Wrench className="w-4 h-4" /></Button>
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

        {/* Hole — the native child webview is composited exactly over this div. */}
        <div ref={holeRef} className="relative flex-1 min-h-0 overflow-hidden">
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
