/**
 * The mission chat provider (`useAgentChat()`): conversations, the active
 * mission and its transcript, sending and the queue, PR-decision cards,
 * attention/unread marks, the compose draft and Builder mode. Live turn state
 * (tokens, tool chips) lives in the external live store, never in this
 * context. The provider composes focused hooks from `./agent-chat/`; the value
 * keeps one memoized object so consumers re-render only when a field changes.
 */
import { MissionSplitViewsProvider } from './MissionSplitViewsContext'
import { MissionSessionsProvider } from './MissionSessionsContext'
import { LiveStoreContext } from './LiveStoreContext'
import { createContext, useContext, useId, useMemo, type ReactNode } from 'react'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { FEATURE_AGENT_CHAT } from '../../../lib/feature-flags'
import { AgentChatPanel } from '../components/AgentChatPanel'
import { AgentBubble } from '../components/AgentBubble'
import { useUiMode } from '../../../context/UiModeContext'
import { useDesktop } from '../../../hooks/useDesktop'
import { useUndo } from '../../../hooks/useUndo'
import { NOOP_AGENT_CHAT, type AgentChatContextValue } from './agent-chat/types'
import { useAgentChatCore } from './agent-chat/useAgentChatCore'
import { useConversationList } from './agent-chat/useConversationList'
import { useFavoriteConversations } from './agent-chat/useFavoriteConversations'
import { useUnreadConversations } from './agent-chat/useUnreadConversations'
import { useAgentEnvironment } from './agent-chat/useAgentEnvironment'
import { useComposeDraft } from './agent-chat/useComposeDraft'
import { useMissionAttention } from './agent-chat/useMissionAttention'
import { useAgentWsEvents } from './agent-chat/useAgentWsEvents'
import { useConversationLoader } from './agent-chat/useConversationLoader'
import { useAgentChatResync } from './agent-chat/useAgentChatResync'
import { useChatPanelVisibility } from './agent-chat/useChatPanelVisibility'
import { useBuilderMode } from './agent-chat/useBuilderMode'
import { useAgentSending } from './agent-chat/useAgentSending'
import { useConversationSettings } from './agent-chat/useConversationSettings'
import { useConversationActions } from './agent-chat/useConversationActions'

export type { AgentVisibility, PrDecisionSnapshotApplication, AgentChatContextValue } from './agent-chat/types'
export type { AgentLiveTool, AgentQueuedItem, AgentConvLive } from '../lib/live-store'
export { describeAgentError, describeAgentErrorToast } from '../lib/agent-chat-ws'
export { retainOptimisticRows, placeOptimisticRows } from '../lib/agent-chat-transcript'

const AgentChatContext = createContext<AgentChatContextValue | null>(null)

export function AgentChatProvider({ children, fixedConversationId }: { children: ReactNode; fixedConversationId?: string }) {
  const instanceId = useId()
  const handlerId = fixedConversationId ? `agent-chat-pane:${instanceId}` : 'agent-chat'
  const { connectionStatus } = useSharedWebSocket()
  const { uiMode } = useUiMode()
  const { setActiveProjectId, activeProjectId } = useDesktop()
  const { pushUndo } = useUndo()

  // ── State: the open mission + shared bookkeeping, the list, marks, environment, draft ──
  const core = useAgentChatCore()
  const { secondaryWindow, active, messages, liveStore, builderActiveRef, selectConversationRef, applyPrDecisionSnapshot } = core
  const list = useConversationList()
  const { archiveScope, setArchiveScope, conversations, setConversations, conversationsLoading, conversationsError, refreshConversations } = list
  const { favoriteConversationIds, setFavoriteConversationIds, toggleFavoriteConversation } = useFavoriteConversations()
  const { unreadConversationIds, markUnread, clearUnread } = useUnreadConversations(core.activeIdRef)
  const { mcpEnabled, enablingMcp, providersReady, usableProviders, usableProvidersRef, refreshMcp, refreshProviders, enableMcpServer } = useAgentEnvironment()
  const draft = useComposeDraft(active, usableProviders)
  const { draftPinnedProjectId, draftProvider, draftModel, draftTierLevel, draftEffort } = draft
  const { recordAttention, reportRunAttention, attentionKinds, attentionConversationIds } = useMissionAttention(conversations, active?.id ?? null, messages)

  // ── Live events, loading and resync of the open mission ──
  const { projectRecoveryRevision } = useAgentWsEvents(core, { handlerId, fixedConversationId, refreshConversations, setConversations, markUnread, recordAttention })
  const { prefetchConversation, loadConversation, hydrateActivePrCards, resyncRunCards, reconcileActiveTurns } = useConversationLoader(core, { fixedConversationId, clearUnread, setConversations })
  useAgentChatResync({ connectionStatus, projectRecoveryRevision, refreshConversations, refreshMcp, refreshProviders, hydrateActivePrCards, reconcileActiveTurns })

  // ── Surfaces and actions ──
  const { visibility, setVisibility, open, close, minimize, toggle } = useChatPanelVisibility(core, {
    fixedConversationId, archiveScopeRef: list.archiveScopeRef, listGenerationRef: list.listGenerationRef, scopeCacheRef: list.scopeCacheRef,
    setConversations, loadConversation, refreshConversations, refreshMcp, refreshProviders,
  })
  const { builderActive, builderSession, enterBuilderMode, exitBuilderMode } = useBuilderMode({ builderActiveRef, secondaryWindow, fixedConversationId, uiMode, open })
  const { materializeDraftConversation, send, abort, editQueuedMessage, steerQueuedMessage, removeQueuedMessage, wasQueueConsumed } = useAgentSending(core, {
    setConversations, draftPinRef: draft.draftPinRef, draftConvRef: draft.draftConvRef, reconcileActiveTurns, hydrateActivePrCards,
  })
  const { setTier, cycleTier, setProvider, setModel, setEffort, setPinnedProject, beginMissionSelection, pendingSelectionRef } = useConversationSettings(core, {
    fixedConversationId, uiMode, activeProjectId, setActiveProjectId, setConversations, draft,
  })
  const {
    startNewConversation, newConversation, selectConversation,
    archiveConversation, unarchiveConversation, deleteConversation, renameConversation,
  } = useConversationActions(core, {
    fixedConversationId, uiMode, activeProjectId, pushUndo, draft, usableProvidersRef, exitBuilderMode, loadConversation,
    pendingSelectionRef, setVisibility, archiveScopeRef: list.archiveScopeRef, listGenerationRef: list.listGenerationRef,
    scopeCacheRef: list.scopeCacheRef, conversationsRef: list.conversationsRef, setConversations,
    setConversationsError: list.setConversationsError, refreshConversations, setFavoriteConversationIds,
  })
  selectConversationRef.current = selectConversation

  const value = useMemo<AgentChatContextValue>(() => ({
    visibility, open, close, minimize, toggle,
    conversations, active, messages, archiveScope, setArchiveScope, conversationsLoading, conversationsError,
    unreadConversationIds, attentionConversationIds, attentionKinds, favoriteConversationIds,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, editQueuedMessage, steerQueuedMessage, removeQueuedMessage, wasQueueConsumed,
    cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, startNewConversation, materializeDraftConversation, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    selectConversation, prefetchConversation, beginMissionSelection, archiveConversation, unarchiveConversation, deleteConversation, renameConversation, toggleFavoriteConversation, refreshConversations,
    resyncRunCards, reportRunAttention, applyPrDecisionSnapshot,
    builderMode: { active: builderActive, enter: enterBuilderMode, exit: exitBuilderMode, session: builderSession },
  }), [
    visibility, open, close, minimize, toggle,
    builderActive, enterBuilderMode, exitBuilderMode, builderSession,
    conversations, active, messages, archiveScope, setArchiveScope, conversationsLoading, conversationsError, unreadConversationIds, attentionConversationIds, attentionKinds, favoriteConversationIds,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, editQueuedMessage, steerQueuedMessage, removeQueuedMessage, wasQueueConsumed,
    cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, startNewConversation, materializeDraftConversation, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    selectConversation, prefetchConversation, beginMissionSelection, archiveConversation, unarchiveConversation, deleteConversation, renameConversation, toggleFavoriteConversation, refreshConversations,
    resyncRunCards, reportRunAttention, applyPrDecisionSnapshot,
  ])

  // The split layout drops panes of archived or deleted missions; only the main window keeps it across reloads.
  const splitMissions = useMemo(() => ({ conversations, loading: conversationsLoading, error: conversationsError, archiveScope }),
    [conversations, conversationsLoading, conversationsError, archiveScope])
  const persistSplitLayout = !secondaryWindow

  // In Agent Mode the conversation UI is the full-screen surface, so the
  // floating panel + bubble are suppressed. (`uiMode` is read at the top of the
  // provider — it also gates the sidebar-highlight sync in setPinnedProject.)
  const floatingAllowed = !fixedConversationId && FEATURE_AGENT_CHAT && uiMode !== 'agent'

  return (
    <LiveStoreContext.Provider value={liveStore}>
      <AgentChatContext.Provider value={value}>
        {fixedConversationId ? <MissionSessionsProvider>{children}</MissionSessionsProvider> : (
          <MissionSplitViewsProvider primaryId={active?.id ?? null} missions={splitMissions} persist={persistSplitLayout}>
            <MissionSessionsProvider>{children}</MissionSessionsProvider>
            {floatingAllowed && visibility === 'open' && <AgentChatPanel />}
            {floatingAllowed && visibility !== 'open' && <AgentBubble />}
          </MissionSplitViewsProvider>
        )}
      </AgentChatContext.Provider>
    </LiveStoreContext.Provider>
  )
}

/**
 * Returns the agent chat API, or a safe no-op when rendered outside the provider
 * (mirrors useMinimizedChats — keeps components like ArcSidebar mountable in
 * isolation / tests without a provider).
 */
export function useAgentChat(): AgentChatContextValue {
  return useContext(AgentChatContext) ?? NOOP_AGENT_CHAT
}
