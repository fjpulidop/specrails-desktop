import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { motion, AnimatePresence } from 'motion/react'
import { MessagesSquare, ChevronDown, Check, Search, Plus, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { compactRelativeTime, absoluteTime } from '../../lib/relative-time'
import { useAgentChat } from '../../context/AgentChatContext'
import type { AgentConversation } from '../../lib/agent-api'

/** Search only earns its row once the list is big enough to need it. */
const SEARCH_THRESHOLD = 8
/** An armed inline delete-confirm reverts on its own after this long. */
const CONFIRM_REVERT_MS = 3000

/**
 * Cursor-grade mission (conversation) dropdown for the floating panel header —
 * the visual sibling of `AgentProjectSelector` (same trigger height/radius,
 * same glass dropdown). Lists conversations newest-first with relative time, a
 * live pulse dot while that mission's agent is working, and a queued-count
 * badge; per-row two-step inline delete; "New mission" on top; search appears
 * above SEARCH_THRESHOLD; full listbox keyboard nav (↑/↓/Enter/Esc).
 *
 * Agent Mode intentionally does NOT mount this — its ArcSidebar conversation
 * tree already switches/deletes missions; the floating Board panel was the gap.
 */
export function AgentMissionSelector() {
  const { t } = useTranslation('agent')
  const {
    conversations, active, selectConversation, deleteConversation,
    startNewConversation, streamingConversationIds, liveByConversation,
  } = useAgentChat()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  // Newest-first even when a background turn bumps updated_at between refreshes.
  const sorted = useMemo(() => {
    const ts = (c: AgentConversation) => {
      const n = Date.parse(c.updated_at)
      return Number.isNaN(n) ? 0 : n
    }
    return [...conversations].sort((a, b) => ts(b) - ts(a))
  }, [conversations])

  const showSearch = conversations.length > SEARCH_THRESHOLD
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sorted
    const fallback = t('mission.untitled').toLowerCase()
    return sorted.filter((c) => (c.title?.trim().toLowerCase() || fallback).includes(q))
  }, [sorted, query, t])

  // Keyboard option space: 0 = "New mission", 1..n = filtered rows.
  const optionCount = filtered.length + 1

  const disarmConfirm = useCallback(() => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    confirmTimerRef.current = null
    setConfirmingId(null)
  }, [])

  useEffect(() => () => { if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current) }, [])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeDropdown()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const openDropdown = () => {
    // Land the highlight on the current mission so ↑/↓ start from context.
    const idx = active ? sorted.findIndex((c) => c.id === active.id) : -1
    setHighlighted(idx >= 0 ? idx + 1 : 0)
    setOpen(true)
  }

  const closeDropdown = () => {
    setOpen(false)
    setQuery('')
    disarmConfirm()
  }

  const chooseMission = (id: string) => {
    if (id !== active?.id) void selectConversation(id)
    closeDropdown()
  }

  const chooseNew = () => {
    // The panel header's + flow: EMPTY compose screen, next send creates.
    startNewConversation(null)
    closeDropdown()
  }

  const armDelete = (id: string) => {
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
    setConfirmingId(id)
    confirmTimerRef.current = setTimeout(() => {
      setConfirmingId(null)
      confirmTimerRef.current = null
    }, CONFIRM_REVERT_MS)
  }

  const confirmDelete = async (id: string) => {
    disarmConfirm()
    const wasActive = active?.id === id
    // Newest remaining (sorted is newest-first) — the handoff target.
    const next = sorted.find((c) => c.id !== id) ?? null
    try {
      // The route aborts any live turn server-side before removing the row.
      await deleteConversation(id)
      if (wasActive) {
        if (next) await selectConversation(next.id)
        // else: context already reset to the EMPTY compose state.
      }
    } catch {
      toast.error(t('mission.deleteFailed'))
    }
  }

  const activateHighlighted = () => {
    if (highlighted === 0) chooseNew()
    else {
      const c = filtered[highlighted - 1]
      if (c) chooseMission(c.id)
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        openDropdown()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const delta = e.key === 'ArrowDown' ? 1 : -1
      setHighlighted((h) => (h + delta + optionCount) % optionCount)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setHighlighted(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setHighlighted(optionCount - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activateHighlighted()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      // First Esc disarms an armed confirm; the next one closes the list.
      if (confirmingId) disarmConfirm()
      else {
        closeDropdown()
        triggerRef.current?.focus()
      }
    }
  }

  const triggerLabel = active?.title?.trim() || t('mission.untitled')

  return (
    <div className="relative min-w-0" ref={rootRef} data-agent-interactive onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        data-testid="mission-trigger"
        onClick={() => (open ? closeDropdown() : openDropdown())}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="agent-mission-listbox"
        title={t('mission.label')}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-foreground hover:bg-surface/70"
      >
        <MessagesSquare className="h-3.5 w-3.5 shrink-0 text-accent-primary" />
        <span className="min-w-0 max-w-[150px] truncate">{triggerLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground/50" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className="absolute left-0 top-full z-10 mt-1 w-72 overflow-hidden rounded-xl border border-border/60 bg-card/95 shadow-2xl backdrop-blur-xl"
          >
            {showSearch && (
              <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
                <Search className="h-3.5 w-3.5 text-foreground/40" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => { setQuery(e.target.value); setHighlighted(0) }}
                  placeholder={t('mission.searchPlaceholder')}
                  className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/40"
                />
              </div>
            )}
            <div
              id="agent-mission-listbox"
              role="listbox"
              aria-label={t('mission.label')}
              aria-activedescendant={`agent-mission-opt-${highlighted}`}
              className="max-h-72 overflow-y-auto py-1"
            >
              <motion.div
                id="agent-mission-opt-0"
                role="option"
                aria-selected={false}
                tabIndex={-1}
                data-testid="mission-new"
                onClick={chooseNew}
                onMouseEnter={() => setHighlighted(0)}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.14 }}
                className={`flex w-full cursor-pointer items-center gap-2.5 px-3 py-1.5 text-left text-sm font-medium text-foreground ${highlighted === 0 ? 'bg-surface/70' : 'hover:bg-surface/70'}`}
              >
                <Plus className="h-4 w-4 text-accent-primary" />
                <span className="flex-1 truncate">{t('mission.new')}</span>
              </motion.div>
              {filtered.length > 0 && <div className="mx-3 my-1 h-px bg-border/50" aria-hidden />}
              {filtered.length === 0 && query.trim() !== '' && (
                <div className="px-3 py-2 text-xs text-foreground/40">{t('mission.noMatches')}</div>
              )}
              {filtered.map((c, i) => (
                <MissionRow
                  key={c.id}
                  conversation={c}
                  index={i + 1}
                  highlighted={highlighted === i + 1}
                  activeId={active?.id ?? null}
                  streaming={streamingConversationIds.has(c.id)}
                  queuedCount={liveByConversation.get(c.id)?.queued.length ?? 0}
                  confirming={confirmingId === c.id}
                  onHover={() => setHighlighted(i + 1)}
                  onSelect={() => chooseMission(c.id)}
                  onArmDelete={() => armDelete(c.id)}
                  onConfirmDelete={() => void confirmDelete(c.id)}
                  onCancelDelete={disarmConfirm}
                />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function MissionRow({
  conversation,
  index,
  highlighted,
  activeId,
  streaming,
  queuedCount,
  confirming,
  onHover,
  onSelect,
  onArmDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  conversation: AgentConversation
  index: number
  highlighted: boolean
  activeId: string | null
  streaming: boolean
  queuedCount: number
  confirming: boolean
  onHover: () => void
  onSelect: () => void
  onArmDelete: () => void
  onConfirmDelete: () => void
  onCancelDelete: () => void
}) {
  const { t } = useTranslation('agent')
  const label = conversation.title?.trim() || t('mission.untitled')
  const isActive = conversation.id === activeId

  if (confirming) {
    // Two-step inline confirm (AgentPrDecisionCard idiom): the row swaps to a
    // destructive prompt with ✓/✕ and reverts on its own after 3s.
    return (
      <div
        id={`agent-mission-opt-${index}`}
        role="option"
        aria-selected={isActive}
        data-testid={`mission-row-${conversation.id}`}
        className="flex w-full items-center gap-2 bg-destructive/10 px-3 py-1.5 text-sm"
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1 truncate text-xs text-destructive">
          {streaming ? t('mission.deleteLiveConfirm') : t('mission.deleteConfirm')}
        </span>
        <button
          type="button"
          data-testid="mission-confirm-yes"
          onClick={(e) => { e.stopPropagation(); onConfirmDelete() }}
          aria-label={t('mission.confirmDelete')}
          className="rounded-md p-1 text-destructive hover:bg-destructive/20"
        >
          <Check className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          data-testid="mission-confirm-no"
          onClick={(e) => { e.stopPropagation(); onCancelDelete() }}
          aria-label={t('mission.cancelDelete')}
          className="rounded-md p-1 text-foreground/60 hover:bg-surface"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  return (
    <motion.div
      id={`agent-mission-opt-${index}`}
      role="option"
      aria-selected={isActive}
      tabIndex={-1}
      data-testid={`mission-row-${conversation.id}`}
      onClick={onSelect}
      onMouseEnter={onHover}
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.14, delay: Math.min(index * 0.03, 0.18) }}
      className={`group flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground ${highlighted ? 'bg-surface/70' : 'hover:bg-surface/70'}`}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className="shrink-0 tabular-nums text-xs text-foreground/40"
        title={absoluteTime(conversation.updated_at)}
      >
        {compactRelativeTime(conversation.updated_at)}
      </span>
      {streaming && (
        <span
          data-testid={`mission-live-${conversation.id}`}
          aria-label={t('mission.working')}
          className="relative flex h-1.5 w-1.5 shrink-0"
        >
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent-primary opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent-primary" />
        </span>
      )}
      {queuedCount > 0 && (
        <span
          data-testid={`mission-queued-${conversation.id}`}
          aria-label={t('mission.queuedBadge', { n: queuedCount })}
          title={t('mission.queuedBadge', { n: queuedCount })}
          className="shrink-0 rounded-full border border-border/60 bg-surface px-1.5 text-[9px] font-semibold leading-4 text-foreground/60"
        >
          {queuedCount}
        </span>
      )}
      {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-accent-primary" />}
      <button
        type="button"
        data-testid={`mission-delete-${conversation.id}`}
        onClick={(e) => { e.stopPropagation(); onArmDelete() }}
        aria-label={t('mission.delete', { title: label })}
        className="shrink-0 rounded-md p-0.5 text-foreground/50 opacity-0 transition-opacity hover:bg-surface hover:text-destructive focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </motion.div>
  )
}
