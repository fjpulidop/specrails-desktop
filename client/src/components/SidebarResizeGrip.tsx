import { cn } from '../lib/utils'

interface Props {
  /** Which app edge the parent sidebar hugs — the grip renders on the inner edge. */
  side: 'left' | 'right'
  dragging: boolean
  width: number
  min: number
  max: number
  label: string
  onPointerDown: (e: React.PointerEvent) => void
  onKeyDown: (e: React.KeyboardEvent) => void
}

/**
 * A whisper-thin drag handle on a docked sidebar's inner edge. A 6px hit-zone
 * with a 1px hairline that stays invisible until hover (or brightens fully while
 * dragging) — resizes without ever looking like a divider. `role="separator"`
 * with arrow-key support for accessibility.
 */
export function SidebarResizeGrip({ side, dragging, width, min, max, label, onPointerDown, onKeyDown }: Props) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-testid={`sidebar-resize-grip-${side}`}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className={cn(
        'group absolute inset-y-0 z-20 w-1.5 cursor-col-resize outline-none',
        side === 'left' ? '-right-0.5' : '-left-0.5',
      )}
    >
      <div
        className={cn(
          'absolute inset-y-0 w-px transition-colors duration-150',
          side === 'left' ? 'right-0' : 'left-0',
          dragging
            ? 'bg-accent-primary'
            : 'bg-transparent group-hover:bg-accent-primary/50 group-focus-visible:bg-accent-primary/70',
        )}
      />
    </div>
  )
}
