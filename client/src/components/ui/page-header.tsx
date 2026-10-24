import type { ReactNode } from 'react'
import { cn } from '../../lib/utils'

interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  /** Decorative icon shown before the title (rendered at 20px, muted). */
  icon?: ReactNode
  /** Inline content right after the title (filter chips, counts). */
  titleExtra?: ReactNode
  /** Right-aligned actions slot. */
  actions?: ReactNode
  /** The surrounding dialog already shows the title: keep it for screen readers only. */
  titleHidden?: boolean
  className?: string
}

/**
 * Shared page header: icon, title as the headline role, optional description and
 * an actions slot. Keeps Jobs, Analytics, Loops and Plugins visually identical (none of them
 * carries an icon; the sidebar already owns that role).
 */
export function PageHeader({ title, description, icon, titleExtra, actions, titleHidden, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3', className)}>
      <div className="flex min-w-0 items-center gap-2.5">
        {icon && <span className="shrink-0 text-muted-foreground [&>svg]:h-5 [&>svg]:w-5" aria-hidden>{icon}</span>}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className={titleHidden ? 'sr-only' : 'text-headline text-foreground'}>{title}</h1>
            {titleExtra}
          </div>
          {description && <p className="mt-0.5 text-caption text-muted-foreground">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
