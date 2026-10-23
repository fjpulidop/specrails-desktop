// ─── Flow ⇄ missions composition ──────────────────────────────────────────────
// Mounted by the application composition root (App.tsx) around the mission
// chat. It owns the Flow state (FlowProvider) and plugs Flow into the missions
// extension seam: the ```flow-offer card, the conversation mode (data-flow
// surface, worktree branch, interrupting sends) and the dock above the
// composer, the Back to Flow / Relaunch actions on a Flow → Spec run card that
// stopped with requested changes, and the Flow-authored explanation of a run
// that failed outright. Missions never import this feature.

import type { ReactNode } from 'react'
import '../flow.css'
import { MissionExtensionsProvider, type MissionConversationMode, type MissionExtensions } from '../../missions/context/MissionExtensionsContext'
import { FlowProvider, useConversationFlow, useFlowContext } from '../context/FlowContext'
import { FLOW_OFFER_TAG } from '../lib/flow-offer'
import { FlowDock } from './FlowDock'
import { FlowOfferCard } from './FlowOfferCard'
import { FlowRunCardActions } from './FlowRunCardActions'
import { FlowRunFailure } from './FlowRunFailure'

/** The missions mode of a conversation while its Flow is active. The Flow bar
 * shows (and copies) the worktree branch, so the git strip steps aside. */
export function useFlowConversationMode(conversationId: string | null, projectId: string | null): MissionConversationMode | null {
  const ctx = useFlowContext()
  const { flow } = useConversationFlow(conversationId, projectId)
  if (!flow || flow.state !== 'active' || ctx?.wrappingUp.has(flow.id)) return null
  return {
    attributes: { 'data-flow': 'active' },
    hideGitStrip: true,
    interruptWhileBusy: true,
  }
}

export const FLOW_MISSION_EXTENSIONS: MissionExtensions = Object.freeze({
  fenceCards: Object.freeze({ [FLOW_OFFER_TAG]: FlowOfferCard }),
  useConversationMode: useFlowConversationMode,
  ConversationDock: FlowDock,
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
