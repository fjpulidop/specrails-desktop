/**
 * The mission chat context contract: what `useAgentChat()` returns, and the
 * safe no-op value used when a component renders outside the provider.
 */
import type { AgentConvLive, AgentLiveTool, AgentQueuedItem } from '../../lib/live-store'
import type {
  ArchiveScope,
  AgentConversation,
  AgentContextReference,
  AgentMessage,
  AgentPrDecisionEnvelope,
  AgentTierLevel,
} from '../../lib/agent-api'
import type { BuilderSession } from '../../../builder/hooks/useBuilderSession'
import type { MissionAttentionKind } from '../../components/mission-run-strip'

export type AgentVisibility = 'hidden' | 'open' | 'minimized'
export type PrDecisionSnapshotApplication = 'accepted' | 'stale' | 'untracked'

export interface AgentChatContextValue {
  visibility: AgentVisibility
  open: () => void
  close: () => void
  minimize: () => void
  toggle: () => void

  conversations: AgentConversation[]
  active: AgentConversation | null
  messages: AgentMessage[]
  /** LIVE TURN STATE is not part of this context (a token must not re-render every
   *  consumer): read it through hooks/useAgentLive.ts. The fields below exist only
   *  so isolated tests can mock `useAgentChat()` with a flat shape; the real
   *  provider leaves them undefined. */
  /** @deprecated read `useActiveLive()` */
  streamingText?: string
  /** @deprecated read `useIsStreaming()` */
  isStreaming?: boolean
  /** @deprecated read `useActiveLive().liveTools` */
  liveTools?: AgentLiveTool[]
  /** @deprecated read `useActiveLive().turnTools` */
  turnTools?: AgentLiveTool[]
  /** @deprecated read `useActiveQueued()` */
  queuedMessages?: AgentQueuedItem[]
  /** @deprecated read `useStreamingConversationIds()` */
  streamingConversationIds?: ReadonlySet<string>
  /** Conversations with assistant/system output that arrived out of view. */
  unreadConversationIds: ReadonlySet<string>
  /** Conversations with a delivery waiting for the person (a review decision,
   *  an approval, a failure nobody acted on) — the mission list's attention mark. */
  attentionConversationIds: ReadonlySet<string>
  /** Why each of those missions needs the person: a decision waits (wins) or a run failed. */
  attentionKinds?: ReadonlyMap<string, MissionAttentionKind>
  /** @deprecated read `useQueuedCounts()` / `useIsConversationStreaming(id)` */
  liveByConversation?: ReadonlyMap<string, AgentConvLive>
  /** Mission IDs surfaced in the left sidebar's Favorite missions section. */
  favoriteConversationIds: ReadonlySet<string>

  mcpEnabled: boolean
  enablingMcp: boolean
  enableMcpServer: () => Promise<void>

  /** null = not yet checked; false = no AI provider CLI is installed. */
  providersReady: boolean | null

  /** `deliveryMode: 'interrupt'` (IntentSession mode only) cuts the running turn instead of queueing. */
  send: (text: string, opts?: { attachmentIds?: string[]; contextRefs?: AgentContextReference[]; queueId?: string; deliveryMode?: 'interrupt' }) => Promise<{ accepted: boolean; conversationId?: string }>
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
  selectConversation: (id: string, options?: { windowRestore?: boolean; signal?: AbortSignal; placeRestore?: boolean }) => Promise<void>
  /** Warm a mission's snapshot (hover/focus intent) so opening it paints at once. */
  prefetchConversation?: (id: string) => void
  /** Mark that the next active-project change follows a mission selection (call before `setActiveProjectId`, in the same handler). */
  beginMissionSelection?: () => void
  archiveScope: ArchiveScope
  setArchiveScope: (scope: ArchiveScope) => void
  conversationsLoading: boolean
  conversationsError: string | null
  archiveConversation: (id: string) => Promise<void>
  unarchiveConversation: (id: string) => Promise<void>
  deleteConversation: (id: string) => Promise<void>
  /** Rename a conversation (optimistic; blank clears to auto-title). */
  renameConversation: (id: string, title: string) => Promise<void>
  /** Toggle the sidebar Favorite missions membership without changing project pinning. */
  toggleFavoriteConversation: (id: string) => void
  /** Refresh the conversation list WITHOUT opening the floating panel. Used on
   *  entering Agent Mode (open() would mount the now-suppressed panel). */
  refreshConversations: () => Promise<void>
  /** Re-read the active mission's run cards now (a strip waiting on a run that
   *  has not shown yet; normally the WS events and the resync poll do it). */
  resyncRunCards?: () => void
  /** An extension's live run (IntentSession) waits for the person or not: the same
   *  sidebar attention dot a delivery feeds (keyed by the strip entry). */
  reportRunAttention?: (conversationId: string, runKey: string, needsPerson: boolean | MissionAttentionKind) => void
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

export const NOOP_AGENT_CHAT: AgentChatContextValue = {
  visibility: 'hidden',
  open: () => {}, close: () => {}, minimize: () => {}, toggle: () => {},
  archiveScope: 'active', setArchiveScope: () => {}, conversationsLoading: false, conversationsError: null,
  conversations: [], active: null, messages: [], streamingText: '', isStreaming: false, liveTools: [], turnTools: [],
  queuedMessages: [], streamingConversationIds: new Set<string>(),
  unreadConversationIds: new Set<string>(),
  attentionConversationIds: new Set<string>(),
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
  archiveConversation: async () => {}, unarchiveConversation: async () => {},
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
