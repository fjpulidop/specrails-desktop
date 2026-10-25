import type { ReactNode } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card'
import { cn } from '../../../lib/utils'

/**
 * Shared heading vocabulary for app-settings blocks: a `Card` with a
 * `CardTitle` (h3) and an optional `CardDescription`. Every settings pane
 * uses it so titles read the same everywhere (no uppercase eyebrows).
 */
export function SettingsCard({
  title,
  description,
  action,
  children,
  className,
  contentClassName,
  ...rest
}: {
  title: ReactNode
  description?: ReactNode
  /** Optional control aligned with the title (e.g. a toggle or refresh). */
  action?: ReactNode
  children?: ReactNode
  className?: string
  contentClassName?: string
  'data-testid'?: string
  /** ⌘K anchor (`lib/settings-registry.ts`). */
  'data-setting-id'?: string
}) {
  return (
    <Card className={cn('scroll-mt-4', className)} data-testid={rest['data-testid']} data-setting-id={rest['data-setting-id']}>
      <CardHeader className="p-3 pb-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <CardTitle>{title}</CardTitle>
            {description && <CardDescription>{description}</CardDescription>}
          </div>
          {action}
        </div>
      </CardHeader>
      {children !== undefined && children !== null && children !== false && (
        <CardContent className={cn('space-y-3 p-3 pt-0', contentClassName)}>{children}</CardContent>
      )}
    </Card>
  )
}
