// ─── "This is it" → hand-off card ─────────────────────────────────────────────
// The rail launch card everyone knows, in hand-off mode: the Flow's placeholder
// spec, the Flow → Spec loop preselected, a free EMPTY rail (or a new one), the
// engine/model/effort selectors, and the same inline refusals (review WIP
// limit, budget, busy rail) the launch route reports. Launch calls the Flow
// hand-off route, never the plain rails launch. The decision is recorded on
// the Flow offer message that started this Flow (`flow-hand-off`); without
// one, the Flow's own state is the record. The engine/model/effort default to
// the Flow conversation's current selection (the rail default only when that
// provider cannot run the loop here, with a note saying so).

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { AgentRailLaunchCard, type RailLaunchHandOff } from '../../missions/components/AgentRailLaunchCard'
import type { AgentMessage, AgentMessageIntent } from '../../missions/lib/agent-api'
import type { RailLaunchProposal } from '../../rails/lib/rail-launch-draft'
import { useLocalIntents } from '../../rails/lib/rail-launch-intents'
import { useFlowContext, type FlowHandOffReceipt } from '../context/FlowContext'
import { FlowApiError, type Flow } from '../lib/flow-api'
import { FLOW_SPEC_LOOP_ID } from '../lib/flow-offer'
import { flowHandOffEngine } from '../lib/flow-engine'
import { useProviderDetection } from '../../providers/hooks/useProviderDetection'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { flowCostDisplay } from '../lib/flow-offer'
import { useFlowLiveStats } from './FlowStripControls'

/** The message whose flow-offer decision started this Flow (null if none). */
export function findFlowAnchor(
  messages: readonly AgentMessage[],
  local: ReadonlyMap<string, readonly AgentMessageIntent[]>,
  flowId: string,
): string | null {
  for (const message of messages) {
    const intents = [...(local.get(message.id) ?? []), ...(message.intents ?? [])]
    if (intents.some((intent) => intent.kind === 'flow-offer' && intent.config?.flowId === flowId)) return message.id
  }
  return null
}

export function FlowHandOffCard({ projectId, conversationId, flow, receipt }: { projectId: string; conversationId: string; flow: Flow; receipt?: FlowHandOffReceipt | null }) {
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const { messages, conversations, active } = useAgentChat()
  const detection = useProviderDetection()
  const conversation = (active?.id === conversationId ? active : null) ?? conversations.find((entry) => entry.id === conversationId) ?? null
  const engine = useMemo(
    () => flowHandOffEngine(conversation, detection.detected, detection.loading),
    [conversation, detection.detected, detection.loading],
  )
  const local = useLocalIntents()
  const anchor = useMemo(() => findFlowAnchor(messages, local, flow.id), [messages, local, flow.id])
  // The milestone recap: what goes to the rail, what it cost, and the safety net.
  const { diff, cost } = useFlowLiveStats(projectId, flow, false)
  const costView = flowCostDisplay(cost)
  const totals = diff?.totals ?? null

  const proposal: RailLaunchProposal = useMemo(() => ({
    version: 1,
    railIndex: null,
    newRail: null,
    ticketIds: flow.ticketId !== null ? [flow.ticketId] : [],
    mode: 'loop',
    loopId: FLOW_SPEC_LOOP_ID,
    aiEngine: engine.aiEngine,
    model: engine.model,
    reasoningEffort: engine.reasoningEffort,
    profileName: null,
    targetPrNumber: null,
    baseBranch: null,
    railName: null,
    rationale: t('flow.handOff.rationale'),
    followUp: null,
  }), [flow.ticketId, t, engine.aiEngine, engine.model, engine.reasoningEffort])

  const handOff: RailLaunchHandOff = useMemo(() => ({
    loop: { id: FLOW_SPEC_LOOP_ID, label: t('flow.handOff.loop') },
    heading: t('flow.handOff.heading'),
    playLabel: t('flow.handOff.launch'),
    dismissLabel: t('flow.handOff.notYet'),
    intentKind: 'flow-hand-off',
    persist: anchor !== null,
    config: { flowId: flow.id },
    onDismiss: () => ctx?.setWrappingUp(flow.id, false),
    launch: async (input) => {
      if (!ctx) return { ok: false, error: 'network' }
      try {
        const result = await ctx.handOff(projectId, flow, input)
        return { ok: true, runIds: result.loopRunIds, prDeliveryId: result.deliveryId }
      } catch (error) {
        if (error instanceof FlowApiError) return { ok: false, error: error.code, detail: error.detail, action: error.action }
        return { ok: false, error: error instanceof Error ? error.message : 'network' }
      }
    },
  }), [anchor, ctx, flow, projectId, t])

  const intent: AgentMessageIntent | null = receipt
    ? { kind: 'flow-hand-off', proposalIndex: 0, status: 'launched', at: '', railIndex: receipt.railIndex, runIds: receipt.runIds, prDeliveryId: receipt.deliveryId }
    : null

  return (
    <div data-testid="flow-hand-off-card">
      {!intent && (
        <p data-testid="flow-hand-off-recap" className="mb-1.5 px-1 text-[11px] leading-snug text-muted-foreground">
          <span className="tabular-nums text-foreground/75">
            {t('flow.bar.files', { count: totals?.files ?? 0 })}
            {totals && totals.files > 0 && <> <span className="text-accent-success">+{totals.additions}</span> <span className="text-destructive">−{totals.deletions}</span></>}
            {' · '}
            {costView.usd ? t('flow.handOff.cost', { cost: `${costView.usd}${costView.partial ? '*' : ''}` }) : t('flow.handOff.costUnknown')}
          </span>
          {' — '}
          {t('flow.handOff.safetyNet')}
        </p>
      )}
      {!intent && engine.fallbackFrom && (
        <p data-testid="flow-hand-off-engine-note" className="mb-1.5 px-1 text-[11px] leading-snug text-muted-foreground">
          {t('flow.handOff.engineFallback', { provider: providerLabel(engine.fallbackFrom) })}
        </p>
      )}
      <AgentRailLaunchCard
        key={`${engine.aiEngine ?? 'default'}:${engine.model ?? ''}:${engine.reasoningEffort ?? ''}`}
        proposal={proposal}
        proposalIndex={0}
        messageId={anchor ?? `flow:${flow.id}`}
        conversationId={conversationId}
        projectId={projectId}
        intent={intent}
        handOff={handOff}
      />
    </div>
  )
}
