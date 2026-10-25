// ─── A delivery's slot in the history ─────────────────────────────────────────
// The pr_decision row sits where the run was launched. While the run is live
// (in the strip) that slot says only what happened — "Launched on Rail 1" —
// and opens the run. Once settled, an Implement run shows its settled card
// (the one full card); a Flow → Spec run shows its outcome as a line that
// expands the card in place, because the Flow's closing summary is the full
// card of that story.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { GitPullRequest, Rocket, Undo2, XCircle, CheckCircle2 } from 'lucide-react'
import type { AgentPrDecisionEnvelope } from '../lib/agent-api'
import { AgentPrDecisionCard } from './AgentPrDecisionCard'
import { AgentRunEventLine, type RunEventTone } from './AgentRunEventLine'
import { useLoopLabel } from '../../delivery/components/LoopChip'
import { FOCUS_PR_CARD_EVENT, focusInConversation, focusMatchesCard, focusPrCard, type FocusPrCardDetail } from './agent-run-failure'

function runName(t: (key: string, options?: Record<string, unknown>) => string, envelope: AgentPrDecisionEnvelope): string {
  return envelope.railName || t('prCard.rail', { index: envelope.railIndex + 1 })
}

/** "Launched on Rail 1 · #4 #7 · Flow hand-off" — opens the live run in the strip. */
export function AgentRunLaunchedLine({ envelope, conversationId }: { envelope: AgentPrDecisionEnvelope; conversationId: string }) {
  const { t } = useTranslation('agent')
  const tickets = envelope.ticketIds.map((id) => `#${id}`).join(' ')
  // The loop's localized display name (built-ins never show their internal name).
  const loop = useLoopLabel(envelope.loopId, envelope.loopName)
  const detail = [tickets, envelope.loopId || envelope.loopName ? loop.label : null].filter(Boolean).join(' · ')
  return (
    <AgentRunEventLine
      icon={Rocket}
      testId="agent-run-launched-line"
      attributes={{ 'data-pr-delivery-id': envelope.prDeliveryId }}
      detail={detail || undefined}
      actionLabel={t('runStrip.event.openRun')}
      onActivate={() => focusPrCard({ prDeliveryId: envelope.prDeliveryId, runIds: envelope.runIds ?? [], conversationId })}
    >
      {t('runStrip.event.launched', { run: runName(t, envelope) })}
    </AgentRunEventLine>
  )
}

/** The outcome of a settled Flow → Spec run, as words and a tone. */
export function settledRunOutcome(
  t: (key: string, options?: Record<string, unknown>) => string,
  envelope: AgentPrDecisionEnvelope,
): { text: string; tone: RunEventTone; icon: typeof Rocket } {
  const run = runName(t, envelope)
  if (envelope.decision === 'discarded' && envelope.statusCode === 'returned_to_flow') {
    return { text: t('runStrip.event.flowReturned', { run }), tone: 'flow', icon: Undo2 }
  }
  if (['pr_ready', 'pr_draft', 'on_review', 'completed', 'merged'].includes(envelope.decision)) {
    const pr = envelope.prNumber ? `#${envelope.prNumber}` : null
    return {
      text: pr ? t('runStrip.event.delivered', { pr }) : t('runStrip.event.deliveredNoPr', { run }),
      tone: 'success',
      icon: envelope.prNumber || envelope.prUrl ? GitPullRequest : CheckCircle2,
    }
  }
  if (envelope.decision === 'superseded') return { text: t('runStrip.event.superseded', { run }), tone: 'neutral', icon: XCircle }
  return { text: t('runStrip.event.discarded', { run }), tone: 'neutral', icon: XCircle }
}

/** A settled Flow → Spec run: its outcome line, expanding the card in place. */
export function AgentSettledRunLine({ envelope, conversationId }: { envelope: AgentPrDecisionEnvelope; conversationId: string }) {
  const { t } = useTranslation('agent')
  const [open, setOpen] = useState(false)
  const outcome = settledRunOutcome(t, envelope)
  const loop = useLoopLabel(envelope.loopId, envelope.loopName)
  // Focus bus: a collapsed card cannot hear the request — expand, then re-dispatch.
  const state = useRef({ open, envelope })
  state.current = { open, envelope }
  const [pending, setPending] = useState<FocusPrCardDetail | null>(null)
  useEffect(() => {
    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<FocusPrCardDetail>).detail
      if (!detail || detail.expanded || !focusInConversation(detail, conversationId)) return
      const current = state.current
      if (current.open || !focusMatchesCard(detail, { prDeliveryId: current.envelope.prDeliveryId, runIds: current.envelope.runIds })) return
      setOpen(true)
      setPending({ ...detail, conversationId })
    }
    window.addEventListener(FOCUS_PR_CARD_EVENT, onFocus)
    return () => window.removeEventListener(FOCUS_PR_CARD_EVENT, onFocus)
  }, [conversationId])
  useEffect(() => {
    if (!pending) return
    setPending(null)
    focusPrCard({ ...pending, expanded: true })
  }, [pending])
  return (
    <div data-testid="agent-settled-run" data-pr-delivery-id={envelope.prDeliveryId}>
      <AgentRunEventLine
        icon={outcome.icon}
        tone={outcome.tone}
        testId="agent-settled-run-line"
        expanded={open}
        detail={envelope.loopId || envelope.loopName ? loop.label : undefined}
        actionLabel={open ? t('runStrip.hideDetails') : t('runStrip.showDetails')}
        onActivate={() => setOpen((value) => !value)}
      >
        {outcome.text}
      </AgentRunEventLine>
      {open && (
        <div className="mt-1">
          <AgentPrDecisionCard envelope={envelope} conversationId={conversationId} />
        </div>
      )}
    </div>
  )
}
