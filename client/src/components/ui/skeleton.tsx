import * as React from 'react'
import { cn } from '../../lib/utils'

/**
 * Loading placeholder. Visible on every theme (7% foreground tint), with a
 * 1.4s shimmer that falls back to a static block under reduced motion.
 */
const Skeleton = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      data-skeleton=""
      aria-hidden="true"
      className={cn('u-skeleton rounded-card', className)}
      {...props}
    />
  )
)
Skeleton.displayName = 'Skeleton'

export { Skeleton }
