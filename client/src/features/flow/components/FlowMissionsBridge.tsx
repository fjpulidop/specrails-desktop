// ─── Flow ⇄ missions composition ──────────────────────────────────────────────
// Mounted by the application composition root (App.tsx) around the mission
// chat. It owns the Flow state (FlowProvider) and plugs Flow into the missions
// extension seam: the ```flow-offer card, the conversation mode (data-flow
// surface, worktree branch, interrupting sends) and the dock above the
// composer. Missions never import this feature.

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import '../flow.css'
import { MissionExtensionsProvider, type MissionConversationMode, type MissionExtensions } from '../../missions/context/MissionExtensionsContext'
import { FlowProvider, useConversationFlow, useFlowContext } from '../context/FlowContext'
import { FLOW_OFFER_TAG } from '../lib/flow-offer'
import { FlowDock } from './FlowDock'
import { FlowOfferCard } from './FlowOfferCard'

/** The missions mode of a conversation while its Flow is active. */
export function useFlowConversationMode(conversationId: string | null, projectId: string | null): MissionConversationMode | null {
  const { t } = useTranslation('agent')
  const ctx = useFlowContext()
  const { flow } = useConversationFlow(conversationId, projectId)
  if (!flow || flow.state !== 'active' || ctx?.wrappingUp.has(flow.id)) return null
  return {
    attributes: { 'data-flow': 'active' },
    gitBranch: flow.branch ? { branch: flow.branch, label: t('flow.gitLabel') } : null,
    interruptWhileBusy: true,
  }
}

export const FLOW_MISSION_EXTENSIONS: MissionExtensions = Object.freeze({
  fenceCards: Object.freeze({ [FLOW_OFFER_TAG]: FlowOfferCard }),
  useConversationMode: useFlowConversationMode,
  ConversationDock: FlowDock,
})

export function FlowMissionsBridge({ children }: { children: ReactNode }) {
  return (
    <FlowProvider>
      <MissionExtensionsProvider value={FLOW_MISSION_EXTENSIONS}>{children}</MissionExtensionsProvider>
    </FlowProvider>
  )
}
