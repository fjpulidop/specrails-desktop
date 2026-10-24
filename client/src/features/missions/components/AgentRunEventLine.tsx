// ─── History event line ───────────────────────────────────────────────────────
// What HAPPENED to a run (or to the mission's mode), as one compact line in its
// chronological slot: "Launched on Rail 1 · #249", "Failed while deriving the
// spec", "Back to Flow", "Entered Flow · feat/…". Never the live state — that
// is the run strip's job. A line can open its run (the strip panel when live)
// or expand its settled card in place.

import type { ReactNode } from 'react'
import { ChevronRight, type LucideIcon } from 'lucide-react'
import { cn } from '../../../lib/utils'

export type RunEventTone = 'neutral' | 'failed' | 'warning' | 'success' | 'flow'

const ICON_TONE: Readonly<Record<RunEventTone, string>> = Object.freeze({
  neutral: 'text-foreground/60',
  failed: 'text-destructive',
  warning: 'text-accent-warning',
  success: 'text-accent-success',
  flow: 'text-accent-flow',
})

export interface AgentRunEventLineProps {
  icon: LucideIcon
  tone?: RunEventTone
  children: ReactNode
  /** Secondary detail after the event, muted. */
  detail?: ReactNode
  /** Opens the run (or toggles its card when `expanded` is set). */
  onActivate?: () => void
  /** Present when the line expands a card in place. */
  expanded?: boolean
  /** Accessible name of the action (e.g. "Show the run"). */
  actionLabel?: string
  testId?: string
  attributes?: Readonly<Record<`data-${string}`, string>>
}

export function AgentRunEventLine({
  icon: Icon, tone = 'neutral', children, detail, onActivate, expanded, actionLabel, testId = 'agent-run-event', attributes,
}: AgentRunEventLineProps) {
  const body = (
    <>
      <Icon className={cn('h-3.5 w-3.5 shrink-0', ICON_TONE[tone])} aria-hidden />
      <span className="min-w-0 truncate text-foreground/80">{children}</span>
      {detail && <span className="min-w-0 truncate text-foreground/75">{detail}</span>}
      {onActivate && expanded !== undefined && (
        <ChevronRight
          aria-hidden
          className={cn('ml-auto h-3 w-3 shrink-0 text-foreground/55 transition-transform duration-200 motion-reduce:transition-none', expanded && 'rotate-90')}
        />
      )}
    </>
  )
  const base = 'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-label leading-4'
  if (!onActivate) {
    return <div data-testid={testId} {...attributes} className={base}>{body}</div>
  }
  return (
    <button
      type="button"
      data-agent-interactive
      data-testid={testId}
      {...attributes}
      onClick={onActivate}
      aria-expanded={expanded}
      title={actionLabel}
      className={cn(base, 'transition-colors hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50')}
    >
      {body}
      {actionLabel && <span className="sr-only">. {actionLabel}</span>}
    </button>
  )
}
