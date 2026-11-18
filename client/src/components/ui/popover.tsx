import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '../../lib/utils'

export type PopoverSide = 'top' | 'bottom'
export type PopoverAlign = 'start' | 'end'

interface Position { left?: number; right?: number; top?: number; bottom?: number }

/**
 * Click-to-open, non-modal popover for compact chips (run evidence, sent
 * instructions). The panel stays beside its trigger in DOM order, so Tab moves
 * into it naturally and it works inside a Radix dialog (focus trap) and a native
 * surface window; the browser top layer escapes clipping and transformed
 * ancestors. Escape closes it without closing the surrounding dialog and returns
 * focus to the trigger; a click outside closes it.
 */
export function Popover({ trigger, label, children, side = 'bottom', align = 'start', width = 360, className, testId, onOpenChange }: {
  /** The trigger button; it receives aria-expanded / aria-controls. */
  trigger: ReactNode
  /** Accessible name of the panel. */
  label: string
  children: ReactNode
  side?: PopoverSide
  align?: PopoverAlign
  width?: number
  className?: string
  testId?: string
  onOpenChange?(open: boolean): void
}) {
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<Position>({ left: 12, top: 12 })
  const trigger$ = useRef<HTMLElement>(null)
  const panel$ = useRef<HTMLDivElement>(null)
  const notify = useRef(onOpenChange)
  useEffect(() => { notify.current = onOpenChange }, [onOpenChange])

  const place = useCallback(() => {
    const bounds = trigger$.current?.getBoundingClientRect()
    if (!bounds) return
    const edge = 12
    const panelWidth = Math.min(width, window.innerWidth - edge * 2)
    const vertical = side === 'bottom' ? { top: bounds.bottom + 6 } : { bottom: window.innerHeight - bounds.top + 6 }
    const horizontal = align === 'start'
      ? { left: Math.max(edge, Math.min(bounds.left, window.innerWidth - panelWidth - edge)) }
      : { right: Math.max(edge, Math.min(window.innerWidth - bounds.right, window.innerWidth - panelWidth - edge)) }
    setPosition({ ...vertical, ...horizontal })
  }, [align, side, width])

  const change = useCallback((value: boolean, restoreFocus = false) => {
    if (value) place()
    setOpen(value)
    notify.current?.(value)
    if (!value && restoreFocus) trigger$.current?.focus()
  }, [place])

  const supportsPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype
  useLayoutEffect(() => {
    if (!open) return
    if (supportsPopover) panel$.current?.showPopover()
    panel$.current?.focus({ preventScroll: true })
  }, [open, supportsPopover])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!trigger$.current?.contains(target) && !panel$.current?.contains(target)) change(false)
    }
    // Window capture runs before the dialog's own Escape listener, so Escape
    // closes only this panel while it is open.
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      event.preventDefault()
      change(false, true)
    }
    const reposition = () => place()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('keydown', escape, true)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', reposition)
    }
  }, [open, change, place])

  return <>
    <Slot ref={trigger$} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => change(!open)}>
      {trigger as ReactElement}
    </Slot>
    {open && (
      <div
        ref={panel$}
        id={panelId}
        popover={supportsPopover ? 'manual' : undefined}
        role="dialog"
        aria-label={label}
        tabIndex={-1}
        data-testid={testId}
        className={cn('font-sans fixed z-50 flex max-h-[min(70dvh,560px)] flex-col overflow-hidden rounded-panel border border-border bg-popover p-0 text-popover-foreground shadow-2 outline-none u-pop', className)}
        style={{ inset: 'auto', margin: 0, ...position, width:`min(${width}px, calc(100vw - 24px))` }}
      >
        {children}
      </div>
    )}
  </>
}
