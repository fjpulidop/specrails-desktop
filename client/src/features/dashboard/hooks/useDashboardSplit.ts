import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Resizable vertical split between the left (`SpecsBoard`) and right
 * (`RailsBoard`) panels of the dashboard.
 *
 * - The left-panel width in pixels is persisted per-project in `localStorage`
 *   under `specrails-desktop:dashboard-split:<projectId>`.
 * - The splitter is disabled on viewports below `DISABLE_BELOW_VIEWPORT_PX`
 *   wide; in that case the left panel takes 100% and `enabled` is `false`.
 * - The persisted value is clamped to `[MIN_LEFT_PX, viewport - MIN_RIGHT_PX]`
 *   on every mount and on viewport resize, and the clamped value is written
 *   back to disk so a stale stored value doesn't leave the panel off-screen.
 * - Snap zones: when a drag releases within `SNAP_TOLERANCE_PX` of any tier
 *   breakpoint, the value snaps exactly to that breakpoint.
 */

export const MIN_LEFT_PX = 320
export const MIN_RIGHT_PX = 280
export const DISABLE_BELOW_VIEWPORT_PX = 900
/**
 * The canonical default ratio is the strongest magnet on the splitter — a wider
 * tolerance than any other snap so the user feels the splitter "stick" to its
 * starting position when they drag close to it.
 */
export const DEFAULT_SNAP_TOLERANCE_PX = 48

function storageKey(projectId: string | null): string | null {
  return projectId ? `specrails-desktop:dashboard-split:${projectId}` : null
}

function loadStored(projectId: string | null): number | null {
  const key = storageKey(projectId)
  if (!key) return null
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function saveStored(projectId: string | null, width: number): void {
  const key = storageKey(projectId)
  if (!key) return
  try {
    localStorage.setItem(key, String(Math.round(width)))
  } catch {
    /* quota / private mode */
  }
}

function clampToViewport(width: number, viewport: number): number {
  const maxLeft = Math.max(MIN_LEFT_PX, viewport - MIN_RIGHT_PX)
  return Math.min(Math.max(width, MIN_LEFT_PX), maxLeft)
}

/** Default dashboard split ratio — left (Specs) share of the viewport. Specs get
 *  70% (rails ~30%) so the specs toolbar (tabs + filters + sort) isn't cramped. */
export const DEFAULT_LEFT_RATIO = 0.70

/**
 * Default splitter position the first time a project is opened (no stored
 * value). Uses the `DEFAULT_LEFT_RATIO` 70/30 split so the rails panel gets
 * roughly a third of the dashboard regardless of viewport size. Clamped to
 * `[MIN_LEFT_PX, viewport - MIN_RIGHT_PX]` so very narrow viewports still
 * honour the minimum gutters.
 */
export function computeDefaultLeftWidth(viewport: number): number {
  const preferred = Math.round(viewport * DEFAULT_LEFT_RATIO)
  return clampToViewport(preferred, viewport)
}

function snapToDefault(width: number, viewport: number): number {
  // Canonical default is the only magnet — sticks the splitter to the position
  // the user sees on first paint when they drag close to it.
  const defaultWidth = computeDefaultLeftWidth(viewport)
  if (Math.abs(width - defaultWidth) <= DEFAULT_SNAP_TOLERANCE_PX) return defaultWidth
  return width
}

interface UseDashboardSplitResult {
  /** Current left-panel width in pixels. `null` while the splitter is disabled. */
  leftWidth: number | null
  /** Whether the splitter is rendered for the current viewport. */
  enabled: boolean
  /** Begin tracking a pointer drag — call from the splitter handle's `onPointerDown`. */
  beginDrag: (e: React.PointerEvent | PointerEvent) => void
  /** Reset to the default 50/50 split. */
  resetToDefault: () => void
}

export function useDashboardSplit(
  projectId: string | null,
  containerRef?: RefObject<HTMLElement | null>,
): UseDashboardSplitResult {
  const [viewport, setViewport] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1200))
  const prevViewportRef = useRef<number>(viewport)
  const [leftWidth, setLeftWidth] = useState<number | null>(() => {
    if (typeof window === 'undefined') return null
    const initialViewport = window.innerWidth
    if (initialViewport < DISABLE_BELOW_VIEWPORT_PX) return null
    // Always open at the canonical "postit + compact rails" default so the
    // first paint matches what double-clicking the splitter restores to.
    // Persistence (`localStorage`) is only used for in-session drag state.
    return computeDefaultLeftWidth(initialViewport)
  })

  const dragRef = useRef<{
    pointerId: number
    element: HTMLElement
    startClientX: number
    startLeftWidth: number
  } | null>(null)
  const rafRef = useRef<number | null>(null)
  const pendingWidthRef = useRef<number | null>(null)

  // Re-resolve when the active project changes.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const el = containerRef?.current
    const v = el?.clientWidth || window.innerWidth
    setViewport(v)
    prevViewportRef.current = v
    if (v < DISABLE_BELOW_VIEWPORT_PX) {
      setLeftWidth(null)
      return
    }
    // Project switch (or initial mount): reset to the canonical default so
    // it matches the double-click target. localStorage is intentionally
    // ignored here — it's an in-session drag memory, not a remembered
    // start position.
    setLeftWidth(computeDefaultLeftWidth(v))
  }, [projectId, containerRef])

  // Container/window resize: re-clamp, toggle enabled-ness, and shift
  // `leftWidth` by the container's width delta so the rails (right) panel
  // preserves its pixel width when outer sidebars open/close.
  useEffect(() => {
    function applyViewport(v: number) {
      setViewport(v)
      if (v < DISABLE_BELOW_VIEWPORT_PX) {
        prevViewportRef.current = v
        setLeftWidth(null)
        return
      }
      const prev = prevViewportRef.current
      const delta = v - prev
      prevViewportRef.current = v
      setLeftWidth((prevLeft) => {
        const base = prevLeft ?? loadStored(projectId) ?? computeDefaultLeftWidth(v)
        // Shift by delta so rails panel keeps its current pixel width.
        const shifted = prevLeft !== null && Number.isFinite(delta) ? base + delta : base
        const clamped = clampToViewport(shifted, v)
        if (clamped !== prevLeft) saveStored(projectId, clamped)
        return clamped
      })
    }
    const el = containerRef?.current
    if (el && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver((entries) => {
        const w = entries[0]?.contentRect.width
        if (typeof w === 'number') applyViewport(w)
      })
      ro.observe(el)
      // Seed with current container width.
      applyViewport(el.clientWidth || window.innerWidth)
      return () => ro.disconnect()
    }
    function onResize() { applyViewport(window.innerWidth) }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [projectId, containerRef])

  const applyPending = useCallback(() => {
    rafRef.current = null
    if (pendingWidthRef.current === null) return
    const clamped = clampToViewport(pendingWidthRef.current, viewport)
    pendingWidthRef.current = null
    setLeftWidth(clamped)
  }, [viewport])

  const handleMove = useCallback((e: PointerEvent) => {
    if (!dragRef.current) return
    // Delta-from-start preserves the exact pixel relationship between the
    // cursor and the splitter handle: whatever offset existed at pointerdown
    // is reproduced for every subsequent pointermove.
    const delta = e.clientX - dragRef.current.startClientX
    pendingWidthRef.current = dragRef.current.startLeftWidth + delta
    if (rafRef.current === null) {
      rafRef.current = requestAnimationFrame(applyPending)
    }
  }, [applyPending])

  const handleUp = useCallback((_e: PointerEvent) => {
    if (!dragRef.current) return
    const { pointerId, element } = dragRef.current
    try { element.releasePointerCapture(pointerId) } catch { /* already released */ }
    dragRef.current = null
    window.removeEventListener('pointermove', handleMove)
    window.removeEventListener('pointerup', handleUp)
    window.removeEventListener('pointercancel', handleUp)
    setLeftWidth((prev) => {
      if (prev === null) return prev
      const snapped = snapToDefault(prev, viewport)
      const clamped = clampToViewport(snapped, viewport)
      saveStored(projectId, clamped)
      return clamped
    })
  }, [handleMove, projectId, viewport])

  const beginDrag = useCallback((e: React.PointerEvent | PointerEvent) => {
    const native = (e as React.PointerEvent).nativeEvent ?? (e as PointerEvent)
    const target = (e as React.PointerEvent).currentTarget as HTMLElement | undefined
    const element = target ?? (native.target as HTMLElement)
    try { element.setPointerCapture(native.pointerId) } catch { /* may fail in tests */ }
    // Anchor the drag on the current state — `handleMove` then applies the
    // raw `(clientX - startClientX)` delta to `startLeftWidth`, which keeps
    // the cursor pixel-locked to wherever the user grabbed the handle.
    dragRef.current = {
      pointerId: native.pointerId,
      element,
      startClientX: native.clientX,
      startLeftWidth: leftWidth ?? 0,
    }
    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
  }, [handleMove, handleUp, leftWidth])

  const resetToDefault = useCallback(() => {
    if (typeof window === 'undefined') return
    // Use the container's own clientWidth (same source the project-switch
    // effect uses) so a double-click restores the EXACT same width the user
    // sees on first paint. Falling back to window.innerWidth without this
    // produced a wider value than the container could fit when outer
    // sidebars were open — the initial view and the double-click view
    // visibly diverged.
    const el = containerRef?.current
    const v = el?.clientWidth || window.innerWidth
    if (v < DISABLE_BELOW_VIEWPORT_PX) return
    const next = computeDefaultLeftWidth(v)
    setLeftWidth(next)
    saveStored(projectId, next)
  }, [projectId, containerRef])

  const enabled = leftWidth !== null && viewport >= DISABLE_BELOW_VIEWPORT_PX

  return { leftWidth, enabled, beginDrag, resetToDefault }
}
