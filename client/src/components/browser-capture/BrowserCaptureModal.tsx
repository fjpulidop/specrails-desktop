import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Trans, useTranslation } from 'react-i18next'
import { ArrowLeft, ArrowRight, RotateCw, X, Crop, Loader2, Globe, AlertTriangle, Monitor, Tablet, Smartphone, Maximize2, Network, Ratio, ChevronRight, Lock, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { useBrowserCaptureSession } from './useBrowserCaptureSession'
import { useBrowserViewport } from './useBrowserViewport'
import { AnnotationEditor } from './AnnotationEditor'
import {
  mapPointToViewport,
  mapRectToDisplay,
  rectFromPoints,
  isUsableSelection,
  clampRectToViewport,
  createPointerInputCoalescer,
  popupOriginLabel,
  BREAKPOINT_DIMS,
  type CaptureRect,
  type CaptureResult,
  type BrowserInputEvent,
  type BreadcrumbSegment,
  type ElementProbe,
  type PointerInputCoalescer,
} from '../../lib/browser-capture'

/**
 * Detect Tauri-on-Mac. The overlay is portaled to <body> as `fixed inset-0`, so it
 * covers the custom titlebar and the native traffic-light controls (close/min/max)
 * float over its top-left. Reserve a left gutter there so the nav buttons clear them.
 */
function isMacTauriOverlay(): boolean {
  if (typeof window === 'undefined') return false
  if (!('__TAURI_INTERNALS__' in window)) return false
  return /mac/i.test(navigator.platform)
}

interface BrowserCaptureModalProps {
  open: boolean
  onClose: () => void
  projectId: string
  pendingSpecId: string
  onCaptured: (result: CaptureResult) => void | Promise<void>
  /** Label for the annotation editor's primary confirm button, so the caller can
   *  reflect context ("Crear spec" vs "Actualizar spec"). */
  confirmLabel?: string
  /** Label for the select-mode toggle button, so the caller can reflect its
   *  destination ("Select to create spec" vs "Select to add to mission"). */
  selectLabel?: string
}

interface SelectionBox {
  startX: number
  startY: number
  curX: number
  curY: number
}

type ViewportPreset = 'fit' | 'desktop' | 'tablet' | 'mobile'
const PRESET_DIMS: Record<Exclude<ViewportPreset, 'fit'>, { w: number; h: number }> = {
  desktop: { w: 1280, h: 800 },
  tablet: { w: 768, h: 1024 },
  mobile: { w: 375, h: 667 },
}

/**
 * Large in-app browser overlay for "Add Spec from browser": URL bar + navigation
 * + a Select-to-create-spec drag mode. The page is rendered from a CDP screencast
 * onto a canvas; in browse mode pointer/keyboard are forwarded to the page, in
 * select mode a drag rectangle is captured (screenshot + DOM) and handed back to
 * Add Spec. Excluded from coverage (canvas + WS + pointer drag is not jsdom-able).
 */
export function BrowserCaptureModal({ open, onClose, projectId, pendingSpecId, onCaptured, confirmLabel, selectLabel }: BrowserCaptureModalProps) {
  const { t } = useTranslation('browser')
  const session = useBrowserCaptureSession({ projectId, open })
  const { canvasRef, viewport, status, errorMsg, url, title, hoverRect, hoverSelector, hoverPath, popup, popupError } = session

  const [addressValue, setAddressValue] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [box, setBox] = useState<SelectionBox | null>(null)
  const [capturing, setCapturing] = useState(false)
  const [preset, setPreset] = useState<ViewportPreset>('fit')
  // Capture the page's XHR/fetch requests alongside the selection (ON by default;
  // a user can disable it for a privacy-sensitive page).
  const [captureNetwork, setCaptureNetwork] = useState(true)
  // Capture the selected element at desktop/tablet/mobile in one shot.
  const [captureAllSizes, setCaptureAllSizes] = useState(false)
  // When set, a single capture is frozen and the markup editor is shown over it.
  const [markup, setMarkup] = useState<CaptureResult | null>(null)
  // Last capture error, shown as a visible banner INSIDE the modal (a sonner toast
  // would be occluded by this z-[80] portal, so a failure looked like "nothing
  // happened"). Cleared when a new selection starts or a capture succeeds.
  const [captureError, setCaptureError] = useState<string | null>(null)
  // Breadcrumb lock: when the user steps up/down the DOM tree (arrows / clicking a
  // segment) the selection locks to that element until the cursor moves again.
  const [locked, setLocked] = useState<ElementProbe | null>(null)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const pendingMoveRef = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef<number | null>(null)
  // Browse-mode input coalescer: batches pointermove (newest-wins) and wheel
  // (deltas summed) onto animation frames before they cross the WS → CDP
  // boundary. Lazily (re)created so a StrictMode unmount/remount can't leave a
  // disposed instance behind; sends via a ref so it never sees a stale closure.
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
  const canvasRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const lastProbeAtRef = useRef(0)
  // Refs for the breadcrumb keyboard handler (avoid re-subscribing on every hover).
  const lockedRef = useRef<ElementProbe | null>(null)
  const hoverSelectorRef = useRef<string | null>(null)
  const navigateElementRef = useRef(session.navigateElement)
  useEffect(() => { lockedRef.current = locked }, [locked])
  useEffect(() => { hoverSelectorRef.current = hoverSelector }, [hoverSelector])
  navigateElementRef.current = session.navigateElement

  const visibleUrl = popup?.active ? popup.url ?? 'about:blank' : url ?? ''
  useEffect(() => { setAddressValue(visibleUrl) }, [visibleUrl, popup?.active])

  const go = useCallback(() => {
    const u = addressValue.trim()
    if (u) void session.navigate('goto', u)
  }, [addressValue, session])

  const { setViewport } = session
  const fixedViewport = preset === 'fit' ? undefined : { width: PRESET_DIMS[preset].w, height: PRESET_DIMS[preset].h }
  useBrowserViewport(containerRef, setViewport, open && !markup, fixedViewport)
  const applyPreset = useCallback((p: ViewportPreset) => {
    setPreset(p)
    if (p !== 'fit') setViewport(PRESET_DIMS[p].w, PRESET_DIMS[p].h)
  }, [setViewport])

  // Escape closes (when not mid-selection).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selecting) { setSelecting(false); setBox(null); setLocked(null) }
        else onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, selecting, onClose])

  // Breadcrumb navigation: ↑ = parent, ↓ = child of the locked-or-hovered element.
  // Locks the selection to the resolved element until the cursor moves again.
  useEffect(() => {
    if (!open || !selecting) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      const sel = lockedRef.current?.selector ?? hoverSelectorRef.current
      if (!sel) return
      e.preventDefault()
      void navigateElementRef.current(sel, e.key === 'ArrowUp' ? 'parent' : 'child').then((probe) => {
        if (probe) setLocked(probe)
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, selecting])

  // A popup taking over the view (OAuth login window) is not capturable — exit
  // select mode; the Select button is also disabled while the popup is viewed.
  useEffect(() => {
    if (popup?.active && selecting) {
      setSelecting(false)
      setBox(null)
      setLocked(null)
      session.clearHover()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popup?.active, selecting])

  const canvasRect = useCallback((): DOMRect | null => {
    const r = canvasRef.current?.getBoundingClientRect() ?? null
    // Cache for the hover-highlight so we never measure layout during render.
    if (r) canvasRectRef.current = { left: r.left, top: r.top, width: r.width, height: r.height }
    return r
  }, [canvasRef])

  const toViewport = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRect()
    if (!rect) return { x: 0, y: 0 }
    return mapPointToViewport({ x: clientX, y: clientY }, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, viewport)
  }, [canvasRect, viewport])

  // ─── Browse-mode interaction (forward to page, rAF-coalesced) ────────────────

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (selecting) return
    const p = toViewport(e.clientX, e.clientY)
    getCoalescer().move(p.x, p.y)
  }, [selecting, toViewport, getCoalescer])

  const buttonOf = (b: number): 'left' | 'middle' | 'right' => (b === 2 ? 'right' : b === 1 ? 'middle' : 'left')

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (selecting) return
    const p = toViewport(e.clientX, e.clientY)
    // Position the cursor exactly at the click point and flush any coalesced
    // input BEFORE the click, so ordering + click precision are guaranteed.
    const c = getCoalescer()
    c.move(p.x, p.y)
    c.flush()
    session.forwardInput({ type: 'mouse', action: 'down', x: p.x, y: p.y, button: buttonOf(e.button), clickCount: e.detail || 1 })
  }, [selecting, toViewport, session, getCoalescer])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (selecting) return
    const p = toViewport(e.clientX, e.clientY)
    const c = getCoalescer()
    c.move(p.x, p.y)
    c.flush()
    session.forwardInput({ type: 'mouse', action: 'up', x: p.x, y: p.y, button: buttonOf(e.button), clickCount: e.detail || 1 })
  }, [selecting, toViewport, session, getCoalescer])

  const onWheel = useCallback((e: React.WheelEvent) => {
    if (selecting) return
    const p = toViewport(e.clientX, e.clientY)
    // Coalesced: a macOS trackpad emits wheel at 60–120 Hz; summing deltas into
    // ≤1 wheel message per frame keeps total scroll distance while cutting the
    // WS + CDP command volume ~2–5× (the single biggest scroll-lag lever).
    getCoalescer().wheel(p.x, p.y, e.deltaX, e.deltaY)
  }, [selecting, toViewport, getCoalescer])

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (selecting || e.key === 'Escape') return
    const meta = e.metaKey || e.ctrlKey
    // Clipboard bridge: the embedded headless page can't reach the OS clipboard,
    // so ⌘/Ctrl+C/X read the page selection into the host clipboard and ⌘/Ctrl+V
    // injects the host clipboard text into the page.
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
        } catch {
          /* clipboard permission denied / unavailable — ignore */
        }
      })()
      return
    }
    // Don't type the letter of an unhandled ⌘/Ctrl combo (e.g. ⌘A) into the page.
    const ev: BrowserInputEvent = { type: 'key', action: 'down', key: e.key, code: e.code, text: !meta && e.key.length === 1 ? e.key : undefined }
    session.forwardInput(ev)
    if (e.key === 'Tab' || e.key === ' ' || e.key.startsWith('Arrow')) e.preventDefault()
  }, [selecting, session])

  const onKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (selecting || e.key === 'Escape') return
    session.forwardInput({ type: 'key', action: 'up', key: e.key, code: e.code })
  }, [selecting, session])

  // ─── Select mode: hover-to-select an element, or drag a custom rectangle ──────

  const runCapture = useCallback(async (rawRect: CaptureRect) => {
    // Clamp into the viewport so a hovered/locked element rect that starts off-screen
    // (negative x/y) or overflows the viewport never trips the server's parseRect
    // guard → "Capture failed (400)". A real drag is already clamped by toViewport.
    const rect = clampRectToViewport(rawRect, viewport)
    setCapturing(true)
    setCaptureError(null)
    try {
      if (captureAllSizes) {
        // Multi-breakpoint = 3 reference images; no markup step.
        const anchorPoint = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
        const result = await session.captureBreakpoints(rect, anchorPoint, pendingSpecId, BREAKPOINT_DIMS)
        await onCaptured(result)
        toast.success(t('modal.toast.captured'))
        onClose()
      } else {
        // Freeze the single capture and hand it to the in-place markup editor.
        const result = await session.capture(rect, pendingSpecId, { captureNetwork })
        setMarkup(result)
      }
    } catch (err) {
      // Surface the REAL failure (with its HTTP status) inside the modal — a
      // sonner toast here is painted under the z-[80] portal and never seen.
      const detail = err instanceof Error ? err.message : String(err)
      setCaptureError(detail)
      toast.error(t('modal.toast.captureFailed'))
    } finally {
      setCapturing(false)
      setSelecting(false)
      setBox(null)
      setLocked(null)
      session.clearHover()
    }
  }, [session, pendingSpecId, captureNetwork, captureAllSizes, onCaptured, onClose, t, viewport])

  const onBreadcrumbClick = useCallback((segment: BreadcrumbSegment) => {
    void session.navigateElement(segment.selector, 'self').then((probe) => { if (probe) setLocked(probe) })
  }, [session])

  const onSelectDown = useCallback((e: React.PointerEvent) => {
    ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    setCaptureError(null) // clear any stale failure banner on a fresh selection
    setBox({ startX: e.clientX, startY: e.clientY, curX: e.clientX, curY: e.clientY })
  }, [])

  const onSelectMove = useCallback((e: React.PointerEvent) => {
    if (box) {
      const cx = e.clientX, cy = e.clientY
      setBox((b) => (b ? { ...b, curX: cx, curY: cy } : b))
      return
    }
    // Moving the cursor over the page resumes live hover (drops a breadcrumb lock).
    if (lockedRef.current) setLocked(null)
    // Not dragging → hover-probe the element under the cursor (throttled: at most
    // one probe per animation frame AND no more often than every 40ms, to avoid
    // flooding the WS / the page's elementFromPoint on fast movement).
    const p = toViewport(e.clientX, e.clientY)
    pendingMoveRef.current = p
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
        if (now - lastProbeAtRef.current < 40) return
        lastProbeAtRef.current = now
        const pt = pendingMoveRef.current
        if (pt) session.probe(pt)
      })
    }
  }, [box, toViewport, session])

  const onSelectUp = useCallback((e: React.PointerEvent) => {
    const lk = lockedRef.current
    setBox(null)
    if (!box) return
    const a = toViewport(box.startX, box.startY)
    const c = toViewport(e.clientX, e.clientY)
    const dragRect = rectFromPoints(a, c)
    // Network work belongs to the event, not a React updater: StrictMode may
    // replay an updater and used to capture the same selection twice.
    if (isUsableSelection(dragRect)) {
      void runCapture(dragRect)
    } else if (lk) {
      void runCapture(lk.rect)
    } else if (hoverRect) {
      void runCapture(hoverRect)
    }
  }, [box, toViewport, hoverRect, runCapture])

  const onBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }, [onClose])

  if (!open || typeof document === 'undefined') return null

  const selectionStyle = box
    ? {
        left: Math.min(box.startX, box.curX),
        top: Math.min(box.startY, box.curY),
        width: Math.abs(box.startX - box.curX),
        height: Math.abs(box.startY - box.curY),
      }
    : null

  // DevTools-style highlight of the element under the cursor (select mode, not
  // mid-drag). Uses the canvas rect cached during the last pointer move so we
  // never measure layout during the render phase.
  const cr = canvasRectRef.current
  const activeRect = locked?.rect ?? hoverRect
  const activePath = locked?.path ?? hoverPath
  const hoverStyle = selecting && activeRect && !box && cr
    ? mapRectToDisplay(activeRect, cr, viewport)
    : null

  const macOverlay = isMacTauriOverlay()

  return createPortal(
    // Translucent backdrop gutter — clicking it closes the capture modal and
    // returns to Add Spec. The Add Spec modal stays mounted underneath.
    <div
      className="fixed inset-0 z-[80] bg-background-deep/60 backdrop-blur-md pointer-events-auto"
      onClick={onBackdropClick}
    >
      {/* Large MODAL panel (not full-bleed): a visible rim of the app around it
          keeps the browser readable as part of Specrails. stopPropagation so
          only clicking the gutter (outside this div) triggers backdrop close. */}
      <div
        className="absolute inset-x-[4%] inset-y-[3.5%] flex flex-col border border-border/70 rounded-2xl bg-background-deep overflow-hidden shadow-2xl ring-1 ring-black/20"
        role="dialog"
        aria-modal="true"
        aria-label={t('modal.dialogLabel')}
        onClick={(e) => e.stopPropagation()}
      >
      {markup ? (
        <AnnotationEditor
          result={markup}
          pendingSpecId={pendingSpecId}
          macOverlay={macOverlay}
          confirmLabel={confirmLabel}
          onConfirm={async (aug) => { await onCaptured(aug); onClose() }}
          onReselect={() => { setMarkup(null); setSelecting(true) }}
          onCancel={() => { setMarkup(null); onClose() }}
        />
      ) : (
      <>
      {captureError && (
        <div role="alert" data-testid="capture-error-banner" className="flex items-center gap-2 px-3 py-2 text-xs bg-destructive/10 text-destructive border-b border-destructive/30 shrink-0">
          <span className="font-medium">{t('modal.toast.captureFailed')}</span>
          <span className="opacity-80 font-mono truncate">{captureError}</span>
        </div>
      )}
      {/* Toolbar */}
      <div className={`flex items-center gap-2 py-1.5 border-b border-border/50 bg-surface/80 shrink-0 ${macOverlay ? 'pr-3' : 'px-3'}`}>
        {/* On macOS desktop the native traffic-light controls float over the top-left;
            this drag-region gutter reserves their space and keeps the window movable. */}
        {macOverlay && <div data-tauri-drag-region className="w-20 self-stretch shrink-0" aria-hidden />}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('common:actions.back')} onClick={() => session.navigate('back')}><ArrowLeft className="w-4 h-4" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.nav.forward')} onClick={() => session.navigate('forward')}><ArrowRight className="w-4 h-4" /></Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.nav.reload')} onClick={() => session.navigate('reload')}><RotateCw className="w-4 h-4" /></Button>
        </div>
        <form
          className="flex-1 flex items-center gap-2 min-w-0"
          onSubmit={(e) => { e.preventDefault(); go() }}
        >
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
        <div className="hidden md:flex items-center gap-0.5 rounded-md border border-border/50 p-0.5 shrink-0" role="group" aria-label={t('modal.viewport.groupLabel')}>
          {([['fit', Maximize2], ['desktop', Monitor], ['tablet', Tablet], ['mobile', Smartphone]] as const).map(([p, Icon]) => (
            <button
              key={p}
              type="button"
              aria-label={t('modal.viewport.presetLabel', { preset: t(`modal.viewport.${p}`) })}
              aria-pressed={preset === p}
              title={t('modal.viewport.presetTitle', { preset: t(`modal.viewport.${p}`) })}
              onClick={() => applyPreset(p)}
              className={`h-7 w-7 inline-flex items-center justify-center rounded transition-colors ${preset === p ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-card/60'}`}
            >
              <Icon className="w-3.5 h-3.5" />
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={t('modal.network.ariaLabel')}
          aria-pressed={captureNetwork}
          title={captureNetwork ? t('modal.network.titleOn') : t('modal.network.titleOff')}
          onClick={() => setCaptureNetwork((v) => !v)}
          className={`hidden md:inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[11px] shrink-0 transition-colors ${captureNetwork ? 'border-accent-info/40 bg-accent-info/10 text-accent-info' : 'border-border/50 text-muted-foreground hover:text-foreground hover:bg-card/60'}`}
        >
          <Network className="w-3.5 h-3.5" />
          {t('modal.network.button')}
        </button>
        <button
          type="button"
          aria-label={t('modal.allSizes.ariaLabel')}
          aria-pressed={captureAllSizes}
          title={captureAllSizes ? t('modal.allSizes.titleOn') : t('modal.allSizes.titleOff')}
          onClick={() => setCaptureAllSizes((v) => !v)}
          className={`hidden md:inline-flex items-center gap-1 h-7 px-2 rounded-md border text-[11px] shrink-0 transition-colors ${captureAllSizes ? 'border-accent-highlight/40 bg-accent-highlight/10 text-accent-highlight' : 'border-border/50 text-muted-foreground hover:text-foreground hover:bg-card/60'}`}
        >
          <Ratio className="w-3.5 h-3.5" />
          {t('modal.allSizes.button')}
        </button>
        <Button
          size="sm"
          variant={selecting ? 'default' : 'secondary'}
          className="gap-1.5"
          onClick={() => { setSelecting((v) => !v); setBox(null); setLocked(null); session.clearHover() }}
          disabled={status !== 'ready' || capturing || popup?.active === true}
          data-testid="browser-select-toggle"
        >
          <Crop className="w-3.5 h-3.5" />
          {selecting ? t('modal.select.active') : (selectLabel ?? t('modal.select.start'))}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={t('modal.closeBrowser')} onClick={onClose}><X className="w-4 h-4" /></Button>
      </div>

      <div className="px-3 py-1 text-[11px] text-muted-foreground truncate shrink-0 flex items-center gap-2">
        <span
          className={`inline-block w-2 h-2 rounded-full shrink-0 ${status === 'ready' ? 'bg-accent-success' : status === 'error' ? 'bg-destructive' : 'bg-accent-warning animate-pulse'}`}
          aria-hidden
        />
        <span className="truncate">
          {status === 'connecting' ? t('modal.status.connecting') : status === 'error' ? (errorMsg ?? t('modal.status.unavailable')) : popup?.active ? t('popup.loginWindow', { origin: popupOriginLabel(popup.url) }) : (title || '')}
        </span>
      </div>

      {/* Popup (OAuth login window) bar: while a popup is viewed, the screencast +
          input target the popup; "Back to page" returns to the opener without
          closing the popup. When the popup self-closes (typical OAuth), the
          server auto-returns and this bar disappears. */}
      {popupError && <div role="alert" className="px-3 py-1.5 text-xs text-destructive border-b border-border/40 shrink-0">{popupError}</div>}
      {popup && (
        <div
          data-testid="browser-popup-bar"
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

      {/* Viewport. tabIndex + key handlers live here so the canvas can be a direct
          flex child — that keeps the max-h-full chain intact so the frame scales
          to fit instead of overflowing at its intrinsic pixel size. */}
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
            <p className="text-xs text-muted-foreground"><Trans i18nKey="modal.error.devHint" t={t} components={{ cmd: <code className="font-mono" /> }} /></p>
          </div>
        ) : (
          <>
            {/* Interactive canvas (browse mode forwards input to the page). Direct
                flex child of the definite-height container so max-w/h-full scale
                the frame to fit, preserving aspect. */}
            <canvas
              ref={canvasRef}
              style={{ maxWidth: `min(100%, ${viewport.width}px)`, maxHeight: `min(100%, ${viewport.height}px)` }}
              className={`max-w-full max-h-full block shadow-2xl ${selecting ? 'cursor-crosshair' : 'cursor-default'}`}
              onPointerMove={onPointerMove}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onContextMenu={(e) => e.preventDefault()}
              onWheel={onWheel}
            />
            {/* Selection capture layer — covers the whole viewport; coordinates are
                mapped via the canvas's displayed rect so off-canvas points clamp. */}
            {selecting && (
              <div
                className="absolute inset-0 cursor-crosshair"
                onPointerDown={onSelectDown}
                onPointerMove={onSelectMove}
                onPointerUp={onSelectUp}
              />
            )}

            {status === 'connecting' && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> {t('modal.status.opening')}
              </div>
            )}
            {capturing && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-foreground bg-background-deep/40">
                <Loader2 className="w-4 h-4 animate-spin" /> {t('modal.status.capturing')}
              </div>
            )}
          </>
        )}

        {/* Hover highlight of the element under the cursor (DevTools-style) */}
        {hoverStyle && (
          <div
            className="fixed border-2 border-accent-info bg-accent-info/10 pointer-events-none z-[81]"
            style={{ left: hoverStyle.left, top: hoverStyle.top, width: hoverStyle.width, height: hoverStyle.height }}
          />
        )}

        {/* Selection rectangle (fixed-positioned over the whole overlay) */}
        {selectionStyle && (
          <div
            className="fixed border-2 border-accent-primary bg-accent-primary/10 pointer-events-none z-[81]"
            style={selectionStyle}
          />
        )}
      </div>

      {selecting && activePath && activePath.length > 0 && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-t border-border/40 bg-surface/70 shrink-0 overflow-x-auto text-[11px]">
          {locked ? <Lock className="w-3 h-3 shrink-0 text-accent-info" /> : null}
          {activePath.map((seg, i) => (
            <Fragment key={`${seg.selector}-${i}`}>
              {i > 0 && <ChevronRight className="w-3 h-3 text-muted-foreground/50 shrink-0" />}
              <button
                type="button"
                onClick={() => onBreadcrumbClick(seg)}
                title={seg.selector}
                className={`shrink-0 font-mono px-1 rounded hover:bg-card/60 transition-colors ${i === activePath.length - 1 ? 'text-accent-info font-medium' : 'text-foreground/70'}`}
              >
                {seg.label}
              </button>
            </Fragment>
          ))}
          <span className="text-muted-foreground/60 shrink-0 ml-auto pl-2 hidden md:inline">{t('modal.breadcrumb.hint')}</span>
        </div>
      )}

      {selecting && (
        <div className="px-3 py-1.5 text-center text-[11px] text-muted-foreground border-t border-border/40 shrink-0">
          {t('modal.select.hint')}
        </div>
      )}
      </>
      )}
      </div>
    </div>,
    document.body,
  )
}
