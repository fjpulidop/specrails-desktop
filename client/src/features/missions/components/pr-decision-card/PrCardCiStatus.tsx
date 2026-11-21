/**
 * pr-ci-loop: the CI outcome of a settled card's open PR (green / pending /
 * needs attention / merge conflict) with the failing checks per PR. The PR
 * stays the deliverable.
 */
import { cn } from '../../../../lib/utils'
import { RunStateGlyph } from '../../../../components/ui/run-state/run-state-glyph'
import { runStateLook } from '../../../../components/ui/run-state/run-state'
import { ciRunState } from '../../../delivery/lib/delivery-run-state'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

export function PrCardCiStatus({ model }: { model: PrDecisionCardModel }) {
  const { t, envelope, ciShown, ciLive } = model
  if (!ciShown) return null
  // Checks still running are work in progress (the lamp), never a spinner.
  const state = ciRunState(ciShown)
  return (
    <div data-testid="agent-pr-ci-status" data-state={ciShown} data-run-state={state}
      className={cn('mt-2 flex items-start gap-1.5 text-xs leading-4', runStateLook(state).text)}>
      <RunStateGlyph state={state} size="xs" className="mt-px" />
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
