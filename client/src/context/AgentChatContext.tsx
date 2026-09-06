import { useMissionWindows } from './MissionWindowsContext'
import { isMissionWindowRoute } from '../lib/mission-windows'
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
  steerQueuedAgentMessage,
  removeQueuedAgentMessage,
  getMcpStatus,
  enableMcp,
  getAvailableProviders,
  getAgentActiveTurns,
  coercePrDecisionEnvelope,
  parsePrDecisionEnvelope,
  type AgentConversation,
  type AgentContextReference,
  type AgentMessage,
  type AgentDeliveryReceipt,
  type AgentPendingMessage,
  type AgentPrDecisionEnvelope,
  type AgentTierLevel,
} from '../lib/agent-api'
import { AgentChatPanel } from '../components/agent-chat/AgentChatPanel'
import { AgentBubble } from '../components/agent-chat/AgentBubble'
import { useBuilderSession, type BuilderSession } from '../hooks/useBuilderSession'
import { useUiMode } from './UiModeContext'
import { useDesktop } from '../hooks/useDesktop'
import { comparePrSnapshotUpdatedAt } from '../lib/pr-delivery'
import { migrateNewMissionComposerDrafts } from '../lib/agent-composer-drafts'

export type AgentVisibility = 'hidden' | 'open' | 'minimized'
export type PrDecisionSnapshotApplication = 'accepted' | 'stale' | 'untracked'

export interface AgentLiveTool {
  id: string
  tool: string
  /** Bounded JSON preview of the tool input (server `agent_tool.input`). */
  input?: string
  /** Bounded output preview merged in from `agent_tool_result` (claude-only). */
  output?: string
  isError?: boolean
  /** Provider tool-call id — correlates the result event to this entry. */
  toolId?: string
  /** ISO timestamp of the tool invocation (server clock). */
  at?: string
}

/** Hard cap on retained activity entries per turn — the modal is a preview
 *  surface, not an archive; unbounded pushes would leak on very long turns. */
const MAX_ACTIVITY_ENTRIES = 200

/** Input awaiting native delivery, a safe tool checkpoint or a resumed turn. */
export interface AgentQueuedItem extends AgentPendingMessage {}

/** Live turn state for ONE conversation. Kept per-conversation so background
 *  agents keep streaming while the user reads another thread. */
export interface AgentConvLive {
  streamingText: string
  isStreaming: boolean
  liveTools: AgentLiveTool[]
  /** The last SETTLED turn's tool activity — kept past agent_done so the
   *  activity-log modal still has content between turns. Session-only. */
  turnTools: AgentLiveTool[]
  queued: AgentQueuedItem[]
}

const EMPTY_LIVE: AgentConvLive = { streamingText: '', isStreaming: false, liveTools: [], turnTools: [], queued: [] }
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

// Sticky agent-autonomy tier (Observe/Edit/Operate/Autonomous): the last
// explicitly selected level survives across missions and app restarts.
const LAST_TIER_KEY = 'specrails-desktop:agent-tier-last'

function readLastTierLevel(): AgentTierLevel {
  try {
    const raw = localStorage.getItem(LAST_TIER_KEY)
    const n = raw === null ? 0 : Number.parseInt(raw, 10)
    return (n === 0 || n === 1 || n === 2 || n === 3 ? n : 0) as AgentTierLevel
  } catch {
    return 0
  }
}

function saveLastTierLevel(level: AgentTierLevel): void {
  try { localStorage.setItem(LAST_TIER_KEY, String(level)) } catch { /* ignore */ }
}

const TERMINAL_PR_CARD_DECISIONS = new Set(['completed', 'merged', 'discarded', 'superseded'])

function envelopesMatch(a: AgentPrDecisionEnvelope, b: AgentPrDecisionEnvelope): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function createdAtMs(envelope: AgentPrDecisionEnvelope): number | null {
  if (!envelope.createdAt) return null
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(envelope.createdAt)
    ? `${envelope.createdAt.replace(' ', 'T')}Z`
    : envelope.createdAt
  const parsed = Date.parse(sqliteUtc)
  return Number.isFinite(parsed) ? parsed : null
}

function incomingGenerationOrder(
  existing: AgentPrDecisionEnvelope,
  incoming: AgentPrDecisionEnvelope,
): -1 | 0 | 1 | null {
  if (incoming.supersedesDeliveryId === existing.prDeliveryId) return 1
  if (existing.supersedesDeliveryId === incoming.prDeliveryId) return -1
  const existingMs = createdAtMs(existing)
  const incomingMs = createdAtMs(incoming)
  if (existingMs == null || incomingMs == null) return null
  if (incomingMs < existingMs) return -1
  if (incomingMs > existingMs) return 1
  return 0
}

function latestDirectSuperseder(
  envelopes: readonly AgentPrDecisionEnvelope[],
  predecessorId: string,
): AgentPrDecisionEnvelope | null {
  let latest: AgentPrDecisionEnvelope | null = null
  for (const candidate of envelopes) {
    if (candidate.supersedesDeliveryId !== predecessorId) continue
    if (!latest) {
      latest = candidate
      continue
    }
    const latestCreated = createdAtMs(latest)
    const candidateCreated = createdAtMs(candidate)
    if (
      latestCreated == null || candidateCreated == null ||
      candidateCreated >= latestCreated
    ) latest = candidate
  }
  return latest
}

function isExplicitPrRestoration(
  envelopes: readonly AgentPrDecisionEnvelope[],
  incoming: AgentPrDecisionEnvelope,
): boolean {
  const sourceId = incoming.restoredFromDeliveryId
  if (!sourceId) return false
  const latestSuperseder = latestDirectSuperseder(envelopes, incoming.prDeliveryId)
  // The durable marker is sufficient when this conversation never contained
  // B. If lineage is present, however, it must name that exact latest B; this
  // prevents a delayed restore-from-B replay after newer generation C exists.
  return !latestSuperseder || latestSuperseder.prDeliveryId === sourceId
}

function isStalePrDecisionEnvelope(
  messages: readonly AgentMessage[],
  incoming: AgentPrDecisionEnvelope,
): boolean {
  const envelopes = messages
    .filter((message) => message.role === 'system')
    .map((message) => parsePrDecisionEnvelope(message.content))
    .filter((envelope): envelope is AgentPrDecisionEnvelope => envelope !== null)
  const existing = [...envelopes].reverse().find(
    (envelope) => envelope.prDeliveryId === incoming.prDeliveryId,
  )
  const explicitRestoration = isExplicitPrRestoration(envelopes, incoming)
  if (existing) {
    const existingTerminal = TERMINAL_PR_CARD_DECISIONS.has(existing.decision)
    const incomingTerminal = TERMINAL_PR_CARD_DECISIONS.has(incoming.decision)
    const order = comparePrSnapshotUpdatedAt(existing.updatedAt, incoming.updatedAt)
    if (order === -1) return true
    // Durable timestamps have one-second precision. Keep the accepted state
    // on every conflicting tie; visual state is not causal ordering evidence.
    if (order === 0 && !envelopesMatch(existing, incoming)) return true
    // A rollback marker may consume the superseded tombstone once. It cannot
    // reopen A after that restored generation has itself reached another
    // terminal state, even if a delayed payload repeats the same A <- B proof.
    if (
      existingTerminal && !incomingTerminal &&
      !(explicitRestoration && existing.decision === 'superseded')
    ) return true
  }
  const supersededIds = new Set(
    envelopes.map((envelope) => envelope.supersedesDeliveryId).filter((id): id is string => Boolean(id)),
  )
  if (explicitRestoration) return false
  if (supersededIds.has(incoming.prDeliveryId) && incoming.decision !== 'superseded') return true

  // Only one actionable delivery generation may exist per rail. Modern rows
  // carry explicit lineage; `createdAt` is the durable fallback for recovered
  // rows. With neither signal, keep an already-actionable generation instead
  // of allowing two contradictory action sets to coexist.
  for (const candidate of envelopes) {
    if (
      candidate.railIndex !== incoming.railIndex ||
      candidate.prDeliveryId === incoming.prDeliveryId ||
      supersededIds.has(candidate.prDeliveryId)
    ) continue
    const order = incomingGenerationOrder(candidate, incoming)
    if (order === -1) return true
    if (
      (order === 0 || order === null) &&
      !TERMINAL_PR_CARD_DECISIONS.has(candidate.decision) &&
      incoming.supersedesDeliveryId !== candidate.prDeliveryId
    ) return true
  }
  return false
}

function projectRestorationSource(
  messages: AgentMessage[],
  incoming: AgentPrDecisionEnvelope,
): AgentMessage[] {
  const sourceId = incoming.restoredFromDeliveryId
  if (!sourceId) return messages
  let changed = false
  const projected = messages.map((message) => {
    if (message.role !== 'system') return message
    const envelope = parsePrDecisionEnvelope(message.content)
    if (
      !envelope || envelope.prDeliveryId !== sourceId ||
      TERMINAL_PR_CARD_DECISIONS.has(envelope.decision)
    ) return message
    changed = true
    return { ...message, content: JSON.stringify({ ...envelope, decision: 'discarded' as const }) }
  })
  return changed ? projected : messages
}

function projectOlderRailGenerations(
  messages: AgentMessage[],
  incoming: AgentPrDecisionEnvelope,
): AgentMessage[] {
  const envelopes = messages
    .filter((message) => message.role === 'system')
    .map((message) => parsePrDecisionEnvelope(message.content))
    .filter((envelope): envelope is AgentPrDecisionEnvelope => envelope !== null)
  const rolledBackByRestoredPredecessor = envelopes.some((envelope) => (
    envelope.restoredFromDeliveryId === incoming.prDeliveryId &&
    isExplicitPrRestoration(envelopes, envelope)
  ))
  if (rolledBackByRestoredPredecessor) return messages

  let changed = false
  const projected = messages.map((message) => {
    if (message.role !== 'system') return message
    const envelope = parsePrDecisionEnvelope(message.content)
    if (
      !envelope ||
      envelope.railIndex !== incoming.railIndex ||
      envelope.prDeliveryId === incoming.prDeliveryId ||
      TERMINAL_PR_CARD_DECISIONS.has(envelope.decision) ||
      incomingGenerationOrder(envelope, incoming) !== 1
    ) return message
    changed = true
    return { ...message, content: JSON.stringify({ ...envelope, decision: 'superseded' as const }) }
  })
  return changed ? projected : messages
}

function upsertPrDecisionMessage(
  messages: AgentMessage[],
  conversationId: string,
  envelope: AgentPrDecisionEnvelope,
): AgentMessage[] {
  if (isStalePrDecisionEnvelope(messages, envelope)) return messages
  const restored = projectRestorationSource(messages, envelope)
  const base = projectOlderRailGenerations(restored, envelope)
  const content = JSON.stringify(envelope)
  const matching = base.flatMap((message, index) => (
    message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId
      ? [index]
      : []
  ))
  if (matching.length > 0) {
    const canonicalIndex = matching[matching.length - 1]
    if (matching.length === 1 && base[canonicalIndex].content === content) return base
    const duplicateIndexes = new Set(matching.slice(0, -1))
    return base.flatMap((message, index) => {
      if (duplicateIndexes.has(index)) return []
      return [index === canonicalIndex ? { ...message, content } : message]
    })
  }
  return [
    ...base,
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
  /** The active thread's last SETTLED turn activity (session-only) — what the
   *  activity-log modal shows between turns. */
  turnTools: AgentLiveTool[]
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

  send: (text: string, opts?: { attachmentIds?: string[]; contextRefs?: AgentContextReference[]; queueId?: string }) => Promise<{ accepted: boolean; conversationId?: string }>
  abort: () => Promise<void>
  /** Edit a still-queued message in place (composer ↑/↓ queue navigation).
   *  `'conflict'` = already dispatched — the caller keeps the text as a draft. */
  editQueuedMessage: (queueId: string, text: string) => Promise<'saved' | 'conflict'>
  steerQueuedMessage: (queueId: string) => Promise<'saved' | 'conflict'>
  removeQueuedMessage: (queueId: string) => Promise<'saved' | 'conflict'>
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
  selectConversation: (id: string, options?: { windowRestore?: boolean; signal?: AbortSignal }) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  /** Rename a conversation (optimistic; blank clears to auto-title). */
  renameConversation: (id: string, title: string) => Promise<void>
  /** Toggle the sidebar Favorite missions membership without changing project pinning. */
  toggleFavoriteConversation: (id: string) => void
  /** Refresh the conversation list WITHOUT opening the floating panel. Used on
   *  entering Agent Mode (open() would mount the now-suppressed panel). */
  refreshConversations: () => Promise<void>
  /** Apply the authoritative snapshot returned by a card action immediately;
   *  the persisted message/WS update later becomes an idempotent no-op.
   *  Standalone cards receive `untracked` so they can still use a local
   *  authoritative override; `stale` means a newer generation already won. */
  applyPrDecisionSnapshot: (envelope: AgentPrDecisionEnvelope) => PrDecisionSnapshotApplication

  /** Project Builder mode (reskin-project-builder-into-agent-panel): the agent
   *  surfaces transform into the day-0 Builder while `active`. `enter` also
   *  opens the floating panel outside Agent Mode; `exit` aborts + resets the
   *  builder session and restores the agent chrome. */
  builderMode: {
    active: boolean
    enter: () => void
    exit: () => void
    session: BuilderSession
  }
}

const AgentChatContext = createContext<AgentChatContextValue | null>(null)

interface WsAgentMsg {
  type: string
  conversationId?: string
  delta?: string
  fullText?: string
  error?: string
  tool?: string
  input?: string
  toolId?: string
  output?: string
  isError?: boolean
  timestamp?: string
  queueId?: string | null
  text?: string
  contextRefs?: AgentContextReference[]
  attachmentIds?: string[]
  deliveryMode?: 'queue' | 'steer'
  deliveryStatus?: 'delivered' | 'interrupted'
  delivery_receipt?: AgentDeliveryReceipt
  deliveryReceipt?: AgentDeliveryReceipt
  receipt?: 'received' | 'read'
  messageId?: string
  assistantSegment?: { id: string; content: string; created_at: string }
  messages?: AgentMessage[]
}

let _toolSeq = 0
let _queueSeq = 0

const receiptRank = { sent: 0, received: 1, read: 2 }
function latestReceipt(a?: AgentDeliveryReceipt, b?: AgentDeliveryReceipt): AgentDeliveryReceipt | undefined {
  return !a ? b : !b || receiptRank[a] >= receiptRank[b] ? a : b
}

function mergeTranscriptRows(current: AgentMessage[], incoming: AgentMessage[]): AgentMessage[] {
  const rows = [...current]
  for (const [incomingIndex, message] of incoming.entries()) {
    const index = rows.findIndex((row) => row.id === message.id)
    if (index >= 0) {
      const receipt = latestReceipt(rows[index].delivery_receipt, message.delivery_receipt)
      rows[index] = { ...message, ...(receipt ? { delivery_receipt: receipt } : {}) }
    }
    else {
      // HTTP can acknowledge a user row before WS delivers the preceding
      // assistant segment. Insert that segment before its already-known user.
      const nextIds = new Set(incoming.slice(incomingIndex + 1).map((row) => row.id))
      const nextIndex = rows.findIndex((row) => nextIds.has(row.id))
      if (nextIndex >= 0) rows.splice(nextIndex, 0, message)
      else rows.push(message)
    }
  }
  return rows
}

export function AgentChatProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const { uiMode } = useUiMode()
  const { setActiveProjectId, activeProjectId } = useDesktop()
  const missionWindows = useMissionWindows()
  const windowsRef = useRef(missionWindows)
  windowsRef.current = missionWindows
  const secondaryWindow = isMissionWindowRoute()
  const editable = (id?: string | null) => id ? windowsRef.current.isEditable(id) : !secondaryWindow

  const [visibility, setVisibility] = useState<AgentVisibility>('hidden')
  const [conversations, setConversations] = useState<AgentConversation[]>([])
  const [active, setActive] = useState<AgentConversation | null>(null)
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const metadataVersion = useRef(new Map<string, number>())
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const [favoriteConversationIds, setFavoriteConversationIds] = useState<ReadonlySet<string>>(loadFavoriteConversationIds)
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === FAVORITE_CONVERSATIONS_KEY || event.key === null) setFavoriteConversationIds(loadFavoriteConversationIds())
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])
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
  // The tier ladder is sticky ACROSS missions: the last explicitly selected
  // level is persisted and seeds every new mission (draft + created rows).
  const [draftTierLevel, setDraftTierLevel] = useState<AgentTierLevel>(() => readLastTierLevel())
  // null = no provider-specific effort override.
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
  const removedQueueIdsRef = useRef(new Set<string>())
  const inputReceiptsRef = useRef(new Map<string, AgentDeliveryReceipt>())
  const inputMessageIdsRef = useRef(new Map<string, string>())
  const withReceipt = (row: AgentMessage): AgentMessage => {
    const receipt = latestReceipt(row.delivery_receipt, inputReceiptsRef.current.get(`${row.conversation_id}:m:${row.id}`))
    return receipt ? { ...row, delivery_receipt: receipt } : row
  }
  const withPendingReceipt = (conversationId: string, item: AgentQueuedItem): AgentQueuedItem => {
    const receipt = latestReceipt(item.deliveryReceipt, inputReceiptsRef.current.get(`${conversationId}:q:${item.queueId}`))
    return receipt ? { ...item, deliveryReceipt: receipt } : item
  }
  const deliveredMessageIdsRef = useRef(new Set<string>())
  const conversationEventVersionRef = useRef(new Map<string, number>())
  const queueClearVersionRef = useRef(new Map<string, number>())
  const transcriptEventsRef = useRef(new Map<string, AgentMessage[]>())
  const draftMaterializeRef = useRef<Promise<AgentConversation> | null>(null)
  const prSnapshotVersionRef = useRef(0)
  const conversationLoadEpochRef = useRef(0)
  const localTurnStartedAtRef = useRef(new Map<string, string>())

  const applyPrDecisionSnapshot = useCallback((
    envelope: AgentPrDecisionEnvelope,
  ): PrDecisionSnapshotApplication => {
    const conversationId = activeIdRef.current
    if (!conversationId) return 'untracked'
    if (isStalePrDecisionEnvelope(messagesRef.current, envelope)) return 'stale'
    const belongsToActiveThread = messagesRef.current.some(
      (message) => message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId,
    )
    if (!belongsToActiveThread) return 'untracked'
    // Advance before scheduling React state so an already-resolving focus GET
    // cannot enqueue a stale overwrite in the same batch.
    prSnapshotVersionRef.current++
    const projected = upsertPrDecisionMessage(messagesRef.current, conversationId, envelope)
    messagesRef.current = projected
    setMessages((current) => {
      // An action can resolve after the user switches conversations. HTTP card
      // snapshots are update-only: the delivery must still exist in the active
      // thread, otherwise appending would leak conversation A's card into B.
      const stillBelongsToActiveThread = current.some(
        (message) => message.role === 'system' && parsePrDecisionEnvelope(message.content)?.prDeliveryId === envelope.prDeliveryId,
      )
      if (!stillBelongsToActiveThread) {
        messagesRef.current = current
        return current
      }
      const next = upsertPrDecisionMessage(current, conversationId, envelope)
      messagesRef.current = next
      return next
    })
    return 'accepted'
  }, [])

  /** Update one conversation's live slice; a fully-idle slice drops its entry. */
  const patchLive = useCallback((id: string, fn: (prev: AgentConvLive) => AgentConvLive | null) => {
    setLiveByConv((m) => {
      const next = fn(m.get(id) ?? EMPTY_LIVE)
      const copy = new Map(m)
      if (
        next === null ||
        (!next.isStreaming && !next.streamingText && next.liveTools.length === 0
          && next.turnTools.length === 0 && next.queued.length === 0)
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
  const turnTools = activeLive.turnTools
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
        const next = pruneFavoriteConversationIds(loadFavoriteConversationIds(), list)
        if (next.size === prev.size && [...next].every(id => prev.has(id))) return prev
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

  const [projectRecoveryRevision, setProjectRecoveryRevision] = useState(0)

  // ── WebSocket: app-global agent_* events (no projectId filter) ──────────────
  useEffect(() => {
    if (!FEATURE_AGENT_CHAT) return
    const handler = (raw: unknown): void => {
      const msg = raw as WsAgentMsg
      if (!msg) return
      if (msg.type === 'desktop.project_recovered') {
        setProjectRecoveryRevision((revision) => revision + 1)
        return
      }
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
      conversationEventVersionRef.current.set(convId, (conversationEventVersionRef.current.get(convId) ?? 0) + 1)
      // NO active-conversation filter for live state: background turns keep
      // accumulating in their own slice so a switch-back shows the full stream.
      // Only the `messages` list (the active thread) is gated on isActive.
      const isActive = convId === activeIdRef.current
      const appendTranscript = (rows: AgentMessage[]) => {
        transcriptEventsRef.current.set(convId, mergeTranscriptRows(transcriptEventsRef.current.get(convId) ?? [], rows).slice(-500))
        if (isActive) {
          messagesRef.current = mergeTranscriptRows(messagesRef.current, rows)
          setMessages((current) => mergeTranscriptRows(current, rows))
        }
      }
      if (msg.type === 'agent_input_receipt') {
        if (msg.receipt !== 'received' && msg.receipt !== 'read') return
        const queueKey = `${convId}:q:${msg.queueId}`
        const messageId = msg.messageId ?? inputMessageIdsRef.current.get(queueKey)
        if (msg.queueId) inputReceiptsRef.current.set(queueKey, latestReceipt(inputReceiptsRef.current.get(queueKey), msg.receipt)!)
        if (messageId) {
          const key = `${convId}:m:${messageId}`
          inputReceiptsRef.current.set(key, latestReceipt(inputReceiptsRef.current.get(key), msg.receipt)!)
          const rows = isActive ? messagesRef.current : transcriptEventsRef.current.get(convId) ?? []
          const existing = rows.find((row) => row.id === messageId)
          if (existing) appendTranscript([withReceipt(existing)])
        }
        patchLive(convId, (previous) => ({ ...previous, queued: previous.queued.map((item) => item.queueId === msg.queueId
          ? { ...item, deliveryReceipt: latestReceipt(item.deliveryReceipt, msg.receipt) } : item) }))
      } else if (msg.type === 'agent_stream') {
        markUnread(convId)
        patchLive(convId, (p) => ({ ...p, isStreaming: true, streamingText: p.streamingText + (msg.delta ?? '') }))
      } else if (msg.type === 'agent_tool') {
        patchLive(convId, (p) => ({
          ...p,
          isStreaming: true,
          liveTools: [
            ...p.liveTools,
            {
              id: `t${_toolSeq++}`,
              tool: msg.tool ?? 'tool',
              ...(msg.input ? { input: msg.input } : {}),
              ...(msg.toolId ? { toolId: msg.toolId } : {}),
              ...(msg.timestamp ? { at: msg.timestamp } : {}),
            },
          ].slice(-MAX_ACTIVITY_ENTRIES),
        }))
      } else if (msg.type === 'agent_tool_result') {
        // Merge the output into its originating entry: by toolId when the
        // provider correlates, else onto the LAST entry still missing output.
        patchLive(convId, (p) => {
          const tools = [...p.liveTools]
          let idx = msg.toolId ? tools.findIndex((t) => t.toolId === msg.toolId) : -1
          if (idx === -1) {
            for (let i = tools.length - 1; i >= 0; i--) {
              if (tools[i].output === undefined) { idx = i; break }
            }
          }
          if (idx === -1) return p
          tools[idx] = {
            ...tools[idx],
            output: msg.output ?? '',
            ...(msg.isError ? { isError: true } : {}),
          }
          return { ...p, liveTools: tools }
        })
      } else if (msg.type === 'agent_partial') {
        const partial = msg.fullText ?? ''
        if (partial) {
          appendTranscript([{ id: msg.messageId ?? `partial-${convId}-${msg.timestamp ?? Date.now()}`, conversation_id: convId, role: 'assistant', content: partial, created_at: msg.timestamp ?? new Date().toISOString() }])
        }
      } else if (msg.type === 'agent_done') {
        localTurnStartedAtRef.current.delete(convId)
        markUnread(convId)
        const full = msg.fullText ?? ''
        if (msg.messageId && full) {
          appendTranscript([{ id: msg.messageId, conversation_id: convId, role: 'assistant', content: full, created_at: msg.timestamp ?? new Date().toISOString() }])
        } else if (isActive && full) {
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
        // about to start (agent_dequeued follows). The finished turn's tool
        // activity survives as `turnTools` so the log modal outlives settle.
        patchLive(convId, (p) => ({
          ...EMPTY_LIVE,
          queued: p.queued,
          turnTools: p.liveTools.length ? p.liveTools : p.turnTools,
        }))
      } else if (msg.type === 'agent_error') {
        localTurnStartedAtRef.current.delete(convId)
        markUnread(convId)
        patchLive(convId, (p) => ({
          ...EMPTY_LIVE,
          queued: p.queued,
          turnTools: p.liveTools.length ? p.liveTools : p.turnTools,
        }))
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
        if (msg.queueId && consumedQueueIdsRef.current.has(msg.queueId)) return
        patchLive(convId, (p) => {
          const receipt = latestReceipt(msg.deliveryReceipt ?? msg.delivery_receipt, inputReceiptsRef.current.get(`${convId}:q:${msg.queueId}`))
          const item = { queueId: msg.queueId ?? `srv-${_queueSeq++}`, text: msg.text ?? '', contextRefs: msg.contextRefs, attachmentIds: msg.attachmentIds, deliveryMode: msg.deliveryMode, ...(receipt ? { deliveryReceipt: receipt } : {}), timestamp: msg.timestamp }
          if (msg.queueId && p.queued.some((q) => q.queueId === msg.queueId)) {
            return { ...p, queued: p.queued.map((q) => q.queueId === msg.queueId ? { ...q, ...item, deliveryReceipt: latestReceipt(q.deliveryReceipt, item.deliveryReceipt), deliveryMode: q.deliveryMode === 'steer' ? 'steer' : item.deliveryMode ?? q.deliveryMode, attachmentIds: item.attachmentIds ?? q.attachmentIds, contextRefs: item.contextRefs ?? q.contextRefs } : q) }
          }
          return {
            ...p,
            queued: [...p.queued, item],
          }
        })
      } else if (msg.type === 'agent_steered') {
        if (!msg.messageId) return
        if (deliveredMessageIdsRef.current.has(msg.messageId)) {
          if (msg.queueId) consumedQueueIdsRef.current.add(msg.queueId)
          patchLive(convId, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== msg.queueId) }))
          return
        }
        deliveredMessageIdsRef.current.add(msg.messageId)
        if (msg.queueId) consumedQueueIdsRef.current.add(msg.queueId)
        inputMessageIdsRef.current.set(`${convId}:q:${msg.queueId}`, msg.messageId)
        const receipt = latestReceipt(msg.delivery_receipt ?? msg.deliveryReceipt, inputReceiptsRef.current.get(`${convId}:q:${msg.queueId}`))
        const rows: AgentMessage[] = []
        if (msg.assistantSegment) rows.push({ ...msg.assistantSegment, conversation_id: convId, role: 'assistant' })
        rows.push(withReceipt({ id: msg.messageId, conversation_id: convId, role: 'user', content: msg.text ?? '', context_refs: msg.contextRefs ?? [], attachment_ids: msg.attachmentIds ?? [], delivery_status: msg.deliveryStatus ?? 'delivered', ...(receipt ? { delivery_receipt: receipt } : {}), created_at: msg.timestamp ?? new Date().toISOString() }))
        appendTranscript(rows)
        // Settling input delivery (including an unconfirmed native write) does
        // not end the turn. Only the persisted assistant segment resets.
        patchLive(convId, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== msg.queueId), streamingText: msg.assistantSegment ? '' : p.streamingText }))
      } else if (msg.type === 'agent_dequeued') {
        // The queued message's turn starts now: chip → real user bubble.
        if (msg.queueId && consumedQueueIdsRef.current.has(msg.queueId)) return
        if (msg.queueId) consumedQueueIdsRef.current.add(msg.queueId)
        patchLive(convId, (p) => {
          return { ...p, queued: msg.queueId ? p.queued.filter((q) => q.queueId !== msg.queueId) : p.queued.slice(1), isStreaming: true, streamingText: '', liveTools: [] }
        })
        if (msg.text) {
          if (msg.messageId) inputMessageIdsRef.current.set(`${convId}:q:${msg.queueId}`, msg.messageId)
          const receipt = latestReceipt(msg.delivery_receipt ?? msg.deliveryReceipt, inputReceiptsRef.current.get(`${convId}:q:${msg.queueId}`))
          appendTranscript([
            withReceipt({
              id: msg.messageId ?? `local-u-${Date.now()}`,
              conversation_id: convId,
              role: 'user',
              content: msg.text!,
              context_refs: msg.contextRefs ?? [],
              attachment_ids: msg.attachmentIds ?? [],
              ...(msg.messageId ? { delivery_status: 'delivered' as const } : {}),
              ...(receipt ? { delivery_receipt: receipt } : {}),
              created_at: msg.timestamp ?? new Date().toISOString(),
            }),
          ])
        }
      } else if (msg.type === 'agent_queue_cleared') {
        queueClearVersionRef.current.set(convId, (queueClearVersionRef.current.get(convId) ?? 0) + 1)
        if (msg.messages?.length) appendTranscript(msg.messages)
        patchLive(convId, (p) => ({ ...p, queued: [] }))
      } else if (msg.type === 'agent_queue_removed') {
        if (!msg.queueId) return
        consumedQueueIdsRef.current.add(msg.queueId)
        removedQueueIdsRef.current.add(msg.queueId)
        patchLive(convId, (p) => ({ ...p, queued: p.queued.filter((item) => item.queueId !== msg.queueId) }))
      } else if (msg.type === 'agent_queue_edited') {
        // A queued chip was edited in place (this window or another) — update
        // its text; the editing window's optimistic update makes this a no-op.
        patchLive(convId, (p) => ({
          ...p,
          queued: p.queued.map((q) => (
            msg.queueId && q.queueId === msg.queueId
              ? { ...q, text: msg.text ?? q.text, contextRefs: msg.contextRefs ?? q.contextRefs, deliveryMode: msg.deliveryMode ?? q.deliveryMode }
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
            const projected = upsertPrDecisionMessage(messagesRef.current, convId, envelope)
            messagesRef.current = projected
            setMessages((current) => {
              const next = upsertPrDecisionMessage(current, convId, envelope)
              messagesRef.current = next
              return next
            })
          }
        }
      }
    }
    registerHandler('agent-chat', handler)
    return () => unregisterHandler('agent-chat')
  }, [registerHandler, unregisterHandler, patchLive, markUnread])

  const loadConversation = useCallback(async (id: string, signal?: AbortSignal) => {
    const epoch = ++conversationLoadEpochRef.current
    const eventVersion = conversationEventVersionRef.current.get(id) ?? 0
    // Invalidates a focus/reconnect card hydration for the previous view even
    // when navigation later returns to the same conversation (C1→C2→C1 ABA).
    prSnapshotVersionRef.current++
    const { conversation, messages: fetched, pendingMessages, live } = await getAgentConversation(id)
    if (signal?.aborted) throw new DOMException('Window transfer cancelled', 'AbortError')
    if (epoch !== conversationLoadEpochRef.current) {
      if (signal) throw new DOMException('The mission changed during restoration', 'AbortError')
      return
    }
    prSnapshotVersionRef.current++
    const msgs = mergeTranscriptRows(fetched, transcriptEventsRef.current.get(id) ?? []).map(withReceipt)
    for (const message of msgs) if (message.delivery_status === 'delivered' || message.delivery_status === 'interrupted') deliveredMessageIdsRef.current.add(message.id)
    setActive(conversation)
    messagesRef.current = msgs
    setMessages(msgs)
    clearUnread(id)
    if (eventVersion === (conversationEventVersionRef.current.get(id) ?? 0) && (pendingMessages !== undefined || live)) {
      patchLive(id, (previous) => ({
        ...previous,
        ...(live ? { isStreaming: live.isStreaming, streamingText: live.streamingText } : {}),
        queued: pendingMessages?.filter((item) => !consumedQueueIdsRef.current.has(item.queueId)).map((item) => withPendingReceipt(id, item)) ?? previous.queued,
      }))
    }
    // Old servers omit live snapshots; retain background state in that case.
    // Modern snapshots hydrate reloads without overwriting newer WS events.
  }, [clearUnread, patchLive])

  // Reconcile persisted cards and checkpoint deliveries after missed WS events.
  // Older servers still use the card-only convergence path.
  const hydrateActivePrCards = useCallback(async (): Promise<void> => {
    const conversationId = activeIdRef.current
    if (!conversationId) return
    const version = prSnapshotVersionRef.current
    const eventVersion = conversationEventVersionRef.current.get(conversationId) ?? 0
    const metaVersion = metadataVersion.current.get(conversationId) ?? 0
    try {
      const fresh = await getAgentConversation(conversationId)
      if (activeIdRef.current !== conversationId || prSnapshotVersionRef.current !== version) return
      if (metaVersion === (metadataVersion.current.get(conversationId) ?? 0)) {
        setActive(current => current?.id === conversationId ? fresh.conversation : current)
        setConversations(current => current.map(item => item.id === conversationId ? fresh.conversation : item))
      }
      // A current server snapshot also reconciles checkpoint deliveries and
      // pending inputs after missed WS events. Never overwrite a newer event.
      if ((fresh.pendingMessages !== undefined || fresh.live) && eventVersion === (conversationEventVersionRef.current.get(conversationId) ?? 0)) {
        const persisted = mergeTranscriptRows(fresh.messages, transcriptEventsRef.current.get(conversationId) ?? []).map(withReceipt)
        for (const message of persisted) if (message.delivery_status === 'delivered' || message.delivery_status === 'interrupted') deliveredMessageIdsRef.current.add(message.id)
        setMessages((current) => mergeTranscriptRows(persisted, current.filter((message) => message.id.startsWith('local-u-') && !persisted.some((row) => row.role === 'user' && row.content === message.content))))
        patchLive(conversationId, (previous) => ({
          ...previous,
          ...(fresh.live ? { isStreaming: fresh.live.isStreaming, streamingText: fresh.live.streamingText } : {}),
          queued: fresh.pendingMessages?.filter((item) => !consumedQueueIdsRef.current.has(item.queueId)).map((item) => withPendingReceipt(conversationId, item)) ?? previous.queued,
        }))
      }
      const envelopes = fresh.messages
        .filter((message) => message.role === 'system')
        .map((message) => parsePrDecisionEnvelope(message.content))
        .filter((envelope): envelope is AgentPrDecisionEnvelope => envelope !== null)
      if (envelopes.length === 0) return
      setMessages((current) => {
        const next = envelopes.reduce(
          (projected, envelope) => upsertPrDecisionMessage(projected, conversationId, envelope),
          current,
        )
        messagesRef.current = next
        return next
      })
    } catch {
      /* Advisory convergence path; the next focus/reconnect can retry. */
    }
  }, [patchLive])

  const reconcileActiveTurns = useCallback(async (): Promise<void> => {
    try {
      const eventVersions = new Map(conversationEventVersionRef.current)
      const snapshot = await getAgentActiveTurns()
      const activeIds = new Set(snapshot.turns.map((turn) => turn.conversationId))
      const capturedAt = Date.parse(snapshot.capturedAt)
      // React may defer or repeat a state updater. Derive side effects before
      // queuing it, otherwise the interruption notice depends on eager render.
      const interrupted = [...liveRef.current].flatMap(([conversationId, live]) => {
        if (!live.isStreaming || activeIds.has(conversationId)) return []
        if ((eventVersions.get(conversationId) ?? 0) !== (conversationEventVersionRef.current.get(conversationId) ?? 0)) return []
        const startedAt = localTurnStartedAtRef.current.get(conversationId)
        if (startedAt && Date.parse(startedAt) > capturedAt) return []
        return [conversationId]
      })
      setLiveByConv((current) => {
        const next = new Map(current)
        for (const [conversationId, live] of current) {
          if (!live.isStreaming || activeIds.has(conversationId)) continue
          if ((eventVersions.get(conversationId) ?? 0) !== (conversationEventVersionRef.current.get(conversationId) ?? 0)) continue
          const localStartedAt = localTurnStartedAtRef.current.get(conversationId)
          if (localStartedAt && Date.parse(localStartedAt) > capturedAt) continue
          next.set(conversationId, { ...EMPTY_LIVE, queued: live.queued, turnTools: live.liveTools.length ? live.liveTools : live.turnTools })
        }
        for (const turn of snapshot.turns) {
          const conversationId = turn.conversationId
          if ((eventVersions.get(conversationId) ?? 0) !== (conversationEventVersionRef.current.get(conversationId) ?? 0)) continue
          const live = next.get(conversationId) ?? EMPTY_LIVE
          next.set(conversationId, { ...live, isStreaming: true,
            streamingText: turn.streamingText ?? live.streamingText,
            queued: turn.pendingMessages?.filter((item) => !consumedQueueIdsRef.current.has(item.queueId)).map((item) => withPendingReceipt(conversationId, item)) ?? live.queued,
          })
        }
        return next
      })
      for (const conversationId of interrupted) localTurnStartedAtRef.current.delete(conversationId)
      const activeId = activeIdRef.current
      if (activeId && interrupted.includes(activeId)) {
        const id = `interrupted-${activeId}-${snapshot.snapshotVersion}`
        setMessages((current) => current.some((message) => message.id === id) ? current : [
          ...current,
          { id, conversation_id: activeId, role: 'assistant', content: '⚠️ The agent turn was interrupted when the Specrails server reconnected. It was not retried.', created_at: snapshot.capturedAt },
        ])
      }
      console.info('[agent-chat] reconciled active turns', { snapshotVersion: snapshot.snapshotVersion, active: activeIds.size, interrupted: interrupted.length })
    } catch {
      /* The connection may still be stabilising; a later reconnect can retry. */
    }
  }, [])

  useEffect(() => {
    const onFocus = () => { void refreshConversations(); void hydrateActivePrCards() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [hydrateActivePrCards, refreshConversations])

  useEffect(() => {
    if (!projectRecoveryRevision) return
    void refreshConversations()
    void hydrateActivePrCards()
  }, [projectRecoveryRevision, refreshConversations, hydrateActivePrCards])

  const previousConnectionRef = useRef(connectionStatus)
  useEffect(() => {
    const previous = previousConnectionRef.current
    previousConnectionRef.current = connectionStatus
    if (connectionStatus === 'connected' && previous !== 'connected') {
      void refreshConversations()
      void refreshMcp()
      void refreshProviders()
      void hydrateActivePrCards()
      void reconcileActiveTurns()
    }
  }, [connectionStatus, refreshConversations, refreshMcp, refreshProviders, hydrateActivePrCards, reconcileActiveTurns])

  const ensureActive = useCallback(async (): Promise<AgentConversation> => {
    if (active) return active
    if (secondaryWindow) throw new Error('This window is reserved for its mission.')
    const list = await listAgentConversations()
    setConversations(list)
    setFavoriteConversationIds((prev) => {
      const next = pruneFavoriteConversationIds(loadFavoriteConversationIds(), list)
      if (next.size === prev.size && [...next].every(id => prev.has(id))) return prev
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

  // ─── Builder mode (reskin-project-builder-into-agent-panel D1) ─────────────
  // The day-0 Project Builder rides the agent surfaces as a SKIN: while active,
  // the panel/mission surface render the builder session (blueprint transport)
  // and the normal agent chrome is hidden — never unmounted, so queues, pinned
  // cards, and live streams survive the mode untouched.
  const [builderActive, setBuilderActive] = useState(false)
  const builderSessionRef = useRef<BuilderSession | null>(null)
  const exitBuilderMode = useCallback(() => {
    builderSessionRef.current?.abortAndReset()
    setBuilderActive(false)
  }, [])
  const builderSession = useBuilderSession(builderActive, { onFinished: exitBuilderMode })
  builderSessionRef.current = builderSession
  const enterBuilderMode = useCallback(() => {
    if (secondaryWindow) return
    setBuilderActive(true)
    // Board mode: the builder lives in the floating panel — summon it. Agent
    // Mode suppresses the panel; the mission surface takes the builder skin.
    if (uiMode !== 'agent') open()
  }, [uiMode, open])
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
    if (!editable(active?.id)) throw new Error('This mission is active in another window.')
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
        // Move the empty-compose-screen drafts (typed text + attachment chips)
        // to the real conversation id BEFORE flipping `active`, so the
        // composer's restore-on-switch effect finds them under the new key —
        // this covers materialization triggered OUTSIDE the composer too
        // (e.g. a browser capture from the workspace sidebar).
        migrateNewMissionComposerDrafts(created.id)
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

  const send = useCallback(async (text: string, opts?: { attachmentIds?: string[]; contextRefs?: AgentContextReference[]; queueId?: string }): Promise<{ accepted: boolean; conversationId?: string }> => {
    if (!editable(active?.id)) return { accepted: false }
    const trimmed = text.trim()
    if (!trimmed) return { accepted: false }
    // EMPTY compose screen (no active conversation) ALWAYS starts a fresh
    // conversation with the draft pin — it never resurrects the latest chat.
    const conv = active ?? await materializeDraftConversation()
    conversationEventVersionRef.current.set(conv.id, (conversationEventVersionRef.current.get(conv.id) ?? 0) + 1)
    const sendEventVersion = conversationEventVersionRef.current.get(conv.id)
    const queueClearVersion = queueClearVersionRef.current.get(conv.id) ?? 0
    const queueId = opts?.queueId ?? `q-${Date.now()}-${_queueSeq++}`
    const nowIso = new Date().toISOString()
    localTurnStartedAtRef.current.set(conv.id, nowIso)
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
      delivery_receipt: 'sent' as const,
      created_at: nowIso,
    }
    // Busy sends wait for the next turn unless the user explicitly picks Steer.
    const wasBusy = liveRef.current.get(conv.id)?.isStreaming === true
    const pendingItem: AgentQueuedItem = { queueId, text: trimmed, contextRefs: opts?.contextRefs, attachmentIds: opts?.attachmentIds, deliveryMode: 'queue', deliveryReceipt: 'sent', timestamp: nowIso }
    if (wasBusy) {
      patchLive(conv.id, (p) => ({ ...p, queued: p.queued.some((item) => item.queueId === queueId)
        ? p.queued.map((item) => item.queueId === queueId ? { ...pendingItem, deliveryReceipt: latestReceipt(item.deliveryReceipt, pendingItem.deliveryReceipt), deliveryMode: item.deliveryMode ?? pendingItem.deliveryMode, timestamp: item.timestamp ?? pendingItem.timestamp } : item)
        : [...p.queued, pendingItem] }))
    } else {
      setMessages((m) => [...m, userBubble])
      patchLive(conv.id, (p) => ({ ...p, isStreaming: true, streamingText: '', liveTools: [] }))
    }
    const attachments = opts?.attachmentIds && opts.attachmentIds.length ? { ids: opts.attachmentIds } : undefined
    try {
      const contextRefs = opts?.contextRefs && opts.contextRefs.length ? opts.contextRefs : undefined
      const res = await sendAgentMessage(conv.id, trimmed, { tierLevel: conv.tier_level, attachments, queueId, contextRefs })
      if (res.removed) {
        // A durable deletion survives reloads, unlike this window's tombstones.
        // Its idempotent retry must never become a new user bubble or turn.
        consumedQueueIdsRef.current.add(queueId)
        removedQueueIdsRef.current.add(queueId)
        const undoIdleStart = !wasBusy && sendEventVersion === conversationEventVersionRef.current.get(conv.id)
        if (activeIdRef.current === conv.id) setMessages((current) => current.filter((message) => message.id !== userBubble.id))
        patchLive(conv.id, (previous) => ({
          ...previous,
          queued: previous.queued.filter((item) => item.queueId !== queueId),
          ...(undoIdleStart ? { isStreaming: false } : {}),
        }))
        if (undoIdleStart) localTurnStartedAtRef.current.delete(conv.id)
        return { accepted: true, conversationId: conv.id }
      }
      if (res.message) {
        inputMessageIdsRef.current.set(`${conv.id}:q:${queueId}`, res.message.id)
        const receipt = latestReceipt(res.message.delivery_receipt, inputReceiptsRef.current.get(`${conv.id}:q:${queueId}`))
        const canonical = withReceipt({ ...res.message, ...(receipt ? { delivery_receipt: receipt } : {}) })
        consumedQueueIdsRef.current.add(queueId)
        transcriptEventsRef.current.set(conv.id, mergeTranscriptRows(transcriptEventsRef.current.get(conv.id) ?? [], [canonical]).slice(-500))
        if (activeIdRef.current === conv.id) setMessages((current) => mergeTranscriptRows(current.filter((message) => message.id !== userBubble.id), [canonical]))
        patchLive(conv.id, (previous) => ({ ...previous, queued: previous.queued.filter((item) => item.queueId !== queueId) }))
        if (res.duplicate) void reconcileActiveTurns()
        return { accepted: true, conversationId: conv.id }
      }
      if (queueClearVersion !== (queueClearVersionRef.current.get(conv.id) ?? 0)) {
        setMessages((current) => current.filter((message) => message.id !== userBubble.id))
        return { accepted: true, conversationId: conv.id }
      }
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
              : { ...p, queued: [...p.queued, { ...pendingItem, deliveryMode: res.deliveryMode ?? pendingItem.deliveryMode }] },
          )
        }
      } else if (!queued && wasBusy && !consumedQueueIdsRef.current.has(queueId)) {
        // Rare race: the turn had just settled — our chip is running as a direct
        // turn (no agent_dequeued will ever come for it), promote it now.
        patchLive(conv.id, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== queueId), isStreaming: true }))
        setMessages((m) => [...m, userBubble])
      }
      return { accepted: true, conversationId: conv.id }
    } catch (e) {
      if (consumedQueueIdsRef.current.has(queueId) || queueClearVersion !== (queueClearVersionRef.current.get(conv.id) ?? 0)) return { accepted: true, conversationId: conv.id }
      localTurnStartedAtRef.current.delete(conv.id)
      // No agent_* WS event will arrive (the POST never spawned a turn) — reset
      // the optimistic state here, mirroring the agent_error handler.
      if (wasBusy) {
        patchLive(conv.id, (p) => ({ ...p, queued: p.queued.filter((q) => q.queueId !== queueId) }))
      } else {
        patchLive(conv.id, (p) => ({ ...p, isStreaming: false, streamingText: '', liveTools: [] }))
        setMessages((current) => current.filter((message) => message.id !== userBubble.id))
      }
      toast.error(e instanceof Error ? e.message : 'Failed to send message.')
      return { accepted: false, conversationId: conv.id }
    }
  }, [active, materializeDraftConversation, patchLive, reconcileActiveTurns])

  const abort = useCallback(async () => {
    if (!active || !editable(active.id)) return
    try {
      await abortAgentTurn(active.id)
      queueClearVersionRef.current.set(active.id, (queueClearVersionRef.current.get(active.id) ?? 0) + 1)
      conversationEventVersionRef.current.set(active.id, (conversationEventVersionRef.current.get(active.id) ?? 0) + 1)
      // Preserve the live turn if stopping fails: hiding it would imply that
      // the provider stopped while it can still spend tokens and mutate state.
      patchLive(active.id, () => null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to stop the agent.')
    }
  }, [active, patchLive])

  const editQueuedMessage = useCallback(async (queueId: string, text: string): Promise<'saved' | 'conflict'> => {
    const conv = active
    if (!conv || !editable(conv.id) || liveRef.current.get(conv.id)?.queued.find((item) => item.queueId === queueId)?.deliveryMode === 'steer') return 'conflict'
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

  const steerQueuedMessage = useCallback(async (queueId: string): Promise<'saved' | 'conflict'> => {
    const conv = active
    const item = conv && liveRef.current.get(conv.id)?.queued.find((entry) => entry.queueId === queueId)
    if (!conv || !editable(conv.id) || !item || item.deliveryMode === 'steer') return 'conflict'
    const result = await steerQueuedAgentMessage(conv.id, queueId)
    if (result === 'saved') {
      conversationEventVersionRef.current.set(conv.id, (conversationEventVersionRef.current.get(conv.id) ?? 0) + 1)
      patchLive(conv.id, (previous) => ({ ...previous, queued: previous.queued.map((entry) => entry.queueId === queueId ? { ...entry, deliveryMode: 'steer' } : entry) }))
    } else if (activeIdRef.current === conv.id) void hydrateActivePrCards()
    return result
  }, [active, patchLive, hydrateActivePrCards])

  const removeQueuedMessage = useCallback(async (queueId: string): Promise<'saved' | 'conflict'> => {
    const conv = active
    const item = conv && liveRef.current.get(conv.id)?.queued.find((entry) => entry.queueId === queueId)
    if (!conv || !editable(conv.id) || !item || item.deliveryMode === 'steer') return 'conflict'
    const result = await removeQueuedAgentMessage(conv.id, queueId)
    if (result === 'saved') {
      consumedQueueIdsRef.current.add(queueId)
      removedQueueIdsRef.current.add(queueId)
      conversationEventVersionRef.current.set(conv.id, (conversationEventVersionRef.current.get(conv.id) ?? 0) + 1)
      patchLive(conv.id, (previous) => ({ ...previous, queued: previous.queued.filter((entry) => entry.queueId !== queueId) }))
    } else if (activeIdRef.current === conv.id) void hydrateActivePrCards()
    return result
  }, [active, patchLive, hydrateActivePrCards])

  const wasQueueConsumed = useCallback((queueId: string): boolean => consumedQueueIdsRef.current.has(queueId) && !removedQueueIdsRef.current.has(queueId), [])

  const patchActive = useCallback(async (patch: Parameters<typeof patchAgentConversation>[1]) => {
    if (!active || !editable(active.id)) return
    const revision = (metadataVersion.current.get(active.id) ?? 0) + 1
    metadataVersion.current.set(active.id, revision)
    const updated = await patchAgentConversation(active.id, patch)
    if (metadataVersion.current.get(active.id) !== revision) return
    setActive(current => current?.id === updated.id ? updated : current)
    setConversations((c) => c.map((x) => (x.id === updated.id ? updated : x)))
  }, [active])

  const setTier = useCallback(async (level: AgentTierLevel) => {
    if (!editable(active?.id)) return
    saveLastTierLevel(level) // sticky across missions
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
    else {
      setDraftModel(model)
      setDraftEffort(null)
    }
  }, [active, patchActive])
  const setEffort = useCallback(async (effort: string | null) => {
    if (active) await patchActive({ reasoningEffort: effort })
    else setDraftEffort(effort)
  }, [active, patchActive])
  const setPinnedProject = useCallback(async (projectId: string | null) => {
    if (secondaryWindow || !editable(active?.id)) return
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

  // Backward binding: the sidebar's active project moves an UNSTARTED mission.
  // `setPinnedProject` above owns the forward direction (mission selector moves
  // the sidebar); this is the reverse, so picking a project in Agent Mode
  // immediately points the agent at it without a second click in the mission's
  // own project selector. Two guards keep it honest:
  //   - only an actual CHANGE binds (the mounted value is recorded and skipped),
  //     so an explicitly Home-pinned mission is never converted on first render;
  //   - a mission that already carries messages keeps its project, because its
  //     transcript, tool calls and `#ref` resolution are scoped to it.
  // Reading the active project from context (not from a click handler) keeps the
  // invariant regardless of which surface moved it — sidebar, command palette,
  // a ref chip, or a minimized-chat restore.
  const lastBoundProjectIdRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const previous = lastBoundProjectIdRef.current
    lastBoundProjectIdRef.current = activeProjectId
    if (previous === undefined || previous === activeProjectId) return
    if (secondaryWindow || uiMode !== 'agent' || !activeProjectId) return
    if (!active) {
      setDraftPinnedProjectId(activeProjectId)
      return
    }
    if (messagesRef.current.length > 0) return
    if (active.pinned_project_id === activeProjectId) return
    void patchActive({ pinnedProjectId: activeProjectId })
  }, [activeProjectId, uiMode, active, patchActive])

  const startNewConversation = useCallback((projectId?: string | null) => {
    if (secondaryWindow) return
    // An explicit mission action while the Builder skin is up is a clear
    // intent to leave it — exit (abort + reset) so the normal compose screen
    // is actually visible, not hidden behind the builder branch.
    exitBuilderMode()
    setActive(null)
    setMessages([])
    setDraftPinnedProjectId(projectId ?? null)
    setDraftProvider('claude')
    setDraftModel(null)
    setDraftTierLevel(readLastTierLevel()) // sticky tier across missions
    setDraftEffort(null)
  }, [exitBuilderMode])

  const newConversation = useCallback(async (projectId?: string | null) => {
    if (secondaryWindow) return
    exitBuilderMode() // same intent-to-leave as startNewConversation
    // Explicit arg pins to that project (null ⇒ Home); arg-less preserves the
    // legacy behavior of inheriting the active conversation's pin.
    const pinnedProjectId = projectId !== undefined ? projectId : (active?.pinned_project_id ?? null)
    const created = await createAgentConversation({ pinnedProjectId, tierLevel: readLastTierLevel() })
    setConversations((c) => [created, ...c])
    setActive(created)
    setMessages([])
  }, [active, exitBuilderMode])

  const selectConversation = useCallback(async (id: string, options?: { windowRestore?: boolean; signal?: AbortSignal }) => {
    if (secondaryWindow && !options?.windowRestore && windowsRef.current.current?.conversationId !== id) return
    if (!secondaryWindow && !options?.windowRestore && await windowsRef.current.focus(id)) return
    if (options?.signal?.aborted) throw new DOMException('Window transfer cancelled', 'AbortError')
    exitBuilderMode()
    await loadConversation(id, options?.signal)
    if (options?.windowRestore && uiMode !== 'agent') setVisibility('open')
  }, [loadConversation, exitBuilderMode, secondaryWindow, uiMode])

  const deleteConversation = useCallback(async (id: string) => {
    if (!editable(id)) return
    await deleteAgentConversation(id)
    await windowsRef.current.discard(id)
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
    if (!editable(id)) return
    const title = rawTitle.trim() || null
    metadataVersion.current.set(id, (metadataVersion.current.get(id) ?? 0) + 1)
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
    setFavoriteConversationIds(() => {
      const next = new Set(loadFavoriteConversationIds())
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to enable MCP.')
    } finally {
      setEnablingMcp(false)
    }
  }, [refreshMcp])

  const value = useMemo<AgentChatContextValue>(() => ({
    visibility, open, close, minimize, toggle,
    conversations, active, messages, streamingText, isStreaming, liveTools, turnTools,
    queuedMessages, streamingConversationIds, liveByConversation: liveByConv,
    unreadConversationIds, favoriteConversationIds,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, editQueuedMessage, steerQueuedMessage, removeQueuedMessage, wasQueueConsumed,
    cycleTier, setTier, setProvider, setModel, setPinnedProject,
    newConversation, startNewConversation, materializeDraftConversation, draftPinnedProjectId,
    draftProvider, draftModel, draftTierLevel, draftEffort, setEffort,
    selectConversation, deleteConversation, renameConversation, toggleFavoriteConversation, refreshConversations,
    applyPrDecisionSnapshot,
    builderMode: { active: builderActive, enter: enterBuilderMode, exit: exitBuilderMode, session: builderSession },
  }), [
    visibility, open, close, minimize, toggle,
    builderActive, enterBuilderMode, exitBuilderMode, builderSession,
    conversations, active, messages, streamingText, isStreaming, liveTools, turnTools,
    queuedMessages, streamingConversationIds, liveByConv, unreadConversationIds, favoriteConversationIds,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady,
    send, abort, editQueuedMessage, steerQueuedMessage, removeQueuedMessage, wasQueueConsumed,
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
  conversations: [], active: null, messages: [], streamingText: '', isStreaming: false, liveTools: [], turnTools: [],
  queuedMessages: [], streamingConversationIds: new Set<string>(),
  unreadConversationIds: new Set<string>(),
  liveByConversation: new Map<string, AgentConvLive>(),
  favoriteConversationIds: new Set<string>(),
  mcpEnabled: true, enablingMcp: false, enableMcpServer: async () => {}, providersReady: true,
  send: async () => ({ accepted: false }), abort: async () => {},
  editQueuedMessage: async () => 'conflict', steerQueuedMessage: async () => 'conflict', removeQueuedMessage: async () => 'conflict', wasQueueConsumed: () => false,
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
  applyPrDecisionSnapshot: () => 'untracked',
  builderMode: {
    active: false,
    enter: () => {},
    exit: () => {},
    session: {
      phase: 'chat', messages: [], streamBuffer: null, blueprint: null, busy: false,
      commitError: null, commitErrorDetail: null, commitSteps: [], createdProjectId: null, launching: false, launched: false, submitting: false,
      conversationReady: false, conversationId: null, dirty: false, canProposeCommit: false, specQualityDetail: null,
      readiness: { ready: false, steps: [], issues: [] }, snapshot: { status: 'idle' },
      generation: { generating: false, specsStarted: 0 }, recent: [], recentLoading: false,
      resume: async () => {}, discardRecent: async () => {}, repairSnapshot: async () => {}, showSurpriseMe: true,
      provider: 'claude', model: null, models: [], efforts: [], effort: 'medium', draft: '', setDraft: () => {},
      setEffort: () => {}, setProvider: () => {}, setModel: () => {},
      send: () => {}, surpriseMe: () => {}, approveBlueprint: () => {}, goToCommit: () => {}, backToChat: () => {},
      submitCommit: () => {}, launchM1: async () => {}, openProject: () => {}, abortAndReset: () => {},
    },
  },
}

/**
 * Returns the agent chat API, or a safe no-op when rendered outside the provider
 * (mirrors useMinimizedChats — keeps components like ArcSidebar mountable in
 * isolation / tests without a provider).
 */
export function useAgentChat(): AgentChatContextValue {
  return useContext(AgentChatContext) ?? NOOP_AGENT_CHAT
}
