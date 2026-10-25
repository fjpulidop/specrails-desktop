import * as React from 'react'
import { cn } from '../../lib/utils'
import type { HelpTopicId } from '../../lib/help-topics'
import { HelpHint } from '../HelpHint'

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
  /** Guide topic: shows "Learn more" after the action. Pair it with a `description`
   *  that says what will appear here, and a primary `action`. */
  learnMore?: HelpTopicId
}

/** Shared empty state: icon, title, one-line description, one action and an optional Learn more. */
function EmptyState({ icon, title, description, action, learnMore, className, ...props }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-card border border-dashed border-border px-6 py-10 text-center',
        className
      )}
      {...props}
    >
      {icon && (
        <div className="grid h-10 w-10 place-items-center rounded-card border border-border bg-card text-muted-foreground" aria-hidden="true">
          {icon}
        </div>
      )}
      <div className="space-y-1">
        <p className="text-strong text-foreground">{title}</p>
        {description && <p className="mx-auto max-w-[44ch] text-caption text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
      {learnMore && <HelpHint topic={learnMore} variant="link" />}
    </div>
  )
}

export { EmptyState }
