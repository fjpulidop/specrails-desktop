import { useTranslation } from 'react-i18next'
import { Button } from './button'
import { cn } from '../../lib/utils'

/** A region that failed to load: a localized message and a way to try again. */
export function LoadError({ message, onRetry, className, testId }: {
  message: string
  onRetry: () => void
  className?: string
  testId?: string
}) {
  const { t } = useTranslation('common')
  return (
    <div role="alert" data-testid={testId} className={cn('flex flex-wrap items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive', className)}>
      <span className="min-w-0 break-words">{message}</span>
      <Button type="button" size="sm" variant="ghost" onClick={onRetry}>{t('actions.retry')}</Button>
    </div>
  )
}
