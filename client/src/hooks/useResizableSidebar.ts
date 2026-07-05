import { useCallback, useLayoutEffect, useRef, useState } from 'react'

interface Options {
  /** Which app edge the sidebar hugs — the drag grip sits on its INNER edge
   *  (right for a left sidebar, left for a right sidebar), so drag direction is
   *  mapped accordingly. */
  side: 'left' | 'right'
  defaultWidth: number
  min: number
  max: number
  /** The fixed narrow rail width when the sidebar is collapsed (e.g. 44 = w-11). */
  collapsedWidth: number
  /** Expanded ⇒ the resizable width applies; collapsed ⇒ the rail width. */
  expanded: boolean
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n))
const keyFor = (id: string) => `specrails-desktop:sidebar-width:${id}`

/**
 * Buttery, jank-free drag-to-resize for a docked sidebar, persisted per key.
 *
 * The width is driven ENTIRELY through the returned `panelRef` (imperative DOM
 * writes), NEVER through React's `style` prop — so:
 *  - a mousemove during the drag mutates `element.style.width` directly with
 *    `transition:none`, producing zero React re-renders (the heavy sidebar tree
 *    is never reconciled mid-drag → no stutter), and
 *  - an UNRELATED re-render (streaming, hover, a new conversation) can't reset
 *    the width and cause a jump, because React doesn't own that style key.
 * A `useLayoutEffect` applies the committed width (and animates collapse/expand
 * via the element's own CSS transition) whenever the drag is NOT in progress.
 * Only the final width is committed to state + localStorage, on pointer-up.
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

  const panelRef = useRef<HTMLDivElement | null>(null)
  const widthRef = useRef(width)
  widthRef.current = width
  const draggingRef = useRef(false)
  // Latest options in a ref so the pointer handlers (attached once per drag)
  // always read current values without re-binding.
  const optsRef = useRef(opts)
  optsRef.current = opts

  // Apply the COMMITTED width to the DOM (px) whenever it changes or the
  // expanded/collapsed state flips — but never while a drag owns the element.
  // The element keeps its CSS `transition` (className) so collapse/expand + a
  // keyboard nudge animate smoothly; a drag sets `transition:none` for itself.
  useLayoutEffect(() => {
    const el = panelRef.current
    if (!el || draggingRef.current) return
    el.style.width = `${opts.expanded ? width : opts.collapsedWidth}px`
  }, [width, opts.expanded, opts.collapsedWidth])

  const onGripPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 || !optsRef.current.expanded) return
    e.preventDefault()
    const el = panelRef.current
    if (!el) return
    const startX = e.clientX
    const startW = widthRef.current
    let live = startW

    draggingRef.current = true
    setDragging(true)
    // Kill the CSS transition so the panel tracks the pointer 1:1 (no easing
    // lag), and lock the cursor + selection globally for the whole gesture.
    el.style.transition = 'none'
    const prevCursor = document.body.style.cursor
    const prevSelect = document.body.style.userSelect
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    try { (e.target as Element).setPointerCapture?.(e.pointerId) } catch { /* older webview */ }

    const onMove = (ev: PointerEvent) => {
      const o = optsRef.current
      const dx = ev.clientX - startX
      const delta = o.side === 'left' ? dx : -dx
      live = clamp(startW + delta, o.min, o.max)
      // Imperative, per-frame-cheap: one style write, no React work.
      el.style.width = `${live}px`
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      el.style.transition = ''
      document.body.style.cursor = prevCursor
      document.body.style.userSelect = prevSelect
      draggingRef.current = false
      setDragging(false)
      setWidth(live) // single commit → one re-render, layoutEffect keeps the px
      try { localStorage.setItem(storageKey, String(Math.round(live))) } catch { /* ignore */ }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [storageKey])

  const onGripKeyDown = useCallback((e: React.KeyboardEvent) => {
    const o = optsRef.current
    const step = e.shiftKey ? 24 : 8
    const grow = o.side === 'left' ? 'ArrowRight' : 'ArrowLeft'
    const shrink = o.side === 'left' ? 'ArrowLeft' : 'ArrowRight'
    let next: number | null = null
    if (e.key === grow) next = clamp(widthRef.current + step, o.min, o.max)
    else if (e.key === shrink) next = clamp(widthRef.current - step, o.min, o.max)
    else if (e.key === 'Home') next = o.defaultWidth
    if (next === null) return
    e.preventDefault()
    setWidth(next)
    try { localStorage.setItem(storageKey, String(Math.round(next))) } catch { /* ignore */ }
  }, [storageKey])

  return { width, dragging, panelRef, onGripPointerDown, onGripKeyDown }
}
