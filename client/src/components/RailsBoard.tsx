import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Layers, Plus, Rocket } from 'lucide-react'
import { RailRow } from './RailRow'
import { railIdFromIndex, railIndexFromId } from '../lib/rail-id'
import type { RailMode, RailStatus } from './RailControls'
import type { FreestyleModel } from './agents/RailModelSelector'
import type { ReasoningEffort } from './agents/RailEffortSelector'
import type { LocalTicket, RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../types'
import { worktreeSummary, type RailWorktreeMap } from '../lib/worktree-progress'
import type { RailExecMetric } from '../context/RailMetricsContext'
import type { RailPrActResult, RailPrCheckoutResult } from '../context/RailPrDecisionContext'

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
  mode: RailMode
  status: RailStatus
  activeJobId?: string
  /** Selected agent profile for this rail. null/undefined = default resolution. */
  profileName?: string | null
  /** Selected AI engine for this rail (multi-provider). null/undefined = primary. */
  aiEngine?: string | null
  /** Selected model for freestyle rails. null/undefined = default (sonnet). */
  freestyleModel?: FreestyleModel | null
  /** Per-rail "Interactive" toggle (freestyle only). When true, the launched job
   *  becomes a persistent chat session with a Finalize button. */
  /** Selected published-loop id (loop mode). */
  selectedLoopId?: string | null
  /** Selected reasoning effort (loop mode). */
  reasoningEffort?: ReasoningEffort | null
  /** Selected model for custom loop rails. null/undefined = provider default. */
  loopModel?: string | null
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
  onPrDecision?: (railIndex: number, action: RailPrDecisionAction, expectedDecision: RailPrDecision) => Promise<RailPrActResult>
  /** POSTs /rails/pr-checkout for a rail's active delivery. */
  onPrCheckout?: (railIndex: number) => Promise<RailPrCheckoutResult>
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

/** Width threshold below which rail rows switch to the compact mini-card layout. */
export const RAILS_COMPACT_THRESHOLD_PX = 320

export function RailsBoard({ rails, ticketMap, railWorktrees, railMetrics, railPrDecisions, onPrDecision, onPrCheckout, providers, onModeChange, onProfileChange, onEngineChange, onFreestyleModelChange, onLoopModelChange, loopAvailable, onLoopChange, onEffortChange, onToggle, onTicketClick, onAddRail, onDeleteRail, onRenameRail, onTicketMoveToSpecs, onLaunchAll, launchAllCount }: RailsBoardProps) {
  const { t } = useTranslation('dashboard')
  const activeRails = rails.filter((r) => r.status === 'running').length
  const [jiggleMode, setJiggleMode] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
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

  return (
    <div ref={containerRef} className="flex flex-col h-full" data-density={density} onClick={handleBackgroundClick}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-accent-secondary">{t('railsBoard.title')}</h2>
          {activeRails > 0 && (
            <span className="text-[10px] text-emerald-400 aurora-light:text-accent-success bg-emerald-400/10 aurora-light:bg-accent-success/10 rounded-full px-1.5 py-0.5 font-medium whitespace-nowrap">
              {t('railsBoard.runningCount', { count: activeRails })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onLaunchAll && (
            <button
              type="button"
              disabled={(launchAllCount ?? 0) === 0}
              onClick={(e) => { e.stopPropagation(); onLaunchAll() }}
              title={t('railsBoard.launchAllTitle')}
              className="flex items-center gap-1.5 h-7 px-2.5 text-xs font-semibold rounded-md border border-emerald-400/50 text-emerald-400 aurora-light:text-accent-success aurora-light:border-accent-success/50 bg-gradient-to-r from-emerald-400/10 to-accent-primary/10 hover:from-emerald-400/20 hover:to-accent-primary/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:from-emerald-400/10 disabled:hover:to-accent-primary/10"
            >
              <Rocket className="w-3.5 h-3.5" />
              {t('railsBoard.launchAll')}
              {(launchAllCount ?? 0) > 0 && (
                <span className="text-[10px] font-mono rounded-full bg-emerald-400/15 px-1.5 py-0.5 leading-none">
                  {launchAllCount}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onAddRail() }}
            className="flex items-center gap-1 h-7 px-2.5 text-xs font-medium rounded-md border border-accent-primary/50 text-accent-primary hover:bg-accent-primary/10 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t('common:actions.add')}
          </button>
        </div>
      </div>

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
                    onPrDecision={onPrDecision ? (action, expected) => onPrDecision(railIndex, action, expected) : undefined}
                    onPrCheckout={onPrCheckout ? () => onPrCheckout(railIndex) : undefined}
                    executionMetric={railMetrics?.[railIndex] ?? null}
                    providers={providers}
                    loopAvailable={loopAvailable}
                    selectedLoopId={rail.selectedLoopId ?? null}
                    reasoningEffort={rail.reasoningEffort ?? null}
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
                                        onToggle={() => onToggle(rail.id)}
                    onTicketClick={onTicketClick}
                    onDelete={() => onDeleteRail(rail.id)}
                    onLongPress={() => setJiggleMode(true)}
                    onRename={(newLabel) => onRenameRail(rail.id, newLabel)}
                    onTicketMoveToSpecs={onTicketMoveToSpecs}
                  />
                </div>
              )}
            </SortableRailWrapper>
            )
          })}
        </SortableContext>
      </div>
    </div>
  )
}
