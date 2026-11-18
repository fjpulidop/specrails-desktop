import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { LiveDot } from '../live-dot'
import { runStateLook, type RunState } from './run-state'

export type RunStateMarkSize = 'xs' | 'sm' | 'md'

const ICON_SIZE: Record<RunStateMarkSize, string> = { xs: 'h-3 w-3', sm: 'h-3.5 w-3.5', md: 'h-4 w-4' }
const LIVE_DOT_SIZE = { xs: 'xs', sm: 'sm', md: 'sm' } as const satisfies Record<RunStateMarkSize, 'xs' | 'sm' | 'md'>

export interface RunStateGlyphProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  state: RunState
  size?: RunStateMarkSize
  /** A `working` run with no current activity: the lamp stays lit without pulsing. */
  quiet?: boolean
  /** Accessible name. Without it the glyph is decorative (`aria-hidden`); pair it with visible words. */
  label?: string
  /** An object glyph that says WHAT the subject is (GitPullRequest: an open PR,
   *  GitMerge: merged only) drawn in the state's tone instead of the state's shape. */
  objectIcon?: LucideIcon | null
}

/**
 * A state's shape: its lucide glyph in the state's tone, or the pulsing info
 * LiveDot (static under reduced motion or `quiet`) for `working`. An object
 * glyph, when given, replaces the shape and keeps the tone.
 */
export function RunStateGlyph({ state, size = 'sm', quiet = false, label, objectIcon, className, ...props }: RunStateGlyphProps) {
  const look = runStateLook(state)
  const a11y = label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true as const }
  const Icon = objectIcon ?? look.icon
  return (
    <span
      data-run-state={state}
      className={cn('inline-flex shrink-0 items-center justify-center', ICON_SIZE[size], look.text, className)}
      {...a11y}
      {...props}
    >
      {Icon
        ? <Icon className={ICON_SIZE[size]} aria-hidden />
        : <LiveDot size={LIVE_DOT_SIZE[size]} dotClassName={look.dot} pulsing={!quiet} aria-hidden />}
    </span>
  )
}
