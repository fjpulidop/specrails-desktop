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
  editQueuedAgentMessage,
  getMcpStatus,
  enableMcp,
  getAvailableProviders,
  coercePrDecisionEnvelope,
  parsePrDecisionEnvelope,
  type AgentConversation,
  type AgentContextReference,
  type AgentMessage,
  type AgentPrDecisionEnvelope,
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

/** A message sent while the agent was busy — parked server-side, shown as a
 *  dimmed chip below the streaming bubble until its turn starts. */
export interface AgentQueuedItem {
  queueId: string
  text: string
  contextRefs?: AgentContextReference[]
}

/** Live turn state for ONE conversation. Kept per-conversation so background
 *  agents keep streaming while the user reads another thread. */
export interface AgentConvLive {
  streamingText: string
  isStreaming: boolean
  liveTools: AgentLiveTool[]
  queued: AgentQueuedItem[]
}

const EMPTY_LIVE: AgentConvLive = { streamingText: '', isStreaming: false, liveTools: [], queued: [] }
const FAVORITE_CONVERSATIONS_KEY = 'specrails-desktop:favorite-agent-conversations'

function loadFavoriteConversationIds(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITE_CONVERSATIONS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set()
  } catch {
    return new Set()
  }
}

function saveFavoriteConversationIds(ids: ReadonlySet<string>): void {
  try { localStorage.setItem(FAVORITE_CONVERSATIONS_KEY, JSON.stringify([...ids])) } catch { /* ignore */ }
}

function pruneFavoriteConversationIds(prev: ReadonlySet<string>, conversations: AgentConversation[]): Set<string> {
  const valid = new Set(conversations.map((c) => c.id))
  return new Set([...prev].filter((id) => valid.has(id)))
}

function upsertPrDecisionMessage(
  messages: AgentMessage[],
  conversationId: string,
  envelope: AgentPrDecisionEnvelope,
): AgentMessage[] {
  const content = JSON.stringify(envelope)
  const idx = messages.findIndex(
    (message) => message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId,
  )
  if (idx >= 0) {
    if (messages[idx].content === content) return messages
    const copy = [...messages]
    copy[idx] = { ...copy[idx], content }
    return copy
  }
  return [
    ...messages,
    {
      id: `prd-${envelope.prDeliveryId}`,
      conversation_id: conversationId,
      role: 'system',
      content,
      created_at: new Date().toISOString(),
    },
  ]
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
  /** Messages waiting behind the in-flight turn (FIFO, server-drained). */
  queuedMessages: AgentQueuedItem[]
  /** Every conversation with a live turn — feeds the sidebar title shimmer. */
  streamingConversationIds: ReadonlySet<string>
  /** Conversations with assistant/system output that arrived out of view. */
  unreadConversationIds: ReadonlySet<string>
  /** Per-conversation live slices (stream/tools/queue) — feeds the mission
   *  selector's queued-count badges without flattening to the active thread. */
  liveByConversation: ReadonlyMap<string, AgentConvLive>
  /** Mission IDs surfaced in the left sidebar's Favorite missions section. */
  favoriteConversationIds: ReadonlySet<string>

  mcpEnabled: boolean
  enablingMcp: boolean
  enableMcpServer: () => Promise<void>

  /** null = not yet checked; false = no AI provider CLI is installed. */
  providersReady: boolean | null

  send: (text: string, opts?: { attachmentIds?: string[]; contextRefs?: AgentContextReference[] }) => Promise<void>
  abort: () => Promise<void>
  /** Edit a still-queued message in place (composer ↑/↓ queue navigation).
   *  `'conflict'` = already dispatched — the caller keeps the text as a draft. */
  editQueuedMessage: (queueId: string, text: string) => Promise<'saved' | 'conflict'>
  /** True when a queued message already left the queue as a real turn
   *  (`agent_dequeued` seen) — distinguishes "dispatched" from "cleared". */
  wasQueueConsumed: (queueId: string) => boolean
  cycleTier: () => Promise<void>
  setTier: (level: AgentTierLevel) => Promise<void>
  setProvider: (provider: string) => Promise<void>
  setModel: (model: string) => Promise<void>
  setPinnedProject: (projectId: string | null) => Promise<void>
  newConversation: (projectId?: string | null) => Promise<void>
  /** Reset to the EMPTY compose screen (active=null) with a draft pin — the next
   *  send creates a fresh conversation. This is the "+ New Agent" action. */
  startNewConversation: (projectId?: string | null) => void
  /** Materialise the EMPTY compose draft without sending a message. Used by
   *  uploads, which are stored against a real conversation id. */
  materializeDraftConversation: () => Promise<AgentConversation>
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
  /** Rename a conversation (optimistic; blank clears to auto-title). */
  renameConversation: (id: string, title: string) => Promise<void>
  /** Toggle the sidebar Favorite missions membership without changing project pinning. */
  toggleFavoriteConversation: (id: string) => void
  /** Refresh the conversation list WITHOUT opening the floating panel. Used on
   *  entering Agent Mode (open() would mount the now-suppressed panel). */
  refreshConversations: () => Promise<void>
  /** Apply the authoritative snapshot returned by a card action immediately;
   *  the persisted message/WS update later becomes an idempotent no-op. */
  applyPrDecisionSnapshot: (envelope: AgentPrDecisionEnvelope) => void
}

const AgentChatContext = createContext<AgentChatContextValue | null>(null)

interface WsAgentMsg {
  type: string
  conversationId?: string
  delta?: string
  fullText?: string
  error?: string
  tool?: string
  queueId?: string | null
  text?: string
  contextRefs?: AgentContextReference[]
}

let _toolSeq = 0
let _queueSeq = 0

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const { uiMode } = useUiMode()
  const { setActiveProjectId } = useDesktop()

  const [visibility, setVisibility] = useState<AgentVisibility>('hidden')
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [active, setActive] = useState<AgentConversation | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [favoriteConversationIds, setFavoriteConversationIds] = useState<ReadonlySet<string>>(loadFavoriteConversationIds)
  const [unreadConversationIds, setUnreadConversationIds] = useState<ReadonlySet<string>>(new Set())
  // Live turn state is PER CONVERSATION: agents keep working in the background,
  // so switching threads never drops streamed text, tool chips or queued
  // messages. The view derives the active conversation's slice below.
  const [liveByConv, setLiveByConv] = useState<ReadonlyMap<string, AgentConvLive>>(new Map())
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
  // send() decides queue-vs-direct from a ref (liveByConv is not among its deps).
  const liveRef = useRef(liveByConv)
  liveRef.current = liveByConv
  // queueIds whose agent_dequeued already ran — send()'s race reconciliation
  // must never re-add a chip that was consumed while the POST was in flight.
  const consumedQueueIdsRef = useRef(new Set<string>())
  const draftMaterializeRef = useRef<Promise<AgentConversation> | null>(null)
  const prSnapshotVersionRef = useRef(0)

  const applyPrDecisionSnapshot = useCallback((envelope: AgentPrDecisionEnvelope): void => {
    const conversationId = activeIdRef.current
    if (!conversationId) return
    const belongsToActiveThread = messagesRef.current.some(
      (message) => message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId,
    )
    if (!belongsToActiveThread) return
    // Advance before scheduling React state so an already-resolving focus GET
    // cannot enqueue a stale overwrite in the same batch.
    prSnapshotVersionRef.current++
    setMessages((current) => {
      // An action can resolve after the user switches conversations. HTTP card
      // snapshots are update-only: the delivery must still exist in the active
      // thread, otherwise appending would leak conversation A's card into B.
      const stillBelongsToActiveThread = current.some(
        (message) => message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId,
      )
      if (!stillBelongsToActiveThread) return current
      return upsertPrDecisionMessage(current, conversationId, envelope)
    })
  }, [])

  /** Update one conversation's live slice; a fully-idle slice drops its entry. */
  const patchLive = useCallback((id: string, fn: (prev: AgentConvLive) => AgentConvLive | null) => {
    setLiveByConv((m) => {
      const next = fn(m.get(id) ?? EMPTY_LIVE)
      const copy = new Map(m)
      if (
        next === null ||
        (!next.isStreaming && !next.streamingText && next.liveTools.length === 0 && next.queued.length === 0)
      ) {
        copy.delete(id)
      } else {
        copy.set(id, next)
      }
      return copy
    })
  }, [])

  const markUnread = useCallback((conversationId: string): void => {
    const documentHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
    if (conversationId === activeIdRef.current && !documentHidden) return
    setUnreadConversationIds((prev) => {
      if (prev.has(conversationId)) return prev
      const next = new Set(prev)
      next.add(conversationId)
      return next
    })
  }, [])

  const clearUnread = useCallback((conversationId: string): void => {
    setUnreadConversationIds((prev) => {
      if (!prev.has(conversationId)) return prev
      const next = new Set(prev)
      next.delete(conversationId)
      return next
    })
  }, [])

  useEffect(() => {
    if (!FEATURE_AGENT_CHAT || typeof document === 'undefined') return
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
      const activeId = activeIdRef.current
      if (activeId) clearUnread(activeId)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [clearUnread])

  // The view's slice — everything downstream (panel, composer, Agent Mode
  // surface) keeps consuming the same flat fields as before.
  const activeLive = (active ? liveByConv.get(active.id) : undefined) ?? EMPTY_LIVE
  const streamingText = activeLive.streamingText
  const isStreaming = activeLive.isStreaming
  const liveTools = activeLive.liveTools
  const queuedMessages = activeLive.queued
  const streamingConversationIds = useMemo(() => {
    const ids = new Set<string>()
    for (const [id, live] of liveByConv) if (live.isStreaming) ids.add(id)
    return ids
  }, [liveByConv])

  // Refresh the conversation list + MCP status lazily on first open.
  const refreshConversations = useCallback(async () => {
    try {
      const list = await listAgentConversations()
      setConversations(list)
      setFavoriteConversationIds((prev) => {
        const next = pruneFavoriteConversationIds(prev, list)
        if (next.size === prev.size) return prev
        saveFavoriteConversationIds(next)
        return next
      })
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
      const convId = msg.conversationId
      if (!convId) return
      // NO active-conversation filter for live state: background turns keep
      // accumulating in their own slice so a switch-back shows the full stream.
      // Only the `messages` list (the active thread) is gated on isActive.
      const isActive = convId === activeIdRef.current
      if (msg.type === 'agent_stream') {
        markUnread(convId)
        patchLive(convId, (p) => ({ ...p, isStreaming: true, streamingText: p.streamingText + (msg.delta ?? '') }))
      } else if (msg.type === 'agent_tool') {
        patchLive(convId, (p) => ({ ...p, isStreaming: true, liveTools: [...p.liveTools, { id: `t${_toolSeq++}`, tool: msg.tool ?? 'tool' }] }))
      } else if (msg.type === 'agent_done') {
        markUnread(convId)
        const full = msg.fullText ?? ''
        if (isActive) {
          setMessages((m) => {
            // A switch-back refetch can already contain this reply (it is
            // persisted before the broadcast) — don't append it twice. Only
            // server-fetched rows (non-local ids) dedupe: two legitimately
            // identical consecutive replies both arrive as local appends.
            const last = m[m.length - 1]
            if (last && last.role === 'assistant' && last.content === full && !last.id.startsWith('local-')) return m
            return [
              ...m,
              { id: `local-${Date.now()}`, conversation_id: convId, role: 'assistant', content: full, created_at: new Date().toISOString() },
            ]
          })
        }
        // Keep queued chips: with a non-empty queue the next drained turn is
        // about to start (agent_dequeued follows).
        patchLive(convId, (p) => ({ ...EMPTY_LIVE, queued: p.queued }))
      } else if (msg.type === 'agent_error') {
        markUnread(convId)
        patchLive(convId, (p) => ({ ...EMPTY_LIVE, queued: p.queued }))
        const err = msg.error || 'The agent turn failed.'
        toast.error(err)
        // Also surface it inline so it's visible in the conversation.
        if (isActive) {
          setMessages((m) => [
            ...m,
            { id: `err-${Date.now()}`, conversation_id: convId, role: 'assistant', content: `⚠️ ${err}`, created_at: new Date().toISOString() },
          ])
        }
      } else if (msg.type === 'agent_queued') {
        // Dedupe by queueId: the sending window already parked its own chip.
        patchLive(convId, (p) => {
          if (msg.queueId && p.queued.some((q) => q.queueId === msg.queueId)) return p
          return {
            ...p,
            queued: [...p.queued, { queueId: msg.queueId ?? `srv-${_queueSeq++}`, text: msg.text ?? '', contextRefs: msg.contextRefs }],
          }
        })
      } else if (msg.type === 'agent_dequeued') {
        // The queued message's turn starts now: chip → real user bubble.
        if (msg.queueId) consumedQueueIdsRef.current.add(msg.queueId)
        patchLive(convId, (p) => {
          const idx = msg.queueId ? p.queued.findIndex((q) => q.queueId === msg.queueId) : 0
          const drop = idx === -1 ? 0 : idx
          return { ...p, queued: p.queued.filter((_, i) => i !== drop), isStreaming: true, streamingText: '', liveTools: [] }
        })
        if (isActive && msg.text) {
          setMessages((m) => [
            ...m,
            {
              id: `local-u-${Date.now()}`,
              conversation_id: convId,
              role: 'user',
              content: msg.text!,
              context_refs: msg.contextRefs ?? [],
              created_at: new Date().toISOString(),
            },
          ])
        }
      } else if (msg.type === 'agent_queue_cleared') {
        patchLive(convId, (p) => ({ ...p, queued: [] }))
      } else if (msg.type === 'agent_queue_edited') {
        // A queued chip was edited in place (this window or another) — update
        // its text; the editing window's optimistic update makes this a no-op.
        patchLive(convId, (p) => ({
          ...p,
          queued: p.queued.map((q) => (
            msg.queueId && q.queueId === msg.queueId
              ? { ...q, text: msg.text ?? q.text, contextRefs: msg.contextRefs ?? q.contextRefs }
              : q
          )),
        }))
      } else if (msg.type === 'agent_pr_decision') {
        markUnread(convId)
        // PR-decision card (safe-pr-review-flow): the WS message carries the
        // persisted envelope's fields top-level. Only the ACTIVE thread's
        // `messages` slice is held in state — upsert its card in place (match
        // by prDeliveryId) or append it for a live arrival without reload.
        // Background conversations need nothing: the server updates the SAME
        // persisted system row, so rehydrate-on-select shows the current state.
        if (isActive) {
          const envelope = coercePrDecisionEnvelope(raw)
          if (envelope) {
            prSnapshotVersionRef.current++
            setMessages((current) => upsertPrDecisionMessage(current, convId, envelope))
          }
        }
      }
    }
    registerHandler('agent-chat', handler)
    return () => unregisterHandler('agent-chat')
  }, [registerHandler, unregisterHandler, patchLive, markUnread])

  const loadConversation = useCallback(async (id: string) => {
    const { conversation, messages: msgs } = await getAgentConversation(id)
    setActive(conversation)
    setMessages(msgs)
    clearUnread(id)
    // Live state (stream text / tools / queue) is per-conversation and is
    // deliberately NOT reset here — a background turn keeps its full context
    // and re-appears mid-stream when the user switches back.
  }, [clearUnread])

  // A card action can complete while this window misses its WS packet. Re-read
  // only the persisted PR system rows on focus/reconnect; user/stream messages
  // remain untouched, so a live turn cannot be clobbered by hydration.
  const hydrateActivePrCards = useCallback(async (): Promise<void> => {
    const conversationId = activeIdRef.current
    if (!conversationId) return
    const version = prSnapshotVersionRef.current
    try {
      const fresh = await getAgentConversation(conversationId)
      if (activeIdRef.current !== conversationId || prSnapshotVersionRef.current !== version) return
      const envelopes = fresh.messages
        .filter((message) => message.role === 'system')
        .map((message) => parsePrDecisionEnvelope(message.content))
        .filter((envelope): envelope is AgentPrDecisionEnvelope => envelope !== null)
      if (envelopes.length === 0) return
      setMessages((current) => envelopes.reduce(
        (next, envelope) => upsertPrDecisionMessage(next, conversationId, envelope),
        current,
      ))
    } catch {
      /* Advisory convergence path; the next focus/reconnect can retry. */
    }
  }, [])

  useEffect(() => {
    const onFocus = () => { void hydrateActivePrCards() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [hydrateActivePrCards])

  const previousConnectionRef = useRef(connectionStatus)
  useEffect(() => {
    const previous = previousConnectionRef.current
    previousConnectionRef.current = connectionStatus
    if (connectionStatus === 'connected' && previous !== 'connected') void hydrateActivePrCards()
  }, [connectionStatus, hydrateActivePrCards])

  const ensureActive = useCallback(async (): Promise<AgentConversation> => {
    if (active) return active
    const list = await listAgentConversations()
    setConversations(list)
    setFavoriteConversationIds((prev) => {
      const next = pruneFavoriteConversationIds(prev, list)
      if (next.size === prev.size) return prev
      saveFavoriteConversationIds(next)
      return next
    })
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

  const materializeDraftConversation = useCallback(async (): Promise<AgentConversation> => {
    if (active) return active
    if (draftMaterializeRef.current) return draftMaterializeRef.current

    const promise = createAgentConversation({
      pinnedProjectId: draftPinRef.current,
      provider: draftConvRef.current.provider,
      model: draftConvRef.current.model,
      tierLevel: draftConvRef.current.tierLevel,
      reasoningEffort: draftConvRef.current.effort,
    })
      .then((created) => {
        setConversations((c) => [created, ...c])
        setActive(created)
        setMessages([])
        return created
      })
      .finally(() => {
        draftMaterializeRef.current = null
      })

    draftMaterializeRef.current = promise
    return promise
  }, [active])

  const send = useCallback(async (text: string, opts?: { attachmentIds?: string[]; contextRefs?: AgentContextReference[] }) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // EMPTY compose screen (no active conversation) ALWAYS starts a fresh
    // conversation with the draft pin — it never resurrects the latest chat.
    const conv = active ?? await materializeDraftConversation()
    const queueId = `q-${Date.now()}-${_queueSeq++}`
    const nowIso = new Date().toISOString()
    // "Last interaction" is NOW — bump the conversation's updated_at (so the
    // mission-list time-since counter resets immediately to "now") and float it
    // to the top (newest-first, matching the server's ORDER BY updated_at DESC).
    setConversations((cs) => {
      const found = cs.find((c) => c.id === conv!.id)
      const bumped = { ...(found ?? conv!), updated_at: nowIso }
      return [bumped, ...cs.filter((c) => c.id !== conv!.id)]
    })
    setActive((a) => (a && a.id === conv!.id ? { ...a, updated_at: nowIso } : a))
    const userBubble = {
      id: `local-u-${Date.now()}`,
      conversation_id: conv.id,
      role: 'user' as const,
      content: trimmed,
      attachment_ids: opts?.attachmentIds ?? [],
      context_refs: opts?.contextRefs ?? [],
      created_at: nowIso,
    }
    // Busy conversation → the message QUEUES (server-side FIFO) and shows as a
    // parked chip below the streaming bubble instead of a normal bubble.
    const wasBusy = liveRef.current.get(conv.id)?.isStreaming === true
    if (wasBusy) {
      patchLive(conv.id, (p) => ({ ...p, queued: [...p.queued, { queueId, text: trimmed, contextRefs: opts?.contextRefs }] }))
    } else {
      setMessages((m) => [...m, userBubble])
      patchLive(conv.id, (p) => ({ ...p, isStreaming: true, streamingText: '', liveTools: [] }))
    }
    const attachments = opts?.attachmentIds && opts.attachmentIds.length ? { ids: opts.attachmentIds } : undefined
    try {
      const contextRefs = opts?.contextRefs && opts.contextRefs.length ? opts.contextRefs : undefined
      const res = await sendAgentMessage(conv.id, trimmed, { tierLevel: conv.tier_level, attachments, queueId, contextRefs })
      const queued = res?.queued === true
      if (queued && !wasBusy) {
        // Rare race: the server was actually mid-turn — re-home the optimistic
        // bubble as a queued chip (the agent_queued event dedupes by queueId).
        // If its agent_dequeued ALREADY ran while this POST was in flight, the
        // chip is consumed — re-adding it would park a phantom chip forever.
        setMessages((m) => m.filter((x) => x.id !== userBubble.id))
        if (!consumedQueueIdsRef.current.has(queueId)) {
          patchLive(conv.id, (p) =>
            p.queued.some((q) => q.queueId === queueId)
              ? p
              : { ...p, queued: [...p.queued, { queueId, text: trimmed, contextRefs: opts?.contextRefs }] },
          )
        }
      } else if (!queued && wasBusy) {
        // Rare race: the turn had just settled — our chip is running as a direct
        // turn (no agent_dequeued will ever come for it), promote it now.
        patchLive(conv.id, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== queueId), isStreaming: true }))
        setMessages((m) => [...m, userBubble])
      }
    } catch (e) {
      // No agent_* WS event will arrive (the POST never spawned a turn) — reset
      // the optimistic state here, mirroring the agent_error handler.
      if (wasBusy) {
        patchLive(conv.id, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== queueId) }))
      } else {
        patchLive(conv.id, (p) => ({ ...p, isStreaming: false, streamingText: '', liveTools: [] }))
      }
      toast.error(e instanceof Error ? e.message : 'Failed to send message.')
    }
  }, [active, materializeDraftConversation, patchLive])

  const abort = useCallback(async () => {
    if (!active) return
    // Stop means stop: drop the stream state AND any queued chips immediately
    // (the server discards its queue too and broadcasts agent_queue_cleared).
    patchLive(active.id, () => null)
    await abortAgentTurn(active.id)
  }, [active, patchLive])

  const editQueuedMessage = useCallback(async (queueId: string, text: string): Promise<'saved' | 'conflict'> => {
    const conv = active
    if (!conv) return 'conflict'
    const r = await editQueuedAgentMessage(conv.id, queueId, text)
    if (r === 'saved') {
      // Optimistic chip update — the agent_queue_edited broadcast is a no-op here.
      patchLive(conv.id, (p) => ({
        ...p,
        queued: p.queued.map((q) => (
          q.queueId === queueId
            ? { ...q, text }
            : q
        )),
      }))
    }
    return r
  }, [active, patchLive])

  const wasQueueConsumed = useCallback((queueId: string): boolean => consumedQueueIdsRef.current.has(queueId), [])

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
  }, [active])

  const selectConversation = useCallback(async (id: string) => { await loadConversation(id) }, [loadConversation])

  const deleteConversation = useCallback(async (id: string) => {
    await deleteAgentConversation(id)
    setConversations((c) => c.filter((x) => x.id !== id))
    setFavoriteConversationIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      saveFavoriteConversationIds(next)
      return next
    })
    patchLive(id, () => null)
    if (activeIdRef.current === id) {
      setActive(null)
      setMessages([])
    }
  }, [patchLive])

  /** Rename a conversation. Optimistic: the title updates locally immediately and
   *  reverts on failure. A blank/whitespace title clears back to auto-title. */
  const renameConversation = useCallback(async (id: string, rawTitle: string): Promise<void> => {
    const title = rawTitle.trim() || null
    let prev: string | null | undefined
    setConversations((cs) => cs.map((c) => {
      if (c.id === id) { prev = c.title; return { ...c, title } }
      return c
    }))
    setActive((a) => (a && a.id === id ? { ...a, title } : a))
    try {
      await patchAgentConversation(id, { title })
    } catch (err) {
      // Revert the optimistic write.
      setConversations((cs) => cs.map((c) => (c.id === id ? { ...c, title: prev ?? null } : c)))
      setActive((a) => (a && a.id === id ? { ...a, title: prev ?? null } : a))
      throw err
    }
  }, [])

  const toggleFavoriteConversation = useCallback((id: string): void => {
    setFavoriteConversationIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      saveFavoriteConversationIds(next)
      return next
    })
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
    queuedMessages, streamingConversationIds, liveByConversation: liveByConv,
    unreadConversationIds, favoriteConversationIds,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, editQueuedMessage, wasQueueConsumed,
    cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, startNewConversation, materializeDraftConversation, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    selectConversation, deleteConversation, renameConversation, toggleFavoriteConversation, refreshConversations,
    applyPrDecisionSnapshot,
  }), [
    visibility, open, close, minimize, toggle,
    conversations, active, messages, streamingText, isStreaming, liveTools,
    queuedMessages, streamingConversationIds, liveByConv, unreadConversationIds, favoriteConversationIds,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, editQueuedMessage, wasQueueConsumed,
    cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, startNewConversation, materializeDraftConversation, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    selectConversation, deleteConversation, renameConversation, toggleFavoriteConversation, refreshConversations,
    applyPrDecisionSnapshot,
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
  queuedMessages: [], streamingConversationIds: new Set<string>(),
  unreadConversationIds: new Set<string>(),
  liveByConversation: new Map<string, AgentConvLive>(),
  favoriteConversationIds: new Set<string>(),
  mcpEnabled: true, enablingMcp: false, enableMcpServer: async () => {}, providersReady: true,
  send: async () => {}, abort: async () => {},
  editQueuedMessage: async () => 'conflict', wasQueueConsumed: () => false,
  cycleTier: async () => {}, setTier: async () => {},
  setProvider: async () => {}, setModel: async () => {}, setPinnedProject: async () => {},
  newConversation: async () => {}, startNewConversation: () => {}, materializeDraftConversation: async () => {
    throw new Error('AgentChatProvider is not mounted')
  }, draftPinnedProjectId: null,
  draftProvider: 'claude', draftModel: null, draftTierLevel: 0,
  draftEffort: null, setEffort: async () => {},
  selectConversation: async () => {}, deleteConversation: async () => {}, renameConversation: async () => {},
  toggleFavoriteConversation: () => {},
  refreshConversations: async () => {},
  applyPrDecisionSnapshot: () => {},
}

/**
 * Returns the agent chat API, or a safe no-op when rendered outside the provider
 * (mirrors useMinimizedChats — keeps components like ArcSidebar mountable in
 * isolation / tests without a provider).
 */
export function useAgentChat(): AgentChatContextValue {
  return useContext(AgentChatContext) ?? NOOP_AGENT_CHAT
}
