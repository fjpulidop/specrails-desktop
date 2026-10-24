// ─── Flow ⇄ missions composition ──────────────────────────────────────────────
// Mounted by the application composition root (App.tsx) around the mission
// chat. It owns the Flow state (FlowProvider) and plugs Flow into the missions
// extension seam: the ```flow-offer card, the conversation mode (data-flow
// surface, worktree branch, interrupting sends), its runs in the mission's
// run strip (the Flow, its hand-off and launch) with the words for the steps
// of Flow → Spec, the mission list's "In Flow" mark and attention dot (one
// app-wide watch per project, live with the mission closed), the polite state announcer, the Back to Flow / Relaunch actions on a Flow → Spec run card that
// stopped with requested changes, and the Flow-authored explanation of a run
// that failed outright, and the repository prompt of "Start in Flow". Missions never import this feature.

import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Waves } from 'lucide-react'
import '../flow.css'
import { MissionExtensionsProvider, type MissionConversationMode, type MissionExtensions, type MissionModeBadge } from '../../missions/context/MissionExtensionsContext'
import { FLOW_ACCENT } from '../lib/flow-accent'
import { FlowProvider, useConversationFlow, useFlowContext } from '../context/FlowContext'
import { FLOW_OFFER_TAG } from '../lib/flow-offer'
import { isOpenFlow } from '../lib/flow-api'
import { useFlowConversationMarks, useFlowRunAttention } from './FlowConversationMarks'
import { FlowDock } from './FlowDock'
import { describeFlowRun, useFlowLiveRuns } from './FlowLiveRuns'
import { FlowOfferCard } from './FlowOfferCard'
import { FlowRepositoryPromptProvider } from './FlowRepositoryPrompt'
import { FlowRunCardActions } from './FlowRunCardActions'
import { FlowRunFailure } from './FlowRunFailure'
import { FlowRailLaunchAlternative } from './StartInFlow'

/**
 * The missions mode of a conversation while it is in Flow (open, paused or
 * needing review): the composer names the mode (chip and its own
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
    composer: { badge: { label: t('agent:flow.mode.chip'), description, icon: Waves, accent: FLOW_ACCENT }, placeholder: t('agent:flow.mode.placeholder') },
    headerBadge: { label: t('specs:badges.inFlow'), description, icon: Waves, accent: FLOW_ACCENT },
  }
}

/** The mark on agent turns written in Flow: the Flow icon, its color and "Flow". */
export function useFlowTurnMark(): MissionModeBadge {
  const { t } = useTranslation('agent')
  return useMemo(() => ({ label: t('flowBoundary.turnMark'), description: t('flow.mode.description'), icon: Waves, accent: FLOW_ACCENT }), [t])
}

export const FLOW_MISSION_EXTENSIONS: MissionExtensions = Object.freeze({
  useTurnMark: useFlowTurnMark,
  fenceCards: Object.freeze({ [FLOW_OFFER_TAG]: FlowOfferCard }),
  useConversationMode: useFlowConversationMode,
  ConversationDock: FlowDock,
  useLiveRuns: useFlowLiveRuns,
  useConversationMarks: useFlowConversationMarks,
  useRunAttention: useFlowRunAttention,
  describeRun: describeFlowRun,
  RunCardActions: FlowRunCardActions,
  RunFailureOutcome: FlowRunFailure,
  RailLaunchAlternative: FlowRailLaunchAlternative,
})

export function FlowMissionsBridge({ children }: { children: ReactNode }) {
  return (
    <FlowProvider>
      <FlowRepositoryPromptProvider>
        <MissionExtensionsProvider value={FLOW_MISSION_EXTENSIONS}>{children}</MissionExtensionsProvider>
      </FlowRepositoryPromptProvider>
    </FlowProvider>
  )
}
