import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useAgentChat } from '../context/AgentChatContext'
import { useMissionSplitViews } from '../context/MissionSplitViewsContext'
import { useUiMode } from '../../../context/UiModeContext'
import { useDesktop } from '../../../hooks/useDesktop'
import { resolveMissionProjectSwitch } from '../lib/resolve-mission-project-switch'

/** Routes that take over the Mission-mode centre (loops/plugins are modals there, but the sidebar has always left them too). */
const CENTRE_ROUTES = ['/loops', '/plugins', '/docs', '/settings']

/**
 * Open a mission so it is actually visible: focus an existing split pane or show the
 * primary one, select the conversation, and — in Mission mode — leave a route that
 * occupies the centre (/settings, /docs, …) for the mission surface. A mission pinned
 * to another registered project also moves the app's active project to it.
 */
export function useOpenMission(): (conversationId: string) => void {
  const splitViews = useMissionSplitViews()
  const { selectConversation, beginMissionSelection, conversations } = useAgentChat()
  const { projects, activeProjectId, setActiveProjectId } = useDesktop()
  const { uiMode } = useUiMode()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { focusExisting, showPrimary } = splitViews
  return useCallback((id: string) => {
    // Same handler as the selection (no effect), so no frame shows the old project under the new mission.
    const mission = conversations.find((c) => c.id === id)
    const projectToSwitchTo = resolveMissionProjectSwitch(mission?.pinned_project_id, activeProjectId, projects)
    if (projectToSwitchTo) { beginMissionSelection?.(); setActiveProjectId(projectToSwitchTo) }
    if (!focusExisting(id)) { showPrimary(); void selectConversation(id) }
    if (uiMode === 'agent' && CENTRE_ROUTES.some((p) => pathname.startsWith(p))) navigate('/')
  }, [conversations, projects, activeProjectId, setActiveProjectId, beginMissionSelection, focusExisting, showPrimary, selectConversation, uiMode, pathname, navigate])
}
