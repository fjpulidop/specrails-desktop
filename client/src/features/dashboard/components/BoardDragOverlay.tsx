/**
 * The board's drag overlay: a floating ghost of the dragged spec (matching the
 * active view tier) or of the rail being reordered.
 */
import { DragOverlay } from '@dnd-kit/core'
import type { LocalTicket } from '../../../types'
import type { SpecsViewTier } from '../../specs/lib/specs-view-tier'

export function BoardDragOverlay({ activeTicket, activeRailDragLabel, viewTier }: {
  activeTicket: LocalTicket | undefined
  activeRailDragLabel: string | null
  viewTier: SpecsViewTier
}) {
  // Drag overlay — renders a floating ghost while dragging. Matches the
  // active view tier so a postit dragged from the postit grid keeps
  // looking like a postit instead of collapsing back to a compact row.
  return (
    <DragOverlay dropAnimation={{ duration: 180, easing: 'ease' }}>
      {activeTicket ? (
        viewTier === 'postit' ? (
          <div className="flex flex-col gap-2 rounded-xl border border-accent-info/40 bg-card shadow-xl shadow-black/30 p-3 rotate-1 scale-[1.02] pointer-events-none w-[260px] min-h-[180px]">
            <div className="flex items-start justify-between gap-2">
              <span className="text-caption font-mono text-muted-foreground">#{activeTicket.id}</span>
              {activeTicket.priority && (
                <span className="h-5 px-1.5 rounded-full text-caption font-medium bg-muted/40 text-foreground">
                  {activeTicket.priority}
                </span>
              )}
            </div>
            <h3 className="text-sm font-medium leading-snug line-clamp-2 text-foreground">
              {activeTicket.title}
            </h3>
            {activeTicket.short_summary && activeTicket.short_summary.trim().length > 0 && (
              <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3 italic">
                {activeTicket.short_summary}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-primary/40 bg-card shadow-xl shadow-black/20 rotate-1 scale-[1.03] pointer-events-none">
            <span className="text-caption font-mono text-muted-foreground shrink-0">#{activeTicket.id}</span>
            <span className="flex-1 text-sm truncate max-w-[240px]">{activeTicket.title}</span>
          </div>
        )
      ) : activeRailDragLabel ? (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-primary/40 bg-card shadow-xl shadow-black/20 rotate-[0.5deg] scale-[1.02] pointer-events-none">
          <span className="text-label">{activeRailDragLabel}</span>
        </div>
      ) : null}
    </DragOverlay>
  )
}
