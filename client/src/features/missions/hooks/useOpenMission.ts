import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAgentChat } from '../context/AgentChatContext'
import { useMissionSplitViews } from '../context/MissionSplitViewsContext'
import { useUiMode } from '../../../context/UiModeContext'

/** Routes that take over the Mission-mode centre (loops/plugins are modals there, but the sidebar has always left them too). */
const CENTRE_ROUTES = ['/loops', '/plugins', '/docs', '/settings']

/**
 * Open a mission so it is actually visible: focus an existing split pane or show the
 * primary one, select the conversation, and — in Mission mode — leave a route that
 * occupies the centre (/settings, /docs, …) for the mission surface.
 */
export function useOpenMission(): (conversationId: string) => void {
  const splitViews = useMissionSplitViews()
  const { selectConversation } = useAgentChat()
  const { uiMode } = useUiMode()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { focusExisting, showPrimary } = splitViews
  return useCallback((id: string) => {
    if (!focusExisting(id)) { showPrimary(); void selectConversation(id) }
    if (uiMode === 'agent' && CENTRE_ROUTES.some((p) => pathname.startsWith(p))) navigate('/')
  }, [focusExisting, showPrimary, selectConversation, uiMode, pathname, navigate])
}
