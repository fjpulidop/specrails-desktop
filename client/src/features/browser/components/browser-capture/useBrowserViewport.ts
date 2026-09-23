import { useEffect, useRef, type RefObject } from 'react'

/** Keep the remote page's CSS viewport matched to its visible container. DPR is
 * sent separately so the renderer can supply Retina pixels without changing the
 * page's responsive layout or the coordinate space used by pointer input.
 *
 * Observe the surface once per enabled period. Session state, pointer probes,
 * and fresh callback identities must not reconnect the observer or continuously
 * resize Chromium. Real layout changes are coalesced onto an animation frame.
 */
export function useBrowserViewport(
  containerRef: RefObject<HTMLElement | null>,
  setViewport: (width: number, height: number, deviceScaleFactor?: number) => void,
  enabled: boolean,
  fixedViewport?: { width: number; height: number },
): void {
  const onViewportRef = useRef(setViewport)
  onViewportRef.current = setViewport

  useEffect(() => {
    const element = containerRef.current
    if (!enabled || !element) return
    let disposed = false
    let scheduled: number | null = null
    let lastWidth = 0
    let lastHeight = 0
    let lastScaleFactor = 0
    let resolutionQuery: MediaQueryList | null = null

    const measure = () => {
      scheduled = null
      if (disposed) return
      const rect = fixedViewport ?? element.getBoundingClientRect()
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) return
      const width = Math.max(1, Math.round(rect.width))
      const height = Math.max(1, Math.round(rect.height))
      const hostScaleFactor = window.devicePixelRatio
      const deviceScaleFactor = Number.isFinite(hostScaleFactor) ? Math.min(2, Math.max(1, hostScaleFactor)) : 1
      if (width === lastWidth && height === lastHeight && deviceScaleFactor === lastScaleFactor) return
      lastWidth = width
      lastHeight = height
      lastScaleFactor = deviceScaleFactor
      onViewportRef.current(width, height, deviceScaleFactor)
    }
    const schedule = () => {
      if (disposed) return
      if (scheduled === null) scheduled = requestAnimationFrame(measure)
    }
    const watchResolution = () => {
      resolutionQuery?.removeEventListener('change', onResolutionChange)
      resolutionQuery = typeof window.matchMedia === 'function'
        ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
        : null
      resolutionQuery?.addEventListener('change', onResolutionChange)
    }
    const onResolutionChange = () => {
      schedule()
      watchResolution()
    }

    // Queue the desired size immediately, even while the session is opening.
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(element)
    window.addEventListener('resize', schedule)
    watchResolution()
    return () => {
      disposed = true
      if (scheduled !== null) cancelAnimationFrame(scheduled)
      observer?.disconnect()
      resolutionQuery?.removeEventListener('change', onResolutionChange)
      window.removeEventListener('resize', schedule)
    }
  }, [containerRef, enabled, fixedViewport?.width, fixedViewport?.height])
}
