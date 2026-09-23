import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Ellipsis } from 'lucide-react'
import { cn } from '../../../../lib/utils'

export interface OverflowMenuItem {
  id: string
  label: ReactNode
  icon?: ReactNode
  destructive?: boolean
  onSelect: () => void
}

interface Props {
  /** Accessible name of the trigger (e.g. "More actions"). */
  label: string
  items: OverflowMenuItem[]
  /** Custom trigger content — defaults to the ⋯ glyph. */
  trigger?: ReactNode
  triggerClassName?: string
  align?: 'left' | 'right'
}

/**
 * Minimal popover menu (the ui folder has no Radix dropdown): a `⋯` trigger
 * with `aria-haspopup`, closes on outside click / Escape / selection, and
 * supports ↑/↓ arrow navigation over its `menuitem`s.
 */
export function OverflowMenu({ label, items, trigger, triggerClassName, align = 'right' }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) return
    function onPointer(event: MouseEvent) { if (root.current && !root.current.contains(event.target as Node)) setOpen(false) }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') { setOpen(false); return }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      const nodes = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
      if (!nodes.length) return
      event.preventDefault()
      const index = nodes.indexOf(document.activeElement as HTMLButtonElement)
      const next = event.key === 'ArrowDown' ? (index + 1) % nodes.length : (index - 1 + nodes.length) % nodes.length
      nodes[next]?.focus()
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onPointer); document.removeEventListener('keydown', onKey) }
  }, [open])

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-label={trigger ? undefined : label}
        title={trigger ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'inline-flex h-7 items-center justify-center gap-1.5 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          trigger ? 'px-2 text-xs' : 'w-7',
          open && 'bg-accent text-foreground',
          triggerClassName,
        )}
      >
        {trigger ?? <Ellipsis className="h-4 w-4" aria-hidden />}
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={cn(
            'absolute top-full z-30 mt-1 min-w-40 overflow-hidden rounded-lg border border-border bg-card p-1 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              onClick={() => { setOpen(false); item.onSelect() }}
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                item.destructive ? 'text-destructive' : 'text-foreground',
              )}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
