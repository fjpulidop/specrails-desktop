import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Layers, Plus, Rocket } from 'lucide-react'
import { RailRow } from './RailRow'
import { MAX_RAILS, railIdFromIndex, railIndexFromId } from '../lib/rail-id'
import type { RailMode, RailStatus } from './RailControls'
import type { FreestyleModel } from '../../agents/components/RailModelSelector'
import type { ReasoningEffort } from '../../agents/components/RailEffortSelector'
import type { LocalTicket, RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../../../types'
import { worktreeSummary, type RailWorktreeMap } from '../lib/worktree-progress'
import type { RailExecMetric } from '../context/RailMetricsContext'
import type { RailPrActResult, RailPrCheckoutResult } from '../../delivery/context/RailPrDecisionContext'
import { ReviewWipBadge } from './ReviewWipBadge'
import { railLaunchAddsReviewWip, reviewWipReached, type PendingReview } from '../../../lib/review-wip'
import { cn } from '../../../lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/ui/tooltip'
import {
  BoardToolbar,
  BoardToolbarRow,
  BoardToolbarSpacer,
  BoardToolbarTitle,
  ToolbarCountBadge,
  toolbarButtonClass,
} from '../../../components/ui/board-toolbar'
import { useElementWidth } from '../../../hooks/useElementWidth'
import { LiveDot } from '../../../components/ui/live-dot'

export const RAIL_SORT_PREFIX = '__rail:'
export function railSortId(railId: string) { return `${RAIL_SORT_PREFIX}${railId}` }
export function isRailSortId(id: string | number): id is string {
  return typeof id === 'string' && id.startsWith(RAIL_SORT_PREFIX)
}
export function extractRailId(sortId: string) { return sortId.slice(RAIL_SORT_PREFIX.length) }

export interface RailState {
  id: string
  label: string
  ticketIds: number[]
  workspaceSelection?: Record<string, string[]>
  mode: RailMode
  status: RailStatus
  activeJobId?: string
  /** Selected agent profile for this rail. null/undefined = default resolution. */
  profileName?: string | null
  /** Selected AI engine for this rail (multi-provider). null/undefined = primary. */
  aiEngine?: string | null
  /** Selected model for freestyle rails. null/undefined = provider default. */
  freestyleModel?: FreestyleModel | null
  /** Per-rail "Interactive" toggle (freestyle only). When true, the launched job
   *  becomes a persistent chat session with a Finalize button. */
  /** Selected published-loop id (loop mode). */
  selectedLoopId?: string | null
  /** Selected reasoning effort (loop mode). */
  reasoningEffort?: ReasoningEffort | null
  /** Selected model for custom loop rails. null/undefined = provider default. */
  loopModel?: string | null
  /** Explicit delivery target: existing open PR the next launch delivers into. */
  targetPr?: import('./RailTargetPrSelector').RailTargetPr | null
}

/**
 * Apply a finished rail job to the rails, returning a new array. On every
 * terminal outcome (completed / failed / canceled / zombie) the job's tickets
 * are stripped from the target rail and the rail is reset to idle:
 *  - completed → the server marked them `done` (they surface in the Done column).
 *  - failed/canceled/zombie → the server reset them to `todo` (or flagged review),
 *    so they must return to the Specs column rather than stay stranded on the rail.
 * Only this job's ids are removed (never the whole rail) so an freestyle rail —
 * one job per spec — keeps its still-running specs in place. When the message
 * carries no ids the whole rail is cleared (best-effort fallback).
 */
export function applyRailJobOutcome(
  rails: RailState[],
  targetIndex: number,
  jobTicketIds: number[],
): RailState[] {
  const strip = new Set(jobTicketIds)
  // IDENTITY mapping: the server railIndex targets the rail whose id encodes it
  // (`rail-N` ↔ N-1) — array POSITION would hit the wrong rail after a board
  // reorder or a middle-rail deletion. Positional fallback only when no rail
  // carries the canonical id (exotic/test fixtures).
  const targetId = railIdFromIndex(targetIndex)
  const hasIdMatch = rails.some((r) => r.id === targetId)
  return rails.map((r, idx) =>
    (hasIdMatch ? r.id === targetId : idx === targetIndex)
      ? {
          ...r,
          status: 'idle' as const,
          activeJobId: undefined,
          ticketIds: strip.size > 0 ? r.ticketIds.filter((id) => !strip.has(id)) : [],
        }
      : r,
  )
}

interface RailsBoardProps {
  rails: RailState[]
  ticketMap: Map<number, LocalTicket>
  /** Per-rail worktree merge-back progress (parallel/isolated launches). */
  railWorktrees?: RailWorktreeMap
  /** Per-rail live execution metrics (elapsed/steps/lines), keyed by railIndex. */
  railMetrics?: Record<number, RailExecMetric>
  /** Active ask-first PR decisions keyed by railIndex (safe-pr-review-flow). */
  railPrDecisions?: Map<number, RailPrStateSnapshot>
  /** POSTs /rails/pr-decision for a rail's active delivery. */
  onPrDecision?: (
    railIndex: number,
    action: RailPrDecisionAction,
    expectedDecision: RailPrDecision,
    expectedPrDeliveryId: string,
    repositoryId?: string,
  ) => Promise<RailPrActResult>
  /** POSTs /rails/pr-checkout for a rail's active delivery. */
  onPrCheckout?: (railIndex: number, expectedPrDeliveryId: string, repositoryId?: string) => Promise<RailPrCheckoutResult>
  /** Installed providers — when >1 the rail header shows an AI engine selector. */
  providers?: readonly string[]
  onModeChange: (railId: string, mode: RailMode) => void
  onProfileChange?: (railId: string, profileName: string | null) => void
  onEngineChange?: (railId: string, aiEngine: string) => void
  onFreestyleModelChange?: (railId: string, model: FreestyleModel) => void
  onLoopModelChange?: (railId: string, model: string) => void
  /** When true, rails offer "Loop" mode. */
  loopAvailable?: boolean
  onLoopChange?: (railId: string, loopId: string) => void
  onEffortChange?: (railId: string, effort: ReasoningEffort) => void
  onTargetPrChange?: (railId: string, value: import('./RailTargetPrSelector').RailTargetPr | null) => void
  onWorkspaceSelectionChange?: (railId: string, selection: Record<string, string[]>) => void
  onToggle: (railId: string) => void
  onTicketClick: (ticket: LocalTicket) => void
  onAddRail: () => void
  onDeleteRail: (railId: string) => void
  onRenameRail: (railId: string, newLabel: string) => void
  /** Right-click → "Move to Specs" handler for compact-tier rail pills. */
  onTicketMoveToSpecs?: (ticketId: number) => void
  /** Opens the Launch-all confirm (parallel launch of every ready rail).
   *  Button hidden when the handler is not provided. */
  onLaunchAll?: () => void
  /** How many rails a Launch-all would start right now (0 disables the button). */
  launchAllCount?: number
  /** Rails a Launch-all holds back for the review WIP limit; keeps the button
   *  enabled so its dialog can explain why nothing (more) launches. */
  launchAllHeld?: number
  /** Review WIP limit (null = none) and the deliveries counting against it. */
  reviewWip?: { limit: number | null; pending: PendingReview[] }
}

function SortableRailWrapper({ railId, children }: { railId: string; children: (props: { listeners: Record<string, Function>; attributes: Record<string, any>; isDragging: boolean }) => React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: railSortId(railId) })
  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : undefined,
    position: 'relative' as const,
    zIndex: isDragging ? 50 : undefined,
  }
  return (
    <div ref={setNodeRef} style={style}>
      {children({ listeners: listeners ?? {}, attributes, isDragging })}
    </div>
  )
}

/** One live-summary entry in the Rails context row. */
function SummaryItem({ dot, label, testId, pulse = false }: { dot: string; label: string; testId: string; pulse?: boolean }) {
  return (
    <span data-testid={testId} className="inline-flex items-center gap-1.5 whitespace-nowrap text-foreground">
      <LiveDot size="xs" dotClassName={dot} pulsing={pulse} aria-hidden />
      {label}
    </span>
  )
}

/**
 * Toolbar button with a tooltip that still works while the button is
 * disabled (disabled buttons swallow pointer events, so the tooltip anchors to
 * a focusable wrapper and the reason is also exposed to assistive tech).
 */
function TooltipButton({ tooltip, disabled, reasonId, children }: { tooltip: string; disabled: boolean; reasonId: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {disabled ? (
          <span tabIndex={0} className="inline-flex shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-describedby={reasonId}>
            {children}
            <span id={reasonId} className="sr-only">{tooltip}</span>
          </span>
        ) : (
          children
        )}
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}

/** Width threshold below which rail rows switch to the compact mini-card layout. */
export const RAILS_COMPACT_THRESHOLD_PX = 320

export function RailsBoard({ rails, ticketMap, railWorktrees, railMetrics, railPrDecisions, onPrDecision, onPrCheckout, providers, onModeChange, onProfileChange, onEngineChange, onFreestyleModelChange, onLoopModelChange, loopAvailable, onLoopChange, onEffortChange, onTargetPrChange, onWorkspaceSelectionChange, onToggle, onTicketClick, onAddRail, onDeleteRail, onRenameRail, onTicketMoveToSpecs, onLaunchAll, launchAllCount, launchAllHeld = 0, reviewWip }: RailsBoardProps) {
  const { t } = useTranslation('dashboard')
  const running = rails.filter((r) => r.status === 'running').length
  const failed = rails.filter((r) => r.status === 'failed').length
  const ready = launchAllCount ?? 0
  const atLimit = rails.length >= MAX_RAILS
  const launchEnabled = ready > 0 || launchAllHeld > 0
  const [row1Ref, row1W] = useElementWidth<HTMLDivElement>()
  const iconOnly = row1W !== null && row1W < 340
  const addIconOnly = row1W !== null && row1W < 400
  const [jiggleMode, setJiggleMode] = useState(false)
  const containerRef = useRef<HTMLElement>(null)
  const [density, setDensity] = useState<'normal' | 'compact'>('normal')

  // Observe the panel's own width and switch to the compact rail layout when
  // the dashboard splitter has collapsed us below the threshold.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return
    const el = containerRef.current
    if (!el) return
    const obs = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width
        setDensity(w < RAILS_COMPACT_THRESHOLD_PX ? 'compact' : 'normal')
      }
    })
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Exit jiggle mode on click outside (on the board background)
  const handleBackgroundClick = useCallback(() => {
    if (jiggleMode) setJiggleMode(false)
  }, [jiggleMode])

  // Exit jiggle mode on Escape key
  useEffect(() => {
    if (!jiggleMode) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setJiggleMode(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [jiggleMode])

  const sortableIds = rails.map((r) => railSortId(r.id))

  // Review WIP limit: once reached, a rail whose launch would open a NEW
  // delivery cannot start; continuations of its own delivery stay allowed.
  const wipLimit = reviewWip?.limit ?? null
  const wipPending = reviewWip?.pending ?? []
  const wipReached = reviewWipReached(wipLimit, wipPending.length)
  const wipBlockedReason = wipReached ? t('reviewWip.playBlocked', { pending: wipPending.length, limit: wipLimit }) : null
  const railLabelFor = (railIndex: number) => rails.find((r, pos) => (railIndexFromId(r.id) ?? pos) === railIndex)?.label ?? `Rail ${railIndex + 1}`

  return (
    <section ref={containerRef} aria-labelledby="rails-board-title" className="flex flex-col h-full" data-density={density} onClick={handleBackgroundClick}>
      {/* Toolbar — rows 1 and 2 line up with the Specs toolbar. Row 1: title,
          Add rail, Launch all (the primary, right-most). Row 2: live run
          summary plus the review WIP badge. */}
      <BoardToolbar data-testid="rails-toolbar">
        <BoardToolbarRow size="primary" ref={row1Ref}>
          <BoardToolbarTitle id="rails-board-title" icon={Layers} hideIconBelow={iconOnly}>
            {t('railsBoard.title')}
          </BoardToolbarTitle>
          <BoardToolbarSpacer />
          <TooltipButton
            tooltip={atLimit ? t('railsBoard.addRailLimit', { max: MAX_RAILS }) : t('railsBoard.addRail')}
            disabled={atLimit}
            reasonId="rails-add-reason"
          >
            <button
              type="button"
              disabled={atLimit}
              onClick={(e) => { e.stopPropagation(); onAddRail() }}
              data-testid="rails-add"
              aria-label={addIconOnly ? t('railsBoard.addRail') : undefined}
              className={cn(toolbarButtonClass, addIconOnly && 'w-8 px-0')}
            >
              <Plus className="w-3.5 h-3.5" aria-hidden />
              {!addIconOnly && t('railsBoard.addRail')}
            </button>
          </TooltipButton>
          {onLaunchAll && (
            <TooltipButton
              tooltip={launchEnabled ? t('railsBoard.launchAllTitle') : t('railsBoard.launchAllNoneReady')}
              disabled={!launchEnabled}
              reasonId="rails-launch-all-reason"
            >
              <button
                type="button"
                disabled={!launchEnabled}
                onClick={(e) => { e.stopPropagation(); onLaunchAll() }}
                data-testid="rails-launch-all"
                aria-label={iconOnly ? t('railsBoard.launchAll') : undefined}
                className={launchEnabled
                  ? 'inline-flex items-center gap-1.5 h-8 px-3 shrink-0 rounded-md text-xs font-semibold whitespace-nowrap bg-accent-success text-background hover:bg-accent-success/90 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background'
                  : toolbarButtonClass}
              >
                <Rocket className="w-3.5 h-3.5" aria-hidden />
                {!iconOnly && t('railsBoard.launchAll')}
                {ready > 0 && <ToolbarCountBadge count={ready} tone="success" data-testid="rails-launch-all-count" />}
              </button>
            </TooltipButton>
          )}
        </BoardToolbarRow>
        <BoardToolbarRow size="secondary">
          <div
            role="status"
            aria-live="polite"
            data-testid="rails-summary"
            className="flex items-center gap-3 min-w-0 overflow-hidden text-xs text-muted-foreground tabular-nums"
          >
            {running > 0 && (
              <SummaryItem dot="bg-accent-success" label={t('railsBoard.summary.running', { count: running })} testId="rails-summary-running" pulse />
            )}
            {ready > 0 && (
              <SummaryItem dot="bg-accent-primary" label={t('railsBoard.summary.ready', { count: ready })} testId="rails-summary-ready" />
            )}
            {failed > 0 && (
              <SummaryItem dot="bg-destructive" label={t('railsBoard.summary.failed', { count: failed })} testId="rails-summary-failed" />
            )}
            <span data-testid="rails-summary-total" className="whitespace-nowrap">
              {t('railsBoard.summary.total', { count: rails.length })}
            </span>
          </div>
          <BoardToolbarSpacer />
          {wipLimit !== null && (
            <ReviewWipBadge
              limit={wipLimit}
              pending={wipPending}
              railLabel={railLabelFor}
              ticketTitle={(id) => ticketMap.get(id)?.title}
            />
          )}
        </BoardToolbarRow>
      </BoardToolbar>

      {/* Rail rows */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2.5">
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {rails.map((rail, idx) => {
            // IDENTITY, not position: worktree progress, metrics and PR
            // decisions are keyed by the SERVER railIndex (`rail-N` ↔ N-1) —
            // array position breaks after a board reorder or a middle-rail
            // deletion. Positional fallback for exotic (test-fixture) ids.
            const railIndex = railIndexFromId(rail.id) ?? idx
            return (
            <SortableRailWrapper key={rail.id} railId={rail.id}>
              {({ listeners, attributes }) => (
                <div data-tour={idx === 0 ? 'rail-1' : undefined}>
                  <RailRow
                    id={rail.id}
                    label={rail.label}
                    tickets={rail.ticketIds.map((id) => ticketMap.get(id)).filter((t): t is LocalTicket => t !== undefined)}
                    mode={rail.mode}
                    status={rail.status}
                    activeJobId={rail.activeJobId}
                    profileName={rail.profileName ?? null}
                    aiEngine={rail.aiEngine ?? null}
                    freestyleModel={rail.freestyleModel ?? null}
                    loopModel={rail.loopModel ?? null}
                    worktreeSummary={worktreeSummary(railWorktrees?.[railIndex])}
                    prDecision={railPrDecisions?.get(railIndex) ?? null}
                    onPrDecision={onPrDecision
                      ? (action, expected, expectedPrDeliveryId, repositoryId) => onPrDecision(railIndex, action, expected, expectedPrDeliveryId, repositoryId)
                      : undefined}
                    onPrCheckout={onPrCheckout
                      ? (expectedPrDeliveryId, repositoryId) => onPrCheckout(railIndex, expectedPrDeliveryId, repositoryId)
                      : undefined}
                    executionMetric={railMetrics?.[railIndex] ?? null}
                    providers={providers}
                    loopAvailable={loopAvailable}
                    selectedLoopId={rail.selectedLoopId ?? null}
                    reasoningEffort={rail.reasoningEffort ?? null}
                    targetPr={rail.targetPr ?? null}
                    workspaceSelection={rail.workspaceSelection}
                    onWorkspaceSelectionChange={onWorkspaceSelectionChange ? selection => onWorkspaceSelectionChange(rail.id, selection) : undefined}
                    jiggleMode={jiggleMode}
                    density={density}
                    dragHandleListeners={listeners}
                    dragHandleAttributes={attributes}
                    onModeChange={(mode) => onModeChange(rail.id, mode)}
                    onProfileChange={onProfileChange ? (p) => onProfileChange(rail.id, p) : undefined}
                    onEngineChange={onEngineChange ? (e) => onEngineChange(rail.id, e) : undefined}
                    onFreestyleModelChange={onFreestyleModelChange ? (m) => onFreestyleModelChange(rail.id, m) : undefined}
                    onLoopModelChange={onLoopModelChange ? (m) => onLoopModelChange(rail.id, m) : undefined}
                    onLoopChange={onLoopChange ? (l) => onLoopChange(rail.id, l) : undefined}
                    onEffortChange={onEffortChange ? (eff) => onEffortChange(rail.id, eff) : undefined}
                    onTargetPrChange={onTargetPrChange ? (v) => onTargetPrChange(rail.id, v) : undefined}
                                        onToggle={() => onToggle(rail.id)}
                    onTicketClick={onTicketClick}
                    onDelete={() => onDeleteRail(rail.id)}
                    onLongPress={() => setJiggleMode(true)}
                    onRename={(newLabel) => onRenameRail(rail.id, newLabel)}
                    onTicketMoveToSpecs={onTicketMoveToSpecs}
                    launchBlockedReason={wipBlockedReason && railLaunchAddsReviewWip(railIndex, railPrDecisions ?? new Map()) ? wipBlockedReason : null}
                  />
                </div>
              )}
            </SortableRailWrapper>
            )
          })}
        </SortableContext>
      </div>
    </section>
  )
}
