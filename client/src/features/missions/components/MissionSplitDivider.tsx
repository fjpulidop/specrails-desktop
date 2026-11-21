import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { cn } from '../../../lib/utils'
import type { PaneRect, SplitDirection } from '../lib/mission-split-tree'

const pct = (value: number) => `${value * 100}%`
/** Hit area across the hairline, in px. */
export const DIVIDER_HIT = 8

export function dividerStyle(direction: SplitDirection, box: PaneRect, ratio: number): CSSProperties {
  return direction === 'row'
    ? { left: pct(box.x + box.width * ratio), top: pct(box.y), height: pct(box.height), width: DIVIDER_HIT, marginLeft: -DIVIDER_HIT / 2 }
    : { top: pct(box.y + box.height * ratio), left: pct(box.x), width: pct(box.width), height: DIVIDER_HIT, marginTop: -DIVIDER_HIT / 2 }
}

export interface DividerDrag {
  /** Ratio for a pointer position along the split axis (px, viewport), keeping the grab offset. */
  ratioAt(pointer: number): number
  /** Imperative preview: write the layout for this ratio without rendering. */
  preview(ratio: number): void
  /** Commit once on release (snapping applies here). */
  commit(ratio: number): void
  /** Restore the committed layout (Escape). */
  cancel(): void
}

interface Props {
  id: string
  direction: SplitDirection
  box: PaneRect
  ratio: number
  min: number
  max: number
  label: string
  /** Starts a drag: returns the geometry for this gesture, measured once. */
  begin(pointer: number): DividerDrag | null
  onKeyboard(ratio: number): void
  onEqualize(): void
}

/**
 * The one divider of the mission split layout: a 1px hairline with an 8px hit
 * area. A drag writes the panes' boxes directly (no React render per frame,
 * coalesced to one write per animation frame) and commits once on release.
 * Every way a drag can end — release, cancel, lost capture, window blur, the
 * page hidden, a move with no button pressed, Escape — ends it exactly once.
 * While dragging, a transparent shield covers the layout so embedded frames
 * (the browser pane) cannot swallow the pointer.
 */
export function MissionSplitDivider({ id, direction, box, ratio, min, max, label, begin, onKeyboard, onEqualize }: Props) {
  const [dragging, setDragging] = useState(false)
  const cleanup = useRef<(() => void) | null>(null)
  const vertical = direction === 'row'
  useEffect(() => () => cleanup.current?.(), [])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    cleanup.current?.()
    const target = event.currentTarget
    const axis = (e: { clientX: number; clientY: number }) => vertical ? e.clientX : e.clientY
    const drag = begin(axis(event))
    if (!drag) return
    const pointerId = event.pointerId
    let live = ratio
    let frame: number | null = null
    let pending: number | null = null
    const doc = target.ownerDocument
    const previous = { cursor: doc.body.style.cursor, select: doc.body.style.userSelect }
    const cursor = vertical ? 'col-resize' : 'row-resize'
    doc.body.style.cursor = cursor
    doc.body.style.userSelect = 'none'
    const shield = doc.createElement('div')
    shield.dataset.splitDragShield = ''
    Object.assign(shield.style, { position: 'fixed', inset: '0', zIndex: '2147483646', cursor })
    doc.body.appendChild(shield)
    try { target.setPointerCapture(pointerId) } catch { /* optional in webviews */ }
    setDragging(true)

    const flush = () => {
      frame = null
      if (pending === null) return
      live = pending
      pending = null
      drag.preview(live)
    }
    const finish = (commit: boolean) => {
      if (cleanup.current !== stop) return
      cleanup.current = null
      if (frame !== null && frame !== -1) cancelAnimationFrame(frame)
      if (pending !== null) live = pending
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKey, true)
      doc.removeEventListener('visibilitychange', onVisibility)
      target.removeEventListener('lostpointercapture', onLost)
      shield.remove()
      doc.body.style.cursor = previous.cursor
      doc.body.style.userSelect = previous.select
      try { if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId) } catch { /* released */ }
      setDragging(false)
      if (commit) drag.commit(live)
      else drag.cancel()
    }
    const stop = () => finish(true)
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return
      if (e.buttons === 0) { finish(true); return }
      pending = drag.ratioAt(axis(e))
      if (frame !== null) return
      frame = -1
      const id = requestAnimationFrame(flush)
      if (frame === -1) frame = id // a synchronous frame already flushed
    }
    const onUp = (e: PointerEvent) => { if (e.pointerId === pointerId) finish(true) }
    const onLost = () => finish(true)
    const onBlur = () => finish(true)
    const onVisibility = () => { if (doc.visibilityState === 'hidden') finish(true) }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    cleanup.current = stop
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKey, true)
    doc.addEventListener('visibilitychange', onVisibility)
    target.addEventListener('lostpointercapture', onLost)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.02
    const [less, more] = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown']
    let next: number | null = null
    if (event.key === less) next = ratio - step
    else if (event.key === more) next = ratio + step
    else if (event.key === 'Home') next = 0.5
    if (next === null) return
    event.preventDefault()
    onKeyboard(Math.min(max, Math.max(min, next)))
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      data-split-divider={id}
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      aria-valuetext={`${Math.round(ratio * 100)}%`}
      onPointerDown={onPointerDown}
      onDoubleClick={onEqualize}
      onKeyDown={onKeyDown}
      style={dividerStyle(direction, box, ratio)}
      className={cn('group absolute z-[35] touch-none select-none outline-none focus-visible:bg-accent-primary/10', vertical ? 'cursor-col-resize' : 'cursor-row-resize')}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute transition-colors duration-150',
          vertical ? 'inset-y-0 left-1/2 w-px -translate-x-1/2' : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
          dragging
            ? 'bg-accent-primary'
            : 'bg-border group-hover:bg-accent-primary/60 group-focus-visible:bg-accent-primary',
        )}
      />
    </div>
  )
}
