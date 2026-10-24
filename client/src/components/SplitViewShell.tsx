import { modalOverlayStyle } from '../lib/modal-safe-area'
import { useCallback, useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { useTranslation } from 'react-i18next'
import { TicketDetailModal } from '../features/specs/components/TicketDetailModal'
import { SpecComparePicker } from '../features/specs/components/SpecComparePicker'
import { DIALOG_SCRIM_CLASS, DialogLayerProvider } from './ui/dialog'
import { DIALOG_LAYER_CLASS } from '../lib/layers'
import { cn } from '../lib/utils'
import type { LocalTicket } from '../types'
import type { CompareSide, SplitState } from '../features/specs/context/TicketDetailModalContext'

interface SplitViewShellProps {
  state: SplitState
  leftTicket: LocalTicket | null
  rightTicket: LocalTicket | null
  allTickets: LocalTicket[]
  allLabels: string[]
  onSave: (ticketId: number, fields: Partial<Pick<LocalTicket, 'title' | 'description' | 'status' | 'priority' | 'labels'>>) => Promise<boolean>
  onDelete: (ticketId: number) => Promise<boolean>
  onOpenTicket: (ticketId: number) => void
  onCloseAll: () => void
  onSetCompared: (ticketId: number | null, side: CompareSide) => void
  onSetRatio: (ratio: number) => void
  onExitSplit: () => void
}

const MIN_RATIO = 0.25
const MAX_RATIO = 0.75

/**
 * Two-panel comparison shell.
 *
 * - Origin side (state.originSide) hosts the original ticket and keeps the
 *   modal's familiar "×" button as a close-all action.
 * - The opposite side hosts either a `SpecComparePicker` (when no compared
 *   ticket is selected) or a second `TicketDetailModal` whose "×" returns
 *   that side to the picker.
 * - The divider between the panels is a `role="separator"` that drag-resizes
 *   the split ratio and supports arrow-key resize.
 */
export function SplitViewShell({
  state,
  leftTicket,
  rightTicket,
  allTickets,
  allLabels,
  onSave,
  onDelete,
  onOpenTicket,
  onCloseAll,
  onSetCompared,
  onSetRatio,
  onExitSplit: _onExitSplit,
}: SplitViewShellProps) {
  const { t } = useTranslation('tickets')
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ pointerId: number; element: HTMLElement } | null>(null)
  const [animating, setAnimating] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setAnimating(false), 320)
    return () => clearTimeout(t)
  }, [])

  const handleDividerMove = useCallback(
    (e: PointerEvent) => {
      if (!dragRef.current) return
      const viewport = window.innerWidth
      const ratio = e.clientX / viewport
      onSetRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)))
    },
    [onSetRatio],
  )

  const handleDividerUp = useCallback(
    (_e: PointerEvent) => {
      if (!dragRef.current) return
      const { pointerId, element } = dragRef.current
      try { element.releasePointerCapture(pointerId) } catch { /* already released */ }
      dragRef.current = null
      window.removeEventListener('pointermove', handleDividerMove)
      window.removeEventListener('pointerup', handleDividerUp)
      window.removeEventListener('pointercancel', handleDividerUp)
    },
    [handleDividerMove],
  )

  const handleDividerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const element = e.currentTarget
      try { element.setPointerCapture(e.pointerId) } catch { /* tests */ }
      dragRef.current = { pointerId: e.pointerId, element }
      window.addEventListener('pointermove', handleDividerMove)
      window.addEventListener('pointerup', handleDividerUp)
      window.addEventListener('pointercancel', handleDividerUp)
    },
    [handleDividerMove, handleDividerUp],
  )

  // Unmount safety net: if the shell unmounts MID-DRAG (project switch dispatches
  // closeAll, sub-900px resize dispatches exitSplit — neither fires pointerup),
  // the window listeners added on pointerdown would leak and keep dispatching
  // onSetRatio. Remove them unconditionally on unmount.
  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handleDividerMove)
      window.removeEventListener('pointerup', handleDividerUp)
      window.removeEventListener('pointercancel', handleDividerUp)
      const drag = dragRef.current
      if (drag) {
        try { drag.element.releasePointerCapture(drag.pointerId) } catch { /* already released */ }
        dragRef.current = null
      }
    }
  }, [handleDividerMove, handleDividerUp])

  const handleDividerKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = 0.04
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        onSetRatio(Math.max(MIN_RATIO, state.splitRatio - step))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        onSetRatio(Math.min(MAX_RATIO, state.splitRatio + step))
      } else if (e.key === 'Home') {
        e.preventDefault()
        onSetRatio(MIN_RATIO)
      } else if (e.key === 'End') {
        e.preventDefault()
        onSetRatio(MAX_RATIO)
      } else if (e.key === '0') {
        e.preventDefault()
        onSetRatio(0.5)
      }
    },
    [onSetRatio, state.splitRatio],
  )

  const handleBackdropClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onCloseAll()
  }

  const renderPanel = (side: CompareSide) => {
    const isOrigin = side === state.originSide
    const ticket = side === 'left' ? leftTicket : rightTicket

    if (ticket) {
      return (
        <TicketDetailModal
          key={`${side}-${ticket.id}`}
          ticket={ticket}
          allLabels={allLabels}
          allTickets={allTickets}
          onClose={isOrigin ? onCloseAll : () => onSetCompared(null, side)}
          onOpenTicket={onOpenTicket}
          onSave={onSave}
          onDelete={onDelete}
          embedded
        />
      )
    }
    // No ticket on this side ⇒ render picker (must be the non-origin side)
    return (
      <SpecComparePicker
        tickets={allTickets}
        excludeIds={[leftTicket?.id, rightTicket?.id].filter((id): id is number => id != null)}
        onSelect={(id) => onSetCompared(id, side)}
      />
    )
  }

  // Escape (Radix) closes both panels — except while typing (the panels'
  // inline editors own Escape to cancel an edit). Nested dialogs (confirms,
  // Selects) are their own Radix layers and consume Escape first.
  const handleEscapeKeyDown = useCallback((e: KeyboardEvent) => {
    const target = e.target instanceof HTMLElement ? e.target : null
    if (target?.closest('input, textarea, select, [contenteditable="true"]')) e.preventDefault()
  }, [])

  // Focus return: Radix only refocuses a `DialogTrigger`; the shell is opened
  // from Spec detail's Compare button / drag gesture, which unmounts with it.
  const [returnTarget] = useState<HTMLElement | null>(() => {
    if (typeof document === 'undefined') return null
    const el = document.activeElement
    return el instanceof HTMLElement && el !== document.body ? el : null
  })
  const handleCloseAutoFocus = useCallback((e: Event) => {
    e.preventDefault()
    if (returnTarget?.isConnected) returnTarget.focus()
  }, [returnTarget])

  const leftPct = (state.splitRatio * 100).toFixed(2)
  const rightPct = ((1 - state.splitRatio) * 100).toFixed(2)

  // A Radix modal on the `entity` layer (same as standalone Spec detail):
  // focus trap, hideOthers, focus return, Escape stacking.
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => { if (!next) onCloseAll() }}>
    <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay style={modalOverlayStyle()} className={cn(DIALOG_SCRIM_CLASS, DIALOG_LAYER_CLASS.entity)} />
    <DialogPrimitive.Content
      ref={containerRef}
      data-testid="split-view-shell"
      data-dialog-layer="entity"
      aria-describedby={undefined}
      style={modalOverlayStyle()}
      className={cn('fixed inset-0 flex outline-none', DIALOG_LAYER_CLASS.entity)}
      onClick={handleBackdropClick}
      onEscapeKeyDown={handleEscapeKeyDown}
      onCloseAutoFocus={handleCloseAutoFocus}
    >
      <DialogPrimitive.Title className="sr-only">{t('split.label')}</DialogPrimitive.Title>
      <DialogLayerProvider layer="entity">
      <div
        className="relative flex w-full h-full"
        style={{
          transition: animating ? 'opacity 280ms cubic-bezier(0.16, 1, 0.3, 1)' : undefined,
        }}
      >
        {/* Left panel */}
        <div
          data-testid="split-panel-left"
          className="relative h-full overflow-hidden"
          style={{
            width: `${leftPct}%`,
            transition: animating ? 'width 280ms cubic-bezier(0.16, 1, 0.3, 1)' : undefined,
          }}
        >
          <div className="h-full flex items-center justify-center p-2">
            <div className="w-full h-full max-h-[95vh]">
              {renderPanel('left')}
            </div>
          </div>
        </div>

        {/* Divider */}
        <div
          data-testid="split-divider"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('split.resize')}
          aria-valuenow={Math.round(state.splitRatio * 100)}
          aria-valuemin={Math.round(MIN_RATIO * 100)}
          aria-valuemax={Math.round(MAX_RATIO * 100)}
          tabIndex={0}
          onPointerDown={handleDividerDown}
          onKeyDown={handleDividerKey}
          className="relative z-10 w-2 cursor-col-resize bg-border/40 hover:bg-accent-primary/40 transition-colors focus:outline-none focus:bg-accent-primary/60"
        />

        {/* Right panel */}
        <div
          data-testid="split-panel-right"
          className="relative h-full overflow-hidden"
          style={{
            width: `${rightPct}%`,
            transition: animating ? 'width 280ms cubic-bezier(0.16, 1, 0.3, 1)' : undefined,
          }}
        >
          <div className="h-full flex items-center justify-center p-2">
            <div className="w-full h-full max-h-[95vh]">
              {renderPanel('right')}
            </div>
          </div>
        </div>
      </div>
      </DialogLayerProvider>
    </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
