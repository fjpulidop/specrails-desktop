// ─── Flow in the mission's run strip (missions useLiveRuns slot) ──────────────
// A conversation's Flow is ONE entry of the run strip, keyed by the Flow so
// the strip morphs in place across its states:
//   active / paused / needs review → "Flow" + branch · files ± · cost and the
//                                    controls (FlowStripControls)
//   "This is it"                   → "Flow → Spec · ready to launch": the
//                                    hand-off settings open as the strip's
//                                    panel (recap, rail, engine) with Launch
//                                    as the strip's primary action
//   launching                      → a skeleton in the strip itself, kept
//                                    after the request until the run shows
//                                    (the entry yields to its delivery)
// Also `describeRun`: the person's words for the steps of Flow → Spec.

import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useAgentChat } from '../../missions/context/AgentChatContext'
import type {
  MissionConversationSlotProps, MissionLiveRun, MissionRunDescription, MissionRunDescriptionInput,
} from '../../missions/context/MissionExtensionsContext'
import { useConversationFlow, useFlowContext } from '../context/FlowContext'
import { isOpenFlow } from '../lib/flow-api'
import { flowFailureStep } from '../lib/flow-failure'
import { FLOW_SPEC_LOOP_ID } from '../lib/flow-offer'
import { FlowHandOffCard } from './FlowHandOffCard'
import { FlowStripControls } from './FlowStripControls'

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
  const { isStreaming, active } = useAgentChat()
  const working = isStreaming && active?.id === conversationId && flow?.state === 'active'
  const wrappingUp = !!ctx && !!flow && ctx.wrappingUp.has(flow.id) && isOpenFlow(flow)
  // Each "This is it" opens the hand-off panel once (a new token per press).
  const handOffSeq = useRef({ flowId: '', on: false, seq: 0 })
  if (flow && (handOffSeq.current.flowId !== flow.id || handOffSeq.current.on !== wrappingUp)) {
    if (wrappingUp && !(handOffSeq.current.flowId === flow.id && handOffSeq.current.on)) handOffSeq.current.seq += 1
    handOffSeq.current = { flowId: flow.id, on: wrappingUp, seq: handOffSeq.current.seq }
  }
  const handOffToken = `hand-off:${flow?.id ?? ''}:${handOffSeq.current.seq}`
  const launching = !!ctx && !!flow && ctx.launching.has(flow.id)
  const receipt = flow ? ctx?.handedOff.get(flow.id) ?? null : null

  // Not memoized: the controls read live contexts (the agent's apps) and must re-render with the strip.
  return liveRuns()
  function liveRuns(): readonly MissionLiveRun[] {
    if (!ctx || !flow || !projectId) return []
    const key = `flow:${flow.id}`
    const label = t('flow.strip.label')
    const attributes = { 'data-flow-id': flow.id, 'data-flow-state': wrappingUp ? 'wrapping-up' : flow.state } as const
    if (wrappingUp || launching) {
      return [{
        key, label, attributes,
        tone: launching ? 'launching' : 'decision',
        headline: launching ? t('flow.strip.launching') : t('flow.strip.ready'),
        primary: launching ? null : { label: t('flow.handOff.launch') },
        panel: <FlowHandOffCard projectId={projectId} conversationId={conversationId} flow={flow} receipt={null} />,
        autoOpenToken: wrappingUp ? handOffToken : null,
      }]
    }
    if (flow.state === 'handed_off' && receipt) {
      // The request returned; the run's own entry replaces this as soon as it shows.
      return [{
        key, label, attributes,
        tone: 'launching',
        headline: t('flow.strip.launchingOn', { rail: t('prCard.rail', { index: receipt.railIndex + 1 }) }),
        yieldsTo: { prDeliveryId: receipt.deliveryId, runIds: receipt.runIds },
      }]
    }
    if (!isOpenFlow(flow) && flow.state !== 'needs-review') return []
    const tone = flow.state === 'paused' ? 'paused' : flow.state === 'needs-review' ? 'decision' : 'running'
    return [{
      key, label, attributes, tone,
      working,
      headline: t(`flow.bar.state.${flow.state}`, { defaultValue: t('flow.bar.state.active') }),
      controls: <FlowStripControls projectId={projectId} flow={flow} inline={inline} working={working} />,
    }]
  }
}
