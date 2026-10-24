import * as React from 'react'
import { cn } from '../../lib/utils'

/**
 * The one keyboard-key chip (command palette, shortcut cheatsheet, title bar).
 * Caption role, control radius, hairline border; no monospace (DESIGN.md keeps
 * mono for ids and code).
 */
const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(({ className, ...props }, ref) => (
  <kbd
    ref={ref}
    className={cn('inline-flex min-w-[1.25rem] items-center justify-center rounded-control border border-border/50 bg-muted/30 px-1.5 text-caption text-muted-foreground', className)}
    {...props}
  />
))
Kbd.displayName = 'Kbd'

export { Kbd }
