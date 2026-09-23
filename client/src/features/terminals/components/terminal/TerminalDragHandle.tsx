import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../../lib/utils'

interface TerminalDragHandleProps {
  /** Current user-chosen height in px. */
  height: number
  /** Upper bound (viewport minus status bar and chrome). */
  maxHeight: number
  /** Commit a new height. Called on pointerup with the final value. */
  onHeightCommit: (h: number) => void
  /** Optional live preview callback — fires during drag, throttled via rAF. */
  onHeightPreview?: (h: number) => void
  minHeight?: number
}

export function TerminalDragHandle({ height, maxHeight, onHeightCommit, onHeightPreview, minHeight = 120 }: TerminalDragHandleProps) {
  const { t } = useTranslation('terminal')
  const draggingRef = useRef(false)
  const startPointerYRef = useRef(0)
  const startHeightRef = useRef(height)
  const rAFScheduledRef = useRef(false)
  const pendingHeightRef = useRef(height)

  const clamp = useCallback((h: number): number => {
    if (h < minHeight) return minHeight
    if (h > maxHeight) return maxHeight
    return Math.round(h)
  }, [minHeight, maxHeight])

  useEffect(() => {
    function onPointerMove(e: PointerEvent) {
      if (!draggingRef.current) return
      const delta = startPointerYRef.current - e.clientY
      const next = clamp(startHeightRef.current + delta)
      pendingHeightRef.current = next
      if (!rAFScheduledRef.current) {
        rAFScheduledRef.current = true
        requestAnimationFrame(() => {
          rAFScheduledRef.current = false
          onHeightPreview?.(pendingHeightRef.current)
        })
      }
    }
    function onPointerUp() {
      if (!draggingRef.current) return
      draggingRef.current = false
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      onHeightCommit(pendingHeightRef.current)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
  }, [clamp, onHeightCommit, onHeightPreview])

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    draggingRef.current = true
    startPointerYRef.current = e.clientY
    startHeightRef.current = height
    pendingHeightRef.current = height
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
    const el = e.target as HTMLDivElement
    // setPointerCapture is not implemented in jsdom (used by vitest) — guard.
    if (typeof el.setPointerCapture === 'function') {
      try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t('dragHandle.resize')}
      onPointerDown={onPointerDown}
      className={cn(
        'absolute top-0 left-0 right-0 h-1',
        'cursor-row-resize',
        'bg-transparent hover:bg-accent-primary/40',
        'transition-colors duration-120',
        'z-10',
      )}
    />
  )
}
