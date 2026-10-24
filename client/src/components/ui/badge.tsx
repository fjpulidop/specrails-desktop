import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

const badgeVariants = cva(
  'inline-flex items-center rounded-pill border px-2 py-0.5 text-micro transition-colors duration-[var(--duration-fast)]',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        outline: 'text-foreground',
        success: 'gap-1.5 before:content-[\'\'] before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full before:bg-current bg-transparent text-accent-success border-accent-success/30',
        warning: 'gap-1.5 before:content-[\'\'] before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full before:bg-current bg-transparent text-accent-warning border-accent-warning/30',
        running: 'gap-1.5 before:content-[\'\'] before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full before:bg-current bg-transparent text-accent-info border-accent-info/30',
        queued: 'gap-1.5 before:content-[\'\'] before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full before:bg-current bg-transparent text-muted-foreground border-border',
        failed: 'gap-1.5 before:content-[\'\'] before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full before:bg-current bg-transparent text-destructive border-destructive/30',
        canceled: 'gap-1.5 before:content-[\'\'] before:h-1.5 before:w-1.5 before:shrink-0 before:rounded-full before:bg-current bg-transparent text-muted-foreground border-border',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
