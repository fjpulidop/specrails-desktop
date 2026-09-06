import { useMissionWindows } from '../../context/MissionWindowsContext'
import { readMissionScroll, saveMissionScroll, useMissionViewRevision } from '../../lib/mission-view-state'
import { ExternalLink } from 'lucide-react'
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { Bot, ShieldAlert, PackageOpen, Pin } from 'lucide-react'
import { useAgentChat } from '../../context/AgentChatContext'
import { useActiveTheme } from '../../context/ThemeContext'
import { useSmoothStream } from '../explore-spec/useSmoothStream'
import { useAgentRefActions } from '../../hooks/useAgentRefActions'
import { listAgentAttachments, type AgentAttachment } from '../../lib/agent-api'
import type { AgentRefTarget } from '../../lib/agent-refs'
import { AgentActivityChip } from './AgentActivityChip'
import { AgentActivityLogModal } from './AgentActivityLogModal'
import { AgentMessage } from './AgentMessage'
import { AgentQueuedMessage } from './AgentQueuedMessage'
import { AgentComposer } from './AgentComposer'
import { AgentThinkingHalo } from './AgentThinkingHalo'
import { AgentPrDecisionCard } from './AgentPrDecisionCard'
import { AgentPrPinnedDock, PrDecisionPill } from './AgentPrPinnedDock'
import { AgentConversationHeader } from './AgentConversationHeader'
import { derivePrCards, isPrDecisionPinned } from './agent-pr-pinning'

// Only loads when a job-ref chip is actually clicked — keeps the conversation
// chunk free of the log-explorer stack.
const JobDetailModal = lazy(() =>
  import('../JobDetailModal').then((m) => ({ default: m.JobDetailModal })),
)

// Only loads when a loop-ref chip resolves — keeps the loops stack out of the
// conversation chunk.
const LoopPreviewModal = lazy(() =>
  import('../loops/LoopPreviewModal').then((m) => ({ default: m.LoopPreviewModal })),
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
// server/agent-spec-framing.ts SPEC_FRAMING_MARKER_KIND.
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
        <button type="button" onClick={() => { void windows.focus(active.id) }} className="rounded-md bg-accent-primary px-4 py-2 text-sm text-white">{t('window.focus')}</button>
      </div>
    </div>
  )
  const frozen = !!active && !windows.isEditable(active.id)
  return <div className="relative flex h-full min-h-0 flex-col" inert={frozen || undefined} aria-busy={frozen || undefined}>
    <AgentConversationContent key={`${active?.id ?? '__new-mission__'}:${revision}`} variant={variant} />
  </div>
}

function AgentConversationContent({ variant }: { variant: 'floating' | 'inline' }) {
  const { t } = useTranslation('agent')
  const {
    active, messages, streamingText, isStreaming, liveTools, turnTools, queuedMessages,
    mcpEnabled, enablingMcp, enableMcpServer, providersReady, cycleTier, send,
  } = useAgentChat()
  // Execution-log modal (opened from the activity chip). While streaming it
  // shows the LIVE turn's tools; after settle it keeps showing the finished
  // turn's activity (turnTools) so an open modal never blanks at agent_done.
  const [activityOpen, setActivityOpen] = useState(false)
  const [queueEditRequest, setQueueEditRequest] = useState<{ conversationId: string; queueId: string; revision: number }>()
  const activityTools = liveTools.length > 0 ? liveTools : turnTools
  const scrollRef = useRef<HTMLDivElement>(null)
  const smoothed = useSmoothStream(streamingText, isStreaming)

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
  // identity is stable across streaming frames — no per-frame reparse). Pinned
  // cards (attention-demanding decisions) surface in the dock above the
  // composer; their history slot renders a slim reference marker instead.
  const prCards = useMemo(() => derivePrCards(messages), [messages])

  // Stick-to-bottom: only auto-scroll while the user is already near the bottom.
  const savedScroll = active ? readMissionScroll(active.id) : null
  const pinnedRef = useRef(savedScroll?.atBottom ?? true)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && savedScroll) el.scrollTop = savedScroll.atBottom ? el.scrollHeight : savedScroll.top
    return () => {
      if (el && active) saveMissionScroll(active.id, { top: el.scrollTop, atBottom: pinnedRef.current })
    }
  }, [active?.id])
  const onMessagesScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (active) saveMissionScroll(active.id, { top: el.scrollTop, atBottom: pinnedRef.current })
  }
  useEffect(() => {
    if (!pinnedRef.current) return
    scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight, behavior: 'auto' })
  }, [messages.length, smoothed, liveTools.length, queuedMessages.length])

  // Shift+Tab anywhere in the view (incl. the composer) cycles the tier ladder.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.shiftKey && (e.key === 'Tab' || e.code === 'Tab')) {
      e.preventDefault()
      e.stopPropagation()
      void cycleTier()
    }
  }

  const inline = variant === 'inline'
  // The inline surface caps the conversation column so it reads like Cursor's
  // centered thread on wide screens; the floating panel fills its own frame.
  const threadClass = inline
    ? 'mx-auto flex w-full max-w-[820px] flex-1 flex-col overflow-hidden'
    : 'flex flex-1 flex-col overflow-hidden'

  return (
    <div className={`flex h-full flex-col overflow-hidden ${inline ? '' : ''}`} onKeyDown={onKeyDown}>
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
          <button type="button" onClick={() => void enableMcpServer()} disabled={enablingMcp} className="rounded-md bg-accent-primary px-2 py-1 text-xs font-medium text-white disabled:opacity-60">
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
        <motion.div
          ref={scrollRef}
          onScroll={onMessagesScroll}
          initial={inline ? { opacity: 0, y: 8 } : false}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: 'easeOut' }}
          className="flex-1 space-y-5 overflow-y-auto px-4 py-4"
        >
          {messages.length === 0 && !isStreaming && (
            <div className="flex h-full flex-col items-center justify-center text-center text-foreground/50">
              <Bot className="mb-2 h-8 w-8 text-accent-primary/60" />
              <p className="text-sm font-medium text-foreground/70">{emptyTitle}</p>
              <p className="mt-1 max-w-[280px] text-xs">{t('emptyHint')}</p>
            </div>
          )}
          {messages.map((m, i) => {
            // `system` rows are app-authored records, not chat bubbles. Some
            // render as inline cards (the PR-decision card, safe-pr-review-flow);
            // others are pure bookkeeping and render as nothing at all — the
            // spec-framing marker that spends an answered frame is one of those.
            // Anything unrecognised is defensively skipped instead of leaking
            // raw JSON, with a one-shot warn so a NEW kind is noticed.
            if (m.role === 'system') {
              if (isSilentSystemRow(m.content)) return null
              const envelope = prCards.byMessageId.get(m.id)
              if (!envelope) {
                if (prCards.duplicateMessageIds.has(m.id)) return null
                if (!warnedSystemRows.has(m.id)) {
                  warnedSystemRows.add(m.id)
                  console.warn(`[agent-chat] skipping unrenderable system message ${m.id}`)
                }
                return null
              }
              // While the card demands attention it lives PINNED above the
              // composer — its chronological slot keeps a slim reference marker
              // (no double render). Unpinning returns the full card here.
              if (isPrDecisionPinned(envelope.decision)) {
                return (
                  <div
                    key={m.id}
                    data-testid="agent-pr-pinned-marker"
                    className="flex items-center gap-2 rounded-lg border border-border/40 bg-surface/30 px-3 py-1.5 text-[11px] text-foreground/45 backdrop-blur-sm"
                  >
                    <Pin className="h-3 w-3 shrink-0 text-accent-primary/50" />
                    <span className="min-w-0 flex-1 truncate">{t('prCard.pinned.marker')}</span>
                    <PrDecisionPill decision={envelope.decision} />
                  </div>
                )
              }
              return <AgentPrDecisionCard key={m.id} envelope={envelope} />
            }
            return (
              <AgentMessage
                key={m.id}
                role={m.role}
                content={m.content}
                createdAt={m.created_at}
                // Option chips are clickable only on the newest settled message —
                // a streaming turn suppresses them everywhere.
                isLast={!isStreaming && i === messages.length - 1}
                // Problem-frame readings stay affordable (but disabled) while a
                // turn streams, so the card doesn't silently go static mid-turn.
                isLatest={i === messages.length - 1}
                isStreaming={isStreaming}
                onPickOption={(option) => void send(option)}
                refsProjectId={refsProjectId}
                onOpenRef={onOpenRef}
                contextRefs={m.context_refs}
                deliveryStatus={m.delivery_status}
                deliveryReceipt={m.delivery_receipt}
                conversationId={m.conversation_id}
                attachments={(m.attachment_ids ?? []).map((id) => attachmentById.get(id)).filter((att): att is AgentAttachment => !!att)}
              />
            )
          })}
          {isStreaming && (
            <div className="space-y-2">
              {smoothed && <AgentMessage role="assistant" content={smoothed} streaming />}
              <AgentActivityChip
                tool={liveTools.length ? liveTools[liveTools.length - 1].tool : null}
                onClick={() => setActivityOpen(true)}
              />
            </div>
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

        {/* Pinned implementation-card slot — always visible above the composer
            while any delivery demands attention; animates away on unpin. */}
        <AnimatePresence initial={false}>
          {active && prCards.pinned.length > 0 && (
            <AgentPrPinnedDock
              key="agent-pr-pinned-dock"
              pinned={prCards.pinned}
              conversationId={active.id}
              inline={inline}
            />
          )}
        </AnimatePresence>

        {inline ? (
          // Docked composer card — same visual language as the EMPTY hero card
          // (rounded glass card, not an edge-to-edge bar) and the morph target
          // of its shared `layoutId`.
          <div className="shrink-0 px-4 pb-4">
            <motion.div
              layoutId="agent-composer-dock"
              transition={{ layout: { type: 'spring', stiffness: 350, damping: 34 } }}
              className="relative mx-auto w-full max-w-[680px] rounded-2xl border border-border/60 bg-card/90 p-3 shadow-2xl backdrop-blur-xl"
              data-testid="agent-composer-dock"
            >
              {/* Thinking halo (Settings ▸ Effects): the Builder's ring orbits the
                  WHOLE composer card while the agent thinks / writes — same
                  outer-edge treatment as the Builder's hero card. */}
              <AgentThinkingHalo active={isStreaming} radius="1rem" inset={-3} />
              <AgentComposer queueEditRequest={queueEditRequest} />
            </motion.div>
          </div>
        ) : (
          <div className="relative shrink-0 border-t border-border/50 bg-surface/30 p-3" data-testid="agent-composer-dock">
            <AgentThinkingHalo active={isStreaming} radius="0.75rem" inset={-2} />
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
      {activityOpen && (
        <AgentActivityLogModal
          tools={activityTools}
          streaming={isStreaming}
          onClose={() => setActivityOpen(false)}
        />
      )}
    </div>
  )
}
