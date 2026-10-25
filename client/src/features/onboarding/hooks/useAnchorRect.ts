import { useEffect, useState } from 'react'

export interface AnchorRect { top: number; left: number; width: number; height: number }

/**
 * The viewport rect of the first element matching `selector`, kept fresh while
 * `enabled`. The guide points at real board elements; when the element is not on
 * screen (another page, Mission mode) it reports null and the guide still reads
 * fine without the highlight.
 */
export function useAnchorRect(selector: string | null, enabled: boolean): AnchorRect | null {
  const [rect, setRect] = useState<AnchorRect | null>(null)
  useEffect(() => {
    if (!enabled || !selector) { setRect(null); return }
    const measure = () => {
      const el = document.querySelector(selector)
      if (!el) { setRect((prev) => (prev === null ? prev : null)); return }
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) { setRect((prev) => (prev === null ? prev : null)); return }
      setRect((prev) => (prev && prev.top === r.top && prev.left === r.left && prev.width === r.width && prev.height === r.height ? prev : { top: r.top, left: r.left, width: r.width, height: r.height }))
    }
    measure()
    const interval = window.setInterval(measure, 500)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [selector, enabled])
  return rect
}
