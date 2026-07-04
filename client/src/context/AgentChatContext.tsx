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

/** A message sent while the agent was busy — parked server-side, shown as a
 *  dimmed chip below the streaming bubble until its turn starts. */
export interface AgentQueuedItem {
  queueId: string
  text: string
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
  /** Per-conversation live slices (stream/tools/queue) — feeds the mission
   *  selector's queued-count badges without flattening to the active thread. */
  liveByConversation: ReadonlyMap<string, AgentConvLive>

  mcpEnabled: boolean
  enablingMcp: boolean
  enableMcpServer: () => Promise<void>

  /** null = not yet checked; false = no AI provider CLI is installed. */
  providersReady: boolean | null

  send: (text: string, opts?: { attachmentIds?: string[] }) => Promise<void>
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
  queueId?: string | null
  text?: string
}

let _toolSeq = 0
let _queueSeq = 0

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const { uiMode } = useUiMode()
  const { setActiveProjectId } = useDesktop()

  const [visibility, setVisibility] = useState<AgentVisibility>('hidden')
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [active, setActive] = useState<AgentConversation | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
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
      const convId = msg.conversationId
      if (!convId) return
      // NO active-conversation filter for live state: background turns keep
      // accumulating in their own slice so a switch-back shows the full stream.
      // Only the `messages` list (the active thread) is gated on isActive.
      const isActive = convId === activeIdRef.current
      if (msg.type === 'agent_stream') {
        patchLive(convId, (p) => ({ ...p, isStreaming: true, streamingText: p.streamingText + (msg.delta ?? '') }))
      } else if (msg.type === 'agent_tool') {
        patchLive(convId, (p) => ({ ...p, isStreaming: true, liveTools: [...p.liveTools, { id: `t${_toolSeq++}`, tool: msg.tool ?? 'tool' }] }))
      } else if (msg.type === 'agent_done') {
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
          return { ...p, queued: [...p.queued, { queueId: msg.queueId ?? `srv-${_queueSeq++}`, text: msg.text ?? '' }] }
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
            { id: `local-u-${Date.now()}`, conversation_id: convId, role: 'user', content: msg.text!, created_at: new Date().toISOString() },
          ])
        }
      } else if (msg.type === 'agent_queue_cleared') {
        patchLive(convId, (p) => ({ ...p, queued: [] }))
      } else if (msg.type === 'agent_queue_edited') {
        // A queued chip was edited in place (this window or another) — update
        // its text; the editing window's optimistic update makes this a no-op.
        patchLive(convId, (p) => ({
          ...p,
          queued: p.queued.map((q) => (msg.queueId && q.queueId === msg.queueId ? { ...q, text: msg.text ?? q.text } : q)),
        }))
      } else if (msg.type === 'agent_pr_decision') {
        // PR-decision card (safe-pr-review-flow): the WS message carries the
        // persisted envelope's fields top-level. Only the ACTIVE thread's
        // `messages` slice is held in state — upsert its card in place (match
        // by prDeliveryId) or append it for a live arrival without reload.
        // Background conversations need nothing: the server updates the SAME
        // persisted system row, so rehydrate-on-select shows the current state.
        if (isActive) {
          const envelope = coercePrDecisionEnvelope(raw)
          if (envelope) {
            const content = JSON.stringify(envelope)
            setMessages((m) => {
              const idx = m.findIndex(
                (x) => x.role === 'system' && parsePrDecisionEnvelope(x.content)?.prDeliveryId === envelope.prDeliveryId,
              )
              if (idx >= 0) {
                if (m[idx].content === content) return m
                const copy = [...m]
                copy[idx] = { ...copy[idx], content }
                return copy
              }
              return [
                ...m,
                { id: `prd-${envelope.prDeliveryId}`, conversation_id: convId, role: 'system', content, created_at: new Date().toISOString() },
              ]
            })
          }
        }
      }
    }
    registerHandler('agent-chat', handler)
    return () => unregisterHandler('agent-chat')
  }, [registerHandler, unregisterHandler, patchLive])

  const loadConversation = useCallback(async (id: string) => {
    const { conversation, messages: msgs } = await getAgentConversation(id)
    setActive(conversation)
    setMessages(msgs)
    // Live state (stream text / tools / queue) is per-conversation and is
    // deliberately NOT reset here — a background turn keeps its full context
    // and re-appears mid-stream when the user switches back.
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
    const queueId = `q-${Date.now()}-${_queueSeq++}`
    const userBubble = {
      id: `local-u-${Date.now()}`,
      conversation_id: conv.id,
      role: 'user' as const,
      content: trimmed,
      attachment_ids: opts?.attachmentIds ?? [],
      created_at: new Date().toISOString(),
    }
    // Busy conversation → the message QUEUES (server-side FIFO) and shows as a
    // parked chip below the streaming bubble instead of a normal bubble.
    const wasBusy = liveRef.current.get(conv.id)?.isStreaming === true
    if (wasBusy) {
      patchLive(conv.id, (p) => ({ ...p, queued: [...p.queued, { queueId, text: trimmed }] }))
    } else {
      setMessages((m) => [...m, userBubble])
      patchLive(conv.id, (p) => ({ ...p, isStreaming: true, streamingText: '', liveTools: [] }))
    }
    const attachments = opts?.attachmentIds && opts.attachmentIds.length ? { ids: opts.attachmentIds } : undefined
    try {
      const res = await sendAgentMessage(conv.id, trimmed, { tierLevel: conv.tier_level, attachments, queueId })
      const queued = res?.queued === true
      if (queued && !wasBusy) {
        // Rare race: the server was actually mid-turn — re-home the optimistic
        // bubble as a queued chip (the agent_queued event dedupes by queueId).
        // If its agent_dequeued ALREADY ran while this POST was in flight, the
        // chip is consumed — re-adding it would park a phantom chip forever.
        setMessages((m) => m.filter((x) => x.id !== userBubble.id))
        if (!consumedQueueIdsRef.current.has(queueId)) {
          patchLive(conv.id, (p) =>
            p.queued.some((q) => q.queueId === queueId) ? p : { ...p, queued: [...p.queued, { queueId, text: trimmed }] },
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
  }, [active, patchLive])

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
        queued: p.queued.map((q) => (q.queueId === queueId ? { ...q, text } : q)),
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
    patchLive(id, () => null)
    if (activeIdRef.current === id) {
      setActive(null)
      setMessages([])
    }
  }, [patchLive])

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
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, editQueuedMessage, wasQueueConsumed,
    cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, startNewConversation, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    selectConversation, deleteConversation, refreshConversations,
  }), [
    visibility, open, close, minimize, toggle,
    conversations, active, messages, streamingText, isStreaming, liveTools,
    queuedMessages, streamingConversationIds, liveByConv,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, editQueuedMessage, wasQueueConsumed,
    cycleTier, setTier, setProvider, setModel, setPinnedProject,
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
  queuedMessages: [], streamingConversationIds: new Set<string>(),
  liveByConversation: new Map<string, AgentConvLive>(),
  mcpEnabled: true, enablingMcp: false, enableMcpServer: async () => {}, providersReady: true,
  send: async () => {}, abort: async () => {},
  editQueuedMessage: async () => 'conflict', wasQueueConsumed: () => false,
  cycleTier: async () => {}, setTier: async () => {},
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
