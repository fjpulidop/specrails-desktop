import { useCallback } from 'react'
import { MIN_LEFT_PX, MIN_RIGHT_PX } from '../hooks/useDashboardSplit'

interface DashboardSplitterProps {
  /** Current left-panel width in pixels. */
  leftWidth: number
  /** Begin pointer drag tracking (provided by `useDashboardSplit`). */
  onPointerDown: (e: React.PointerEvent) => void
  /** Reset the split to the default 50/50. */
  onReset: () => void
  /** Move the split by a signed pixel delta (keyboard), provided by `useDashboardSplit`. */
  onNudge: (delta: number) => void
  /** Total dashboard width — used to derive `aria-valuemax`. */
  viewport: number
}

/**
 * Vertical splitter handle between the SpecsBoard (left) and RailsBoard
 * (right) on the dashboard. The handle is a 6px-wide hit area with a 1px
 * visible rule that lifts to `accent-info/40` on hover.
 */
export function DashboardSplitter({ leftWidth, onPointerDown, onReset, onNudge, viewport }: DashboardSplitterProps) {
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // Keyboard a11y: arrow keys nudge ±16 px; Shift = ±64 px.
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onNudge(-step)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      onNudge(step)
    }
  }, [onNudge])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={leftWidth}
      aria-valuemin={MIN_LEFT_PX}
      aria-valuemax={Math.max(MIN_LEFT_PX, viewport - MIN_RIGHT_PX)}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={handleKeyDown}
      className="relative w-1.5 shrink-0 cursor-col-resize group select-none touch-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-info/60"
      data-testid="dashboard-splitter"
    >
      {/* Static rule */}
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border/40 group-hover:bg-accent-info/40 group-focus-visible:bg-accent-info/60 transition-colors" />
      {/* Grip dots */}
      <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 flex flex-col items-center justify-center gap-1 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity">
        <div className="w-1 h-1 rounded-full bg-accent-info/60" />
        <div className="w-1 h-1 rounded-full bg-accent-info/60" />
        <div className="w-1 h-1 rounded-full bg-accent-info/60" />
      </div>
    </div>
  )
}
