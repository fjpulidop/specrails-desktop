/**
 * Header of a settled PR decision card: the state icon and title (flow, CI and
 * delivery outcomes named precisely), the help hint, project and rail badge.
 */
import {
  GitBranch, GitMerge, GitPullRequest, AlertTriangle, XCircle, CheckCircle2,
  MessageSquareWarning, Undo2, CircleStop,
} from 'lucide-react'
import { cn } from '../../../../lib/utils'
import { HelpHint } from '../../../../components/HelpHint'
import { FLOW_SPEC_LOOP_ID } from '../../../delivery/components/LoopChip'
import type { AgentPrDecisionEnvelope } from '../../lib/agent-api'
import type { PrDecisionCardModel } from './usePrDecisionCardModel'

const HEADER_ICON: Record<AgentPrDecisionEnvelope['decision'], typeof GitBranch> = {
  building: GitBranch,
  on_review: GitBranch,
  pr_draft: GitPullRequest,
  pr_ready: GitPullRequest,
  no_changes: CheckCircle2,
  completed: CheckCircle2,
  pr_closed: XCircle,
  superseded: GitPullRequest,
  implementation_failed: AlertTriangle,
  pr_failed: AlertTriangle,
  merged: GitMerge,
  discarded: XCircle,
}

const HEADER_ICON_TONE: Record<AgentPrDecisionEnvelope['decision'], string> = {
  building: 'text-accent-primary',
  on_review: 'text-accent-review',
  pr_draft: 'text-accent-info',
  pr_ready: 'text-accent-info',
  no_changes: 'text-accent-success',
  completed: 'text-accent-success',
  pr_closed: 'text-accent-warning',
  superseded: 'text-muted-foreground',
  implementation_failed: 'text-destructive',
  pr_failed: 'text-destructive',
  merged: 'text-accent-success',
  discarded: 'text-muted-foreground',
}

/** The settled card's icon, its tone and the title line. */
export function settledCardHeading(model: PrDecisionCardModel) {
  const { t, envelope, decision, flowOutcome, presentation, ciShown, degradedDraft } = model
  // A person stopped the run: a neutral stop, not the failure triangle.
  const stoppedHeader = decision === 'implementation_failed' && envelope.statusCode === 'run_stopped'
  const Icon = flowOutcome === 'changes' ? MessageSquareWarning : flowOutcome === 'returned' ? Undo2 : stoppedHeader ? CircleStop : HEADER_ICON[decision]
  const iconTone = flowOutcome === 'changes' || flowOutcome === 'crashed' ? 'text-accent-warning' : flowOutcome === 'returned' ? 'text-accent-info' : stoppedHeader ? 'text-muted-foreground' : HEADER_ICON_TONE[decision]
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
  return { Icon, iconTone, title }
}

export function PrCardHeader({ model, shouldAnnounce, announceExtra }: {
  model: PrDecisionCardModel
  shouldAnnounce: boolean
  announceExtra: string
}) {
  const { t, envelope, decision, terminal, projectName } = model
  const { Icon, iconTone, title } = settledCardHeading(model)
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Icon className={cn('h-4 w-4 shrink-0', iconTone)} aria-hidden />
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
