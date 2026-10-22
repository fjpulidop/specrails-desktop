// ─── Flow-or-Implement offer card (```flow-offer) ─────────────────────────────
// Rendered by missions through the extension fence slot. Shows the agent's
// recommendation and its reason with the other path one click away:
//   Flow      → the entry confirmation (FlowEntryCard) in place; Start begins
//               the Flow and records { chosenMode: 'flow', flowId }.
//   Implement → replies to the agent so it continues with framing + spec draft.
// The decision (recommendedMode, chosenMode) persists on agent_messages.intent
// so the card renders frozen after a reload. It is also the timeline anchor of
// the Flow's hand-off decision (`flow-hand-off`).

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, useReducedMotion } from 'motion/react'
import { Ban, CheckCircle2, FileText, Hammer, Sparkles, Waves } from 'lucide-react'
import { cn } from '../../../lib/utils'
import type { MissionFenceCardProps } from '../../missions/context/MissionExtensionsContext'
import { patchAgentMessageIntent, type AgentMessageIntent } from '../../missions/lib/agent-api'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { intentFor, recordLocalIntent, useLocalIntents } from '../../rails/lib/rail-launch-intents'
import { useConversationFlow } from '../context/FlowContext'
import { isOpenFlow, type Flow } from '../lib/flow-api'
import { otherMode, parseFlowOffer, type FlowMode } from '../lib/flow-offer'
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
    const intent = { kind: 'flow-offer' as const, proposalIndex: index, recommendedMode: offer.recommended, ...decision }
    const res = await patchAgentMessageIntent(conversationId, messageId, intent).catch(() => null)
    recordLocalIntent(messageId, res && res.ok ? res.intent : { ...intent, at: new Date().toISOString() })
  }

  if (decided) {
    return <FlowOfferStub intent={decided} handOff={handOff} flow={flow} />
  }

  const choose = async (mode: FlowMode) => {
    if (busy) return
    if (mode === 'flow') { setView('entry'); return }
    setBusy(true)
    try {
      await record({ status: 'accepted', chosenMode: 'implement' })
      onSend?.(t('flow.offer.implementReply'))
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
    void record({ status: 'accepted', chosenMode: 'flow', config: { flowId: started.id } })
  }

  if (view === 'entry') {
    return (
      <FlowEntryCard
        idea={offer.idea}
        title={offer.title}
        projectId={projectId}
        conversationId={conversationId}
        provider={active?.id === conversationId ? active?.provider : null}
        blockedByOpenFlow={isOpenFlow(flow)}
        onStarted={onStarted}
        onCancel={() => setView('choose')}
      />
    )
  }

  const recommended = offer.recommended
  const alternative = otherMode(recommended)
  const modeIcon = (mode: FlowMode) => (mode === 'flow' ? Waves : FileText)
  const RecommendedIcon = modeIcon(recommended)
  const AlternativeIcon = modeIcon(alternative)
  const disabled = busy || isStreaming || !messageId || !conversationId

  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      role="group"
      aria-labelledby={`flow-offer-${messageId}-${index}`}
      data-testid="flow-offer-card"
      data-recommended={recommended}
      className="my-1 overflow-hidden rounded-xl border border-border/60 bg-card/80 shadow-md backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-border/40 bg-surface/40 px-3.5 py-2">
        <Sparkles className="h-3.5 w-3.5 text-accent-primary" aria-hidden />
        <span id={`flow-offer-${messageId}-${index}`} className="text-[10px] font-semibold uppercase tracking-widest text-foreground/70">{t('flow.offer.heading')}</span>
      </div>
      <div className="space-y-3 px-3.5 py-3">
        <p className="text-sm text-foreground/90">{offer.idea}</p>
        {offer.reason && <p className="text-xs italic text-foreground/60">{offer.reason}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            data-agent-interactive
            data-testid={`flow-offer-choose-${recommended}`}
            disabled={disabled}
            onClick={() => void choose(recommended)}
            className={cn(
              'group flex flex-col items-start gap-1 rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              recommended === 'flow' ? 'border-accent-info/50 bg-accent-info/10 hover:bg-accent-info/15' : 'border-accent-primary/50 bg-accent-primary/10 hover:bg-accent-primary/15',
            )}
          >
            <span className="flex w-full items-center gap-1.5 text-xs font-semibold text-foreground">
              <RecommendedIcon className={cn('h-3.5 w-3.5', recommended === 'flow' ? 'text-accent-info' : 'text-accent-primary')} aria-hidden />
              {t(`flow.offer.mode.${recommended}.title`)}
              <span className="ml-auto rounded-full border border-current/30 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-foreground/60">{t('flow.offer.recommended')}</span>
            </span>
            <span className="text-[11px] leading-4 text-foreground/60">{t(`flow.offer.mode.${recommended}.hint`)}</span>
          </button>
          <button
            type="button"
            data-agent-interactive
            data-testid={`flow-offer-choose-${alternative}`}
            disabled={disabled}
            onClick={() => void choose(alternative)}
            className="flex flex-col items-start gap-1 rounded-lg border border-border/60 bg-surface/30 px-3 py-2 text-left transition-colors hover:border-foreground/30 hover:bg-surface/60 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/85">
              <AlternativeIcon className="h-3.5 w-3.5 text-foreground/55" aria-hidden />
              {t(`flow.offer.mode.${alternative}.title`)}
            </span>
            <span className="text-[11px] leading-4 text-foreground/55">{t(`flow.offer.mode.${alternative}.hint`)}</span>
          </button>
        </div>
        <div className="flex justify-end">
          <button type="button" data-agent-interactive data-testid="flow-offer-dismiss" disabled={disabled} onClick={() => void dismiss()} className="rounded-md px-2 py-0.5 text-[11px] text-foreground/50 transition-colors hover:bg-surface hover:text-foreground disabled:opacity-50">
            {t('flow.offer.notNow')}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

/** Frozen record of the decision (and of the Flow's hand-off when it happened). */
function FlowOfferStub({ intent, handOff, flow }: { intent: AgentMessageIntent; handOff: AgentMessageIntent | null; flow: Flow | null }) {
  const { t } = useTranslation('agent')
  const dismissed = intent.status === 'dismissed'
  const chosen = intent.chosenMode ?? null
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
        'my-1 flex items-center gap-2 rounded-xl border px-3 py-2 text-xs backdrop-blur',
        dismissed ? 'border-border/50 bg-surface/40 text-foreground/50' : chosen === 'flow' ? 'border-accent-info/30 bg-accent-info/[0.06] text-foreground/80' : 'border-accent-primary/30 bg-accent-primary/[0.06] text-foreground/80',
      )}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', chosen === 'flow' && !dismissed ? 'text-accent-info' : dismissed ? '' : 'text-accent-primary')} aria-hidden />
      <span className="min-w-0 flex-1 truncate">
        {dismissed ? t('flow.offer.stub.dismissed') : chosen === 'flow' ? flowLabel : t('flow.offer.stub.implement')}
      </span>
      {!dismissed && intent.recommendedMode && intent.recommendedMode !== chosen && (
        <span className="shrink-0 text-[10px] text-foreground/45">{t('flow.offer.stub.overrode', { mode: t(`flow.offer.mode.${intent.recommendedMode}.title`) })}</span>
      )}
    </div>
  )
}
