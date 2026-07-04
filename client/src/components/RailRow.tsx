import { useState, useRef, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { useDroppable, useDndContext } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { GripVertical, Trash2, ArrowLeft } from 'lucide-react'
import { RailControls, type RailMode, type RailStatus } from './RailControls'
import { effectiveLoopId } from '../lib/rail-loops'
import { SpecCard } from './SpecCard'
import { RailProfileSelector } from './agents/RailProfileSelector'
import { RailEngineSelector } from './agents/RailEngineSelector'
import { RailModelSelector, type UltracodeModel } from './agents/RailModelSelector'
import { RailLoopSelector } from './agents/RailLoopSelector'
import { RailExecutionInfo } from './RailExecutionInfo'
import { RailEffortSelector, type ReasoningEffort } from './agents/RailEffortSelector'
import { RailPrDecisionStrip } from './RailPrDecisionStrip'
import { providerSupportsReasoningEffort } from '../lib/provider-capabilities'
import { modelsForProvider, defaultModelForProvider } from '../lib/loop-run-models'
import type { LocalTicket, RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../types'
import type { RailPrActResult } from '../context/RailPrDecisionContext'

const LONG_PRESS_MS = 800
const SWIPE_THRESHOLD = 60

interface RailRowProps {
  id: string
  label: string
  tickets: LocalTicket[]
  mode: RailMode
  status: RailStatus
  activeJobId?: string
  profileName?: string | null
  /** Selected AI engine for this rail (multi-provider). null/undefined = primary. */
  aiEngine?: string | null
  /** Selected model for ultracode rails. null/undefined = default (sonnet). */
  ultracodeModel?: UltracodeModel | null
  /** Selected model for custom loop rails. null/undefined = provider default. */
  loopModel?: string | null
  /** Per-rail "Interactive" toggle (ultracode only). */
  /** Installed providers — when >1 the rail header shows an AI engine selector. */
  providers?: readonly string[]
  /** When true, the rail offers "Loop" mode (run a published loop). */
  loopAvailable?: boolean
  /** Selected published-loop id (loop mode). */
  selectedLoopId?: string | null
  /** Selected reasoning effort (loop mode). */
  reasoningEffort?: ReasoningEffort | null
  /** Merge-back progress for a parallel/isolated launch (null when none). */
  worktreeSummary?: { merged: number; needsReview: number; failed: number; reported: number } | null
  /** Active ask-first PR decision for this rail (null when none). */
  prDecision?: RailPrStateSnapshot | null
  /** POSTs /rails/pr-decision for this rail (already bound to its railIndex). */
  onPrDecision?: (action: RailPrDecisionAction, expectedDecision: RailPrDecision) => Promise<RailPrActResult>
  /** Live execution metrics (elapsed/steps/lines) while running — same WS source
   *  as the Jobs view. Null when not running / no data. */
  executionMetric?: import('../context/RailMetricsContext').RailExecMetric | null
  jiggleMode: boolean
  dragHandleListeners?: Record<string, Function>
  dragHandleAttributes?: Record<string, any>
  /**
   * Visual density. `'normal'` (default) renders the full rail card with
   * a droppable body and embedded spec cards. `'compact'` renders a tall
   * premium mini-card with only the header controls (name, Mode dropdown,
   * Profile picker, Play/Stop/Log, spec counter) — used when the dashboard
   * splitter has collapsed the rails panel below ~220 px wide. Tickets are
   * still reachable via the Move-to-Rail popover on dashboard postits.
   */
  density?: 'normal' | 'compact'
  onModeChange: (mode: RailMode) => void
  onProfileChange?: (profileName: string | null) => void
  onEngineChange?: (aiEngine: string) => void
  onUltracodeModelChange?: (model: UltracodeModel) => void
  onLoopModelChange?: (model: string) => void
  onLoopChange?: (loopId: string) => void
  onEffortChange?: (effort: ReasoningEffort) => void
  onToggle: () => void
  onTicketClick: (ticket: LocalTicket) => void
  onDelete: () => void
  onLongPress: () => void
  onRename: (newLabel: string) => void
  /** Optional — when wired, right-clicking a compact-tier ticket pill opens
   *  a context menu offering "← Move to Specs" which removes the ticket
   *  from this rail and returns it to the specs list. */
  onTicketMoveToSpecs?: (ticketId: number) => void
}

export function RailRow({
  id, label, tickets, mode, status, activeJobId, profileName, aiEngine, ultracodeModel, loopModel, providers,
  loopAvailable, selectedLoopId, reasoningEffort, worktreeSummary, prDecision, onPrDecision, executionMetric, jiggleMode,
  dragHandleListeners, dragHandleAttributes, density = 'normal',
  onModeChange, onProfileChange, onEngineChange, onUltracodeModelChange, onLoopModelChange, onLoopChange, onEffortChange, onToggle, onTicketClick, onDelete, onLongPress, onRename,
  onTicketMoveToSpecs,
}: RailRowProps) {
  const { t } = useTranslation('dashboard')
  // Codex has no agent profiles — hide the profile selector when this rail's
  // engine is codex (the engine selector is shown only on multi-provider projects).
  const profileApplies = (aiEngine ?? providers?.[0]) !== 'codex'
  // Ultracode is Claude-only. Effective engine = explicit rail override, else
  // the project's primary provider (providers[0]); default to claude when
  // unknown (single-provider claude projects pass no providers list).
  const engineIsClaude = (aiEngine ?? providers?.[0] ?? 'claude') === 'claude'
  // Reasoning effort applies only to providers with a per-invocation knob
  // (codex native, claude soft) — NOT gemini, so its selector is hidden there.
  const effortApplies = providerSupportsReasoningEffort(aiEngine ?? providers?.[0] ?? 'claude')
  // Which secondary selectors are visible right now. When any is shown we move
  // them onto their own row beneath the rail name so the header doesn't cram
  // engine + model + mode segments + play into a single line.
  const showEngineSel = !!onEngineChange && status !== 'running' && (providers?.length ?? 0) > 1
  const showProfileSel = !!onProfileChange && status !== 'running' && profileApplies && mode !== 'loop'
  const showModelSel = !!onUltracodeModelChange && status !== 'running' && mode === 'ultracode' && engineIsClaude
  // Model picker for custom loop rails (non-factory loops) — provider-aware.
  const showLoopModelSel = !!onLoopModelChange && status !== 'running' && mode === 'loop'
  const loopModelProvider = aiEngine ?? providers?.[0] ?? 'claude'
  const loopModelOptions = modelsForProvider(loopModelProvider)
  const effectiveLoopModel = loopModel ?? defaultModelForProvider(loopModelProvider)
  const loopModelPickerEl = showLoopModelSel && onLoopModelChange ? (
    <select
      data-testid="loop-model-selector"
      aria-label={t('railSelectors.loopModelTitle')}
      value={effectiveLoopModel}
      onChange={(e) => onLoopModelChange(e.target.value)}
      className="h-5 text-[10px] rounded border border-border/50 bg-transparent text-muted-foreground hover:text-foreground pr-4 pl-1 focus:outline-none focus:ring-1 focus:ring-primary/40"
    >
      {loopModelOptions.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
    </select>
  ) : null
  // The rail's unified Loop picker (factory + custom loops) replaces the old mode
  // segmented control — always shown when idle. Effort shows for custom loops.
  const showLoopSel = !!onLoopChange && status !== 'running'
  // Only the engine + model selectors crowd the header (and always render when
  // their condition holds). The profile selector self-hides when the project
  // has no profiles, so it can't trigger an empty row — it rides along the
  // second row when one exists, else stays inline on the top row.
  const hasSelectorRow = showEngineSel || showModelSel || showLoopModelSel || showLoopSel
  // Compact-tier right-click context menu state. `{ticketId, x, y}` while
  // open, `null` otherwise. Closed by outside-click, Escape, or selection.
  const [ticketCtxMenu, setTicketCtxMenu] = useState<{ ticketId: number; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!ticketCtxMenu) return
    function onPointer(e: PointerEvent) {
      // Don't close when the pointerdown lands inside the popup itself —
      // otherwise the menu unmounts before the menuitem's click handler fires.
      const target = e.target as Element | null
      if (target?.closest('[role="menu"]')) return
      setTicketCtxMenu(null)
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setTicketCtxMenu(null) }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [ticketCtxMenu])
  const { isOver, setNodeRef } = useDroppable({ id })
  // True whenever a ticket (numeric id) is being dragged anywhere in the
  // dashboard's DndContext — used to surface a subtle "available drop target"
  // hint on every rail body, not just the one under the cursor.
  const { active } = useDndContext()
  const ticketDragActive = typeof active?.id === 'number'
  const [swipeX, setSwipeX] = useState(0)
  const [swiping, setSwiping] = useState(false)
  const [showSwipeDelete, setShowSwipeDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFiredRef = useRef(false)

  const isRunning = status === 'running'
  const canDelete = !isRunning

  // ── Long press detection ──────────────────────────────────────────────────
  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }, [])

  const startLongPress = useCallback(() => {
    if (!canDelete) return
    longPressFiredRef.current = false
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true
      onLongPress()
      longPressTimerRef.current = null
    }, LONG_PRESS_MS)
  }, [canDelete, onLongPress])

  // ── Touch handlers (swipe + long press) ───────────────────────────────────
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const touch = e.touches[0]
    touchStartRef.current = { x: touch.clientX, y: touch.clientY }
    setSwiping(false)
    setShowSwipeDelete(false)
    startLongPress()
  }, [startLongPress])

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const touch = e.touches[0]
    const dx = touch.clientX - touchStartRef.current.x
    const dy = touch.clientY - touchStartRef.current.y

    // Cancel long press if finger moves
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearLongPress()

    // Horizontal swipe left
    if (canDelete && dx < -10 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      setSwiping(true)
      // Apply rubber-band resistance past threshold
      const raw = Math.max(dx, -150)
      setSwipeX(raw)
    }
  }, [canDelete, clearLongPress])

  const handleTouchEnd = useCallback(() => {
    clearLongPress()
    if (swiping) {
      if (swipeX < -SWIPE_THRESHOLD && canDelete) {
        setShowSwipeDelete(true)
        setSwipeX(-80) // snap to reveal delete button
      } else {
        setSwipeX(0)
        setShowSwipeDelete(false)
      }
      setSwiping(false)
    }
    touchStartRef.current = null
  }, [swipeX, swiping, canDelete, clearLongPress])

  // ── Mouse handlers (long press only — no mouse swipe) ─────────────────────
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // Only start long press on the rail header area, not on buttons
    if ((e.target as HTMLElement).closest('button')) return
    startLongPress()
  }, [startLongPress])

  const handleMouseUp = useCallback(() => {
    // Only clear the timer — don't exit jiggle mode (it persists after release)
    clearLongPress()
  }, [clearLongPress])

  // Suppress the click event that follows a successful long press, so it
  // doesn't bubble up to RailsBoard's background click handler and
  // immediately exit jiggle mode.
  const handleClick = useCallback((e: React.MouseEvent) => {
    if (longPressFiredRef.current) {
      e.stopPropagation()
      longPressFiredRef.current = false
      return
    }
    if (showSwipeDelete) {
      setShowSwipeDelete(false)
      setSwipeX(0)
    }
  }, [showSwipeDelete])

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowSwipeDelete(false)
    setSwipeX(0)
    onDelete()
  }, [onDelete])

  // ── Compact density rendering ─────────────────────────────────────────────
  // Independent jiggle phase derived from the rail id so neighbouring rails
  // wobble out of sync instead of all dancing in lockstep.
  const railJigglePhaseMs = jiggleMode && canDelete
    ? -((Array.from(id).reduce((a, c) => a + c.charCodeAt(0), 0) * 53) % 400)
    : undefined
  const railJiggleStyle = railJigglePhaseMs !== undefined
    ? ({ animationDelay: `${railJigglePhaseMs}ms` } as React.CSSProperties)
    : undefined

  if (density === 'compact') {
    return (
      <div
        ref={setNodeRef}
        data-testid={`rail-row-compact-${id}`}
        data-density="compact"
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onClick={handleClick}
        style={railJiggleStyle}
        className={`group relative flex flex-col gap-1.5 rounded-xl border bg-card p-2.5 transition-all ${
          isOver
            ? 'border-accent-info/60 shadow-[0_0_0_1px_hsl(var(--accent-info)/0.35),0_0_14px_hsl(var(--accent-info)/0.18)]'
            : ticketDragActive
              ? 'border-dashed border-accent-info/35'
              : isRunning
                ? 'border-accent-success/40 shadow-sm'
                : 'border-border/40 hover:border-accent-info/30 hover:shadow-md'
        } ${jiggleMode && canDelete ? 'animate-jiggle' : ''}`}
      >
        {/* Header line: drag grip + status dot + label */}
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors shrink-0"
            {...dragHandleListeners}
            {...dragHandleAttributes}
          >
            <GripVertical className="w-3 h-3" />
          </button>
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-300 ${
              isRunning
                ? 'bg-accent-success shadow-[0_0_4px_hsl(var(--accent-success)/0.8)] animate-pulse'
                : status === 'failed'
                  ? 'bg-accent-warning shadow-[0_0_4px_hsl(var(--accent-warning)/0.6)]'
                  : 'bg-muted-foreground/25'
            }`}
            aria-hidden
          />
          {editing ? (
            <form
              className="flex items-center gap-0.5 min-w-0 flex-1"
              onSubmit={(e) => {
                e.preventDefault()
                const trimmed = editValue.trim()
                if (trimmed) onRename(trimmed)
                setEditing(false)
              }}
            >
              <input
                ref={inputRef}
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={() => {
                  const trimmed = editValue.trim()
                  if (trimmed) onRename(trimmed)
                  setEditing(false)
                }}
                onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }}
                className="flex-1 min-w-0 text-xs font-medium bg-transparent border-b border-accent-info/60 outline-none text-foreground/90 px-0.5"
                autoFocus
              />
            </form>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                const suffix = label.startsWith('Rail ') ? label.slice(5) : label
                setEditValue(suffix)
                setEditing(true)
                setTimeout(() => inputRef.current?.select(), 0)
              }}
              className="flex-1 min-w-0 text-left text-xs font-medium text-foreground/90 hover:text-foreground truncate"
              title={label}
            >
              {label}
            </button>
          )}
        </div>

        {/* Assigned spec id pills — clickable, opens the ticket modal */}
        {tickets.length > 0 && (
          <div className="flex flex-wrap gap-1" data-testid={`rail-row-compact-tickets-${id}`}>
            {tickets.map((ticket) => (
              <button
                key={ticket.id}
                type="button"
                onClick={(e) => { e.stopPropagation(); onTicketClick(ticket) }}
                onMouseDown={(e) => {
                  // Right-click (button 2) opens the context menu directly.
                  // `onContextMenu` is suppressed in the Tauri webview by
                  // default, so we trigger off `mousedown` to work in both
                  // the browser and the desktop app.
                  if (e.button === 2 && onTicketMoveToSpecs) {
                    e.preventDefault()
                    e.stopPropagation()
                    setTicketCtxMenu({ ticketId: ticket.id, x: e.clientX, y: e.clientY })
                  }
                }}
                onContextMenu={(e) => {
                  // Always prevent the OS / Tauri default menu, even when
                  // the popup was already opened via mousedown above.
                  if (!onTicketMoveToSpecs) return
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onPointerDown={(e) => e.stopPropagation()}
                title={`#${ticket.id} ${ticket.title}`}
                className="inline-flex items-center px-1.5 py-0.5 rounded-md text-[10px] font-mono font-medium border border-accent-info/30 bg-accent-info/10 text-accent-info hover:bg-accent-info/20 hover:border-accent-info/60 transition-colors"
              >
                #{ticket.id}
              </button>
            ))}
          </div>
        )}

        {/* Right-click context menu for assigned ticket pills.
            Portal'd to document.body so `position: fixed` is always relative
            to the viewport, regardless of any transformed ancestor (dnd-kit
            sortable, animation, etc.) that would otherwise turn the rail row
            into the fixed-positioning containing block. */}
        {ticketCtxMenu && onTicketMoveToSpecs && createPortal(
          <div
            role="menu"
            data-testid={`rail-row-compact-context-menu-${id}`}
            className="fixed z-[200] min-w-[160px] rounded-lg border border-border/60 bg-card/95 backdrop-blur shadow-xl shadow-black/40 p-1"
            style={{
              top: Math.min(ticketCtxMenu.y, window.innerHeight - 60),
              left: Math.min(ticketCtxMenu.x, window.innerWidth - 180),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                onTicketMoveToSpecs(ticketCtxMenu.ticketId)
                setTicketCtxMenu(null)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs text-accent-warning hover:bg-accent-warning/10 transition-colors"
            >
              <ArrowLeft className="w-3 h-3" aria-hidden />
              {t('railRow.moveToSpecs')}
            </button>
          </div>,
          document.body
        )}

        {/* Mode dropdown + Engine + Profile picker (stacked) */}
        <div className="flex flex-col gap-1">
          {onEngineChange && !isRunning && (
            <RailEngineSelector value={aiEngine ?? null} providers={providers ?? []} onChange={onEngineChange} />
          )}
          {onProfileChange && !isRunning && profileApplies && mode !== 'loop' && (
            <RailProfileSelector value={profileName ?? null} onChange={onProfileChange} />
          )}
          {onUltracodeModelChange && !isRunning && mode === 'ultracode' && engineIsClaude && (
            <RailModelSelector value={ultracodeModel ?? null} onChange={onUltracodeModelChange} />
          )}
          {loopModelPickerEl}
          {onLoopChange && !isRunning && (
            <RailLoopSelector
              value={effectiveLoopId(selectedLoopId, mode)}
              onChange={onLoopChange}
              ultracodeAvailable={engineIsClaude}
              loopsEnabled={loopAvailable}
            />
          )}
          {onEffortChange && !isRunning && mode === 'loop' && effortApplies && (
            <RailEffortSelector value={reasoningEffort ?? null} onChange={onEffortChange} />
          )}
          <RailControls
            mode={mode}
            status={status}
            activeJobId={activeJobId}
            ticketCount={tickets.length}
            ultracodeAvailable={engineIsClaude}
            loopAvailable={loopAvailable}
            onModeChange={onModeChange}
                onToggle={onToggle}
          />
        </div>

        {/* Live execution metrics (elapsed · steps · lines) — same WS source as Jobs */}
        {isRunning && executionMetric && <RailExecutionInfo metric={executionMetric} />}

        {/* Parallel/isolated merge-back progress */}
        {worktreeSummary && (worktreeSummary.merged > 0 || worktreeSummary.needsReview > 0) && (
          <div className="mt-1 flex items-center gap-2 text-[10px]" data-testid="rail-worktree-summary">
            {worktreeSummary.merged > 0 && (
              <span className="text-accent-success">{t('railControls.worktreesMerged', { count: worktreeSummary.merged })}</span>
            )}
            {worktreeSummary.needsReview > 0 && (
              <span className="text-accent-warning">{t('railControls.worktreesNeedsReview', { count: worktreeSummary.needsReview })}</span>
            )}
          </div>
        )}

        {/* Ask-first PR decision strip (safe-pr-review-flow) */}
        {prDecision && onPrDecision && (
          <div className="mt-1">
            <RailPrDecisionStrip decision={prDecision} density="compact" act={onPrDecision} />
          </div>
        )}

        {/* Jiggle-mode delete button */}
        {jiggleMode && canDelete && (
          <button
            type="button"
            onClick={handleDeleteClick}
            className="absolute -top-1 -right-1 w-5 h-5 flex items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm hover:opacity-90 transition-opacity"
            aria-label={t('railRow.deleteRail', { label })}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
    )
  }

  return (
    <div
      className="relative overflow-hidden rounded-xl"
      onClick={handleClick}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onMouseDown={handleMouseDown}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Swipe-revealed delete button (behind the rail) */}
      {canDelete && (showSwipeDelete || swipeX < 0) && (
        <div className="absolute inset-y-0 right-0 w-20 flex items-center justify-center bg-red-500/90 rounded-r-xl z-0">
          <button
            type="button"
            onClick={handleDeleteClick}
            className="flex flex-col items-center gap-1 text-white"
          >
            <Trash2 className="w-5 h-5" />
            <span className="text-[9px] font-medium">{t('common:actions.delete')}</span>
          </button>
        </div>
      )}

      {/* Main rail content (slides left on swipe). Solid `bg-card`
          background (no backdrop-blur) so the card looks identical
          regardless of the page-background gradient behind it. */}
      <div
        className={`relative z-10 flex flex-col rounded-xl border overflow-hidden bg-card ${
          jiggleMode && canDelete ? 'animate-jiggle' : ''
        } ${
          isOver
            ? 'border-primary/50 shadow-[0_0_0_1px_hsl(var(--primary)/0.25),0_0_12px_hsl(var(--primary)/0.08)]'
            : 'border-border/40 hover:border-border/60'
        }`}
        style={{
          transform: swipeX < 0 ? `translateX(${swipeX}px)` : undefined,
          transition: swiping ? 'none' : 'transform 0.3s cubic-bezier(0.25, 0.1, 0.25, 1)',
          ...(railJigglePhaseMs !== undefined ? { animationDelay: `${railJigglePhaseMs}ms` } : {}),
        }}
      >
        {/* Row header — name + mode/play on top, secondary selectors on a
            recessed config strip below so nothing crams together. */}
        <div className="flex flex-col border-b border-border/30 bg-gradient-to-r from-muted/30 to-transparent shrink-0">
          <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              className="touch-none cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/60 transition-colors -ml-1"
              {...dragHandleListeners}
              {...dragHandleAttributes}
            >
              <GripVertical className="w-3.5 h-3.5" />
            </button>
            <div
              className={`w-1.5 h-1.5 rounded-full shrink-0 transition-all duration-300 ${
                status === 'running' ? 'bg-emerald-400 shadow-[0_0_4px_hsl(142_70%_56%/0.8)] animate-pulse' : status === 'failed' ? 'bg-amber-400 shadow-[0_0_4px_hsl(38_92%_50%/0.6)]' : 'bg-muted-foreground/25'
              }`}
            />
            {editing ? (
              <form
                className="flex items-center gap-0.5"
                onSubmit={(e) => {
                  e.preventDefault()
                  const trimmed = editValue.trim()
                  if (trimmed) onRename(trimmed)
                  setEditing(false)
                }}
              >
                <span className="text-xs font-medium text-foreground/50">Rail </span>
                <input
                  ref={inputRef}
                  type="text"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={() => {
                    const trimmed = editValue.trim()
                    if (trimmed) onRename(trimmed)
                    setEditing(false)
                  }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { setEditing(false) } }}
                  className="w-24 text-xs font-medium bg-transparent border-b border-primary/50 outline-none text-foreground/80 px-0.5"
                  autoFocus
                />
              </form>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  // Extract suffix after "Rail " prefix for editing
                  const suffix = label.startsWith('Rail ') ? label.slice(5) : label
                  setEditValue(suffix)
                  setEditing(true)
                  setTimeout(() => inputRef.current?.select(), 0)
                }}
                className="text-xs font-medium text-foreground/80 hover:text-foreground hover:underline decoration-dotted underline-offset-2 cursor-text transition-colors"
              >
                {label}
              </button>
            )}
            {tickets.length > 0 && (
              <span className="text-[9px] text-muted-foreground bg-muted/30 rounded-full px-1.5 py-0.5 leading-none">
                {tickets.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Profile stays inline when no second row exists (it self-hides
                with no profiles, so it never leaves an empty gap here). */}
            {!hasSelectorRow && showProfileSel && onProfileChange && (
              <RailProfileSelector value={profileName ?? null} onChange={onProfileChange} />
            )}
            <RailControls mode={mode} status={status} activeJobId={activeJobId} ticketCount={tickets.length} ultracodeAvailable={engineIsClaude} loopAvailable={loopAvailable} onModeChange={onModeChange} onToggle={onToggle} />
            {/* Jiggle-mode delete button */}
            {jiggleMode && canDelete && (
              <button
                type="button"
                onClick={handleDeleteClick}
                className="w-5 h-5 flex items-center justify-center rounded-full bg-red-500 text-white shadow-sm hover:bg-red-600 transition-colors"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
          </div>

          {/* Live execution metrics (elapsed · steps · lines) — same WS source as Jobs */}
          {isRunning && executionMetric && (
            <div className="px-3 pb-1"><RailExecutionInfo metric={executionMetric} /></div>
          )}
          {/* Parallel/isolated merge-back progress */}
          {worktreeSummary && (worktreeSummary.merged > 0 || worktreeSummary.needsReview > 0) && (
            <div className="px-3 pb-1 flex items-center gap-2 text-[10px]">
              {worktreeSummary.merged > 0 && (
                <span className="text-accent-success">{t('railControls.worktreesMerged', { count: worktreeSummary.merged })}</span>
              )}
              {worktreeSummary.needsReview > 0 && (
                <span className="text-accent-warning">{t('railControls.worktreesNeedsReview', { count: worktreeSummary.needsReview })}</span>
              )}
            </div>
          )}

          {/* Ask-first PR decision strip (safe-pr-review-flow) */}
          {prDecision && onPrDecision && (
            <div className="px-3 pb-1.5">
              <RailPrDecisionStrip decision={prDecision} density="normal" act={onPrDecision} />
            </div>
          )}

          {/* Secondary selector strip (engine / profile / ultracode model).
              A recessed bar with its own divider + faint inset background so it
              reads as the rail's config row instead of floating controls. */}
          {hasSelectorRow && (
            <div className="flex items-center flex-wrap gap-x-3 gap-y-1 px-3 py-1.5 border-t border-border/20 bg-background/20">
              {showEngineSel && onEngineChange && (
                <RailEngineSelector value={aiEngine ?? null} providers={providers ?? []} onChange={onEngineChange} />
              )}
              {hasSelectorRow && showProfileSel && onProfileChange && (
                <RailProfileSelector value={profileName ?? null} onChange={onProfileChange} />
              )}
              {showModelSel && onUltracodeModelChange && (
                <RailModelSelector value={ultracodeModel ?? null} onChange={onUltracodeModelChange} />
              )}
              {loopModelPickerEl}
              {showLoopSel && onLoopChange && (
                <RailLoopSelector
                  value={effectiveLoopId(selectedLoopId, mode)}
                  onChange={onLoopChange}
                  ultracodeAvailable={engineIsClaude}
                  loopsEnabled={loopAvailable}
                />
              )}
              {mode === 'loop' && !isRunning && effortApplies && onEffortChange && (
                <RailEffortSelector value={reasoningEffort ?? null} onChange={onEffortChange} />
              )}
            </div>
          )}
        </div>

        {/* Droppable body */}
        <div
          ref={setNodeRef}
          data-drop-target={ticketDragActive ? 'available' : undefined}
          className={`min-h-[56px] px-3 py-2 space-y-1.5 transition-colors duration-150 ${
            isOver
              ? 'bg-accent-info/[0.06]'
              : ticketDragActive
                ? 'bg-accent-info/[0.02]'
                : 'bg-card/20'
          }`}
        >
          {tickets.length === 0 ? (
            <div
              className={`h-10 flex items-center justify-center rounded-lg border border-dashed transition-all duration-150 ${
                isOver
                  ? 'border-accent-info/60 text-accent-info/80 bg-accent-info/[0.06]'
                  : ticketDragActive
                    ? 'border-accent-info/35 text-accent-info/60'
                    : 'border-border/25 text-muted-foreground/30'
              }`}
            >
              <span className="text-[10px] select-none">{isOver ? t('railRow.dropHere') : ticketDragActive ? t('railRow.dropOnThisRail') : t('railRow.dragSpecsHere')}</span>
            </div>
          ) : (
            <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
              {tickets.map((ticket) => (
                <div
                  key={ticket.id}
                  onMouseDown={(e) => {
                    if (e.button === 2 && onTicketMoveToSpecs) {
                      e.preventDefault()
                      e.stopPropagation()
                      setTicketCtxMenu({ ticketId: ticket.id, x: e.clientX, y: e.clientY })
                    }
                  }}
                  onContextMenu={(e) => {
                    if (!onTicketMoveToSpecs) return
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                >
                  <SpecCard ticket={ticket} onClick={onTicketClick} dragDisabled={status === 'running'} />
                </div>
              ))}
            </SortableContext>
          )}
        </div>

        {/* Right-click context menu also reachable from the normal-density
            rail body (same component instance as the compact branch).
            Portal'd to body — see compact branch above for rationale. */}
        {ticketCtxMenu && onTicketMoveToSpecs && density === 'normal' && createPortal(
          <div
            role="menu"
            data-testid={`rail-row-normal-context-menu-${id}`}
            className="fixed z-[200] min-w-[160px] rounded-lg border border-border/60 bg-card/95 backdrop-blur shadow-xl shadow-black/40 p-1"
            style={{
              top: Math.min(ticketCtxMenu.y, window.innerHeight - 60),
              left: Math.min(ticketCtxMenu.x, window.innerWidth - 180),
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation()
                onTicketMoveToSpecs(ticketCtxMenu.ticketId)
                setTicketCtxMenu(null)
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-xs text-accent-warning hover:bg-accent-warning/10 transition-colors"
            >
              <ArrowLeft className="w-3 h-3" aria-hidden />
              {t('railRow.moveToSpecs')}
            </button>
          </div>,
          document.body
        )}
      </div>
    </div>
  )
}
