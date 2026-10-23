// ─── "Hand off" → one confirmation line ──────────────────────────────────────
// The rail launch card in hand-off mode reads as ONE line: "Rail 2 will turn
// your 7 changed files into a reviewed PR. If it fails, your work is safe."
// with Launch and Not yet. How (rail, engine, model, effort — prefilled; the
// loop is fixed to Flow → Spec) sits under "Change how", with what the Flow
// changed and cost so far. The cost so far also ends the main line; a partial
// cost's `*` is explained in words (screen readers) and by a short visible
// note under the line. The engine fallback note, when relevant, shows on the
// main line too (it changes what launches).
// The same inline refusals (review WIP limit, budget, busy rail) the launch
// route reports show under the line. Launch calls the Flow hand-off route,
// never the plain rails launch. The decision is recorded on
// the Flow offer message that started this Flow (`flow-hand-off`); without
// one, the Flow's own state is the record. The engine/model/effort default to
// the Flow conversation's current selection (the rail default only when that
// provider cannot run the loop here, with a note saying so). The person's own
// choices (rail, engine, model, effort) are kept in FlowContext per Flow and
// restored when the hand-off reopens after "Not yet" or a remount.

import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { AgentRailLaunchCard, type RailLaunchHandOff } from '../../missions/components/AgentRailLaunchCard'
import type { AgentMessage, AgentMessageIntent } from '../../missions/lib/agent-api'
import type { RailLaunchProposal } from '../../rails/lib/rail-launch-draft'
import { useLocalIntents } from '../../rails/lib/rail-launch-intents'
import { useFlowContext, type FlowHandOffDraft, type FlowHandOffReceipt } from '../context/FlowContext'
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
  // What goes to the rail and what it cost so far (inside "Change how").
  const { diff, cost } = useFlowLiveStats(projectId, flow, false)
  const costView = flowCostDisplay(cost)
  const totals = diff?.totals ?? null
  const fileCount = totals?.files ?? null

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
    rationale: null,
    followUp: null,
  }), [flow.ticketId, t, engine.aiEngine, engine.model, engine.reasoningEffort])

  // The choices the person made earlier, read when the card (re)mounts.
  const cardKey = `${engine.aiEngine ?? 'default'}:${engine.model ?? ''}:${engine.reasoningEffort ?? ''}`
  const drafts = ctx?.handOffDrafts
  // eslint-disable-next-line react-hooks/exhaustive-deps -- read once per card mount (cardKey)
  const draft = useMemo(() => drafts?.get(flow.id) ?? null, [cardKey, flow.id])
  const setHandOffDraft = ctx?.setHandOffDraft
  const onDraftChange = useCallback((next: FlowHandOffDraft) => setHandOffDraft?.(flow.id, next), [setHandOffDraft, flow.id])

  const partialTurns = costView.partial && costView.usd ? cost?.unpricedTurns ?? 0 : 0
  const costWords = costView.usd ? t('flow.handOff.cost', { cost: `${costView.usd}${partialTurns ? '*' : ''}` }) : t('flow.handOff.costUnknown')
  const partialWords = partialTurns ? t('flow.bar.costPartial', { count: partialTurns }) : null

  const handOff: RailLaunchHandOff = useMemo(() => ({
    loop: { id: FLOW_SPEC_LOOP_ID, label: t('flow.handOff.loop') },
    heading: t('flow.handOff.heading'),
    summary: (rail: string) => fileCount !== null && fileCount > 0
      ? t('flow.handOff.line', { rail, count: fileCount })
      : t('flow.handOff.lineNoCount', { rail }),
    details: (
      <p data-testid="flow-hand-off-recap" className="text-[12px] leading-4 tabular-nums text-foreground/75">
        {t('flow.bar.files', { count: totals?.files ?? 0 })}
        {totals && totals.files > 0 && <> <span className="text-accent-success">+{totals.additions}</span> <span className="text-destructive">−{totals.deletions}</span></>}
        {' · '}
        {costWords}
        {partialWords && <span className="sr-only"> ({partialWords})</span>}
      </p>
    ),
    lineAside: (
      <span data-testid="flow-hand-off-cost" className="tabular-nums text-foreground/75">
        {' · '}{costWords}
        {partialWords && <span className="sr-only"> ({partialWords})</span>}
      </span>
    ),
    lineNote: partialWords
      ? <p data-testid="flow-hand-off-cost-partial" className="text-[12px] leading-4 text-foreground/75">* {partialWords}</p>
      : null,
    note: engine.fallbackFrom ? t('flow.handOff.engineFallback', { provider: providerLabel(engine.fallbackFrom) }) : null,
    playLabel: t('flow.handOff.launch'),
    dismissLabel: t('flow.handOff.notYet'),
    intentKind: 'flow-hand-off',
    persist: anchor !== null,
    config: { flowId: flow.id },
    draft,
    onDraftChange,
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
  }), [anchor, ctx, flow, projectId, t, fileCount, totals, costWords, partialWords, engine.fallbackFrom, draft, onDraftChange])

  const intent: AgentMessageIntent | null = receipt
    ? { kind: 'flow-hand-off', proposalIndex: 0, status: 'launched', at: '', railIndex: receipt.railIndex, runIds: receipt.runIds, prDeliveryId: receipt.deliveryId }
    : null

  return (
    <div data-testid="flow-hand-off-card">
      <AgentRailLaunchCard
        key={cardKey}
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
