import * as React from 'react'
import { cn } from '../../lib/utils'

export type RailMarkState = 'idle' | 'travel' | 'arrive'

export interface RailMarkProps extends Omit<React.SVGAttributes<SVGSVGElement>, 'children'> {
  /** Rendered height/width box in px (the mark is ~2.1:1; width is `size`). */
  size?: number
  /** idle: pill rests at the end station; travel: loops along the rails; arrive: one decelerating run. */
  state?: RailMarkState
  /** Purely decorative marks are hidden from assistive tech. */
  decorative?: boolean
  label?: string
}

const PILL_W = 128
const TRACK_W = 352
const DISTANCE = TRACK_W - PILL_W

/**
 * The Specrails mark: a spec pill travelling between two rails. Ported from the
 * boot splash so the shell continues the same image. Theme-driven gradient.
 */
export function RailMark({
  size = 48,
  state = 'idle',
  decorative = true,
  label = 'Specrails',
  className,
  style,
  ...rest
}: RailMarkProps) {
  const gradId = `railmark-${React.useId().replace(/:/g, '')}`
  const motionClass =
    state === 'travel' ? 'animate-rail-travel' : state === 'arrive' ? 'animate-rail-arrive' : ''
  const pillStyle = {
    '--rail-distance': `${DISTANCE}px`,
    '--rail-progress': `${DISTANCE}px`,
    transform: state === 'idle' ? `translateX(${DISTANCE}px)` : undefined,
  } as React.CSSProperties

  return (
    <svg
      viewBox="64 166 384 182"
      width={size}
      height={Math.round((size * 182) / 384)}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : label}
      data-testid="rail-mark"
      data-state={state}
      className={cn('shrink-0', className)}
      style={style}
      {...rest}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--color-accent-primary)" />
          <stop offset="100%" stopColor="var(--color-accent-secondary)" />
        </linearGradient>
      </defs>
      <rect x="80" y="182" width={TRACK_W} height="18" rx="9" fill="var(--color-border)" />
      <rect x="80" y="314" width={TRACK_W} height="18" rx="9" fill="var(--color-border)" />
      <rect
        className={motionClass}
        data-testid="rail-mark-pill"
        x="80"
        y="220"
        width={PILL_W}
        height="72"
        rx="36"
        fill={`url(#${gradId})`}
        style={pillStyle}
      />
    </svg>
  )
}
