import * as React from 'react'
import type { LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '../../../lib/utils'
import { RunStateGlyph } from './run-state-glyph'
import { runStateLook, type RunState } from './run-state'

export interface RunStatePillProps extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'> {
  state: RunState
  /** Words more specific than the state's own name (`common:runState.<state>`). */
  label?: React.ReactNode
  /** A `working` run with no current activity: lit, not pulsing. */
  quiet?: boolean
  /** Object glyph in the state's tone (see RunStateGlyph). */
  objectIcon?: LucideIcon | null
}

/** A state's pill: glyph plus localized label in the state's tone, on a tinted hairline. */
export const RunStatePill = React.forwardRef<HTMLSpanElement, RunStatePillProps>(function RunStatePill(
  { state, label, quiet, objectIcon, className, ...props },
  ref,
) {
  const { t } = useTranslation('common')
  const look = runStateLook(state)
  return (
    <span
      ref={ref}
      data-run-state={state}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-pill border bg-transparent px-2 py-0.5 text-caption font-medium',
        look.text,
        look.border,
        className,
      )}
      {...props}
    >
      <RunStateGlyph state={state} size="xs" quiet={quiet} objectIcon={objectIcon} />
      {label ?? t(look.labelKey)}
    </span>
  )
})
