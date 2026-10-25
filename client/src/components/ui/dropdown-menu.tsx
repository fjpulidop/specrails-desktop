import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '../../lib/utils'

/**
 * Lightweight accessible overflow menu ("More" actions).
 *
 * The app does not ship `@radix-ui/react-dropdown-menu`, so this implements the
 * WAI-ARIA menu-button pattern directly: the trigger carries
 * `aria-haspopup="menu"`/`aria-expanded`, the menu is portalled with fixed
 * positioning (escapes `overflow` ancestors), ArrowUp/ArrowDown/Home/End move
 * focus between items, Escape and outside clicks close and return focus.
 */

interface DropdownMenuContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  triggerRef: React.RefObject<HTMLButtonElement | null>
  menuId: string
}

const DropdownMenuContext = React.createContext<DropdownMenuContextValue | null>(null)

function useDropdownMenu(): DropdownMenuContextValue {
  const ctx = React.useContext(DropdownMenuContext)
  if (!ctx) throw new Error('DropdownMenu parts must be rendered inside <DropdownMenu>')
  return ctx
}

export function DropdownMenu({
  children,
  open: controlledOpen,
  onOpenChange,
}: {
  children: React.ReactNode
  /** Controlled open state (a menu opened by something other than a click on its trigger). */
  open?: boolean
  onOpenChange?: (open: boolean) => void
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const onOpenChangeRef = React.useRef(onOpenChange)
  onOpenChangeRef.current = onOpenChange
  const setOpen = React.useCallback((next: boolean) => {
    setUncontrolledOpen(next)
    onOpenChangeRef.current?.(next)
  }, [])
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const menuId = React.useId()
  const value = React.useMemo(() => ({ open, setOpen, triggerRef, menuId }), [open, setOpen, menuId])
  return <DropdownMenuContext.Provider value={value}>{children}</DropdownMenuContext.Provider>
}

export const DropdownMenuTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement>
>(({ onClick, onKeyDown, className, ...props }, forwardedRef) => {
  const { open, setOpen, triggerRef, menuId } = useDropdownMenu()
  const setRefs = (node: HTMLButtonElement | null) => {
    triggerRef.current = node
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }
  return (
    <button
      ref={setRefs}
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={open ? menuId : undefined}
      className={cn(
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
      onClick={(e) => {
        onClick?.(e)
        if (!e.defaultPrevented) setOpen(!open)
      }}
      onKeyDown={(e) => {
        onKeyDown?.(e)
        if (e.key === 'ArrowDown' && !open) {
          e.preventDefault()
          setOpen(true)
        }
      }}
      {...props}
    />
  )
})
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger'

interface DropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: 'start' | 'end'
  /** Open below (default) or above the trigger (a trigger docked at the bottom edge, e.g. a bulk bar). */
  side?: 'bottom' | 'top'
}

export function DropdownMenuContent({
  className,
  align = 'end',
  side = 'bottom',
  children,
  ...props
}: DropdownMenuContentProps) {
  const { open, setOpen, triggerRef, menuId } = useDropdownMenu()
  const menuRef = React.useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = React.useState<{ top?: number; bottom?: number; left?: number; right?: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!open) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const vertical = side === 'top' ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }
    setPos(
      align === 'end'
        ? { ...vertical, right: Math.max(8, window.innerWidth - rect.right) }
        : { ...vertical, left: Math.max(8, rect.left) },
    )
  }, [open, align, side, triggerRef])

  const items = () =>
    Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? [],
    )

  React.useEffect(() => {
    if (!open) return
    // Focus the first item once the menu mounts.
    const id = requestAnimationFrame(() => items()[0]?.focus())
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onScrollOrResize = () => setOpen(false)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      cancelAnimationFrame(id)
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open, setOpen, triggerRef])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLElement)
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      list[(index + 1) % list.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      list[(index - 1 + list.length) % list.length]?.focus()
    } else if (e.key === 'Home') {
      e.preventDefault()
      list[0]?.focus()
    } else if (e.key === 'End') {
      e.preventDefault()
      list[list.length - 1]?.focus()
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return createPortal(
    <div
      ref={menuRef}
      id={menuId}
      role="menu"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      style={pos ? { position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, right: pos.right } : { position: 'fixed' }}
      className={cn(
        'z-[105] min-w-[10rem] rounded-card border border-border bg-popover p-1 text-popover-foreground shadow-2',
        className,
      )}
      {...props}
    >
      {children}
    </div>,
    document.body,
  )
}

interface DropdownMenuItemProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  onSelect?: () => void
  destructive?: boolean
}

export function DropdownMenuItem({
  className,
  onSelect,
  destructive,
  disabled,
  children,
  ...props
}: DropdownMenuItemProps) {
  const { setOpen, triggerRef } = useDropdownMenu()
  return (
    <button
      type="button"
      role="menuitem"
      tabIndex={-1}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      className={cn(
        'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none transition-colors',
        'hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground',
        'disabled:pointer-events-none disabled:opacity-50',
        destructive && 'text-destructive hover:text-destructive focus-visible:text-destructive',
        className,
      )}
      onClick={() => {
        if (disabled) return
        setOpen(false)
        triggerRef.current?.focus()
        onSelect?.()
      }}
      {...props}
    >
      {children}
    </button>
  )
}

export function DropdownMenuSeparator({ className }: { className?: string }) {
  return <div role="separator" className={cn('-mx-1 my-1 h-px bg-border', className)} />
}
