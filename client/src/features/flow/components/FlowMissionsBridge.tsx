// ─── Flow ⇄ missions composition ──────────────────────────────────────────────
// Mounted by the application composition root (App.tsx) around the mission
// chat. It owns the Flow state (FlowProvider) and plugs Flow into the missions
// extension seam: the ```flow-offer card, the conversation mode (data-flow
// surface, worktree branch, interrupting sends), its runs in the mission's
// run strip (the Flow, its hand-off and launch) with the words for the steps
// of Flow → Spec, the polite state announcer, the Back to Flow / Relaunch actions on a Flow → Spec run card that
// stopped with requested changes, and the Flow-authored explanation of a run
// that failed outright. Missions never import this feature.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Waves } from 'lucide-react'
import '../flow.css'
import { MissionExtensionsProvider, type MissionConversationMode, type MissionExtensions } from '../../missions/context/MissionExtensionsContext'
import { FlowProvider, useConversationFlow, useFlowContext } from '../context/FlowContext'
import { FLOW_OFFER_TAG } from '../lib/flow-offer'
import { isOpenFlow } from '../lib/flow-api'
import { useFlowConversationMarks } from './FlowConversationMarks'
import { FlowDock } from './FlowDock'
import { describeFlowRun, useFlowLiveRuns } from './FlowLiveRuns'
import { FlowOfferCard } from './FlowOfferCard'
import { FlowRunCardActions } from './FlowRunCardActions'
import { FlowRunFailure } from './FlowRunFailure'

/**
 * The missions mode of a conversation while it is in Flow (open, paused or
 * needing review): the composer names the mode (chip, accent line, its own
 * placeholder), the header says "In Flow" (the board's wording), and the git
 * strip steps aside — the branch lives in the run strip. Only an ACTIVE Flow
 * that is not being handed off interrupts on send and marks the surface.
 */
export function useFlowConversationMode(conversationId: string | null, projectId: string | null): MissionConversationMode | null {
  const { t } = useTranslation(['agent', 'specs'])
  const ctx = useFlowContext()
  const { flow } = useConversationFlow(conversationId, projectId)
  if (!flow || !(isOpenFlow(flow) || flow.state === 'needs-review')) return null
  const live = flow.state === 'active' && !ctx?.wrappingUp.has(flow.id)
  const description = t('agent:flow.mode.description')
  return {
    ...(live ? { attributes: { 'data-flow': 'active' }, interruptWhileBusy: true } : {}),
    hideGitStrip: true,
    composer: { badge: { label: t('agent:flow.mode.chip'), description, icon: Waves }, placeholder: t('agent:flow.mode.placeholder') },
    headerBadge: { label: t('specs:badges.inFlow'), description, icon: Waves },
  }
}

export const FLOW_MISSION_EXTENSIONS: MissionExtensions = Object.freeze({
  fenceCards: Object.freeze({ [FLOW_OFFER_TAG]: FlowOfferCard }),
  useConversationMode: useFlowConversationMode,
  ConversationDock: FlowDock,
  useLiveRuns: useFlowLiveRuns,
  useConversationMarks: useFlowConversationMarks,
  describeRun: describeFlowRun,
  RunCardActions: FlowRunCardActions,
  RunFailureOutcome: FlowRunFailure,
})

export function FlowMissionsBridge({ children }: { children: ReactNode }) {
  return (
    <FlowProvider>
      <MissionExtensionsProvider value={FLOW_MISSION_EXTENSIONS}>{children}</MissionExtensionsProvider>
    </FlowProvider>
  )
}
