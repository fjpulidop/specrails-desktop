/**
 * Inline PR-decision card (safe-pr-review-flow, Option B): rendered in place of
 * a `system`-role message whose content is a pr_decision envelope. A pure
 * view/controller over the authoritative `rail_pr_deliveries` row — buttons
 * POST the same `/rails/pr-decision` endpoint the dashboard uses (scoped to the
 * CARD's project, never the active one) and the card re-renders from the next
 * `agent_pr_decision` broadcast, which updates the same envelope in place.
 *
 * This file is the container: `usePrDecisionCardModel` owns the state machine
 * and effects; the card frame stays here (one root node across states) and the
 * body comes from `pr-decision-card/` — building, run-only or settled.
 */
import { cn } from '../../../lib/utils'
import type { AgentPrDecisionEnvelope } from '../lib/agent-api'
import type { MissionRunCardSummary, MissionRunVitalsSnapshot } from './mission-run-strip'
import { usePrDecisionCardModel } from './pr-decision-card/usePrDecisionCardModel'
import { BuildingRunBody } from './pr-decision-card/BuildingRunBody'
import { RunOnlyBody } from './pr-decision-card/RunOnlyBody'
import { SettledPrBody } from './pr-decision-card/SettledPrBody'

export { deriveMissionRunStatus, flowCardOutcome } from './pr-decision-card/run-status'

export interface AgentPrDecisionCardProps {
  envelope: AgentPrDecisionEnvelope
  conversationId?: string | null
  /** Inside the run strip's panel: no card chrome of its own (the panel is the surface). */
  embedded?: boolean
  /** What the card knows about its live run (the strip's state) — on change only. */
  onSummary?: (summary: MissionRunCardSummary) => void
  /** Each run's vitals as its log chip measures them (the strip's totals). */
  onRunVitals?: (runId: string, snapshot: MissionRunVitalsSnapshot) => void
}

/** Chrome removed when the card is the content of the run strip's panel. */
const EMBEDDED_CARD = 'rounded-none border-0 bg-transparent px-0 py-0 shadow-none'

export function AgentPrDecisionCard({ envelope, conversationId, embedded = false, onSummary, onRunVitals }: AgentPrDecisionCardProps) {
  const model = usePrDecisionCardModel({ envelope, conversationId, embedded, onSummary, onRunVitals })
  const { decision, runOnly, runStatus, cardRef, focusRegion, flash, flashClass } = model

  // The launch card lands in `building` from second zero: say what is actually
  // happening (isolated-worktree run) and that the PR question comes at settle.
  if (decision === 'building') {
    return (
      <div
        ref={cardRef}
        {...focusRegion}
        data-testid="agent-pr-decision-card"
        data-flash={flash ? 'true' : undefined}
        className={cn('rounded-xl border border-border/60 bg-card/80 px-3.5 py-2.5 text-xs text-muted-foreground shadow-lg transition-shadow', embedded && EMBEDDED_CARD, flashClass)}
      >
        <BuildingRunBody model={model} />
      </div>
    )
  }

  // ── mission-rail-cards: run-only card (shared-cwd launch, no delivery) ────
  if (runOnly) {
    return (
      <div
        ref={cardRef}
        {...focusRegion}
        data-testid="agent-pr-decision-card"
        data-flash={flash ? 'true' : undefined}
        data-run-only="true"
        className={cn('rounded-card border border-border/60 bg-card px-3.5 py-3 shadow-1 transition-shadow', runStatus === 'succeeded' && 'border-accent-success/30', runStatus === 'cancelled' && 'border-border/40', embedded && EMBEDDED_CARD, flashClass)}
      >
        <RunOnlyBody model={model} />
      </div>
    )
  }

  return (
    <div
      ref={cardRef}
      {...focusRegion}
      data-testid="agent-pr-decision-card"
      data-flash={flash ? 'true' : undefined}
      className={cn(
        'rounded-card border border-border/60 bg-card px-3.5 py-3 shadow-1 transition-shadow',
        decision === 'merged' && 'border-accent-success/30',
        decision === 'completed' && 'border-accent-success/30',
        // Settled: muted tokens, never an opacity over text (AA stays intact).
        decision === 'discarded' && 'border-border/40',
        embedded && EMBEDDED_CARD,
        flashClass,
      )}
    >
      <SettledPrBody model={model} />
    </div>
  )
}
