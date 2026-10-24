import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../lib/utils'
import { TooltipProvider } from './tooltip'

/**
 * Shared layout primitive for the Board-mode column headers (Specs | Rails).
 *
 * Both halves stack the same rows so they line up across the splitter:
 *  - `primary` (48 px): title, the half's own controls, one primary action.
 *  - `secondary` (40 px): the slice being shown (status selector / run summary).
 *  - `tertiary` (wraps): optional context, e.g. the active-filter chips.
 *
 * No business logic lives here; the surface also provides the tooltip context
 * so the toolbar's tooltips work wherever a board is mounted.
 */

interface BoardToolbarProps {
  children: React.ReactNode
  className?: string
  'data-testid'?: string
}

export function BoardToolbar({ children, className, 'data-testid': testId }: BoardToolbarProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <header
        data-testid={testId}
        className={cn('shrink-0 border-b border-border/40 bg-background/60', className)}
      >
        {children}
      </header>
    </TooltipProvider>
  )
}

const ROW_SIZE_CLASSES = {
  primary: 'h-12',
  secondary: 'h-10',
  tertiary: 'min-h-9 py-1.5 flex-wrap',
} as const

interface BoardToolbarRowProps {
  size: keyof typeof ROW_SIZE_CLASSES
  children: React.ReactNode
  className?: string
  'data-testid'?: string
}

export const BoardToolbarRow = React.forwardRef<HTMLDivElement, BoardToolbarRowProps>(
  ({ size, children, className, 'data-testid': testId }, ref) => (
    <div
      ref={ref}
      data-testid={testId}
      data-row={size}
      className={cn('flex items-center gap-2 px-4 min-w-0', ROW_SIZE_CLASSES[size], className)}
    >
      {children}
    </div>
  ),
)
BoardToolbarRow.displayName = 'BoardToolbarRow'

interface BoardToolbarTitleProps {
  id: string
  icon: LucideIcon
  /** Drop the icon when the row is too narrow to afford it. */
  hideIconBelow?: boolean
  children: React.ReactNode
}

export function BoardToolbarTitle({ id, icon: Icon, hideIconBelow = false, children }: BoardToolbarTitleProps) {
  return (
    <div className="flex items-center gap-2 shrink-0">
      {!hideIconBelow && <Icon className="w-4 h-4 text-muted-foreground" aria-hidden />}
      <h2 id={id} className="text-sm font-semibold text-foreground whitespace-nowrap">
        {children}
      </h2>
    </div>
  )
}

export function BoardToolbarSpacer() {
  return <div className="flex-1 min-w-0" aria-hidden />
}

/** Neutral secondary control: every toolbar trigger shares this skin. */
export const toolbarButtonClass =
  'inline-flex items-center justify-center gap-1.5 h-8 px-2.5 shrink-0 rounded-md text-xs font-medium whitespace-nowrap border border-border/60 bg-muted/20 text-foreground hover:bg-muted/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:bg-transparent disabled:text-muted-foreground disabled:hover:bg-transparent'

const BADGE_TONE_CLASSES = {
  accent: 'bg-accent-primary text-background',
  success: 'bg-background/25 text-current',
  muted: 'bg-muted text-foreground',
} as const

interface ToolbarCountBadgeProps {
  count: number
  tone?: keyof typeof BADGE_TONE_CLASSES
  className?: string
  'data-testid'?: string
}

export function ToolbarCountBadge({ count, tone = 'muted', className, 'data-testid': testId }: ToolbarCountBadgeProps) {
  return (
    <span
      data-testid={testId}
      className={cn(
        'min-w-[18px] h-[18px] px-1 rounded-full text-xs leading-none tabular-nums font-semibold inline-flex items-center justify-center',
        BADGE_TONE_CLASSES[tone],
        className,
      )}
    >
      {count}
    </span>
  )
}
