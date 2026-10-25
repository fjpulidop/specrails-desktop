// ─── Flow in the mission's run strip (missions useLiveRuns slot) ──────────────
// A conversation's Flow is ONE entry of the run strip, keyed by the Flow so
// the strip morphs in place across its states:
//   active / paused                → "Flow · 7 files" with Pause (or Resume)
//                                    and the primary Hand off on the row; the
//                                    branch, files ±, cost, Preview and
//                                    Discard live in its panel (FlowPanel)
//   needs review                   → informational (the copy of the project
//                                    is missing): the note in its panel
//   Hand off                       → "Ready to turn into a PR", a calm state
//                                    (no bell, no attention dot): the
//                                    hand-off line opens as the strip's panel,
//                                    with Launch declared as an outward
//                                    primary (also on the strip while the
//                                    panel is folded). Only "Not yet" and Esc
//                                    dismiss it; a click outside just folds
//                                    the panel. The choices (rail, engine,
//                                    model, effort) survive in FlowContext
//   launching                      → a skeleton in the strip itself, kept
//                                    after the request until the run shows
//                                    (the entry yields to its delivery). After
//                                    HAND_OFF_SHOW_TIMEOUT_MS without the run
//                                    it stops spinning: "Still handing off…"
//                                    with Refresh: it only re-reads (the run
//                                    cards and the Flow); the entry stays
//                                    until the delivery shows or the Flow
//                                    state moves on
// The diff and cost are measured ONCE here (useFlowLiveStats) and shared by
// the row and the panel. Also `describeRun`: the person's words for the steps
// of the hand-off loop (Flow → Spec).

import { useEffect, useMemo, useRef, useState } from 'react'
import { RefreshCw, Waves } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import { useIsStreaming } from '../../missions/hooks/useAgentLive'
import type {
  MissionConversationSlotProps, MissionLiveRun, MissionRunDescription, MissionRunDescriptionInput,
} from '../../missions/context/MissionExtensionsContext'
import { useConversationFlow, useFlowContext } from '../context/FlowContext'
import { isOpenFlow } from '../lib/flow-api'
import { flowFailureStep } from '../lib/flow-failure'
import { FLOW_SPEC_LOOP_ID } from '../lib/flow-offer'
import { FLOW_ACCENT } from '../lib/flow-accent'
import { flowOpenRunTone } from '../lib/flow-run-tone'
import { FlowHandOffCard } from './FlowHandOffCard'
import { FlowPanel, FlowStripControls, flowStripHeadline, useFlowLiveStats } from './FlowStripControls'

const FLOW_QUIET_BUTTON = 'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-label font-medium text-foreground/80 transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50'

/** How long the strip waits for the handed-off run to show before it stops spinning. */
export const HAND_OFF_SHOW_TIMEOUT_MS = 45_000

/** Flow → Spec steps and failures in the person's words (null for other loops). */
export function describeFlowRun(t: TFunction, input: MissionRunDescriptionInput): MissionRunDescription | null {
  if (input.loopId !== FLOW_SPEC_LOOP_ID) return null
  const step = flowFailureStep(input.stepId, input.codes)
  return {
    step: step === 'unknown' ? null : t(`flow.strip.step.${step}`),
    failure: t(`flow.failure.step.${step}`),
  }
}

export function useFlowLiveRuns({ conversationId, projectId, inline }: MissionConversationSlotProps): readonly MissionLiveRun[] {
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const { flow } = useConversationFlow(conversationId, projectId)
  const { active, resyncRunCards } = useAgentChat()
  const isStreaming = useIsStreaming()
  const working = isStreaming && active?.id === conversationId && flow?.state === 'active'
  const wrappingUp = !!ctx && !!flow && ctx.wrappingUp.has(flow.id) && isOpenFlow(flow)
  // Each "Hand off" opens the hand-off panel once (a new token per press).
  const handOffSeq = useRef({ flowId: '', on: false, seq: 0 })
  if (flow && (handOffSeq.current.flowId !== flow.id || handOffSeq.current.on !== wrappingUp)) {
    if (wrappingUp && !(handOffSeq.current.flowId === flow.id && handOffSeq.current.on)) handOffSeq.current.seq += 1
    handOffSeq.current = { flowId: flow.id, on: wrappingUp, seq: handOffSeq.current.seq }
  }
  const handOffToken = `hand-off:${flow?.id ?? ''}:${handOffSeq.current.seq}`
  const launching = !!ctx && !!flow && ctx.launching.has(flow.id)
  const receipt = flow ? ctx?.handedOff.get(flow.id) ?? null : null
  // The handed-off run has not shown for a while: stop spinning (never forever).
  const waitingFor = flow?.state === 'handed_off' && receipt ? receipt.deliveryId : null
  const [overdue, setOverdue] = useState<string | null>(null)
  useEffect(() => {
    if (!waitingFor) return
    const timer = window.setTimeout(() => {
      setOverdue(waitingFor)
      resyncRunCards?.()
    }, HAND_OFF_SHOW_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [waitingFor, resyncRunCards])
  const stillHandingOff = waitingFor !== null && overdue === waitingFor

  const openFlow = flow && projectId && (isOpenFlow(flow) || flow.state === 'needs-review') && !wrappingUp && !launching ? flow : null
  const stats = useFlowLiveStats(projectId, openFlow, working)

  // Memoized on what the entry shows; the controls and panel read their own
  // live contexts (the agent's apps) and re-render on their own.
  return useMemo(liveRuns, [ctx, flow, projectId, conversationId, inline, wrappingUp, launching, receipt, stillHandingOff, resyncRunCards, working, stats, handOffToken, t])
  function liveRuns(): readonly MissionLiveRun[] {
    if (!ctx || !flow || !projectId) return []
    const key = `flow:${flow.id}`
    const label = t('flow.strip.label')
    // Every Flow entry keeps the Flow mark (the strip adds the state's shape).
    const mode = { label, icon: Waves, accent: FLOW_ACCENT }
    const attributes = { 'data-flow-id': flow.id, 'data-flow-state': wrappingUp ? 'wrapping-up' : flow.state } as const
    if (wrappingUp || launching) {
      const flowId = flow.id
      return [{
        key, label, attributes, mode,
        // Ready to hand off is calm: the person just asked for it, nothing is late.
        tone: launching ? 'launching' : 'info',
        headline: launching ? t('flow.strip.launching') : t('flow.strip.ready'),
        panel: <FlowHandOffCard projectId={projectId} conversationId={conversationId} flow={flow} receipt={null} />,
        autoOpenToken: wrappingUp ? handOffToken : null,
        // Launch stays one click away on the strip while the panel is folded.
        wantsPrimary: !launching,
        // Esc is "Not yet"; a click outside only folds the panel. Never while it launches.
        onPanelClose: launching ? null : (reason) => { if (reason === 'escape') ctx.setWrappingUp(flowId, false) },
      }]
    }
    if (flow.state === 'handed_off' && receipt) {
      const rail = t('prCard.rail', { index: receipt.railIndex + 1 })
      // The request returned; the run's own entry replaces this as soon as it shows.
      return [{
        key, label, attributes, mode,
        tone: stillHandingOff ? 'info' : 'launching',
        headline: stillHandingOff ? t('flow.strip.stillHandingOff', { rail }) : t('flow.strip.launchingOn', { rail }),
        controls: stillHandingOff ? (
          <button
            type="button"
            data-agent-interactive
            data-testid="flow-strip-refresh"
            onClick={() => { resyncRunCards?.(); ctx.refreshFlow(projectId, conversationId) }}
            className={FLOW_QUIET_BUTTON}
          >
            <RefreshCw className="h-3 w-3" aria-hidden />
            {t('flow.strip.refresh')}
          </button>
        ) : undefined,
        yieldsTo: { prDeliveryId: receipt.deliveryId, runIds: receipt.runIds },
      }]
    }
    if (!isOpenFlow(flow) && flow.state !== 'needs-review') return []
    // needs-review has nothing to decide on the row: it is informational
    // (one rule with the mission list's attention dot: flow-run-tone.ts).
    const tone = flowOpenRunTone(flow.state) ?? 'running'
    return [{
      key, label, attributes, tone, mode,
      working,
      headline: flowStripHeadline(t, flow, stats.diff),
      controls: <FlowStripControls projectId={projectId} flow={flow} inline={inline} />,
      panel: <FlowPanel projectId={projectId} flow={flow} stats={stats} />,
    }]
  }
}
