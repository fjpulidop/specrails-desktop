import { useEffect, useLayoutEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from '../../lib/utils'

/**
 * Non-modal popover opened by hovering or focusing its trigger (the same pattern as the
 * usage popover in the status bar): it stays open while the pointer is over the trigger or
 * the panel, closes shortly after leaving, and opens upward from the trigger.
 * A click also opens it so touch and keyboard users reach the content.
 */
export function HoverPopover({ trigger, label, description, children, className, testId, onOpenChange, width = 360 }: {
  /** The trigger element; it receives the hover/focus handlers. */
  trigger: ReactNode
  /** Accessible name of the panel. */
  label: string
  description?: string
  children: ReactNode
  className?: string
  testId?: string
  onOpenChange?: (open: boolean) => void
  width?: number
}) {
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 12, bottom: 32 })
  const trigger$ = useRef<HTMLButtonElement>(null)
  const panel$ = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cancelClose = () => { clearTimeout(closeTimer.current) }
  useEffect(() => () => clearTimeout(closeTimer.current), [])

  const change = (value: boolean) => {
    cancelClose()
    if (value) {
      const bounds = trigger$.current?.getBoundingClientRect()
      if (bounds) setPosition({ left: Math.max(12, Math.min(bounds.left, window.innerWidth - width - 12)), bottom: window.innerHeight - bounds.top + 6 })
    }
    setOpen(prev => { if (prev !== value) onOpenChange?.(value); return value })
  }
  const scheduleClose = () => {
    cancelClose()
    closeTimer.current = setTimeout(() => {
      if (document.activeElement === trigger$.current || panel$.current?.contains(document.activeElement)) return
      change(false)
    }, 180)
  }

  // The native top layer escapes composer clipping while preserving DOM tab order.
  // DOM-only test environments may not implement the Popover API.
  const supportsPopover = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype
  useLayoutEffect(() => {
    if (open && supportsPopover) panel$.current?.showPopover()
  }, [open, supportsPopover])

  useEffect(() => {
    if (!open) return
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!trigger$.current?.contains(target) && !panel$.current?.contains(target)) change(false)
    }
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') change(false)
    }
    document.addEventListener('pointerdown', dismissOutside)
    document.addEventListener('keydown', dismissEscape)
    return () => {
      document.removeEventListener('pointerdown', dismissOutside)
      document.removeEventListener('keydown', dismissEscape)
    }
  }, [open])

  return <>
    <Slot ref={trigger$} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onPointerEnter={(event: React.PointerEvent) => { if (event.pointerType === 'mouse') change(true) }}
      onPointerLeave={scheduleClose} onFocus={() => change(true)} onBlur={scheduleClose}
      onKeyDown={event => { if (event.key === 'Tab') event.stopPropagation() }}
      onClick={(event: React.MouseEvent) => { event.preventDefault(); change(true) }}>
      {trigger as React.ReactElement}
    </Slot>
    {/* Keep the panel beside its trigger in DOM order so Tab can enter and leave naturally. */}
    {open && <div ref={panel$} id={panelId} popover={supportsPopover ? "manual" : undefined} role="dialog" aria-labelledby={`${panelId}-title`} aria-describedby={`${panelId}-description`} data-hover-popover data-testid={testId}
        className={cn('font-sans fixed z-50 max-h-[calc(100dvh-48px)] rounded-xl border border-border bg-card p-3 shadow-xl outline-none', className)}
        style={{ ...position, top: "auto", right: "auto", margin: 0, width: `min(${width}px, calc(100vw - 24px))` }}
        onKeyDown={event => { if (event.key === 'Tab') event.stopPropagation() }}
        onPointerEnter={cancelClose} onPointerLeave={scheduleClose}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger$.current) scheduleClose() }}>
        <div id={`${panelId}-title`} className="sr-only">{label}</div>
        <div id={`${panelId}-description`} className="sr-only">{description ?? label}</div>
        <div className="max-h-[calc(100dvh-72px)] overflow-y-auto">{children}</div>
      </div>}
  </>
}
