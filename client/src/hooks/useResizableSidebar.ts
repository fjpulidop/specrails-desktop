import { useCallback, useEffect, useRef, useState } from 'react'

interface Options {
  /** Which app edge the sidebar hugs — the drag grip sits on its INNER edge
   *  (right for a left sidebar, left for a right sidebar), so drag direction is
   *  mapped accordingly. */
  side: 'left' | 'right'
  defaultWidth: number
  min: number
  max: number
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const keyFor = (id: string) => `specrails-desktop:sidebar-width:${id}`

/**
 * Drag-to-resize width for a docked sidebar, persisted per key to localStorage.
 * Returns the current width + handlers for a `role="separator"` grip (pointer
 * drag + arrow-key resize). The width is committed to storage on drag/keys end
 * so a reload restores the last size. The consumer applies `width` as an inline
 * style ONLY when the sidebar is expanded (collapsed sidebars keep their fixed
 * narrow rail); the grip is rendered only when resizing is meaningful.
 */
export function useResizableSidebar(id: string, opts: Options) {
  const storageKey = keyFor(id)
  const [width, setWidth] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      const n = raw ? Number.parseInt(raw, 10) : Number.NaN
      if (Number.isFinite(n)) return clamp(n, opts.min, opts.max)
    } catch { /* storage unavailable */ }
    return opts.defaultWidth
  })
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startW = useRef(0)

  // Live pointer drag: map horizontal movement to width by side. A left
  // sidebar's grip is on its right edge (drag right → wider); a right sidebar's
  // grip is on its left edge (drag left → wider).
  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX.current
      const delta = opts.side === 'left' ? dx : -dx
      setWidth(clamp(startW.current + delta, opts.min, opts.max))
    }
    const onUp = () => setDragging(false)
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
    }
  }, [dragging, opts.side, opts.min, opts.max])

  // Persist once a gesture settles (never mid-drag — cheap + avoids churn).
  useEffect(() => {
    if (dragging) return
    try { localStorage.setItem(storageKey, String(Math.round(width))) } catch { /* ignore */ }
  }, [dragging, width, storageKey])

  const onGripPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    startX.current = e.clientX
    startW.current = width
    setDragging(true)
  }, [width])

  const onGripKeyDown = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 24 : 8
    // Arrow toward the app edge shrinks; away widens (side-aware).
    const grow = opts.side === 'left' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = opts.side === 'left' ? 'ArrowLeft' : 'ArrowRight'
    if (e.key === grow) { e.preventDefault(); setWidth((w) => clamp(w + step, opts.min, opts.max)) }
    else if (e.key === shrink) { e.preventDefault(); setWidth((w) => clamp(w - step, opts.min, opts.max)) }
    else if (e.key === 'Home') { e.preventDefault(); setWidth(opts.defaultWidth) }
  }, [opts.side, opts.min, opts.max, opts.defaultWidth])

  return { width, dragging, onGripPointerDown, onGripKeyDown }
}
