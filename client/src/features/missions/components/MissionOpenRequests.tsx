import { useEffect, useRef } from 'react'
import { useUiMode } from '../../../context/UiModeContext'
import { OPEN_MISSION_EVENT, type OpenMissionDetail } from '../../../lib/mission-events'
import { useAgentChat } from '../context/AgentChatContext'
import { useOpenMission } from '../hooks/useOpenMission'

/**
 * Answers `requestOpenMission` (lib/mission-events) in the main window: Mission
 * mode shows the mission (switching project when it is pinned elsewhere), Board
 * mode opens it in the floating agent panel, like the live board's mission cards.
 */
export function MissionOpenRequests() {
  const { uiMode } = useUiMode()
  const { selectConversation, open } = useAgentChat()
  const openMission = useOpenMission()
  const latest = useRef({ uiMode, selectConversation, open, openMission })
  latest.current = { uiMode, selectConversation, open, openMission }
  useEffect(() => {
    const onRequest = (event: Event) => {
      const id = (event as CustomEvent<OpenMissionDetail>).detail?.conversationId
      if (typeof id !== 'string' || !id) return
      const current = latest.current
      if (current.uiMode === 'agent') current.openMission(id)
      else { void current.selectConversation(id); current.open() }
    }
    window.addEventListener(OPEN_MISSION_EVENT, onRequest)
    return () => window.removeEventListener(OPEN_MISSION_EVENT, onRequest)
  }, [])
  return null
}
