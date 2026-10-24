import { cn } from '../../lib/utils'

export type RailStationState = 'pending' | 'active' | 'done' | 'failed'

export interface RailStation {
  id: string
  label: string
  state: RailStationState
}

export interface RailTrackProps {
  /** 0..1 determinate progress. Omit with `running` for an indeterminate travelling pill. */
  progress?: number
  stations?: RailStation[]
  running?: boolean
  orientation?: 'horizontal' | 'vertical'
  className?: string
  'aria-label'?: string
}

const STATION_TONE: Record<RailStationState, string> = {
  pending: 'bg-border',
  active: 'bg-accent-primary',
  done: 'bg-accent-success',
  failed: 'bg-destructive',
}

/**
 * Rail track primitive: a hairline with a gradient pill. Indeterminate while
 * `running` without `progress`; stations are small lamps along the line.
 */
export function RailTrack({
  progress,
  stations,
  running = false,
  orientation = 'horizontal',
  className,
  'aria-label': ariaLabel,
}: RailTrackProps) {
  const vertical = orientation === 'vertical'
  const determinate = typeof progress === 'number'
  const pct = determinate ? Math.min(1, Math.max(0, progress)) * 100 : 0
  const indeterminate = running && !determinate

  return (
    <div
      role={determinate ? 'progressbar' : 'status'}
      aria-label={ariaLabel}
      aria-valuemin={determinate ? 0 : undefined}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={determinate ? Math.round(pct) : undefined}
      data-testid="rail-track"
      data-orientation={orientation}
      className={cn('relative [container-type:inline-size]', vertical ? 'h-full w-3 min-h-8' : 'h-3 w-full min-w-8', className)}
    >
      <div
        className={cn(
          'absolute bg-border',
          vertical ? 'left-1/2 top-0 bottom-0 w-px -translate-x-1/2' : 'top-1/2 left-0 right-0 h-px -translate-y-1/2',
        )}
        aria-hidden
      />
      {(determinate || indeterminate) && (
        <div
          aria-hidden
          data-testid="rail-track-pill"
          className={cn(
            'absolute rounded-full bg-gradient-to-r from-accent-primary to-[var(--color-rail-end)]',
            vertical ? 'left-1/2 -translate-x-1/2 w-1.5 h-4' : 'top-1/2 -translate-y-1/2 h-1.5 w-8',
            indeterminate && !vertical && 'left-0 animate-rail-travel [--rail-distance:calc(100cqw-2rem)]',
            indeterminate && vertical && 'top-0',
          )}
          style={
            determinate
              ? vertical
                ? { top: `calc(${pct}% - ${pct / 100} * 1rem)`, transition: 'top var(--duration-base, 200ms) var(--ease-rail, ease-out)' }
                : { left: `calc(${pct}% - ${pct / 100} * 2rem)`, transition: 'left var(--duration-base, 200ms) var(--ease-rail, ease-out)' }
              : undefined
          }
        />
      )}
      {stations?.map((s, i) => {
        const at = stations.length > 1 ? (i / (stations.length - 1)) * 100 : 0
        return (
          <span
            key={s.id}
            title={s.label}
            data-state={s.state}
            className={cn(
              'absolute h-1.5 w-1.5 rounded-full ring-2 ring-background',
              STATION_TONE[s.state],
              vertical ? 'left-1/2 -translate-x-1/2 -translate-y-1/2' : 'top-1/2 -translate-x-1/2 -translate-y-1/2',
            )}
            style={vertical ? { top: `${at}%` } : { left: `${at}%` }}
          >
            <span className="sr-only">{`${s.label}: ${s.state}`}</span>
          </span>
        )
      })}
    </div>
  )
}
