// ─── Flow-or-Implement offer card (```flow-offer) ─────────────────────────────
// Rendered by missions through the extension fence slot. Flow and Implement
// never compete: two options with equal weight, always in the same order
// (Flow, then spec + Implement), and the agent's reason as neutral context
// ("Why the agent asked"). A legacy offer's `recommended` is ignored.
//   Flow      → the entry confirmation (FlowEntryCard) in place; Start begins
//               the Flow and records { chosenMode: 'flow', flowId }.
//   Implement → replies to the agent so it continues with framing + spec draft.
// The decision (chosenMode) persists on agent_messages.intent so the card
// renders frozen after a reload. It is also the timeline anchor of the Flow's
// hand-off decision (`flow-hand-off`).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowUpRight, Ban, CheckCircle2, FileText, Hammer, Waves } from 'lucide-react'
import { focusPrCard } from '../../missions/components/agent-run-failure'
import { cn } from '../../../lib/utils'
import type { MissionFenceCardProps } from '../../missions/context/MissionExtensionsContext'
import { patchAgentMessageIntent, type AgentMessageIntent } from '../../missions/lib/agent-api'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { intentFor, recordLocalIntent, useLocalIntents } from '../../rails/lib/rail-launch-intents'
import { useConversationFlow } from '../context/FlowContext'
import { isOpenFlow, type Flow } from '../lib/flow-api'
import { FLOW_OFFER_MODES, parseFlowOffer, type FlowMode } from '../lib/flow-offer'
import { FlowEntryCard } from './FlowEntryCard'

export function FlowOfferCard({ payload, index, messageId, conversationId, projectId, intents, isStreaming, onSend }: MissionFenceCardProps) {
  const { t } = useTranslation('agent')
  const reduced = useReducedMotion()
  const { active } = useAgentChat()
  const local = useLocalIntents()
  const offer = parseFlowOffer(payload)
  const { flow } = useConversationFlow(conversationId, projectId)
  const [view, setView] = useState<'choose' | 'entry'>('choose')
  const [busy, setBusy] = useState(false)

  if (!offer) return null
  const decided = messageId ? intentFor(local, messageId, intents, index, 'flow-offer') : null
  const handOff = messageId ? intentFor(local, messageId, intents, 0, 'flow-hand-off') : null

  const record = async (decision: Omit<AgentMessageIntent, 'at' | 'kind' | 'proposalIndex'>) => {
    if (!messageId || !conversationId) return
    const intent = { kind: 'flow-offer' as const, proposalIndex: index, ...decision }
    const res = await patchAgentMessageIntent(conversationId, messageId, intent).catch(() => null)
    recordLocalIntent(messageId, res && res.ok ? res.intent : { ...intent, at: new Date().toISOString() })
  }

  if (decided) {
    return <FlowOfferStub intent={decided} handOff={handOff} flow={flow} conversationId={conversationId} />
  }

  const choose = async (mode: FlowMode) => {
    if (busy) return
    if (mode === 'flow') { setView('entry'); return }
    setBusy(true)
    try {
      await record({ status: 'accepted', chosenMode: 'implement', ...(offer.ticketId ? { config: { ticketId: offer.ticketId } } : {}) })
      // An existing spec goes straight to its launch; a new idea gets its spec first.
      onSend?.(offer.ticketId ? t('flow.offer.implementExistingReply', { id: offer.ticketId }) : t('flow.offer.implementReply'))
    } finally {
      setBusy(false)
    }
  }
  const dismiss = async () => {
    if (busy) return
    setBusy(true)
    try { await record({ status: 'dismissed', chosenMode: null }) } finally { setBusy(false) }
  }
  const onStarted = (started: Flow) => {
    void record({ status: 'accepted', chosenMode: 'flow', config: { flowId: started.id, ...(offer.ticketId ? { ticketId: offer.ticketId } : {}) } })
  }

  if (view === 'entry') {
    return (
      <FlowEntryCard
        idea={offer.idea}
        title={offer.title}
        repositoryId={offer.repositoryId}
        ticketId={offer.ticketId}
        projectId={projectId}
        conversationId={conversationId}
        provider={active?.id === conversationId ? active?.provider : null}
        blockedByOpenFlow={isOpenFlow(flow)}
        openFlowId={isOpenFlow(flow) ? flow!.id : null}
        onStarted={onStarted}
        onCancel={() => setView('choose')}
      />
    )
  }

  const modeIcon = (mode: FlowMode) => (mode === 'flow' ? Waves : FileText)
  const disabled = busy || isStreaming || !messageId || !conversationId
  const labelId = `flow-offer-${messageId}-${index}`
  const hintId = `${labelId}-hint`

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      role="group"
      aria-labelledby={labelId}
      data-testid="flow-offer-card"
      className="my-1 overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-md"
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-surface/40 px-3.5 py-2">
        <Waves className="h-3.5 w-3.5 text-accent-flow" aria-hidden />
        <span id={labelId} className="text-[13px] font-semibold text-foreground">{t('flow.offer.heading')}</span>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        {offer.ticketId ? (
          <p data-testid="flow-offer-spec" className="flex min-w-0 items-baseline gap-1.5 text-sm text-foreground/90">
            <span className="shrink-0 font-mono text-xs text-foreground/70">{t('flow.entry.existingSpec.label', { id: offer.ticketId })}</span>
            <span className="min-w-0 truncate" title={offer.title ?? offer.idea}>{offer.title ?? offer.idea}</span>
          </p>
        ) : (
          <p className="text-sm text-foreground/90">{offer.idea}</p>
        )}
        {offer.reason && (
          <div data-testid="flow-offer-reason" className="text-xs leading-5">
            <p className="font-medium text-foreground/75">{t('flow.offer.why')}</p>
            <p className="text-foreground/70">{offer.reason}</p>
          </div>
        )}
        <div className="grid gap-2 sm:grid-cols-2">
          {FLOW_OFFER_MODES.map((mode) => {
            const Icon = modeIcon(mode)
            return (
              <button
                key={mode}
                type="button"
                data-agent-interactive
                data-testid={`flow-offer-choose-${mode}`}
                disabled={disabled}
                aria-describedby={isStreaming ? hintId : undefined}
                onClick={() => void choose(mode)}
                className={cn(
                  'group flex flex-col items-start gap-1 rounded-lg border border-border/60 bg-surface/30 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
                  mode === 'flow'
                    ? 'hover:border-accent-flow/50 hover:bg-accent-flow/10 focus-visible:ring-accent-flow/50'
                    : 'hover:border-accent-primary/50 hover:bg-accent-primary/10 focus-visible:ring-accent-primary/50',
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <Icon className={cn('h-3.5 w-3.5', mode === 'flow' ? 'text-accent-flow' : 'text-accent-primary')} aria-hidden />
                  {t(`flow.offer.mode.${mode}.title`)}
                </span>
                <span className="text-xs leading-4 text-foreground/70">{t(`flow.offer.mode.${mode}.${offer.ticketId ? 'hintExisting' : 'hint'}`)}</span>
              </button>
            )
          })}
        </div>
        <div className="flex items-center justify-between gap-2">
          <p id={hintId} className="min-w-0 text-xs text-foreground/70" data-testid="flow-offer-streaming-hint">
            {isStreaming ? t('flow.offer.waitForReply') : null}
          </p>
          <button type="button" data-agent-interactive data-testid="flow-offer-dismiss" disabled={disabled} onClick={() => void dismiss()} className="shrink-0 rounded-md px-2 py-0.5 text-xs text-foreground/75 transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50 disabled:opacity-50">
            {t('flow.offer.notNow')}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

/** Frozen record of the decision (and of the Flow's hand-off when it happened). */
function FlowOfferStub({ intent, handOff, flow, conversationId }: { intent: AgentMessageIntent; handOff: AgentMessageIntent | null; flow: Flow | null; conversationId: string | null }) {
  const { t } = useTranslation('agent')
  const dismissed = intent.status === 'dismissed'
  const chosen = intent.chosenMode ?? null
  // The hand-off record links to its run card (the shared card focus bus).
  const launched = !dismissed && chosen === 'flow' && handOff?.status === 'launched'
  const runTarget = launched
    ? { prDeliveryId: handOff!.prDeliveryId ?? (flow && flow.id === intent.config?.flowId ? flow.deliveryId : null), runIds: handOff!.runIds ?? [] }
    : null
  const flowLabel = handOff && handOff.status === 'launched'
    ? t('flow.offer.stub.handedOff', { rail: typeof handOff.railIndex === 'number' ? handOff.railIndex + 1 : '?' })
    : flow && flow.id === intent.config?.flowId
      ? t(`flow.offer.stub.state.${flow.state}`)
      : t('flow.offer.stub.flow')
  const Icon = dismissed ? Ban : chosen === 'flow' ? Waves : chosen === 'implement' ? Hammer : CheckCircle2
  return (
    <div
      data-testid={`flow-offer-stub-${dismissed ? 'dismissed' : chosen ?? 'accepted'}`}
      className={cn(
        'my-1 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs',
        dismissed ? 'border-border/50 bg-surface/40 text-foreground/70' : chosen === 'flow' ? 'border-accent-flow/30 bg-accent-flow/[0.06] text-foreground/80' : 'border-accent-primary/30 bg-accent-primary/[0.06] text-foreground/80',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', chosen === 'flow' && !dismissed ? 'text-accent-flow' : dismissed ? '' : 'text-accent-primary')} aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {dismissed ? t('flow.offer.stub.dismissed') : chosen === 'flow' ? flowLabel : t('flow.offer.stub.implement')}
      </span>
      {runTarget && (runTarget.prDeliveryId || runTarget.runIds.length > 0) && (
        <button
          type="button"
          data-agent-interactive
          data-testid="flow-offer-stub-view-run"
          onClick={() => focusPrCard({ prDeliveryId: runTarget.prDeliveryId, runIds: runTarget.runIds, conversationId })}
          className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-xs font-medium text-accent-flow hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-flow/50"
        >
          {t('flow.offer.stub.viewRun')}
          <ArrowUpRight className="h-3 w-3" aria-hidden />
        </button>
      )}
    </div>
  )
}
