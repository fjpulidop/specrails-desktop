import type { ReactNode } from 'react'
import { AlertTriangle, Info } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip'
import { cn } from '../../../lib/utils'

/**
 * A small info icon whose explanation shows on hover / focus, so the analytics
 * page stays scannable instead of carrying paragraphs. The text is also the
 * button's accessible name, so screen readers get it without hovering.
 */
export function InfoHint({ children, className, testId, tone = 'neutral' }: {
  children: ReactNode
  className?: string
  testId?: string
  /** `caution`: a data caveat (missing cost or usage), drawn with the caution lamp. */
  tone?: 'neutral' | 'caution'
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-testid={testId}
            data-tone={tone}
            className={cn('inline-flex shrink-0 items-center rounded hover:text-foreground', tone === 'caution' ? 'text-accent-warning' : 'text-muted-foreground', ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', className)}
          >
            {tone === 'caution' ? <AlertTriangle className="h-3 w-3" aria-hidden /> : <Info className="h-3 w-3" aria-hidden />}
            <span className="sr-only">{children}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">{children}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
