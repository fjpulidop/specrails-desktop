// ─── Intent ⇄ missions composition ──────────────────────────────────────────────
// Mounted by the application composition root (App.tsx) around the mission
// chat. It owns the Intent state (IntentProvider) and plugs Intent into the missions
// extension seam: the ```flow-offer card, the conversation mode (data-flow
// surface, worktree branch, interrupting sends), its runs in the mission's
// run strip (the Intent, its hand-off and launch) with the words for the steps
// of Intent → Spec, the mission list's "In Intent" mark and attention dot (one
// app-wide watch per project, live with the mission closed), the polite state announcer, the Back to Intent / Relaunch actions on an Intent session → Spec run card that
// stopped with requested changes, and the Intent-authored explanation of a run
// that failed outright, and the repository prompt of "Start in Intent". Missions never import this feature.

import { useMemo, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Waves } from 'lucide-react'
import '../intent.css'
import { MissionExtensionsProvider, type MissionConversationMode, type MissionExtensions, type MissionModeBadge } from '../../missions/context/MissionExtensionsContext'
import { FLOW_ACCENT } from '../lib/intent-accent'
import { IntentProvider, useConversationFlow, useFlowContext } from '../context/IntentContext'
import { FLOW_OFFER_TAG } from '../lib/intent-offer'
import { isOpenFlow } from '../lib/intent-api'
import { useFlowConversationMarks, useFlowRunAttention } from './IntentConversationMarks'
import { IntentDock } from './IntentDock'
import { describeFlowRun, useFlowLiveRuns } from './IntentLiveRuns'
import { IntentOfferCard } from './IntentOfferCard'
import { IntentRepositoryPromptProvider } from './IntentRepositoryPrompt'
import { IntentRunCardActions } from './IntentRunCardActions'
import { IntentRunFailure } from './IntentRunFailure'
import { IntentRailLaunchAlternative } from './StartInIntent'

/**
 * The missions mode of a conversation while it is in Intent (open, paused or
 * needing review): the composer names the mode (chip and its own
 * placeholder), the header says "In Intent" (the board's wording), and the git
 * strip steps aside — the branch lives in the run strip. Only an ACTIVE Intent
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

/** The mark on agent turns written in Intent: the Intent icon, its color and "Intent". */
export function useFlowTurnMark(): MissionModeBadge {
  const { t } = useTranslation('agent')
  return useMemo(() => ({ label: t('flowBoundary.turnMark'), description: t('flow.mode.description'), icon: Waves, accent: FLOW_ACCENT }), [t])
}

export const FLOW_MISSION_EXTENSIONS: MissionExtensions = Object.freeze({
  useTurnMark: useFlowTurnMark,
  fenceCards: Object.freeze({ [FLOW_OFFER_TAG]: IntentOfferCard }),
  useConversationMode: useFlowConversationMode,
  ConversationDock: IntentDock,
  useLiveRuns: useFlowLiveRuns,
  useConversationMarks: useFlowConversationMarks,
  useRunAttention: useFlowRunAttention,
  describeRun: describeFlowRun,
  RunCardActions: IntentRunCardActions,
  RunFailureOutcome: IntentRunFailure,
  RailLaunchAlternative: IntentRailLaunchAlternative,
})

export function IntentMissionsBridge({ children }: { children: ReactNode }) {
  return (
    <IntentProvider>
      <IntentRepositoryPromptProvider>
        <MissionExtensionsProvider value={FLOW_MISSION_EXTENSIONS}>{children}</MissionExtensionsProvider>
      </IntentRepositoryPromptProvider>
    </IntentProvider>
  )
}
