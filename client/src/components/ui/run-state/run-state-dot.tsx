import * as React from 'react'
import { LiveDot } from '../live-dot'
import { runStateLook, type RunState } from './run-state'

export interface RunStateDotProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children' | 'color'> {
  state: RunState
  size?: 'xs' | 'sm' | 'md'
  /** A `working` run with no current activity: lit, not pulsing. */
  quiet?: boolean
  /** Accessible name. Without it the dot is decorative (`aria-hidden`). */
  label?: string
}

/**
 * A state's lamp: hollow for `queued`, ringed for `needs-input`, the pulsing
 * info LiveDot for `working` (static under reduced motion or `quiet`), a
 * static solid dot in the state's tone otherwise.
 */
export function RunStateDot({ state, size = 'xs', quiet = false, label, ...props }: RunStateDotProps) {
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }
  return (
    <LiveDot
      data-run-state={state}
      size={size}
      dotClassName={runStateLook(state).dot}
      pulsing={state === 'working' && !quiet}
      {...a11y}
      {...props}
    />
  )
}
