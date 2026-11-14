import { useEffect, useRef, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
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
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ left: 12, bottom: 32 })
  const trigger$ = useRef<HTMLButtonElement>(null)
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
      if (document.activeElement === trigger$.current || document.activeElement?.closest('[data-hover-popover]')) return
      change(false)
    }, 180)
  }

  return <Dialog.Root open={open} onOpenChange={change} modal={false}>
    <Dialog.Trigger asChild ref={trigger$}
      onPointerEnter={(event: React.PointerEvent) => { if (event.pointerType === 'mouse') change(true) }}
      onPointerLeave={scheduleClose} onFocus={() => change(true)} onBlur={scheduleClose}
      onClick={(event: React.MouseEvent) => { event.preventDefault(); change(true) }}>
      {trigger as React.ReactElement}
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Content data-hover-popover data-testid={testId}
        className={cn('font-sans fixed z-50 max-h-[calc(100dvh-48px)] rounded-xl border border-border bg-card p-3 shadow-xl outline-none', className)}
        style={{ ...position, width: `min(${width}px, calc(100vw - 24px))` }}
        onPointerEnter={cancelClose} onPointerLeave={scheduleClose}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && event.relatedTarget !== trigger$.current) scheduleClose() }}
        onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()}>
        <Dialog.Title className="sr-only">{label}</Dialog.Title>
        <Dialog.Description className="sr-only">{description ?? label}</Dialog.Description>
        <div className="max-h-[calc(100dvh-72px)] overflow-y-auto">{children}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
