/**
 * "<mission> replied": when a mission turn finishes (`agent_done`, or a
 * background turn's `agent_turn_done`) and the person is not watching that
 * mission, tell them through the app's attention pipeline (category
 * `question`: the mission waits for their next message). A mission is watched
 * when its view is on screen in the focused window: the main window's primary
 * mission or a split pane (Mission mode), the open floating chat (Board mode),
 * or its own detached window. Main window only.
 */
import { useEffect, useRef } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { useUiMode } from '../../../context/UiModeContext'
import { useDesktop } from '../../../hooks/useDesktop'
import i18n from '../../../lib/i18n'
import { appAttention } from '../../../lib/attention/app-attention'
import type { AttentionCenter } from '../../../lib/attention/attention-center'
import { isMainFocused, type WindowFocus } from '../../../lib/attention/window-focus'
import { useAgentChat } from '../context/AgentChatContext'
import { useMissionSplitViews } from '../context/MissionSplitViewsContext'
import { useMissionWindows } from '../context/MissionWindowsContext'
import { useOpenMission } from './useOpenMission'

/** Routes that cover the Mission-mode centre (the mission is not visible behind them). */
const CENTRE_ROUTES = ['/loops', '/plugins', '/docs', '/settings']
const SNIPPET_CHARS = 140

/** The reply's first words, as plain text. */
export function replySnippet(text: string | undefined): string {
  if (!text) return ''
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[`*_>#~]+/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = Array.from(plain)
  return chars.length <= SNIPPET_CHARS ? plain : `${chars.slice(0, SNIPPET_CHARS - 1).join('')}…`
}

export interface MissionScreen {
  uiMode: 'kanban' | 'agent'
  pathname: string
  activeId: string | null
  primaryVisible: boolean
  splitIds: readonly string[]
  chatOpen: boolean
  /** conversationId → the label of the native window it is detached to. */
  detached: ReadonlyMap<string, string>
}

/** Is this mission what the person is looking at, given the focus? */
export function missionOnScreen(conversationId: string, screen: MissionScreen, focus: WindowFocus): boolean {
  const windowLabel = screen.detached.get(conversationId)
  if (windowLabel) return focus.label === windowLabel
  if (!isMainFocused(focus)) return false
  if (screen.uiMode === 'kanban') return screen.chatOpen && screen.activeId === conversationId
  if (screen.splitIds.includes(conversationId)) return true
  return screen.primaryVisible && screen.activeId === conversationId && !CENTRE_ROUTES.some((route) => screen.pathname.startsWith(route))
}

export function useMissionReplyNotifications({ pathname, center = appAttention }: { pathname: string; center?: AttentionCenter }): void {
  const agentChat = useAgentChat()
  const splitViews = useMissionSplitViews()
  const windows = useMissionWindows()
  const { uiMode } = useUiMode()
  const { projects } = useDesktop()
  const openMission = useOpenMission()

  // Everything the handler reads at event time, never a stale closure.
  const screenRef = useRef<MissionScreen | null>(null)
  screenRef.current = {
    uiMode,
    pathname,
    activeId: agentChat.active?.id ?? null,
    primaryVisible: splitViews.primaryVisible,
    splitIds: splitViews.conversationIds,
    chatOpen: agentChat.visibility === 'open',
    detached: new Map(windows.transfers.filter((transfer) => transfer.state === 'detached').map((transfer) => [transfer.conversationId, transfer.windowLabel])),
  }
  const lookupRef = useRef({ conversations: agentChat.conversations, projects, openMission, openChat: agentChat.open, focusWindow: windows.focus })
  lookupRef.current = { conversations: agentChat.conversations, projects, openMission, openChat: agentChat.open, focusWindow: windows.focus }

  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  useEffect(() => {
    registerHandler('mission-reply-attention', (raw) => {
      const msg = raw as { type?: unknown; conversationId?: unknown; messageId?: unknown; timestamp?: unknown; fullText?: unknown } | null
      if (!msg || (msg.type !== 'agent_done' && msg.type !== 'agent_turn_done') || typeof msg.conversationId !== 'string') return
      const conversationId = msg.conversationId
      const { conversations, projects: projectList } = lookupRef.current
      const mission = conversations.find((conversation) => conversation.id === conversationId)
      const projectId = mission?.pinned_project_id ?? null
      const projectName = projectId ? projectList.find((project) => project.id === projectId)?.name ?? null : null
      const missionTitle = mission?.title?.trim() || i18n.t('commands:notifications.attention.untitledMission')
      const snippet = replySnippet(typeof msg.fullText === 'string' ? msg.fullText : undefined)
      const occurrence = typeof msg.messageId === 'string' ? msg.messageId : typeof msg.timestamp === 'string' ? msg.timestamp : String(Date.now())
      void center.dispatch({
        key: `mission:${conversationId}:${occurrence}`,
        category: 'question',
        projectId,
        title: i18n.t('commands:notifications.attention.missionReplied', { title: missionTitle }),
        body: [projectName, snippet].filter((part): part is string => !!part).join(' · '),
        isOnScreen: (focus) => !!screenRef.current && missionOnScreen(conversationId, screenRef.current, focus),
        open: () => {
          const { openMission: open, openChat, focusWindow } = lookupRef.current
          if (screenRef.current?.detached.has(conversationId)) { void focusWindow(conversationId); return }
          open(conversationId)
          if (screenRef.current?.uiMode === 'kanban') openChat()
        },
      })
    })
    return () => unregisterHandler('mission-reply-attention')
  }, [registerHandler, unregisterHandler, center])
}
