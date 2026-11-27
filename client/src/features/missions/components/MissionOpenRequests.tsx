import { useEffect, useRef } from 'react'
import { useUiMode } from '../../../context/UiModeContext'
import { OPEN_MISSION_EVENT, OPEN_MISSION_NATIVE_EVENT, requestOpenMission, type OpenMissionDetail } from '../../../lib/mission-events'
import { isTauri } from '../../../lib/tauri-shell'
import { useAgentChat } from '../context/AgentChatContext'
import { useOpenMission } from '../hooks/useOpenMission'

/**
 * Answers `requestOpenMission` (lib/mission-events) in the main window: Mission
 * mode shows the mission (switching project when it is pinned elsewhere), Board
 * mode opens it in the floating agent panel, like the live board's mission cards.
 * Loop editor windows ask through the host's `specrails://open-mission` event.
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
    // A loop editor window asks through the host (Loops ▸ Fix PR CI ▸ Run on a PR).
    let disposed = false
    let unlisten: (() => void) | undefined
    if (isTauri()) {
      void import('@tauri-apps/api/event').then(({ listen }) => listen<OpenMissionDetail>(OPEN_MISSION_NATIVE_EVENT, event => {
        if (typeof event.payload?.conversationId === 'string') requestOpenMission(event.payload.conversationId)
      })).then(stop => { if (disposed) stop(); else unlisten = stop }).catch(() => {})
    }
    return () => { disposed = true; unlisten?.(); window.removeEventListener(OPEN_MISSION_EVENT, onRequest) }
  }, [])
  return null
}
