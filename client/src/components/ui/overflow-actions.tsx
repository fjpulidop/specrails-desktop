import type { ReactNode } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { cn } from '../../lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from './dropdown-menu'

export interface OverflowActionItem {
  id: string
  label: string
  /** One line under the label: what the action does to the person's work. */
  hint?: string
  icon?: ReactNode
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
  testId?: string
}

/**
 * The secondary actions of a decision point behind one "More actions" menu, so a card keeps a
 * single primary button (and at most one quiet secondary) instead of four buttons of equal weight.
 */
export function OverflowActions({ label, items, disabled, testId = 'overflow-actions', className }: {
  label: string
  items: readonly OverflowActionItem[]
  disabled?: boolean
  testId?: string
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={label}
        title={label}
        disabled={disabled}
        data-testid={testId}
        data-agent-interactive
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors',
          'hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50',
          'disabled:pointer-events-none disabled:opacity-50',
          className,
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={item.onSelect}
            disabled={item.disabled}
            destructive={item.destructive}
            data-testid={item.testId}
            data-agent-interactive
            className="items-start"
          >
            {item.icon && <span className="mt-0.5 shrink-0" aria-hidden>{item.icon}</span>}
            <span className="flex min-w-0 flex-col">
              <span>{item.label}</span>
              {item.hint && <span className="text-caption font-normal text-muted-foreground">{item.hint}</span>}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
