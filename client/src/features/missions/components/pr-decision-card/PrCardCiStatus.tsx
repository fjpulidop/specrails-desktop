/**
 * pr-ci-loop: the CI outcome of a settled card's open PR (green / pending /
 * needs attention / merge conflict) with the failing checks per PR. The PR
 * stays the deliverable.
 */
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

export function PrCardCiStatus({ model }: { model: PrDecisionCardModel }) {
  const { t, envelope, ciShown, ciLive } = model
  if (!ciShown) return null
  return (
    <div data-testid="agent-pr-ci-status" data-state={ciShown}
      className={cn('mt-2 flex items-start gap-1.5 text-xs leading-4', ciShown === 'green' ? 'text-accent-success' : ciShown === 'pending' ? 'text-accent-info' : 'text-accent-warning')}>
      {ciShown === 'green' ? <CheckCircle2 className="mt-px h-3 w-3 shrink-0" /> : ciShown === 'pending' ? <Loader2 className="mt-px h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" /> : <AlertTriangle className="mt-px h-3 w-3 shrink-0" />}
      <div className="min-w-0">
        <p>{ciShown === 'green' ? t('prCard.ci.green') : ciShown === 'pending' ? t('prCard.ci.pending', { count: ciLive?.pending ?? 0 }) : ciShown === 'conflict' ? t('prCard.ci.conflict') : t('prCard.ci.notGreen')}</p>
        {ciShown === 'red' && ciLive?.failing.map((entry) => (
          <p key={entry.pr || 'pr'} data-testid="agent-pr-ci-failing" className="mt-0.5 break-words text-muted-foreground">
            {t('prCard.ci.failing', { checks: entry.checks.join(', '), pr: entry.pr, context: entry.pr ? 'pr' : undefined })}
          </p>
        ))}
        {/* The last CI loop's own diagnosis, when there was one. */}
        {ciShown === 'red' && envelope.statusCode === 'ci_needs_attention' && envelope.statusDetail
          ? <p className="mt-0.5 whitespace-pre-line text-muted-foreground">{envelope.statusDetail}</p>
          : null}
      </div>
    </div>
  )
}
