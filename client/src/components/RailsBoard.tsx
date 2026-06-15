import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { SortableContext, verticalListSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Layers, Plus } from 'lucide-react'
import { RailRow } from './RailRow'
import type { RailMode, RailStatus } from './RailControls'
import type { UltracodeModel } from './agents/RailModelSelector'
import type { LocalTicket } from '../types'

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
  /** Selected model for ultracode rails. null/undefined = default (sonnet). */
  ultracodeModel?: UltracodeModel | null
  /** Per-rail "Interactive" toggle (ultracode only). When true, the launched job
   *  becomes a persistent chat session with a Finalize button. */
  interactive?: boolean
}

/**
 * Apply a finished rail job to the rails, returning a new array. On every
 * terminal outcome (completed / failed / canceled / zombie) the job's tickets
 * are stripped from the target rail and the rail is reset to idle:
 *  - completed → the server marked them `done` (they surface in the Done column).
 *  - failed/canceled/zombie → the server reset them to `todo` (or flagged review),
 *    so they must return to the Specs column rather than stay stranded on the rail.
 * Only this job's ids are removed (never the whole rail) so an ultracode rail —
 * one job per spec — keeps its still-running specs in place. When the message
 * carries no ids the whole rail is cleared (best-effort fallback).
 */
export function applyRailJobOutcome(
  rails: RailState[],
  targetIndex: number,
  jobTicketIds: number[],
): RailState[] {
  const strip = new Set(jobTicketIds)
  return rails.map((r, idx) =>
    idx === targetIndex
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
  /** Installed providers — when >1 the rail header shows an AI engine selector. */
  providers?: readonly string[]
  onModeChange: (railId: string, mode: RailMode) => void
  onProfileChange?: (railId: string, profileName: string | null) => void
  onEngineChange?: (railId: string, aiEngine: 'claude' | 'codex') => void
  onUltracodeModelChange?: (railId: string, model: UltracodeModel) => void
  onInteractiveChange?: (railId: string, interactive: boolean) => void
  onToggle: (railId: string) => void
  onTicketClick: (ticket: LocalTicket) => void
  onAddRail: () => void
  onDeleteRail: (railId: string) => void
  onRenameRail: (railId: string, newLabel: string) => void
  /** Right-click → "Move to Specs" handler for compact-tier rail pills. */
  onTicketMoveToSpecs?: (ticketId: number) => void
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

export function RailsBoard({ rails, ticketMap, providers, onModeChange, onProfileChange, onEngineChange, onUltracodeModelChange, onInteractiveChange, onToggle, onTicketClick, onAddRail, onDeleteRail, onRenameRail, onTicketMoveToSpecs }: RailsBoardProps) {
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
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onAddRail() }}
          className="flex items-center gap-1 h-7 px-2.5 text-xs font-medium rounded-md border border-accent-primary/50 text-accent-primary hover:bg-accent-primary/10 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          {t('common:actions.add')}
        </button>
      </div>

      {/* Rail rows */}
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-2.5">
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          {rails.map((rail, idx) => (
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
                    ultracodeModel={rail.ultracodeModel ?? null}
                    interactive={rail.interactive ?? false}
                    providers={providers}
                    jiggleMode={jiggleMode}
                    density={density}
                    dragHandleListeners={listeners}
                    dragHandleAttributes={attributes}
                    onModeChange={(mode) => onModeChange(rail.id, mode)}
                    onProfileChange={onProfileChange ? (p) => onProfileChange(rail.id, p) : undefined}
                    onEngineChange={onEngineChange ? (e) => onEngineChange(rail.id, e) : undefined}
                    onUltracodeModelChange={onUltracodeModelChange ? (m) => onUltracodeModelChange(rail.id, m) : undefined}
                    onInteractiveChange={onInteractiveChange ? (v) => onInteractiveChange(rail.id, v) : undefined}
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
          ))}
        </SortableContext>
      </div>
    </div>
  )
}
