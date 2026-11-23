// Surfaces docked at the bottom of a page (a run's pause card, its question,
// its composer) register here; the floating agent bubble keeps clear of them.
import { useCallback, useEffect, useRef } from 'react'

const elements = new Set<HTMLElement>()
const listeners = new Set<() => void>()
const notify = () => { for (const listener of listeners) listener() }

let observer: ResizeObserver | null = null
function resizeObserver(): ResizeObserver | null {
  if (observer || typeof ResizeObserver === 'undefined') return observer
  observer = new ResizeObserver(notify)
  return observer
}

/** Subscribe to changes of the registered surfaces (added, removed, resized). */
export function subscribeBubbleAvoid(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The visible rectangles the bubble must keep clear of. */
export function bubbleAvoidRects(): DOMRect[] {
  return [...elements].filter((element) => element.isConnected).map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
}

/** A ref for a bottom-docked surface the agent bubble should not cover. */
export function useBubbleAvoid<T extends HTMLElement>(): (element: T | null) => void {
  const current = useRef<T | null>(null)
  useEffect(() => () => {
    if (current.current) { elements.delete(current.current); resizeObserver()?.unobserve(current.current); notify() }
  }, [])
  return useCallback((element: T | null) => {
    if (current.current === element) return
    if (current.current) { elements.delete(current.current); resizeObserver()?.unobserve(current.current) }
    current.current = element
    if (element) { elements.add(element); resizeObserver()?.observe(element) }
    notify()
  }, [])
}

/**
 * The top a `size`-square bubble at `top`/`left` should take so it covers no
 * registered surface: just above the highest one it overlaps, never above
 * `minTop`. Pure over the rectangles it is given.
 */
export function avoidTop(bubble: { left: number; top: number; size: number }, rects: ReadonlyArray<Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>>, minTop: number, gap = 8): number {
  let top = bubble.top
  // A lift can bring the bubble onto another surface above; settle in a few passes.
  for (let pass = 0; pass < 4; pass++) {
    const hit = rects.filter((rect) => bubble.left < rect.right && bubble.left + bubble.size > rect.left && top < rect.bottom + gap && top + bubble.size > rect.top - gap)
    if (hit.length === 0) break
    top = Math.min(...hit.map((rect) => rect.top - gap - bubble.size))
  }
  return Math.max(minTop, top)
}
