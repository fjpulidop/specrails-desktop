import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, ChevronDown, ChevronRight, MessageSquareWarning, Sparkles } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { focusPrCard, type RunFailureRow } from './agent-run-failure'
import { AgentContextInlineTokens } from './AgentMessage'
import { AgentRunEventLine } from './AgentRunEventLine'
import { useMissionExtensions } from '../context/MissionExtensionsContext'
import type { AgentContextReference, AgentPrDecisionEnvelope } from '../lib/agent-api'

/**
 * The moment a run failed (`run-failure` system row, mission-rail-cards), as
 * ONE history event line in plain words — "Rail 1 failed while writing the
 * spec" — that opens the run (its strip panel while live, its card once
 * settled). The run itself carries the recovery actions; this is only the
 * trace of when it happened.
 */
export function AgentRunFailureMarker({ row, conversationId = null, envelope = null }: {
  row: RunFailureRow
  conversationId?: string | null
  /** The run's delivery, when the conversation has it (names the loop). */
  envelope?: Pick<AgentPrDecisionEnvelope, 'loopId' | 'railName'> | null
}) {
  const { t } = useTranslation('agent')
  const { describeRun } = useMissionExtensions()
  // Flow → Spec still needs changes: a review outcome, not a crash.
  const changes = row.code === 'review_changes_requested'
  const rail = envelope?.railName || t('prCard.rail', { index: row.railIndex + 1 })
  const described = changes ? null : describeRun?.(t, { loopId: envelope?.loopId ?? null, stepId: row.stepId, codes: [row.code] })?.failure ?? null
  const reason = described ?? (t(`runStrip.failed.${row.code}`, { defaultValue: '' }) || t('runStrip.failed.generic'))
  return (
    <AgentRunEventLine
      icon={changes ? MessageSquareWarning : AlertTriangle}
      tone={changes ? 'warning' : 'failed'}
      testId="agent-run-failure-marker"
      attributes={{ 'data-code': row.code }}
      actionLabel={t('runStrip.event.openRun')}
      onActivate={() => focusPrCard({ prDeliveryId: row.prDeliveryId ?? null, runIds: [row.runId], conversationId })}
    >
      {changes ? t('runStrip.event.changes', { run: rail }) : t('runStrip.event.failed', { run: rail, reason })}
    </AgentRunEventLine>
  )
}

/**
 * The automatic failure briefing the SERVER sent as a user turn: rendered as a
 * muted, collapsible chip instead of a person's speech bubble, so the
 * transcript never reads as if the user typed it.
 */
export function AgentSystemBriefing({ content, contextRefs }: { content: string; contextRefs?: AgentContextReference[] }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  // Automatic turns other than a run failure (Back to Flow) name themselves.
  const automatic = (contextRefs?.[0] as { metadata?: { automatic?: unknown } } | undefined)?.metadata?.automatic === true
  return (
    <div data-testid="agent-system-briefing" className="flex flex-col items-end gap-1">
      <button
        type="button"
        data-agent-interactive
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-surface/50 px-2.5 py-1 text-caption text-foreground/60 transition-colors hover:border-accent-primary/40 hover:text-foreground/80',
        )}
      >
        <Sparkles className="h-3 w-3 text-accent-primary/70" aria-hidden />
        {automatic ? t('flowReturn.automaticTurn') : t('runFailure.briefing.title')}
        {open ? <ChevronDown className="h-3 w-3 opacity-60" aria-hidden /> : <ChevronRight className="h-3 w-3 opacity-60" aria-hidden />}
      </button>
      {open && (
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm border border-border/40 bg-surface/40 px-3.5 py-2 text-xs text-foreground/70" data-testid="agent-system-briefing-body">
          <AgentContextInlineTokens content={content} contextRefs={contextRefs} />
        </div>
      )}
    </div>
  )
}
