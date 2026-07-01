import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { MODAL_FLOAT_VIEWPORT_MIN } from '../lib/viewport'
import {
  arrowDelta,
  centerGeom,
  clampPosition,
  computeMove,
  computeResize,
  computeResizeExtreme,
  gripAriaOrientation,
  gripStyle,
  GRIP_POSITIONS,
  seedFromRect,
  type GripPosition,
  type ModalGeometry,
  type Viewport,
} from '../lib/modal-geometry'

const KEY_STEP = 16
const KEY_STEP_LARGE = 64
/**
 * Only the top band of the panel initiates a move. This keeps the modal BODY
 * free for clicks/text-selection while still letting the user grab the header
 * area to reposition — whether `headerHandleProps` is spread on a dedicated
 * header (always within the band) or on the whole panel.
 */
const MOVE_HANDLE_BAND = 64

export interface UseMovableResizableModalOptions {
  /** Master switch (e.g. `false` for embedded modals). Defaults to `true`. */
  enabled?: boolean
  /** When `false`, the header move surface is inert (resize-only). Defaults to `true`. */
  allowMove?: boolean
  minWidth?: number
  minHeight?: number
  /**
   * On the FIRST drag, seed the float geometry from the panel's CURRENT on-screen
   * rect instead of re-centering it. Use for panels that don't start centered
   * (e.g. a bottom-right agent chat) so a click on the header doesn't jump them
   * to the middle. Default `false` (center — correct for centered modals).
   */
  anchorFromCurrentRect?: boolean
  /**
   * When set, the panel's floating geometry (position + size) is persisted to
   * localStorage under this key and restored on next mount — so a panel reopened
   * from a bubble/trigger reappears where it was left.
   */
  persistKey?: string
}

export interface ResizeHandleProps {
  position: GripPosition
  role: 'separator'
  'aria-orientation': 'horizontal' | 'vertical'
  tabIndex: 0
  /** Fixed-position placement mirroring the panel edge. */
  style: CSSProperties
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
}

export interface UseMovableResizableModalResult {
  /** Callback ref — attach to the panel element. */
  panelRef: React.RefCallback<HTMLDivElement>
  /** Empty until the user first moves/resizes; then fixed inline geometry. */
  panelStyle: CSSProperties
  /** Spread on the header drag-zone (no-op props when move disabled). */
  headerHandleProps: { onPointerDown: (e: React.PointerEvent<HTMLElement>) => void }
  resizeHandles: ResizeHandleProps[]
  isFloating: boolean
  /** Effective enabled (option AND viewport gate). */
  enabled: boolean
  reset: () => void
  /** Wrap a backdrop click handler to ignore the click that ends a drag/resize. */
  guardBackdrop: <T extends (...args: never[]) => void>(cb: T) => (...args: Parameters<T>) => void
}

type DragState =
  | { mode: 'move'; startX: number; startY: number; startGeom: ModalGeometry; pointerId: number; element: HTMLElement }
  | { mode: 'resize'; position: GripPosition; startX: number; startY: number; startGeom: ModalGeometry; pointerId: number; element: HTMLElement }

function readViewport(): Viewport {
  if (typeof window === 'undefined') return { width: 0, height: 0 }
  return { width: window.innerWidth, height: window.innerHeight }
}

const INTERACTIVE_SELECTOR = 'button, input, textarea, select, a, [role="button"], [contenteditable="true"]'

/**
 * Make a modal panel movable (drag the header) and resizable (8 grips) while
 * defaulting to its current centered CSS layout — `panelStyle` is empty until
 * the first interaction, so an untouched modal is byte-identical to before.
 *
 * Geometry math lives in `lib/modal-geometry`; this hook owns the React state,
 * pointer-capture lifecycle (jsdom-safe), rAF throttling, the 900px viewport
 * gate, and keyboard resize.
 */
export function useMovableResizableModal(
  options: UseMovableResizableModalOptions = {},
): UseMovableResizableModalResult {
  const { enabled: enabledOption = true, allowMove = true, minWidth = 320, minHeight = 200, anchorFromCurrentRect = false, persistKey } = options

  const panelNodeRef = useRef<HTMLDivElement | null>(null)
  const [panelNode, setPanelNode] = useState<HTMLDivElement | null>(null)
  const panelRef = useCallback<React.RefCallback<HTMLDivElement>>((node) => {
    panelNodeRef.current = node
    setPanelNode(node)
  }, [])
  const [geom, setGeom] = useState<ModalGeometry | null>(() => {
    if (!persistKey || typeof window === 'undefined') return null
    try {
      const raw = window.localStorage.getItem(persistKey)
      if (!raw) return null
      const g = JSON.parse(raw) as ModalGeometry
      if ([g?.x, g?.y, g?.w, g?.h].every((n) => typeof n === 'number' && Number.isFinite(n)) && g.w > 0 && g.h > 0) {
        return clampPosition(g, readViewport()) // clamp into the current viewport
      }
    } catch {
      /* ignore corrupt value */
    }
    return null
  })
  const [panelRect, setPanelRect] = useState<ModalGeometry | null>(null)
  const [viewportOk, setViewportOk] = useState<boolean>(
    () => typeof window === 'undefined' || window.innerWidth >= MODAL_FLOAT_VIEWPORT_MIN,
  )

  const dragRef = useRef<DragState | null>(null)
  const geomRef = useRef<ModalGeometry | null>(null)
  const rafRef = useRef(false)
  const pendingRef = useRef<ModalGeometry | null>(null)
  const wasDraggingRef = useRef(false)

  geomRef.current = geom
  const bounds = { minWidth, minHeight }
  const effectiveEnabled = enabledOption && viewportOk

  // ─── Viewport gate: auto-collapse a floating modal below the threshold ──────
  useEffect(() => {
    function onResize() {
      const ok = window.innerWidth >= MODAL_FLOAT_VIEWPORT_MIN
      setViewportOk(ok)
      if (!ok) setGeom(null)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!enabledOption) setGeom(null)
  }, [enabledOption])

  // Persist the floating geometry so a reopened panel restores its place. Only
  // non-null geom is written (a transient null from a viewport/disable reset must
  // not wipe the saved position).
  useEffect(() => {
    if (!persistKey || typeof window === 'undefined' || !geom) return
    try {
      window.localStorage.setItem(persistKey, JSON.stringify(geom))
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [geom, persistKey])

  // ─── Measure the centered panel so grips can overlay it before any drag ─────
  // (Grips are a viewport-fixed overlay, independent of the modal's internal
  //  layout/scroll. When floating we use `geom` instead.)
  useEffect(() => {
    if (!effectiveEnabled || geom !== null) {
      setPanelRect(null)
      return
    }
    const el = panelNodeRef.current
    if (!el) return
    const measure = () => setPanelRect(seedFromRect(el.getBoundingClientRect()))
    measure()
    let ro: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [effectiveEnabled, geom, panelNode])

  const flush = useCallback((next: ModalGeometry) => {
    pendingRef.current = next
    if (rafRef.current) return
    rafRef.current = true
    requestAnimationFrame(() => {
      rafRef.current = false
      if (pendingRef.current) setGeom(pendingRef.current)
    })
  }, [])

  // ─── Pointer drag lifecycle (shared by move + resize) ───────────────────────
  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      const vp = readViewport()
      const dx = e.clientX - drag.startX
      const dy = e.clientY - drag.startY
      const next =
        drag.mode === 'move'
          ? computeMove(drag.startGeom, dx, dy, vp)
          : computeResize(drag.startGeom, drag.position, dx, dy, vp, bounds)
      flush(next)
    },
    [flush, bounds.minWidth, bounds.minHeight], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const endDrag = useCallback(() => {
    const drag = dragRef.current
    if (!drag) return
    try { drag.element.releasePointerCapture(drag.pointerId) } catch { /* already released */ }
    dragRef.current = null
    wasDraggingRef.current = true
    // Clear the backdrop-suppression flag on the next tick.
    setTimeout(() => { wasDraggingRef.current = false }, 0)
    if (pendingRef.current) setGeom(pendingRef.current)
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', endDrag)
    window.removeEventListener('pointercancel', endDrag)
  }, [onPointerMove])

  const beginDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>, build: (startGeom: ModalGeometry) => DragState) => {
      if (!effectiveEnabled || e.button !== 0) return
      const el = panelNodeRef.current
      if (!el) return
      let startGeom = geomRef.current
      if (!startGeom) {
        const rect = el.getBoundingClientRect()
        // Guard against a degenerate (not-yet-laid-out / hidden) measurement —
        // seeding {0,0,0,0} would jam the modal into the top-left corner.
        if (rect.width <= 0 || rect.height <= 0) return
        // Anchor from the panel's current on-screen position (for non-centered
        // panels), else center by size (NOT rect.left/top) so a mid-animation
        // transform can't skew a centered modal into the corner.
        startGeom = clampPosition(
          anchorFromCurrentRect ? seedFromRect(rect) : centerGeom(rect, readViewport()),
          readViewport(),
        )
      }
      geomRef.current = startGeom
      pendingRef.current = startGeom
      const drag = build(startGeom)
      dragRef.current = drag
      try { drag.element.setPointerCapture(drag.pointerId) } catch { /* jsdom */ }
      // Make the modal floating immediately so the seed geometry is applied
      // before the first pointermove (no visual jump from the centered layout).
      setGeom(startGeom)
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', endDrag)
      window.addEventListener('pointercancel', endDrag)
    },
    [effectiveEnabled, onPointerMove, endDrag, anchorFromCurrentRect],
  )

  const onHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      if (!allowMove) return
      const target = e.target as HTMLElement
      if (target.closest(INTERACTIVE_SELECTOR)) return
      // Only the top band of the panel is a move surface — keeps the body free.
      const panel = panelNodeRef.current
      if (panel && e.clientY - panel.getBoundingClientRect().top > MOVE_HANDLE_BAND) return
      beginDrag(e, (startGeom) => ({
        mode: 'move',
        startX: e.clientX,
        startY: e.clientY,
        startGeom,
        pointerId: e.pointerId,
        element: e.currentTarget,
      }))
    },
    [allowMove, beginDrag],
  )

  const onGripPointerDown = useCallback(
    (position: GripPosition) => (e: React.PointerEvent<HTMLElement>) => {
      e.stopPropagation()
      beginDrag(e, (startGeom) => ({
        mode: 'resize',
        position,
        startX: e.clientX,
        startY: e.clientY,
        startGeom,
        pointerId: e.pointerId,
        element: e.currentTarget,
      }))
    },
    [beginDrag],
  )

  const reset = useCallback(() => setGeom(null), [])

  const guardBackdrop = useCallback(
    <T extends (...args: never[]) => void>(cb: T) =>
      (...args: Parameters<T>) => {
        if (wasDraggingRef.current) return
        cb(...args)
      },
    [],
  )

  const onGripKeyDown = useCallback(
    (position: GripPosition) => (e: React.KeyboardEvent<HTMLElement>) => {
      if (!effectiveEnabled) return
      if (e.key === '0') { e.preventDefault(); reset(); return }
      const el = panelNodeRef.current
      if (!el) return
      const vp = readViewport()
      const start = geomRef.current ?? seedFromRect(el.getBoundingClientRect())
      if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        setGeom(computeResizeExtreme(start, position, e.key === 'Home' ? 'min' : 'max', vp, bounds))
        return
      }
      const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP
      const delta = arrowDelta(position, e.key, step)
      if (!delta) return
      e.preventDefault()
      setGeom(computeResize(start, position, delta.dx, delta.dy, vp, bounds))
    },
    [effectiveEnabled, reset, bounds.minWidth, bounds.minHeight], // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Re-clamp to the viewport when it shrinks while floating (size + position).
  useEffect(() => {
    if (!geom || !viewportOk) return
    function onResize() {
      const current = geomRef.current
      if (!current) return
      setGeom(clampPosition(current, readViewport()))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [geom, viewportOk])

  // Unmount safety net: clear listeners + capture if we unmount mid-drag.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      const drag = dragRef.current
      if (drag) {
        try { drag.element.releasePointerCapture(drag.pointerId) } catch { /* already released */ }
        dragRef.current = null
      }
    }
  }, [onPointerMove, endDrag])

  const isFloating = effectiveEnabled && geom !== null

  const panelStyle: CSSProperties =
    isFloating && geom
      ? {
          position: 'fixed',
          left: geom.x,
          top: geom.y,
          width: geom.w,
          height: geom.h,
          maxWidth: 'none',
          maxHeight: 'none',
          margin: 0,
          transform: 'none',
          // Kill any lingering entry animation so it can't override the fixed
          // position with its own transform keyframes.
          animation: 'none',
        }
      : {}

  const gripRect = isFloating ? geom : panelRect
  const resizeHandles: ResizeHandleProps[] =
    effectiveEnabled && gripRect
      ? GRIP_POSITIONS.map((position) => ({
          position,
          role: 'separator' as const,
          'aria-orientation': gripAriaOrientation(position),
          tabIndex: 0 as const,
          style: { position: 'fixed', ...gripStyle(position, gripRect) },
          onPointerDown: onGripPointerDown(position),
          onKeyDown: onGripKeyDown(position),
        }))
      : []

  return {
    panelRef,
    panelStyle,
    headerHandleProps: { onPointerDown: onHeaderPointerDown },
    resizeHandles,
    isFloating,
    enabled: effectiveEnabled,
    reset,
    guardBackdrop,
  }
}

/** Expose for tests / consumers that need to read the suppression flag. */
export { KEY_STEP, KEY_STEP_LARGE }
