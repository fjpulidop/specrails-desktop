import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import type { AgentPrDecisionValue } from '../lib/agent-api'

const PILL_TONE: Record<AgentPrDecisionValue, string> = {
  building: 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary',
  on_review: 'border-accent-review/40 bg-accent-review/10 text-accent-review',
  pr_draft: 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  pr_ready: 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  no_changes: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
  completed: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
  pr_closed: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  superseded: 'border-border/60 bg-surface/60 text-foreground/40',
  implementation_failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  pr_failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  merged: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
  discarded: 'border-border/60 bg-surface/60 text-foreground/50',
}

/** Compact decision-state pill (the project builder's milestone rows). */
export function PrDecisionPill({ decision }: { decision: AgentPrDecisionValue }) {
  const { t } = useTranslation('agent')
  return (
    <span
      data-testid="pr-decision-pill"
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-caption font-medium uppercase tracking-wide',
        PILL_TONE[decision],
      )}
    >
      {t(`prCard.pinned.state.${decision}`)}
    </span>
  )
}
