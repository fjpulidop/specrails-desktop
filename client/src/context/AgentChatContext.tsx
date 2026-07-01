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

  send: (text: string) => Promise<void>
  abort: () => Promise<void>
  cycleTier: () => Promise<void>
  setTier: (level: AgentTierLevel) => Promise<void>
  setProvider: (provider: string) => Promise<void>
  setModel: (model: string) => Promise<void>
  setPinnedProject: (projectId: string | null) => Promise<void>
  newConversation: () => Promise<void>
  selectConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
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

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const conv = await ensureActive()
    setMessages((m) => [
      ...m,
      { id: `local-u-${Date.now()}`, conversation_id: conv.id, role: 'user', content: trimmed, created_at: new Date().toISOString() },
    ])
    setIsStreaming(true)
    setStreamingText('')
    await sendAgentMessage(conv.id, trimmed, { tierLevel: conv.tier_level })
  }, [ensureActive])

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

  const setTier = useCallback(async (level: AgentTierLevel) => { await patchActive({ tierLevel: level }) }, [patchActive])
  const cycleTier = useCallback(async () => {
    const next = (((active?.tier_level ?? 0) + 1) % 4) as AgentTierLevel
    await setTier(next)
  }, [active, setTier])
  const setProvider = useCallback(async (provider: string) => { await patchActive({ provider }) }, [patchActive])
  const setModel = useCallback(async (model: string) => { await patchActive({ model }) }, [patchActive])
  const setPinnedProject = useCallback(async (projectId: string | null) => { await patchActive({ pinnedProjectId: projectId }) }, [patchActive])

  const newConversation = useCallback(async () => {
    const created = await createAgentConversation({ pinnedProjectId: active?.pinned_project_id ?? null })
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
    newConversation, selectConversation, deleteConversation,
  }), [
    visibility, open, close, minimize, toggle,
    conversations, active, messages, streamingText, isStreaming, liveTools,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, selectConversation, deleteConversation,
  ])

  return (
    <AgentChatContext.Provider value={value}>
      {children}
      {FEATURE_AGENT_CHAT && visibility === 'open' && <AgentChatPanel />}
      {/* Persistent bottom-center bubble: the single entry point when the panel
          is not open (summon from hidden AND restore from minimized). */}
      {FEATURE_AGENT_CHAT && visibility !== 'open' && <AgentBubble />}
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
  newConversation: async () => {}, selectConversation: async () => {}, deleteConversation: async () => {},
}

/**
 * Returns the agent chat API, or a safe no-op when rendered outside the provider
 * (mirrors useMinimizedChats — keeps components like ArcSidebar mountable in
 * isolation / tests without a provider).
 */
export function useAgentChat(): AgentChatContextValue {
  return useContext(AgentChatContext) ?? NOOP_AGENT_CHAT
}
