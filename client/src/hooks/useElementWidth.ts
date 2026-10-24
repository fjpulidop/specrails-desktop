import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Observe an element's content width with a `ResizeObserver`.
 *
 * Returns a callback ref and the last measured width (rounded to an integer).
 * The width is `null` until the first measurement and stays `null` when the
 * environment has no `ResizeObserver` or never reports a size (jsdom), so
 * width-tier consumers can treat `null` as "assume the roomiest layout".
 */
export function useElementWidth<T extends HTMLElement>(): [React.RefCallback<T>, number | null] {
  const [width, setWidth] = useState<number | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)

  const ref = useCallback((node: T | null) => {
    observerRef.current?.disconnect()
    observerRef.current = null
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      const next = Math.round(entry.contentRect.width)
      // Hidden/detached elements report 0: keep the previous tier instead of
      // collapsing every control to its smallest form.
      if (next <= 0) return
      setWidth((prev) => (prev === next ? prev : next))
    })
    observer.observe(node)
    observerRef.current = observer
  }, [])

  useEffect(() => () => {
    observerRef.current?.disconnect()
    observerRef.current = null
  }, [])

  return [ref, width]
}
