import { useMissionPaneLayoutId } from '../context/MissionSplitViewsContext'
import { useMissionWindows } from '../context/MissionWindowsContext'
import { isLocalEngineId } from '../../providers/lib/provider-capabilities'
import { readMissionScroll, saveMissionScroll, useMissionViewRevision } from '../lib/mission-view-state'
import { ArrowDown, ExternalLink } from 'lucide-react'
import { Suspense, lazy, memo, startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { useReducedMotion } from '../../../hooks/useReducedMotion'
import { Bot, ShieldAlert, PackageOpen, Rocket } from 'lucide-react'
import { useAgentChat } from '../context/AgentChatContext'
import { useActiveLive, useActiveQueued, useIsStreaming } from '../hooks/useAgentLive'
import { useActiveTheme } from '../../settings/context/ThemeContext'
import { useSmoothStream } from '../../specs/components/explore-spec/useSmoothStream'
import { useAgentRefActions } from '../hooks/useAgentRefActions'
import { listAgentAttachments, type AgentAttachment } from '../lib/agent-api'
import type { AgentRefTarget } from '../lib/agent-refs'
import { AgentActivityChip } from './AgentActivityChip'
import { AgentActivityLogModal } from './AgentActivityLogModal'
import { AgentMessage } from './AgentMessage'
import { AgentQueuedMessage } from './AgentQueuedMessage'
import { AgentComposer } from './AgentComposer'
import { AgentPrDecisionCard } from './AgentPrDecisionCard'
import { AgentRunStrip } from './AgentRunStrip'
import { AgentRunEventLine } from './AgentRunEventLine'
import { AgentRunLaunchedLine, AgentSettledRunLine } from './AgentRunHistoryLines'
import { proposalRunKey } from './mission-run-strip'
import { FLOW_SPEC_LOOP_ID } from '../../delivery/components/LoopChip'
import { AgentConversationHeader } from './AgentConversationHeader'
import { derivePrCards, isPrEnvelopePinned } from './agent-pr-pinning'
import { openRunStrip, parseRunFailureRow, systemBriefingRunId } from './agent-run-failure'
import { AgentFlowReturnCard, parseFlowReturnBriefingRow } from './AgentFlowReturnCard'
import { AgentFlowDeliveredCard, parseFlowDeliveredRow } from './AgentFlowDeliveredCard'
import { AgentFlowBoundaryLine, flowTurnMessageIds, parseFlowBoundaryRow } from './AgentFlowBoundaryLine'
import { AgentRunFailureMarker, AgentSystemBriefing } from './AgentRunFailureMarker'
import { FEATURE_MISSION_RAIL_CARDS } from '../../../lib/feature-flags'
import { useRailLaunchProposals } from './useRailLaunchProposals'
import { AgentSubagentsCard } from './AgentSubagentsCard'
import { AgentBackgroundTurn, AgentDeferredChangeNotice, AgentSessionNotices, AgentTurnOriginLabel } from './AgentSessionIndicators'
import { useMissionSession, useMissionSessions } from '../context/MissionSessionsContext'
import { placeUnanchoredSubagents, subagentsForTurn, unanchoredSubagents } from '../lib/mission-sessions'
import { composerDrafts, writeComposerDraft } from '../lib/agent-composer-drafts'
import { useGuardedTierCycle } from '../hooks/useGuardedTierCycle'
import { extractAgentOptions } from './agent-options'
import { promoteAgentProtocolFences } from './agent-fence-promotion'
import type { AgentSubagent } from '../lib/agent-api'
import { useMissionConversationMode, useMissionTurnMark, type MissionModeBadge } from '../context/MissionExtensionsContext'

// Only loads when a job-ref chip is actually clicked — keeps the conversation
// chunk free of the log-explorer stack.
const JobDetailModal = lazy(() =>
  import('../../jobs/components/JobDetailModal').then((m) => ({ default: m.JobDetailModal })),
)

// Only loads when a loop-ref chip resolves — keeps the loops stack out of the
// conversation chunk.
const LoopPreviewModal = lazy(() =>
  import('../../loops/components/LoopPreviewModal').then((m) => ({ default: m.LoopPreviewModal })),
)

// Foreign/unparseable system rows are skipped (never render raw JSON); warn
// once per row id so a corrupt row doesn't spam on every re-render.
const warnedSystemRows = new Set<string>()

/**
 * Shared inner conversation UI — banners + sticky-scroll message list + streaming
 * + composer — consumed by BOTH the floating `AgentChatPanel` (variant='floating')
 * and the inline `AgentModeSurface` (variant='inline'). Window chrome
 * (drag/resize/maximize) stays in the panel wrapper. Context-driven.
 */
// System rows that are records rather than cards: recognised, rendered as
// nothing, and deliberately NOT warned about. Kept in sync with
// server/modules/missions/runtime/agent-spec-framing.ts SPEC_FRAMING_MARKER_KIND.
const SILENT_SYSTEM_ROW_KINDS = new Set(['spec-framing.committed'])

function isSilentSystemRow(content: string): boolean {
  if (!content.startsWith('{')) return false
  try {
    const parsed = JSON.parse(content) as { kind?: unknown }
    return typeof parsed?.kind === 'string' && SILENT_SYSTEM_ROW_KINDS.has(parsed.kind)
  } catch {
    return false
  }
}

export function AgentConversationView({ variant }: { variant: 'floating' | 'inline' }) {
  const { t } = useTranslation('agent')
  const { active } = useAgentChat()
  const windows = useMissionWindows()
  const revision = useMissionViewRevision(active?.id ?? '__new-mission__')
  const transfer = windows.transfers.find(item => item.conversationId === active?.id)
  if (active && !windows.current && transfer?.state === 'detached') return (
    <div className="flex h-full flex-col">
      {variant === 'inline' && <AgentConversationHeader />}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <ExternalLink className="h-8 w-8 text-accent-primary" />
        <p className="text-sm text-muted-foreground">{t('window.detached')}</p>
        <button type="button" onClick={() => { void windows.focus(active.id) }} className="rounded-md bg-accent-primary px-4 py-2 text-sm text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 focus-visible:ring-offset-1 focus-visible:ring-offset-background">{t('window.focus')}</button>
      </div>
    </div>
  )
  const frozen = !!active && !windows.isEditable(active.id)
  return <div className="relative flex h-full min-h-0 flex-col" inert={frozen || undefined} aria-busy={frozen || undefined}>
    <AgentConversationContent key={`${active?.id ?? '__new-mission__'}:${revision}`} variant={variant} />
  </div>
}

const NO_ROWS: AgentMessageRow[] = []
/** Rows mounted on the first paint of a long mission; the rest backfill in a transition. */
const INITIAL_ROWS = 24
/** Older rows skip layout and paint until scrolled near (content-visibility). */
const RECENT_ROWS_FULL_RENDER = 12
/** Rows that follow the in-flight flag; older ones never depend on it. */
const RECENT_STREAMING_AWARE_ROWS = 4

type AgentMessageRow = ReturnType<typeof useAgentChat>['messages'][number]
type AgentMessageProps = Parameters<typeof AgentMessage>[0]

/** Rows re-render only when their data changes: function props are stable by
 *  construction (see onPickOption) and arrays compare by content. */
function sameMessageProps(a: AgentMessageProps, b: AgentMessageProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof AgentMessageProps>
  for (const key of keys) {
    const x = a[key]
    const y = b[key]
    if (Object.is(x, y)) continue
    if (typeof x === 'function' && typeof y === 'function') continue
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((item, index) => Object.is(item, y[index]))) continue
    return false
  }
  return true
}
const MemoAgentMessage = memo(AgentMessage, sameMessageProps)

/**
 * The in-flight turn: streamed text, the activity chip. The ONLY part of the
 * conversation that re-renders per streamed frame.
 */
function LiveTail({ tolerantFences, agentDescription, onOpenActivity, onGrew }: {
  tolerantFences: boolean
  agentDescription: string | null
  onOpenActivity: () => void
  onGrew: () => void
}) {
  const live = useActiveLive()
  const smoothed = useSmoothStream(live.streamingText, live.isStreaming)
  const firstRun = useRef(true)
  const toolCount = live.liveTools.length
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return }
    onGrew()
  }, [onGrew, smoothed, toolCount])
  if (!live.isStreaming) return null
  return (
    <div className="space-y-2">
      {smoothed && <AgentMessage role="assistant" content={smoothed} streaming tolerantFences={tolerantFences} />}
      <AgentActivityChip
        tool={toolCount ? live.liveTools[toolCount - 1].tool : null}
        agentDescription={agentDescription}
        onClick={onOpenActivity}
      />
    </div>
  )
}

/** The execution log: live tools while the turn runs, the finished turn's after it. */
function ActivityLog({ onClose }: { onClose: () => void }) {
  const live = useActiveLive()
  return <AgentActivityLogModal tools={live.liveTools.length > 0 ? live.liveTools : live.turnTools} streaming={live.isStreaming} onClose={onClose} />
}

function AgentConversationContent({ variant }: { variant: 'floating' | 'inline' }) {
  const composerLayoutId = useMissionPaneLayoutId()
  const reduced = useReducedMotion()
  const { t } = useTranslation('agent')
  const {
    active, messages: committedMessages, mcpEnabled, enablingMcp, enableMcpServer, providersReady, send,
  } = useAgentChat()
  // Live turn state is read through its own subscriptions (hooks/useAgentLive):
  // a streamed token re-renders the tail below, never this component.
  const isStreaming = useIsStreaming()
  const queuedMessages = useActiveQueued()
  // Opening a mission paints its header, composer and run strip first; the
  // transcript follows as an interruptible low-priority render (windowed to the
  // newest rows, then backfilled) so a long history never blocks the switch.
  const messages = useDeferredValue(committedMessages, NO_ROWS)
  const cycleTier = useGuardedTierCycle()
  // Execution-log modal (opened from the activity chip). While streaming it
  // shows the LIVE turn's tools; after settle it keeps showing the finished
  // turn's activity (turnTools) so an open modal never blanks at agent_done.
  const [activityOpen, setActivityOpen] = useState(false)
  const [queueEditRequest, setQueueEditRequest] = useState<{ conversationId: string; queueId: string; revision: number }>()
  const scrollRef = useRef<HTMLDivElement>(null)

  // Ticket/job reference chips resolve against the CONVERSATION's pinned
  // project (it may differ from the active one). Home/app-global missions have
  // no pin, so refs stay plain text there (v1 choice — a bare `#N` / uuid is
  // only resolvable against a concrete project).
  const { openRef, jobRef, closeJobRef, loopRef, closeLoopRef } = useAgentRefActions()
  const refsProjectId = active?.pinned_project_id ?? null
  const [attachmentById, setAttachmentById] = useState<Map<string, AgentAttachment>>(new Map())
  const messageAttachmentIds = useMemo(() => {
    const ids = new Set<string>()
    for (const message of messages) {
      for (const id of message.attachment_ids ?? []) ids.add(id)
    }
    for (const message of queuedMessages) for (const id of message.attachmentIds ?? []) ids.add(id)
    return [...ids].sort()
  }, [messages, queuedMessages])
  const messageAttachmentKey = messageAttachmentIds.join('\0')
  useEffect(() => {
    const ids = messageAttachmentKey ? messageAttachmentKey.split('\0') : []
    if (!active?.id || ids.length === 0) {
      setAttachmentById(new Map())
      return
    }
    let cancelled = false
    const wanted = new Set(ids)
    listAgentAttachments(active.id)
      .then((attachments) => {
        if (cancelled) return
        setAttachmentById(new Map(attachments.filter((att) => wanted.has(att.id)).map((att) => [att.id, att])))
      })
      .catch(() => {
        if (!cancelled) setAttachmentById(new Map())
      })
    return () => {
      cancelled = true
    }
  }, [active?.id, messageAttachmentKey])
  const onOpenRef = useMemo(
    () =>
      refsProjectId
        ? (ref: AgentRefTarget) => { void openRef(refsProjectId, ref) }
        : undefined,
    [refsProjectId, openRef],
  )
  // Code Rain gets a themed empty-state title.
  const emptyTitle = useActiveTheme().id === 'code-rain' ? t('emptyTitleCodeRain') : t('emptyTitle')

  // PR-decision envelopes parsed ONCE per message-state change (`messages`
  // identity is stable across streaming frames — no per-frame reparse). Live
  // deliveries show in the run strip above the composer; their history slot
  // renders a one-line "launched" event instead.
  const prCards = useMemo(() => derivePrCards(messages), [messages])
  // Agent turns produced while the conversation was in Flow (between boundaries).
  const flowTurns = useMemo(() => flowTurnMessageIds(messages), [messages])
  const extensionTurnMark = useMissionTurnMark()
  const turnMark = useMemo<MissionModeBadge>(() => extensionTurnMark ?? { label: t('flowBoundary.turnMark') }, [extensionTurnMark, t])
  // Undecided agent launch proposals (mission-rail-cards) pin next to the PR cards.
  const railProposals = useRailLaunchProposals(messages)
  // Core sessions: sub-agents anchor under the message of the turn that launched
  // them; the rest (turn still in flight) render in the live area.
  const session = useMissionSession(active?.id)
  const { stopSubagents, dismissNotice } = useMissionSessions()
  const anchoredTurnIds = useMemo(() => new Set(messages.map((m) => m.core_turn_id).filter((id): id is string => !!id)), [messages])
  // Launches stay where they happened; only the in-flight turn's agents ride the live area.
  // Anchors are messages rendered as bubbles (system rows and briefings render elsewhere).
  const placement = useMemo(() => placeUnanchoredSubagents(
    unanchoredSubagents(session, anchoredTurnIds),
    messages.filter((m) => m.role !== 'system' && !(FEATURE_MISSION_RAIL_CARDS && systemBriefingRunId(m))),
    isStreaming,
  ), [session, anchoredTurnIds, messages, isStreaming])
  const liveSubagentCards = placement.live
  const stopMissionAgents = async (ids?: string[]) => { if (active) await stopSubagents(active.id, ids) }
  const relaunchSubagent = (node: AgentSubagent) => {
    if (!active) return
    writeComposerDraft(active.id, t('subagents.relaunchDraft', { description: node.description }), [])
  }
  const subagentCard = (nodes: AgentSubagent[], key: string) => active && nodes.length > 0 ? (
    <AgentSubagentsCard key={key} conversationId={active.id} subagents={nodes} liveEvents={session?.liveEvents ?? {}} onStop={stopMissionAgents} onRelaunch={relaunchSubagent} />
  ) : null

  // Stick-to-bottom: only auto-scroll while the user is already near the bottom.
  const savedScroll = active ? readMissionScroll(active.id) : null
  const pinnedRef = useRef(savedScroll?.atBottom ?? true)
  // Rendered mirror of pinnedRef (scrolled up ⇒ the jump-to-latest pill can show)
  // and whether something arrived below the fold since the user scrolled away.
  const [detached, setDetached] = useState(!(savedScroll?.atBottom ?? true))
  // Windowed first paint: only the newest rows mount at once, the rest backfills
  // in a transition. A mission reopened mid-history needs the full height to
  // restore its scroll position, so it renders everything straight away.
  const [backfilled, setBackfilled] = useState(() => !(savedScroll?.atBottom ?? true))
  // Decided once, when the transcript first arrives: rows added later never hide older ones.
  const windowedRef = useRef<boolean | null>(null)
  if (windowedRef.current === null && messages.length > 0) windowedRef.current = messages.length > INITIAL_ROWS
  const windowed = windowedRef.current === true && !backfilled
  const windowStart = windowed ? messages.length - INITIAL_ROWS : 0
  const backfillAnchor = useRef<{ height: number; top: number } | null>(null)
  useEffect(() => {
    if (!windowed) return
    const frame = requestAnimationFrame(() => {
      const el = scrollRef.current
      backfillAnchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null
      startTransition(() => setBackfilled(true))
    })
    return () => cancelAnimationFrame(frame)
  }, [windowed])
  // Older rows mount ABOVE the viewport: keep the distance to the bottom unchanged.
  useLayoutEffect(() => {
    const el = scrollRef.current
    const anchor = backfillAnchor.current
    if (!el || !anchor || !backfilled) return
    backfillAnchor.current = null
    el.scrollTop = anchor.top + (el.scrollHeight - anchor.height)
  }, [backfilled])
  const [unseen, setUnseen] = useState(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && savedScroll) el.scrollTop = savedScroll.atBottom ? el.scrollHeight : savedScroll.top
    // Late layout (the run strip mounting, sub-agent cards, markdown images)
    // must not leave a mission that opened at the bottom a few pixels short.
    let frame = 0
    let observer: ResizeObserver | null = null
    let settle: ReturnType<typeof setTimeout> | null = null
    if (el && (savedScroll?.atBottom ?? true)) {
      const toBottom = (): void => { if (pinnedRef.current) el.scrollTop = el.scrollHeight }
      frame = requestAnimationFrame(toBottom)
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(toBottom)
        observer.observe(el)
        for (const child of Array.from(el.children)) observer.observe(child)
        settle = setTimeout(() => { observer?.disconnect(); observer = null }, 500)
      }
    }
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      if (settle) clearTimeout(settle)
      if (el && active) saveMissionScroll(active.id, { top: el.scrollTop, atBottom: pinnedRef.current })
    }
  }, [active?.id])
  // The transcript arrives after the first paint: a mission saved mid-history
  // restores its scroll position once its rows exist.
  const restoredRows = useRef(false)
  useLayoutEffect(() => {
    if (restoredRows.current || messages.length === 0) return
    restoredRows.current = true
    const el = scrollRef.current
    if (el && savedScroll && !savedScroll.atBottom) el.scrollTop = savedScroll.top
    else if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [messages.length])
  const onMessagesScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setDetached(!pinnedRef.current)
    if (pinnedRef.current) setUnseen(false)
    if (active) saveMissionScroll(active.id, { top: el.scrollTop, atBottom: pinnedRef.current })
  }
  const contentMounted = useRef(false)
  // Something grew below the fold (a row, the streaming tail, a chip): follow it
  // when the person is at the bottom, else flag it on the jump pill.
  const onContentGrew = useCallback(() => {
    if (!contentMounted.current) {
      contentMounted.current = true
      if (!pinnedRef.current) return
    }
    if (!pinnedRef.current) {
      setUnseen(true)
      return
    }
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'auto' })
  }, [])
  useEffect(onContentGrew, [onContentGrew, messages.length, queuedMessages.length, liveSubagentCards.length, session?.notices.length])
  const jumpToLatest = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = true
    setDetached(false)
    setUnseen(false)
    el.scrollTo?.({ top: el.scrollHeight, behavior: reduced ? 'auto' : 'smooth' })
    if (!el.scrollTo) el.scrollTop = el.scrollHeight
  }
  const showJumpPill = detached && (isStreaming || unseen)

  // Screen readers hear the turn boundaries, never every streamed frame.
  const [liveAnnouncement, setLiveAnnouncement] = useState('')
  const wasStreamingRef = useRef(isStreaming)
  useEffect(() => {
    const was = wasStreamingRef.current
    wasStreamingRef.current = isStreaming
    if (isStreaming && !was) setLiveAnnouncement(t('conversation.agentWorking'))
    else if (!isStreaming && was && committedMessages[committedMessages.length - 1]?.role === 'assistant') setLiveAnnouncement(t('conversation.agentReplied'))
  }, [isStreaming, committedMessages, t])

  // Alt+1…9 answers the newest message's suggested replies (the numbered
  // chips) while the composer is empty — same gating as the chips themselves.
  const lastMessage = messages[messages.length - 1]
  const pickableOptions = useMemo(() => {
    if (!lastMessage || lastMessage.role !== 'assistant') return null
    const content = isLocalEngineId(active?.provider) ? promoteAgentProtocolFences(lastMessage.content) : lastMessage.content
    return extractAgentOptions(content).options ?? null
  }, [lastMessage, active?.provider])

  // Shift+Tab anywhere in the view (incl. the composer) cycles the tier ladder.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.shiftKey && (e.key === 'Tab' || e.code === 'Tab')) {
      e.preventDefault()
      e.stopPropagation()
      cycleTier()
      return
    }
    if (e.altKey && !e.metaKey && !e.ctrlKey && !e.shiftKey && /^Digit[1-9]$/.test(e.code)) {
      const options = pickableOptions
      const canPick = !!options && (!isStreaming || !!conversationMode?.interruptWhileBusy)
      const draftEmpty = !active || !(composerDrafts.get(active.id) ?? '').trim()
      const option = canPick && draftEmpty ? options[Number(e.code.slice(5)) - 1] : undefined
      if (option === undefined) return
      e.preventDefault()
      e.stopPropagation()
      void send(option, isStreaming && conversationMode?.interruptWhileBusy ? { deliveryMode: 'interrupt' } : undefined)
    }
  }

  // Mission extensions (Flow mode): surface attributes + a dock above the composer.
  const conversationMode = useMissionConversationMode(active?.id ?? null, refsProjectId)
  // One stable handler for every row (rows are memoised): reads the latest state.
  const pickRef = useRef<(option: string) => void>(() => {})
  pickRef.current = (option) => void send(option, isStreaming && conversationMode?.interruptWhileBusy ? { deliveryMode: 'interrupt' } : undefined)
  const onPickOption = useCallback((option: string) => pickRef.current(option), [])

  const inline = variant === 'inline'
  // The inline surface caps the conversation column so it reads like Cursor's
  // centered thread on wide screens; the floating panel fills its own frame.
  const threadClass = inline
    ? 'mx-auto flex w-full max-w-[992px] min-h-0 flex-1 flex-col overflow-hidden'
    : 'flex min-h-0 flex-1 flex-col overflow-hidden'

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden" onKeyDown={onKeyDown} data-mission-surface {...conversationMode?.attributes}>
      {providersReady === false && (
        <div className="flex items-start gap-2 border-b border-border/50 bg-accent-warning/10 px-3 py-2 text-xs text-foreground">
          <PackageOpen className="mt-0.5 h-4 w-4 shrink-0 text-accent-warning" />
          <div className="flex-1">
            <p className="font-medium">{t('noProvider.title')}</p>
            <p className="mt-0.5 text-foreground/70">{t('noProvider.body')}</p>
          </div>
        </div>
      )}
      {providersReady !== false && !mcpEnabled && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-accent-warning/10 px-3 py-2 text-xs text-foreground">
          <ShieldAlert className="h-4 w-4 shrink-0 text-accent-warning" />
          <span className="flex-1">{t('degraded.body')}</span>
          <button type="button" onClick={() => void enableMcpServer()} disabled={enablingMcp} className="rounded-md bg-accent-primary px-2 py-1 text-label text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50 disabled:cursor-not-allowed disabled:opacity-60">
            {enablingMcp ? t('degraded.enabling') : t('degraded.enable')}
          </button>
        </div>
      )}

      {/* Agent-Mode conversation title bar: breadcrumb (project path / title) +
          ⋮ overflow menu (Rename, Copy …). Inline surface only — the floating
          panel carries its own header chrome. Self-hides when no active thread. */}
      {inline && active && <AgentConversationHeader />}

      <div className={threadClass}>
        {/* Inline: the thread eases in once while the composer card morphs into
            place below — conversation switches keep it mounted (no re-fade). */}
        <div className="relative flex min-h-0 flex-1 flex-col">
        <motion.div
          ref={scrollRef}
          onScroll={onMessagesScroll}
          initial={inline ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          role="log"
          aria-label={t('conversation.ariaLabel')}
          aria-relevant="additions"
          className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4"
        >
          {committedMessages.length === 0 && !isStreaming && (
            <div className="flex h-full flex-col items-center justify-center text-center text-foreground/50">
              <Bot className="mb-2 h-8 w-8 text-accent-primary/60" />
              <p className="text-sm font-medium text-foreground/70">{emptyTitle}</p>
              <p className="mt-1 max-w-[280px] text-xs">{t('emptyHint')}</p>
            </div>
          )}
          {messages.slice(windowStart).map((m, offset) => {
            const i = windowStart + offset
            // `system` rows are app-authored records, not chat bubbles. Some
            // render as inline cards (the PR-decision card, safe-pr-review-flow);
            // others are pure bookkeeping and render as nothing at all — the
            // spec-framing marker that spends an answered frame is one of those.
            // Anything unrecognised is defensively skipped instead of leaking
            // raw JSON, with a one-shot warn so a NEW kind is noticed.
            if (m.role === 'system') {
              if (isSilentSystemRow(m.content)) return null
              // mission-rail-cards: the moment a run failed, as a slim trace
              // (the run card itself carries the recovery actions).
              if (FEATURE_MISSION_RAIL_CARDS) {
                const failure = parseRunFailureRow(m.content)
                if (failure) {
                  const failedEnvelope = failure.prDeliveryId ? prCards.byDeliveryId.get(failure.prDeliveryId) ?? null : null
                  return <AgentRunFailureMarker key={m.id} row={failure} conversationId={m.conversation_id} envelope={failedEnvelope} />
                }
              }
              // Back to Flow: what the reviewer asked for (server-authored, once per delivery).
              const flowReturn = parseFlowReturnBriefingRow(m.content)
              if (flowReturn) return <AgentFlowReturnCard key={m.id} row={flowReturn} conversationId={m.conversation_id} />
              // Flow delivered: the closing summary (server-authored, once per Flow).
              const flowDelivered = parseFlowDeliveredRow(m.content)
              if (flowDelivered) return <AgentFlowDeliveredCard key={m.id} row={flowDelivered} />
              // Entered / left Flow: one event line at the boundary.
              const flowBoundary = parseFlowBoundaryRow(m.content)
              if (flowBoundary) return <AgentFlowBoundaryLine key={m.id} row={flowBoundary} />
              const envelope = prCards.byMessageId.get(m.id)
              if (!envelope) {
                if (prCards.duplicateMessageIds.has(m.id)) return null
                if (!warnedSystemRows.has(m.id)) {
                  warnedSystemRows.add(m.id)
                  console.warn(`[agent-chat] skipping unrenderable system message ${m.id}`)
                }
                return null
              }
              // While the run is live, the strip above the composer shows it:
              // its history slot only says it was launched (and opens it).
              if (isPrEnvelopePinned(envelope)) {
                return <AgentRunLaunchedLine key={m.id} envelope={envelope} conversationId={m.conversation_id} />
              }
              // A settled Flow → Spec run: its outcome line (the Flow's closing
              // summary is the full card of that story); expands in place.
              if (envelope.loopId === FLOW_SPEC_LOOP_ID) {
                return <AgentSettledRunLine key={m.id} envelope={envelope} conversationId={m.conversation_id} />
              }
              return <AgentPrDecisionCard key={m.id} envelope={envelope} conversationId={m.conversation_id} />
            }
            // mission-rail-cards: the automatic failure briefing is a server-
            // authored user turn — a muted collapsible chip, never a bubble.
            if (FEATURE_MISSION_RAIL_CARDS && systemBriefingRunId(m)) {
              return <AgentSystemBriefing key={m.id} content={m.content} contextRefs={m.context_refs} />
            }
            const railPinned = railProposals.pinnedMessageIds.has(m.id)
            const turnSubagents = m.role === 'assistant' ? subagentsForTurn(session, m.core_turn_id) : []
            const continuation = m.role === 'assistant' && (m.turn_origin === 'subagent' || m.turn_origin === 'system') ? m.turn_origin : null
            return (
              <div key={m.id} className={i < messages.length - RECENT_ROWS_FULL_RENDER ? 'space-y-1 [content-visibility:auto] [contain-intrinsic-size:auto_120px]' : 'space-y-1'}>
              {continuation && <AgentTurnOriginLabel origin={continuation} />}
              <MemoAgentMessage
                role={m.role}
                content={m.content}
                messageId={m.id}
                intents={m.intents ?? null}
                railProposalsPinned={railPinned}
                tolerantFences={isLocalEngineId(active?.provider)}
                createdAt={m.created_at}
                modeMark={flowTurns.has(m.id) ? turnMark : null}
                // Option chips are clickable only on the newest settled message —
                // a streaming turn suppresses them everywhere, except in a mode
                // that interrupts while busy (Flow): there a pick cuts the turn.
                isLast={(!isStreaming || !!conversationMode?.interruptWhileBusy) && i === messages.length - 1}
                // Problem-frame readings stay affordable (but disabled) while a
                // turn streams, so the card doesn't silently go static mid-turn.
                isLatest={i === messages.length - 1}
                // Only the newest rows act on "a turn is in flight" (frame readings, extension
                // cards): older rows keep a constant prop so a turn starting or ending does not
                // re-render (re-parse) the whole transcript.
                isStreaming={isStreaming && i >= messages.length - RECENT_STREAMING_AWARE_ROWS}
                onPickOption={onPickOption}
                refsProjectId={refsProjectId}
                onOpenRef={onOpenRef}
                contextRefs={m.context_refs}
                deliveryStatus={m.delivery_status}
                deliveryReceipt={m.delivery_receipt}
                conversationId={m.conversation_id}
                attachments={(m.attachment_ids ?? []).map((id) => attachmentById.get(id)).filter((att): att is AgentAttachment => !!att)}
              />
              {railPinned && railProposals.pinned.filter((p) => p.messageId === m.id).map((p) => (
                // The proposal waits in the run strip for Play / Dismiss — its
                // chronological slot says it was proposed (and opens it).
                <AgentRunEventLine
                  key={`proposal:${p.proposalIndex}`}
                  icon={Rocket}
                  testId="agent-rail-launch-proposed-line"
                  actionLabel={t('runStrip.event.openRun')}
                  onActivate={() => openRunStrip({ conversationId: m.conversation_id, key: proposalRunKey(p.messageId, p.proposalIndex) })}
                >
                  {t('runStrip.event.proposed')}
                </AgentRunEventLine>
              ))}
              {subagentCard(turnSubagents, `subagents:${m.id}`)}
              {(placement.afterMessage.get(m.id) ?? []).map((group, index) => subagentCard(group, `subagents:${m.id}:${index}`))}
              </div>
            )
          })}
          <LiveTail
            tolerantFences={isLocalEngineId(active?.provider)}
            agentDescription={[...liveSubagentCards].reverse().find((node) => node.phase === 'running')?.description ?? null}
            onOpenActivity={() => setActivityOpen(true)}
            onGrew={onContentGrew}
          />
          {subagentCard(liveSubagentCards, 'subagents:live')}
          {session?.backgroundTurn && !isStreaming && <AgentBackgroundTurn turn={session.backgroundTurn} />}
          {active && session && session.notices.length > 0 && (
            <AgentSessionNotices notices={session.notices} onDismiss={(noticeId) => dismissNotice(active.id, noticeId)} />
          )}
          {session?.deferredChanges && (
            <AgentDeferredChangeNotice onApplyNow={() => stopMissionAgents()} />
          )}
          {/* Messages parked behind the in-flight turn — dimmed user-style chips
              pinned below the stream; each becomes a real bubble on dequeue. */}
          {queuedMessages.length > 0 && (
            <div className="space-y-2" data-testid="agent-queued-messages">
              {queuedMessages.map((q) => (
                <AgentQueuedMessage key={`${active?.id}:${q.queueId}`} item={q} conversationId={active?.id}
                  onEdit={(queueId) => { if (active) setQueueEditRequest((previous) => ({ conversationId: active.id, queueId, revision: (previous?.revision ?? 0) + 1 })) }}
                  attachments={(q.attachmentIds ?? []).map((id) => attachmentById.get(id)).filter((att): att is AgentAttachment => !!att)} />
              ))}
            </div>
          )}
        </motion.div>
        <div className="sr-only" role="status" aria-live="polite" data-testid="agent-conversation-live">{liveAnnouncement}</div>
        <AnimatePresence>
          {showJumpPill && (
            <motion.button
              key="jump-to-latest"
              type="button"
              onClick={jumpToLatest}
              data-testid="agent-jump-to-latest"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              className="absolute bottom-2 left-1/2 z-10 inline-flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 text-label text-foreground shadow-md shadow-black/10 hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
            >
              <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              {t('conversation.newMessages')}
            </motion.button>
          )}
        </AnimatePresence>
        </div>

        {/* The run strip: the ONE live view of this mission's runs (launch
            proposals, deliveries, the extension's Flow). Its panel opens the
            run's full card above it, over the conversation. */}
        <AnimatePresence initial={false}>
          {active && (
            <motion.div
              key="mission-run-strip"
              initial={reduced ? false : { opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 6 }}
              transition={{ duration: 0.2, ease: 'easeOut' }}
              className="shrink-0"
            >
              <AgentRunStrip
                conversationId={active.id}
                projectId={refsProjectId}
                inline={inline}
                deliveries={prCards.pinned}
                proposals={railProposals.pinned}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {inline ? (
          // Docked composer card — same visual language as the EMPTY hero card
          // (a single flat surface) and the morph target
          // of its shared `layoutId`.
          <div className="shrink-0 px-4 pb-4">
            <motion.div
              layoutId={composerLayoutId}
              transition={{ layout: { type: 'spring', stiffness: 350, damping: 34 } }}
              className="relative mx-auto w-full max-w-[960px]"
              data-testid="agent-composer-dock"
            >
              <AgentComposer showModeBadge={false} queueEditRequest={queueEditRequest} />
            </motion.div>
          </div>
        ) : (
          <div className="relative shrink-0 border-t border-border/50 bg-surface/30 p-3" data-testid="agent-composer-dock">
            {/* Kanban floating panel: the project selector lives in the panel
                HEADER (next to the Agent title), so the composer hides its own. */}
            <AgentComposer hideProjectSelector queueEditRequest={queueEditRequest} />
          </div>
        )}
      </div>

      {/* Job/loop-run ref chip clicked: the mission-mode job detail modal,
          scoped to the mission's PINNED project (never the active one). */}
      {jobRef && (
        <Suspense fallback={null}>
          <JobDetailModal jobId={jobRef.jobId} projectId={jobRef.projectId} onClose={closeJobRef} />
        </Suspense>
      )}

      {/* Loop ref chip resolved (factory id, or a uuid that turned out to be a
          loop definition): the read-only loop preview — loops are app-global. */}
      {loopRef && (
        <Suspense fallback={null}>
          <LoopPreviewModal loop={loopRef} onClose={closeLoopRef} />
        </Suspense>
      )}

      {/* Activity chip clicked: the turn's execution log (tool calls with
          input/output previews + copy affordances). Same z-[65] portal tier. */}
      {activityOpen && <ActivityLog onClose={() => setActivityOpen(false)} />}
    </div>
  )
}
