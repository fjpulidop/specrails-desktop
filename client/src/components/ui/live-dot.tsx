import * as React from 'react'
import { cn } from '../../lib/utils'
import { useReducedMotion } from '../../hooks/useReducedMotion'

export type LiveDotTone = 'primary' | 'success' | 'info' | 'warning' | 'destructive' | 'muted'

const TONE_CLASS: Record<LiveDotTone, string> = {
  primary: 'bg-accent-primary',
  success: 'bg-accent-success',
  info: 'bg-accent-info',
  warning: 'bg-accent-warning',
  destructive: 'bg-destructive',
  muted: 'bg-muted-foreground',
}

const SIZE_CLASS = { xs: 'h-1.5 w-1.5', sm: 'h-2 w-2', md: 'h-2.5 w-2.5' } as const

export interface LiveDotProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'color'> {
  tone?: LiveDotTone
  /** Soft expanding ring while work is live. Defaults to true. */
  pulsing?: boolean
  size?: keyof typeof SIZE_CLASS
  /** Override the tone with an explicit background class (e.g. a status map). */
  dotClassName?: string
}

/** Status lamp: a solid dot with an optional soft 2s opacity ring. */
function LiveDot({
  tone = 'primary',
  pulsing = true,
  size = 'sm',
  dotClassName,
  className,
  ...props
}: LiveDotProps) {
  const reduced = useReducedMotion()
  const color = dotClassName ?? TONE_CLASS[tone]
  const sz = SIZE_CLASS[size]
  return (
    <span className={cn('relative flex shrink-0', sz, className)} {...props}>
      {pulsing && !reduced && (
        <span
          data-live-ring=""
          aria-hidden="true"
          className={cn('u-lamp-ring absolute inline-flex h-full w-full rounded-full', color)}
        />
      )}
      <span className={cn('relative inline-flex rounded-full', sz, color)} />
    </span>
  )
}

export { LiveDot }
