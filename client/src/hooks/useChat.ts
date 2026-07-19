import { useState, useCallback, useEffect, useLayoutEffect, useRef, createContext, useContext } from 'react'
import { useSharedWebSocket } from './useSharedWebSocket'
import type { ChatConversationSummary, ChatMessage } from '../types'
import { getApiBase } from '../lib/api'
import { useDesktop } from './useDesktop'
import { toast } from 'sonner'
import i18n from '../lib/i18n'

const PANEL_OPEN_KEY = 'specrails.chatPanelOpen'

export interface ChatConversation {
  id: string
  title: string | null
  model: string
  /** AI provider driving this conversation (for example Claude, Codex, Gemini, or Kimi). NULL/undefined
   *  on single-provider projects → rendered as the default (Claude). */
  provider?: string | null
  messages: ChatMessage[]
  isStreaming: boolean
  streamingText: string
  commandProposals: string[]
}

export interface ChatSendOptions {
  /** Use lightweight mode: minimal system prompt, limited turns, no auto-titling */
  lightweight?: boolean
  /** Limit Claude's agentic tool-use turns */
  maxTurns?: number
  /** Optional attachments folded into the prompt as <user-attachment> blocks. */
  attachments?: { ticketKey: string; ids: string[] }
}

export interface UseChatReturn {
  conversations: ChatConversation[]
  activeTabIndex: number
  isPanelOpen: boolean
  setActiveTabIndex: (i: number) => void
  togglePanel: () => void
  createConversation: (model?: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  sendMessage: (conversationId: string, text: string, options?: ChatSendOptions) => Promise<void>
  startWithMessage: (text: string, options?: ChatSendOptions, model?: string, kind?: 'sidebar' | 'explore', contextScope?: { specrails: boolean; openspec: boolean; full: boolean; mcp: boolean }, provider?: string) => Promise<string | null>
  hydrateConversation: (id: string) => Promise<void>
  abortStream: (conversationId: string) => Promise<void>
  confirmCommand: (command: string) => Promise<void>
  dismissCommandProposal: (conversationId: string, command: string) => void
  changeConversationModel: (id: string, model: string) => Promise<void>
}

export const ChatContext = createContext<UseChatReturn | null>(null)

export function useChatContext(): UseChatReturn | null {
  return useContext(ChatContext)
}

export function useChat(): UseChatReturn {
  const { activeProjectId } = useDesktop()
  const [conversations, setConversations] = useState<ChatConversation[]>([])
  const [activeTabIndex, setActiveTabIndex] = useState(0)
  const [isPanelOpen, setIsPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(PANEL_OPEN_KEY) === 'true'
    } catch {
      return false
    }
  })

  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  // Per-project conversation cache
  const convCacheRef = useRef<Map<string, ChatConversation[]>>(new Map())
  const prevProjectRef = useRef<string | null>(null)

  // Load conversations — re-fetch when project changes
  useEffect(() => {
    // Save outgoing project conversations
    if (prevProjectRef.current && prevProjectRef.current !== activeProjectId) {
      convCacheRef.current.set(prevProjectRef.current, conversations)
    }
    prevProjectRef.current = activeProjectId

    // Restore cached conversations instantly
    if (activeProjectId) {
      const cached = convCacheRef.current.get(activeProjectId)
      if (cached) {
        setConversations(cached)
        setActiveTabIndex(0)
      } else {
        setConversations([])
        setActiveTabIndex(0)
      }
    }

    async function load() {
      try {
        const base = getApiBase()
        const res = await fetch(`${base}/chat/conversations`)
        if (!res.ok) return
        const data = await res.json() as { conversations: ChatConversationSummary[] }
        const convos = data.conversations.slice(0, 3)

        const withMessages: ChatConversation[] = await Promise.all(
          convos.map(async (c) => {
            try {
              const msgRes = await fetch(`${getApiBase()}/chat/conversations/${c.id}/messages`)
              const msgData = msgRes.ok ? await msgRes.json() as { messages: ChatMessage[] } : { messages: [] }
              return {
                id: c.id,
                title: c.title,
                model: c.model,
                provider: c.provider,
                messages: msgData.messages,
                isStreaming: false,
                streamingText: '',
                commandProposals: [],
              }
            } catch {
              return {
                id: c.id,
                title: c.title,
                model: c.model,
                provider: c.provider,
                messages: [],
                isStreaming: false,
                streamingText: '',
                commandProposals: [],
              }
            }
          })
        )
        setConversations(withMessages)
        if (activeProjectId) convCacheRef.current.set(activeProjectId, withMessages)
      } catch {
        // ignore fetch errors on mount
      }
    }
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId])

  const handleMessage = useCallback((raw: unknown) => {
    const msg = raw as Record<string, unknown>
    if (typeof msg.type !== 'string') return

    // In Super mode, filter messages to the active project only
    const apiBase = getApiBase()
    const activeProjectId = apiBase.startsWith('/api/projects/')
      ? apiBase.split('/api/projects/')[1]
      : null

    if (activeProjectId && msg.projectId && msg.projectId !== activeProjectId) {
      return
    }

    if (msg.type === 'chat_stream') {
      const conversationId = msg.conversationId as string
      const delta = msg.delta as string
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, isStreaming: true, streamingText: c.streamingText + delta }
            : c
        )
      )
    } else if (msg.type === 'chat_done') {
      const conversationId = msg.conversationId as string
      const fullText = msg.fullText as string
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== conversationId) return c
          const finalMessage: ChatMessage = {
            id: Date.now(),
            conversation_id: conversationId,
            role: 'assistant',
            content: fullText,
            created_at: new Date().toISOString(),
          }
          return {
            ...c,
            isStreaming: false,
            streamingText: '',
            messages: [...c.messages, finalMessage],
          }
        })
      )
    } else if (msg.type === 'chat_error') {
      const conversationId = msg.conversationId as string
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, isStreaming: false, streamingText: '' }
            : c
        )
      )
    } else if (msg.type === 'chat_command_proposal') {
      const conversationId = msg.conversationId as string
      const command = msg.command as string
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId && !c.commandProposals.includes(command)
            ? { ...c, commandProposals: [...c.commandProposals, command] }
            : c
        )
      )
    } else if (msg.type === 'chat_title_update') {
      const conversationId = msg.conversationId as string
      const title = msg.title as string
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, title } : c))
      )
    }
  }, [])

  useLayoutEffect(() => {
    registerHandler('chat', handleMessage)
    return () => unregisterHandler('chat')
  }, [handleMessage, registerHandler, unregisterHandler])

  const togglePanel = useCallback(() => {
    setIsPanelOpen((prev) => {
      const next = !prev
      try { localStorage.setItem(PANEL_OPEN_KEY, String(next)) } catch { /* ignore */ }
      return next
    })
  }, [])

  const createConversation = useCallback(async (model = 'sonnet') => {
    try {
      const res = await fetch(`${getApiBase()}/chat/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
      if (!res.ok) return
      const data = await res.json() as { conversation: ChatConversationSummary }
      const newConvo: ChatConversation = {
        id: data.conversation.id,
        title: data.conversation.title,
        model: data.conversation.model,
        provider: data.conversation.provider,
        messages: [],
        isStreaming: false,
        streamingText: '',
        commandProposals: [],
      }
      setConversations((prev) => {
        const next = [...prev, newConvo].slice(0, 3)
        // Switch to the newly created tab using the current (pre-add) length
        setActiveTabIndex(Math.min(prev.length, 2))
        return next
      })
    } catch {
      // ignore
    }
  }, [])

  const deleteConversation = useCallback(async (id: string) => {
    try {
      await fetch(`${getApiBase()}/chat/conversations/${id}`, { method: 'DELETE' })
    } catch { /* ignore */ }
    setConversations((prev) => {
      const next = prev.filter((c) => c.id !== id)
      return next
    })
    setActiveTabIndex((prev) => Math.max(0, prev - 1))
  }, [])

  const sendMessage = useCallback(async (conversationId: string, text: string, options?: ChatSendOptions) => {
    // Optimistically add user message to local state
    const optimisticMsg: ChatMessage = {
      id: Date.now(),
      conversation_id: conversationId,
      role: 'user',
      content: text,
      created_at: new Date().toISOString(),
    }
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, messages: [...c.messages, optimisticMsg], isStreaming: true }
          : c
      )
    )

    try {
      const body: Record<string, unknown> = { text }
      if (options?.lightweight) body.lightweight = true
      if (options?.maxTurns != null) body.maxTurns = options.maxTurns
      if (options?.attachments && options.attachments.ids.length > 0) {
        body.attachments = options.attachments
      }
      await fetch(`${getApiBase()}/chat/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } catch {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, isStreaming: false, messages: c.messages.filter((m) => m.id !== optimisticMsg.id) }
            : c
        )
      )
      toast.error(i18n.t('chat:errors.sendFailed'))
    }
  }, [])

  const abortStream = useCallback(async (conversationId: string) => {
    try {
      await fetch(`${getApiBase()}/chat/conversations/${conversationId}/messages/stream`, {
        method: 'DELETE',
      })
    } catch { /* ignore */ }
  }, [])

  const confirmCommand = useCallback(async (command: string) => {
    try {
      await fetch(`${getApiBase()}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command }),
      })
    } catch { /* ignore */ }
  }, [])

  const dismissCommandProposal = useCallback((conversationId: string, command: string) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId
          ? { ...c, commandProposals: c.commandProposals.filter((p) => p !== command) }
          : c
      )
    )
  }, [])

  const changeConversationModel = useCallback(async (id: string, model: string) => {
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, model } : c))
    )
    try {
      await fetch(`${getApiBase()}/chat/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      })
    } catch { /* ignore */ }
  }, [])

  // Create a conversation and immediately send the first message
  const startWithMessage = useCallback(async (
    text: string,
    options?: ChatSendOptions,
    model?: string,
    kind?: 'sidebar' | 'explore',
    contextScope?: { specrails: boolean; openspec: boolean; full: boolean; mcp: boolean },
    provider?: string,
  ): Promise<string | null> => {
    try {
      const body: Record<string, unknown> = { model: model ?? undefined, kind: kind ?? undefined }
      if (contextScope && kind === 'explore') body.contextScope = contextScope
      if (provider) body.aiEngine = provider
      const res = await fetch(`${getApiBase()}/chat/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) return null
      const data = await res.json() as { conversation: ChatConversationSummary }
      const newConvo: ChatConversation = {
        id: data.conversation.id,
        title: data.conversation.title,
        model: data.conversation.model,
        // Server persists provider only on multi-provider projects (else NULL).
        // Fall back to the requested engine so a freshly-started non-default
        // session labels its bubbles correctly without waiting for a reload.
        provider: data.conversation.provider ?? provider ?? null,
        messages: [],
        isStreaming: false,
        streamingText: '',
        commandProposals: [],
      }
      setConversations((prev) => {
        const next = [...prev, newConvo].slice(-3)
        setActiveTabIndex(next.length - 1)
        return next
      })
      // Fire-and-forget the message send so the caller gets the ID immediately
      void sendMessage(data.conversation.id, text, options)
      return data.conversation.id
    } catch {
      return null
    }
  }, [sendMessage])

  // Hydrate a specific conversation by id (used by Explore shell restore when
  // the conversation is older than the top-3 kept in memory). Idempotent —
  // no-op if the conv is already present.
  const hydrateConversation = useCallback(async (id: string): Promise<void> => {
    if (conversations.some((c) => c.id === id)) return
    try {
      const res = await fetch(`${getApiBase()}/chat/conversations/${id}`)
      if (!res.ok) return
      const data = await res.json() as {
        conversation: ChatConversationSummary
        messages: ChatMessage[]
      }
      const hydrated: ChatConversation = {
        id: data.conversation.id,
        title: data.conversation.title,
        model: data.conversation.model,
        provider: data.conversation.provider,
        messages: data.messages,
        isStreaming: false,
        streamingText: '',
        commandProposals: [],
      }
      setConversations((prev) => {
        if (prev.some((c) => c.id === id)) return prev
        return [...prev, hydrated]
      })
    } catch { /* ignore */ }
  }, [conversations])

  return {
    conversations,
    activeTabIndex,
    isPanelOpen,
    setActiveTabIndex,
    togglePanel,
    createConversation,
    deleteConversation,
    sendMessage,
    startWithMessage,
    hydrateConversation,
    abortStream,
    confirmCommand,
    dismissCommandProposal,
    changeConversationModel,
  }
}
