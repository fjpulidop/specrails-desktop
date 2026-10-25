import { useVirtualizer } from '@tanstack/react-virtual'
import type { RefObject } from 'react'

/**
 * A row virtualiser that keeps working where layout is unavailable (jsdom, a
 * pane that is still 0px tall): it falls back to a fixed viewport so a bounded
 * window of rows renders, never all of them and never none. A row measured at 0
 * keeps its estimate for the same reason.
 */
export function useRowVirtualizer(options: {
  count: number
  parentRef: RefObject<HTMLElement | null>
  estimateSize: (index: number) => number
  overscan?: number
  fallbackHeight?: number
  measure?: boolean
}) {
  const fallbackHeight = options.fallbackHeight ?? 600
  return useVirtualizer({
    count: options.count,
    getScrollElement: () => options.parentRef.current,
    estimateSize: options.estimateSize,
    overscan: options.overscan ?? 12,
    initialRect: { width: 600, height: fallbackHeight },
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement as HTMLElement | null
      if (!el) return () => {}
      const measure = () => {
        const rect = el.getBoundingClientRect()
        cb({ width: rect.width || el.clientWidth || 600, height: rect.height || el.clientHeight || fallbackHeight })
      }
      measure()
      if (typeof ResizeObserver === 'undefined') return () => {}
      const observer = new ResizeObserver(measure)
      observer.observe(el)
      return () => observer.disconnect()
    },
    ...(options.measure
      ? {
        measureElement: (element: Element) => {
          const height = (element as HTMLElement).getBoundingClientRect().height
          return height > 0 ? height : options.estimateSize(Number((element as HTMLElement).dataset.index ?? 0))
        },
      }
      : {}),
  })
}
