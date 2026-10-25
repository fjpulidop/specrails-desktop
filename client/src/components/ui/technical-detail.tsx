import { cn } from '../../lib/utils'

/** The server's own words behind a localized line: closed by default, selectable, never hover-only. */
export function TechnicalDetail({ summary, children, className, testId }: {
  summary: string
  children: string
  className?: string
  testId?: string
}) {
  return (
    <details className={cn('text-muted-foreground', className)} data-testid={testId}>
      <summary className="cursor-pointer font-medium text-muted-foreground">{summary}</summary>
      <p className="mt-1 select-text break-words font-mono text-caption">{children}</p>
    </details>
  )
}
