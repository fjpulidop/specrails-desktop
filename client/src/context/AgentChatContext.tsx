import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { FEATURE_AGENT_CHAT } from '../lib/feature-flags'
import {
  listAgentConversations,
  createAgentConversation,
  getAgentConversation,
  patchAgentConversation,
  deleteAgentConversation,
  sendAgentMessage,
  abortAgentTurn,
  getMcpStatus,
  enableMcp,
  getAvailableProviders,
  type AgentConversation,
  type AgentMessage,
  type AgentTierLevel,
} from '../lib/agent-api'
import { AgentChatPanel } from '../components/agent-chat/AgentChatPanel'
import { AgentBubble } from '../components/agent-chat/AgentBubble'
import { useUiMode } from './UiModeContext'
import { useDesktop } from '../hooks/useDesktop'

export type AgentVisibility = 'hidden' | 'open' | 'minimized'

export interface AgentLiveTool {
  id: string
  tool: string
}

export interface AgentChatContextValue {
  visibility: AgentVisibility
  open: () => void
  close: () => void
  minimize: () => void
  toggle: () => void

  conversations: AgentConversation[]
  active: AgentConversation | null
  messages: AgentMessage[]
  streamingText: string
  isStreaming: boolean
  liveTools: AgentLiveTool[]

  mcpEnabled: boolean
  enablingMcp: boolean
  enableMcpServer: () => Promise<void>

  /** null = not yet checked; false = no AI provider CLI is installed. */
  providersReady: boolean | null

  send: (text: string, opts?: { attachmentIds?: string[] }) => Promise<void>
  abort: () => Promise<void>
  cycleTier: () => Promise<void>
  setTier: (level: AgentTierLevel) => Promise<void>
  setProvider: (provider: string) => Promise<void>
  setModel: (model: string) => Promise<void>
  setPinnedProject: (projectId: string | null) => Promise<void>
  newConversation: (projectId?: string | null) => Promise<void>
  /** Reset to the EMPTY compose screen (active=null) with a draft pin — the next
   *  send creates a fresh conversation. This is the "+ New Agent" action. */
  startNewConversation: (projectId?: string | null) => void
  /** Pinned project for the EMPTY compose screen (before a conversation exists). */
  draftPinnedProjectId: string | null
  /** Provider/model/tier/effort for the EMPTY compose screen — the first send
   *  creates the conversation with these (the setters branch on `active === null`). */
  draftProvider: string
  draftModel: string | null
  draftTierLevel: AgentTierLevel
  draftEffort: string | null
  setEffort: (effort: string | null) => Promise<void>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  /** Refresh the conversation list WITHOUT opening the floating panel. Used on
   *  entering Agent Mode (open() would mount the now-suppressed panel). */
  refreshConversations: () => Promise<void>
}

const AgentChatContext = createContext<AgentChatContextValue | null>(null)

interface WsAgentMsg {
  type: string
  conversationId?: string
  delta?: string
  fullText?: string
  error?: string
  tool?: string
}

let _toolSeq = 0

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const { uiMode } = useUiMode()
  const { setActiveProjectId } = useDesktop()

  const [visibility, setVisibility] = useState<AgentVisibility>('hidden')
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [active, setActive] = useState<AgentConversation | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [streamingText, setStreamingText] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [liveTools, setLiveTools] = useState<AgentLiveTool[]>([])
  const [mcpEnabled, setMcpEnabled] = useState(true)
  const [enablingMcp, setEnablingMcp] = useState(false)
  const [providersReady, setProvidersReady] = useState<boolean | null>(null)
  // Pinned project chosen on the EMPTY compose screen (no conversation yet). The
  // first send materialises a conversation with this pin.
  const [draftPinnedProjectId, setDraftPinnedProjectId] = useState<string | null>(null)
  const draftPinRef = useRef<string | null>(null)
  draftPinRef.current = draftPinnedProjectId
  // Provider/model/tier chosen on the EMPTY compose screen (no conversation yet).
  // The first send materialises a conversation with these — mirrors the draft pin;
  // without them the EMPTY controls would visibly snap back (patchActive no-ops).
  const [draftProvider, setDraftProvider] = useState('claude')
  const [draftModel, setDraftModel] = useState<string | null>(null)
  const [draftTierLevel, setDraftTierLevel] = useState<AgentTierLevel>(0)
  // null = the app default ("medium") — shown as Medium in the selector.
  const [draftEffort, setDraftEffort] = useState<string | null>(null)
  const draftConvRef = useRef({ provider: 'claude', model: null as string | null, tierLevel: 0 as AgentTierLevel, effort: null as string | null })
  draftConvRef.current = { provider: draftProvider, model: draftModel, tierLevel: draftTierLevel, effort: draftEffort }

  const activeIdRef = useRef<string | null>(null)
  activeIdRef.current = active?.id ?? null

  // Refresh the conversation list + MCP status lazily on first open.
  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listAgentConversations())
    } catch {
      /* surfaced elsewhere */
    }
  }, [])

  const refreshMcp = useCallback(async () => {
    try {
      const s = await getMcpStatus()
      setMcpEnabled(s.enabled)
    } catch {
      setMcpEnabled(false)
    }
  }, [])

  const refreshProviders = useCallback(async () => {
    try {
      setProvidersReady((await getAvailableProviders()).any)
    } catch {
      // On a probe failure, don't hard-block the agent — leave it usable.
      setProvidersReady(true)
    }
  }, [])

  // ── WebSocket: app-global agent_* events (no projectId filter) ──────────────
  useEffect(() => {
    if (!FEATURE_AGENT_CHAT) return
    const handler = (raw: unknown): void => {
      const msg = raw as WsAgentMsg
      if (typeof msg.type !== 'string' || !msg.type.startsWith('agent_')) return
      // Auto-title updates apply to the LIST (any conversation), not just the
      // active one — handle before the active-conversation filter.
      if (msg.type === 'agent_title' && msg.conversationId) {
        const title = (msg as { title?: string }).title ?? null
        setConversations((cs) => cs.map((c) => (c.id === msg.conversationId ? { ...c, title } : c)))
        setActive((a) => (a && a.id === msg.conversationId ? { ...a, title } : a))
        return
      }
      if (!msg.conversationId || msg.conversationId !== activeIdRef.current) return
      if (msg.type === 'agent_stream') {
        setIsStreaming(true)
        setStreamingText((t) => t + (msg.delta ?? ''))
      } else if (msg.type === 'agent_tool') {
        setLiveTools((tools) => [...tools, { id: `t${_toolSeq++}`, tool: msg.tool ?? 'tool' }])
      } else if (msg.type === 'agent_done') {
        const full = msg.fullText ?? ''
        setMessages((m) => [
          ...m,
          { id: `local-${Date.now()}`, conversation_id: msg.conversationId!, role: 'assistant', content: full, created_at: new Date().toISOString() },
        ])
        setStreamingText('')
        setIsStreaming(false)
        setLiveTools([])
      } else if (msg.type === 'agent_error') {
        setStreamingText('')
        setIsStreaming(false)
        setLiveTools([])
        const err = msg.error || 'The agent turn failed.'
        toast.error(err)
        // Also surface it inline so it's visible in the conversation.
        setMessages((m) => [
          ...m,
          { id: `err-${Date.now()}`, conversation_id: msg.conversationId!, role: 'assistant', content: `⚠️ ${err}`, created_at: new Date().toISOString() },
        ])
      }
    }
    registerHandler('agent-chat', handler)
    return () => unregisterHandler('agent-chat')
  }, [registerHandler, unregisterHandler])

  const loadConversation = useCallback(async (id: string) => {
    const { conversation, messages: msgs } = await getAgentConversation(id)
    setActive(conversation)
    setMessages(msgs)
    setStreamingText('')
    setIsStreaming(false)
    setLiveTools([])
  }, [])

  const ensureActive = useCallback(async (): Promise<AgentConversation> => {
    if (active) return active
    const list = await listAgentConversations()
    setConversations(list)
    if (list.length > 0) {
      await loadConversation(list[0].id)
      return list[0]
    }
    const created = await createAgentConversation({})
    setConversations((c) => [created, ...c])
    setActive(created)
    setMessages([])
    return created
  }, [active, loadConversation])

  const open = useCallback(() => {
    setVisibility('open')
    void refreshConversations()
    void refreshMcp()
    void refreshProviders()
    void ensureActive()
  }, [refreshConversations, refreshMcp, refreshProviders, ensureActive])

  const close = useCallback(() => setVisibility('hidden'), [])
  const minimize = useCallback(() => setVisibility('minimized'), [])
  const toggle = useCallback(() => {
    setVisibility((v) => (v === 'open' ? 'minimized' : 'open'))
    if (visibility !== 'open') {
      void refreshConversations()
      void refreshMcp()
      void refreshProviders()
      void ensureActive()
    }
  }, [visibility, refreshConversations, refreshMcp, refreshProviders, ensureActive])

  const send = useCallback(async (text: string, opts?: { attachmentIds?: string[] }) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // EMPTY compose screen (no active conversation) ALWAYS starts a fresh
    // conversation with the draft pin — it never resurrects the latest chat.
    let conv = active
    if (!conv) {
      conv = await createAgentConversation({
        pinnedProjectId: draftPinRef.current,
        provider: draftConvRef.current.provider,
        model: draftConvRef.current.model,
        tierLevel: draftConvRef.current.tierLevel,
        reasoningEffort: draftConvRef.current.effort,
      })
      setConversations((c) => [conv!, ...c])
      setActive(conv)
      setMessages([])
    }
    setMessages((m) => [
      ...m,
      { id: `local-u-${Date.now()}`, conversation_id: conv.id, role: 'user', content: trimmed, attachment_ids: opts?.attachmentIds ?? [], created_at: new Date().toISOString() },
    ])
    setIsStreaming(true)
    setStreamingText('')
    const attachments = opts?.attachmentIds && opts.attachmentIds.length ? { ids: opts.attachmentIds } : undefined
    try {
      await sendAgentMessage(conv.id, trimmed, { tierLevel: conv.tier_level, attachments })
    } catch (e) {
      // No agent_* WS event will arrive (the POST never spawned a turn) — reset
      // the streaming state here, mirroring the agent_error handler.
      setStreamingText('')
      setIsStreaming(false)
      setLiveTools([])
      toast.error(e instanceof Error ? e.message : 'Failed to send message.')
    }
  }, [active])

  const abort = useCallback(async () => {
    if (active) await abortAgentTurn(active.id)
    setIsStreaming(false)
    setStreamingText('')
  }, [active])

  const patchActive = useCallback(async (patch: Parameters<typeof patchAgentConversation>[1]) => {
    if (!active) return
    const updated = await patchAgentConversation(active.id, patch)
    setActive(updated)
    setConversations((c) => c.map((x) => (x.id === updated.id ? updated : x)))
  }, [active])

  const setTier = useCallback(async (level: AgentTierLevel) => {
    if (active) await patchActive({ tierLevel: level })
    else setDraftTierLevel(level)
  }, [active, patchActive])
  const cycleTier = useCallback(async () => {
    const next = (((active?.tier_level ?? draftTierLevel) + 1) % 4) as AgentTierLevel
    await setTier(next)
  }, [active, draftTierLevel, setTier])
  const setProvider = useCallback(async (provider: string) => {
    if (active) await patchActive({ provider })
    // Model + effort reset on provider switch (mirrors the server's stale reset).
    else { setDraftProvider(provider); setDraftModel(null); setDraftEffort(null) }
  }, [active, patchActive])
  const setModel = useCallback(async (model: string) => {
    if (active) await patchActive({ model })
    else setDraftModel(model)
  }, [active, patchActive])
  const setEffort = useCallback(async (effort: string | null) => {
    if (active) await patchActive({ reasoningEffort: effort })
    else setDraftEffort(effort)
  }, [active, patchActive])
  const setPinnedProject = useCallback(async (projectId: string | null) => {
    // On the EMPTY compose screen there's no conversation yet — record the pick
    // as a draft pin; otherwise patch the live conversation.
    if (active) await patchActive({ pinnedProjectId: projectId })
    else setDraftPinnedProjectId(projectId)
    // Agent Mode coherence: picking a project on the "+ New Agent" compose
    // screen also moves the left sidebar's highlighted project (the reverse
    // already holds — sidebar clicks seed the draft pin). Home (null) leaves
    // the sidebar untouched; the Kanban floating panel is unaffected.
    if (!active && projectId && uiMode === 'agent') setActiveProjectId(projectId)
  }, [active, patchActive, uiMode, setActiveProjectId])

  const startNewConversation = useCallback((projectId?: string | null) => {
    setActive(null)
    setMessages([])
    setStreamingText('')
    setIsStreaming(false)
    setLiveTools([])
    setDraftPinnedProjectId(projectId ?? null)
    setDraftProvider('claude')
    setDraftModel(null)
    setDraftTierLevel(0)
    setDraftEffort(null)
  }, [])

  const newConversation = useCallback(async (projectId?: string | null) => {
    // Explicit arg pins to that project (null ⇒ Home); arg-less preserves the
    // legacy behavior of inheriting the active conversation's pin.
    const pinnedProjectId = projectId !== undefined ? projectId : (active?.pinned_project_id ?? null)
    const created = await createAgentConversation({ pinnedProjectId })
    setConversations((c) => [created, ...c])
    setActive(created)
    setMessages([])
    setStreamingText('')
    setIsStreaming(false)
  }, [active])

  const selectConversation = useCallback(async (id: string) => { await loadConversation(id) }, [loadConversation])

  const deleteConversation = useCallback(async (id: string) => {
    await deleteAgentConversation(id)
    setConversations((c) => c.filter((x) => x.id !== id))
    if (activeIdRef.current === id) {
      setActive(null)
      setMessages([])
      setStreamingText('')
      setIsStreaming(false)
      setLiveTools([])
    }
  }, [])

  const enableMcpServer = useCallback(async () => {
    setEnablingMcp(true)
    try {
      await enableMcp()
      await refreshMcp()
    } finally {
      setEnablingMcp(false)
    }
  }, [refreshMcp])

  const value = useMemo<AgentChatContextValue>(() => ({
    visibility, open, close, minimize, toggle,
    conversations, active, messages, streamingText, isStreaming, liveTools,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, startNewConversation, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    selectConversation, deleteConversation, refreshConversations,
  }), [
    visibility, open, close, minimize, toggle,
    conversations, active, messages, streamingText, isStreaming, liveTools,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, startNewConversation, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    selectConversation, deleteConversation, refreshConversations,
  ])

  // In Agent Mode the conversation UI is the full-screen surface, so the
  // floating panel + bubble are suppressed. (`uiMode` is read at the top of the
  // provider — it also gates the sidebar-highlight sync in setPinnedProject.)
  const floatingAllowed = FEATURE_AGENT_CHAT && uiMode !== 'agent'

  return (
    <AgentChatContext.Provider value={value}>
      {children}
      {floatingAllowed && visibility === 'open' && <AgentChatPanel />}
      {/* Persistent bottom-center bubble: the single entry point when the panel
          is not open (summon from hidden AND restore from minimized). */}
      {floatingAllowed && visibility !== 'open' && <AgentBubble />}
    </AgentChatContext.Provider>
  )
}

const NOOP_AGENT_CHAT: AgentChatContextValue = {
  visibility: 'hidden',
  open: () => {}, close: () => {}, minimize: () => {}, toggle: () => {},
  conversations: [], active: null, messages: [], streamingText: '', isStreaming: false, liveTools: [],
  mcpEnabled: true, enablingMcp: false, enableMcpServer: async () => {}, providersReady: true,
  send: async () => {}, abort: async () => {}, cycleTier: async () => {}, setTier: async () => {},
  setProvider: async () => {}, setModel: async () => {}, setPinnedProject: async () => {},
  newConversation: async () => {}, startNewConversation: () => {}, draftPinnedProjectId: null,
  draftProvider: 'claude', draftModel: null, draftTierLevel: 0,
  draftEffort: null, setEffort: async () => {},
  selectConversation: async () => {}, deleteConversation: async () => {},
  refreshConversations: async () => {},
}

/**
 * Returns the agent chat API, or a safe no-op when rendered outside the provider
 * (mirrors useMinimizedChats — keeps components like ArcSidebar mountable in
 * isolation / tests without a provider).
 */
export function useAgentChat(): AgentChatContextValue {
  return useContext(AgentChatContext) ?? NOOP_AGENT_CHAT
}
