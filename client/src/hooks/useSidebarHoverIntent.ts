import { useCallback, useEffect, useRef, useState } from 'react'
import type { FocusEvent } from 'react'

/** Delay before a hovered, unpinned sidebar expands — a pointer passing over
 *  the rail on its way elsewhere must not pop the panel open. */
export const SIDEBAR_HOVER_OPEN_DELAY_MS = 150
/** Delay before it collapses again — forgiving a brief exit past the edge. */
export const SIDEBAR_HOVER_CLOSE_DELAY_MS = 250

/** Elements outside the sidebar's DOM subtree (portalled flyouts) that still
 *  belong to it carry this attribute, so focus moving into them keeps it open. */
export const SIDEBAR_FLYOUT_ATTR = 'data-sidebar-flyout'

interface Options {
  /** Hover/focus expansion only applies to an unpinned sidebar. */
  enabled: boolean
  /** While a resize drag owns the pointer the sidebar never collapses. */
  dragging: boolean
}

/**
 * Hover intent + keyboard focus expansion for an unpinned sidebar rail. Opens
 * after a short dwell, closes after a short grace period, and also opens while
 * focus is inside (keyboard users reach the expanded labels); a blur collapses
 * only when focus actually leaves the sidebar and the pointer is not over it.
 */
export function useSidebarHoverIntent({ enabled, dragging }: Options) {
  const [hovered, setHovered] = useState(false)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInside = useRef(false)
  const draggingRef = useRef(dragging)
  draggingRef.current = dragging

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  // Leaving the unpinned mode drops any pending/hover expansion.
  useEffect(() => {
    if (enabled) return
    clearTimers()
    setHovered(false)
  }, [enabled, clearTimers])

  const onMouseEnter = useCallback(() => {
    pointerInside.current = true
    if (!enabled) return
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null }
    if (openTimer.current) return
    openTimer.current = setTimeout(() => {
      openTimer.current = null
      setHovered(true)
    }, SIDEBAR_HOVER_OPEN_DELAY_MS)
  }, [enabled])

  const onMouseLeave = useCallback(() => {
    pointerInside.current = false
    if (!enabled) return
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null }
    if (draggingRef.current) return
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      setHovered(false)
    }, SIDEBAR_HOVER_CLOSE_DELAY_MS)
  }, [enabled])

  const onFocus = useCallback(() => {
    if (!enabled) return
    clearTimers()
    setHovered(true)
  }, [enabled, clearTimers])

  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    if (!enabled) return
    const next = e.relatedTarget as Node | null
    if (next && e.currentTarget.contains(next)) return
    if (next instanceof Element && next.closest(`[${SIDEBAR_FLYOUT_ATTR}]`)) return
    if (pointerInside.current || draggingRef.current) return
    clearTimers()
    setHovered(false)
  }, [enabled, clearTimers])

  return {
    hovered,
    setHovered,
    handlers: { onMouseEnter, onMouseLeave, onFocus, onBlur },
  }
}
