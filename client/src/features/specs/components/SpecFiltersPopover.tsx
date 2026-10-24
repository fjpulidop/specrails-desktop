import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { SlidersHorizontal } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { toolbarButtonClass, ToolbarCountBadge } from '../../../components/ui/board-toolbar'
import type { LocalTicket } from '../../../types'
import { SpecLabelFilterOptions } from './SpecLabelFilterOptions'
import { SpecEpicFilterOptions } from './SpecEpicFilterOptions'
import { SpecSprintFilterOptions } from './SpecSprintFilterOptions'
import { SpecJiraStatusFilterOptions } from './SpecJiraStatusFilterOptions'

interface SpecFiltersPopoverProps {
  /** tickets + doneTickets (unfiltered): source of the label/epic/sprint entries. */
  tickets: LocalTicket[]
  /** Label/epic/sprint/search-filtered tickets: source of the Jira-status entries. */
  jiraStatusTickets: LocalTicket[]
  labels: Set<string>
  onLabelsChange: (next: Set<string>) => void
  epic: string | null
  onEpicChange: (v: string | null) => void
  sprint: string | null
  onSprintChange: (v: string | null) => void
  jiraStatus: string | null
  onJiraStatusChange: (v: string | null) => void
  showEpic: boolean
  showSprint: boolean
  showJiraStatus: boolean
  onClearAll: () => void
  /** Narrow toolbar: hide the "Filters" text, keep the icon and the badge. */
  compact: boolean
}

export interface SpecFiltersPopoverHandle {
  open: () => void
}

/** Number of active filter values (status and search are not counted here). */
export function countActiveSpecFilters(f: {
  labels: Set<string>
  epic: string | null
  sprint: string | null
  jiraStatus: string | null
}): number {
  return f.labels.size + (f.epic ? 1 : 0) + (f.sprint ? 1 : 0) + (f.jiraStatus ? 1 : 0)
}

const PANEL_WIDTH = 320
const EDGE = 8

interface PanelPos {
  top: number
  right: number
  maxHeight: number
}

interface SectionProps {
  id: 'labels' | 'epic' | 'sprint' | 'jira-status'
  title: string
  active: boolean
  onClear: () => void
  children: React.ReactNode
}

function Section({ id, title, active, onClear, children }: SectionProps) {
  const { t } = useTranslation('specs')
  const headingId = useId()
  return (
    <section data-testid={`spec-filters-section-${id}`} aria-labelledby={headingId}>
      <div className="flex items-center justify-between gap-2 px-2 pt-1.5 pb-1">
        <h3 id={headingId} className="text-xs font-semibold text-muted-foreground">{title}</h3>
        {active && (
          <button
            type="button"
            onClick={onClear}
            data-testid={`spec-filters-section-clear-${id}`}
            className="h-6 rounded px-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('filters.clearSection')}
          </button>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * One "Filters" trigger for every narrowing dimension beyond status: labels
 * (always), epic, sprint and Jira status (only when the project carries that
 * data). The panel is portalled with fixed positioning so it escapes the
 * board's overflow-hidden panels, and changes apply live.
 */
export const SpecFiltersPopover = forwardRef<SpecFiltersPopoverHandle, SpecFiltersPopoverProps>(
  function SpecFiltersPopover(props, ref) {
    const {
      tickets, jiraStatusTickets,
      labels, onLabelsChange, epic, onEpicChange, sprint, onSprintChange, jiraStatus, onJiraStatusChange,
      showEpic, showSprint, showJiraStatus, onClearAll, compact,
    } = props
    const { t } = useTranslation('specs')
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState<PanelPos | null>(null)
    const triggerRef = useRef<HTMLButtonElement>(null)
    const panelRef = useRef<HTMLDivElement>(null)
    const panelId = useId()
    const count = countActiveSpecFilters({ labels, epic, sprint, jiraStatus })

    useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), [])

    const close = useCallback((refocus: boolean) => {
      setOpen(false)
      if (refocus) triggerRef.current?.focus()
    }, [])

    const place = useCallback(() => {
      const rect = triggerRef.current?.getBoundingClientRect()
      if (!rect) return
      const vw = window.innerWidth
      const vh = window.innerHeight
      // Right-align to the trigger, clamped so the panel stays on screen.
      const maxRight = Math.max(EDGE, vw - EDGE - PANEL_WIDTH)
      const right = Math.min(Math.max(EDGE, vw - rect.right), maxRight)
      const top = rect.bottom + 4
      const maxHeight = Math.max(160, Math.min(vh * 0.7, 520, vh - top - EDGE))
      setPos({ top, right, maxHeight })
    }, [])

    useLayoutEffect(() => {
      if (open) place()
    }, [open, place])

    useEffect(() => {
      if (!open) return
      const frame = requestAnimationFrame(() => panelRef.current?.focus())
      const onPointerDown = (e: PointerEvent) => {
        const target = e.target as Node
        if (panelRef.current?.contains(target) || triggerRef.current?.contains(target)) return
        close(false)
      }
      const onReflow = () => place()
      document.addEventListener('pointerdown', onPointerDown)
      window.addEventListener('resize', onReflow)
      window.addEventListener('scroll', onReflow, true)
      return () => {
        cancelAnimationFrame(frame)
        document.removeEventListener('pointerdown', onPointerDown)
        window.removeEventListener('resize', onReflow)
        window.removeEventListener('scroll', onReflow, true)
      }
    }, [open, close, place])

    const panel = open ? (
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label={t('filters.title')}
        tabIndex={-1}
        data-testid="specs-filters-panel"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close(true)
          }
        }}
        // Portal clicks bubble through the React tree: keep them away from the
        // board's background handler (which exits jiggle mode).
        onClick={(e) => e.stopPropagation()}
        style={pos ? { position: 'fixed', top: pos.top, right: pos.right, maxHeight: pos.maxHeight } : { position: 'fixed' }}
        className="z-50 w-80 max-w-[calc(100vw-16px)] max-h-[min(70vh,520px)] flex flex-col rounded-xl border border-border/60 bg-popover text-popover-foreground shadow-xl shadow-black/30 focus-visible:outline-none"
      >
        <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-2">
          <Section id="labels" title={t('filters.sections.labels')} active={labels.size > 0} onClear={() => onLabelsChange(new Set())}>
            <SpecLabelFilterOptions tickets={tickets} active={labels} onChange={onLabelsChange} />
          </Section>
          {showEpic && (
            <Section id="epic" title={t('filters.sections.epic')} active={epic !== null} onClear={() => onEpicChange(null)}>
              <SpecEpicFilterOptions tickets={tickets} active={epic} onChange={onEpicChange} />
            </Section>
          )}
          {showSprint && (
            <Section id="sprint" title={t('filters.sections.sprint')} active={sprint !== null} onClear={() => onSprintChange(null)}>
              <SpecSprintFilterOptions tickets={tickets} active={sprint} onChange={onSprintChange} />
            </Section>
          )}
          {showJiraStatus && (
            <Section id="jira-status" title={t('filters.sections.jiraStatus')} active={jiraStatus !== null} onClear={() => onJiraStatusChange(null)}>
              <SpecJiraStatusFilterOptions tickets={jiraStatusTickets} active={jiraStatus} onChange={onJiraStatusChange} />
            </Section>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-border/40 p-2">
          <button
            type="button"
            onClick={onClearAll}
            disabled={count === 0}
            data-testid="specs-filters-clear-all"
            className="h-8 rounded-md px-2.5 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('filters.clearAll')}
          </button>
          <button
            type="button"
            onClick={() => close(true)}
            data-testid="specs-filters-done"
            className={toolbarButtonClass}
          >
            {t('filters.done')}
          </button>
        </div>
      </div>
    ) : null

    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={count > 0 ? t('filters.triggerActive', { count }) : t('filters.trigger')}
          title={compact ? t('filters.trigger') : undefined}
          data-testid="specs-filters-trigger"
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          className={cn(toolbarButtonClass, count > 0 && 'border-accent-primary/50', compact && 'px-2')}
        >
          <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden />
          {!compact && <span>{t('filters.trigger')}</span>}
          {count > 0 && <ToolbarCountBadge count={count} tone="accent" data-testid="specs-filters-count" />}
        </button>
        {panel && createPortal(panel, document.body)}
      </>
    )
  },
)
