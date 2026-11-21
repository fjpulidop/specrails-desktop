/**
 * Header of a settled PR decision card: the state icon and title (flow, CI and
 * delivery outcomes named precisely), the help hint, project and rail badge.
 */
import { cn } from '../../../../lib/utils'
import { HelpHint } from '../../../../components/HelpHint'
import { RunStateGlyph } from '../../../../components/ui/run-state/run-state-glyph'
import { FLOW_SPEC_LOOP_ID } from '../../../delivery/components/LoopChip'
import { deliveryLook, deliveryOverrideOf } from '../../../delivery/lib/delivery-run-state'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

/** The settled card's state (status vocabulary), its object glyph and the title line. */
export function settledCardHeading(model: PrDecisionCardModel) {
  const { t, envelope, decision, flowOutcome, presentation, ciShown, degradedDraft } = model
  // A person stopped the run: a neutral stop, not a failure; Intent → Spec
  // outcomes (changes requested, returned, crashed) say more than the decision.
  const { state, objectIcon } = deliveryLook(decision, deliveryOverrideOf({ decision, statusCode: envelope.statusCode ?? null, flowOutcome }))
  // Intent → Spec names itself where the title would otherwise be generic.
  const flowSpec = envelope.loopId === FLOW_SPEC_LOOP_ID
  const flowSpecDelivered = flowSpec && ['on_review', 'pr_draft', 'pr_ready', 'completed'].includes(decision) && !degradedDraft
  const title = flowOutcome === 'changes'
    ? t(flowSpec ? 'prCard.title.flowSpecChanges' : 'prCard.title.review_changes_requested')
    : flowOutcome === 'crashed'
      ? t('prCard.title.flowSpecFailed')
    : flowOutcome === 'returned'
      ? t('prCard.title.returned_to_flow')
      : presentation.superseded
    ? t('prCard.title.superseded')
    : presentation.noChanges
      ? t('prCard.title.no_changes')
      : presentation.deliveryBlocked
      ? t('prCard.title.delivery_blocked')
      : presentation.retryablePush
        ? t('prCard.title.update_failed')
        : presentation.closed
          ? t('prCard.title.pr_closed')
          : presentation.partial
            ? t('prCard.title.partial')
            : envelope.statusCode === 'run_stopped'
                ? t('prCard.title.run_stopped')
            : ciShown === 'conflict'
                ? t('prCard.title.ci_conflict')
            : ciShown === 'red'
                ? t('prCard.title.ci_needs_attention')
            : ciShown === 'pending'
                ? t('prCard.title.ci_pending')
            : ciShown === 'green'
                ? t('prCard.title.ci_green')
            : envelope.statusCode === 'existing_pr_updated'
                ? t('prCard.title.existing_pr_updated')
                : degradedDraft ? t('prCard.title.pr_draft_degraded')
                  : flowSpecDelivered ? t('prCard.title.flowSpecDelivered') : t(`prCard.title.${decision}`)
  return { state, objectIcon, title }
}

export function PrCardHeader({ model, shouldAnnounce, announceExtra }: {
  model: PrDecisionCardModel
  shouldAnnounce: boolean
  announceExtra: string
}) {
  const { t, envelope, decision, terminal, projectName } = model
  const { state, objectIcon, title } = settledCardHeading(model)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <RunStateGlyph state={state} objectIcon={objectIcon} size="md" data-testid="agent-pr-decision-glyph" />
      <span
        className={cn('min-w-0 flex-1 basis-[12rem] truncate text-sm font-medium', decision === 'discarded' ? 'text-muted-foreground' : 'text-foreground')}
        title={title}
        data-testid="agent-pr-decision-title"
        // With no operation/recovery text to announce, the visible title is the single live region (no sr-only duplicate).
        {...(shouldAnnounce && !announceExtra ? { role: 'status', 'aria-live': 'polite' as const } : {})}
      >
        {title}
      </span>
      {!terminal && <HelpHint topic="prDecision" />}
      <span className="min-w-0 max-w-[140px] shrink truncate text-label text-muted-foreground" title={projectName}>
        {projectName}
      </span>
      <span className="shrink-0 rounded-full border border-border/60 bg-surface/60 px-2 py-0.5 text-caption font-medium text-muted-foreground">
        {t('prCard.rail', { index: envelope.railIndex + 1 })}
      </span>
    </div>
  )
}
