// ─── Run-state vocabulary ─────────────────────────────────────────────────────
// ONE status vocabulary for everything that runs or waits in the client: jobs,
// rails, mission runs, PR deliveries, loop steps, Intent sessions, the inbox and
// spec activity. Each domain maps its own status to a RunState with a pure,
// exhaustive mapper next to its model; this table is the only place that knows
// what a state looks like (tone, glyph, dot) and what it is called.
// Rules (DESIGN.md › Status vocabulary):
//   - running is always `working`: info tone + LiveDot. Never success/primary
//     for running and never a spinner for a state (`Loader2` only inside a
//     button whose action the person just triggered);
//   - AlertTriangle is always warning (`blocked`); a failure is XCircle in the
//     destructive tone;
//   - primary is a state colour only for `needs-input`.

import { AlertTriangle, CheckCircle2, Circle, CircleSlash, Eye, MessageCircleQuestion, PauseCircle, XCircle, type LucideIcon } from 'lucide-react'

export const RUN_STATES = [
  'queued',
  'working',
  'needs-input',
  'review',
  'paused',
  'blocked',
  'failed',
  'done',
  'stopped',
] as const

export type RunState = (typeof RUN_STATES)[number]

export interface RunStateLook {
  /** The state's shape. `null` for `working`: its mark is the pulsing LiveDot. */
  icon: LucideIcon | null
  /** Text / icon colour (`text-*`). */
  text: string
  /** Solid lamp (`bg-*`); `queued` is a hollow ring instead. */
  dot: string
  /** 30 % tinted hairline for pills and chips. */
  border: string
  /** CSS colour for SVG strokes and fills (graphs, legends). */
  color: string
  /** Visible name: `common:runState.<state>`. */
  labelKey: `common:runState.${RunState}`
  /** One-sentence meaning (tooltips, sr-only hints): `common:runState.hint.<state>`. */
  hintKey: `common:runState.hint.${RunState}`
}

const MUTED_COLOR = 'var(--color-muted-foreground)'

function look(state: RunState, icon: LucideIcon | null, text: string, dot: string, border: string, color: string): RunStateLook {
  return { icon, text, dot, border, color, labelKey: `common:runState.${state}`, hintKey: `common:runState.hint.${state}` }
}

/** The single look table. Exhaustive by construction (`satisfies`). */
export const RUN_STATE_LOOK = {
  queued: look('queued', Circle, 'text-muted-foreground', 'border border-muted-foreground bg-transparent', 'border-border', MUTED_COLOR),
  working: look('working', null, 'text-accent-info', 'bg-accent-info', 'border-accent-info/30', 'var(--color-accent-info)'),
  'needs-input': look('needs-input', MessageCircleQuestion, 'text-accent-primary', 'bg-accent-primary ring-2 ring-accent-primary/20', 'border-accent-primary/30', 'var(--color-accent-primary)'),
  review: look('review', Eye, 'text-accent-review', 'bg-accent-review', 'border-accent-review/30', 'var(--color-accent-review)'),
  paused: look('paused', PauseCircle, 'text-accent-warning', 'bg-accent-warning', 'border-accent-warning/30', 'var(--color-accent-warning)'),
  blocked: look('blocked', AlertTriangle, 'text-accent-warning', 'bg-accent-warning', 'border-accent-warning/30', 'var(--color-accent-warning)'),
  failed: look('failed', XCircle, 'text-destructive', 'bg-destructive', 'border-destructive/30', 'var(--color-destructive)'),
  done: look('done', CheckCircle2, 'text-accent-success', 'bg-accent-success', 'border-accent-success/30', 'var(--color-accent-success)'),
  stopped: look('stopped', CircleSlash, 'text-muted-foreground', 'bg-muted-foreground', 'border-border', MUTED_COLOR),
} as const satisfies Record<RunState, RunStateLook>

export function runStateLook(state: RunState): RunStateLook {
  return RUN_STATE_LOOK[state]
}

export function isRunState(value: unknown): value is RunState {
  return typeof value === 'string' && (RUN_STATES as readonly string[]).includes(value)
}
