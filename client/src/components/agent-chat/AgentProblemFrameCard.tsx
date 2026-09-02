// ─── In-conversation problem-framing card ──────────────────────────────────────
// Renders the agent's fenced ```problem-frame snapshot (see agent-problem-frame.ts)
// BEFORE any spec draft exists: two readings of the same request, each anchored
// to the surfaces it would touch, and the question that separates them.
//
// The two readings are deliberately given IDENTICAL visual weight. The card's
// job is to make a fabricated second reading obvious at a glance — hierarchy
// would invite the eye to skip the alternative, which is the one field the
// whole framing step exists to surface.

import { Compass, CircleHelp, FileCode2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProblemFrame, ProblemFrameReading } from './agent-problem-frame'

function Reading({ label, value }: { label: string; value: ProblemFrameReading }) {
  const { t } = useTranslation('agent')
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/50 bg-surface/50 p-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground/50">{label}</div>
      <div className="text-xs leading-5 text-foreground/90">{value.reading}</div>
      {value.touches.length > 0 && (
        <div className="flex flex-col gap-1 pt-0.5">
          <div className="text-[10px] uppercase tracking-wider text-foreground/40">
            {t('problemFrame.touches')}
          </div>
          <div className="flex flex-wrap gap-1">
            {value.touches.map((path, i) => (
              <span
                key={`${i}-${path}`}
                className="inline-flex max-w-full items-center gap-1 rounded border border-border/50 bg-background-deep/40 px-1.5 py-0.5 font-mono text-[10px] text-foreground/65"
              >
                <FileCode2 className="h-2.5 w-2.5 shrink-0 text-accent-info/70" />
                <span className="truncate">{path}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Bullets({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-foreground/45">{label}</div>
      <ul className="flex flex-col gap-0.5">
        {items.map((item, i) => (
          <li key={`${i}-${item}`} className="flex items-start gap-1.5 text-[11px] leading-5 text-foreground/70">
            <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-foreground/30" />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function AgentProblemFrameCard({ frame }: { frame: ProblemFrame }) {
  const { t } = useTranslation('agent')
  const hasFooter = frame.assumptions.length > 0 || frame.unknowns.length > 0

  return (
    <div
      data-testid="agent-problem-frame-card"
      className="my-1 overflow-hidden rounded-xl border border-accent-info/25 bg-card/80 shadow-lg backdrop-blur"
    >
      <div className="flex items-center gap-1.5 border-b border-border/40 bg-accent-info/[0.06] px-3.5 py-2 text-[10px] font-semibold uppercase tracking-widest text-accent-info/90">
        <Compass className="h-3 w-3" />
        {t('problemFrame.heading')}
      </div>

      <div className="flex flex-col gap-2.5 px-3.5 py-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Reading label={t('problemFrame.restated')} value={frame.restated} />
          <Reading label={t('problemFrame.alternative')} value={frame.alternative} />
        </div>

        <div className="flex items-start gap-2 rounded-lg border border-accent-primary/25 bg-accent-primary/[0.07] px-2.5 py-2">
          <CircleHelp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-primary/80" />
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-accent-primary/80">
              {t('problemFrame.discriminator')}
            </div>
            <div className="mt-0.5 text-xs leading-5 text-foreground/90">{frame.discriminator}</div>
          </div>
        </div>

        {hasFooter && (
          <div className="grid gap-2 border-t border-border/40 pt-2.5 sm:grid-cols-2">
            <Bullets label={t('problemFrame.assumptions')} items={frame.assumptions} />
            <Bullets label={t('problemFrame.unknowns')} items={frame.unknowns} />
          </div>
        )}
      </div>
    </div>
  )
}

/** Tiny shimmer chip shown while a problem-frame block is still streaming in
 *  (the raw JSON is cut from the bubble meanwhile). */
export function AgentProblemFramePending() {
  const { t } = useTranslation('agent')
  return (
    <span
      data-testid="agent-problem-frame-pending"
      className="inline-flex w-fit items-center gap-1.5 rounded-full border border-accent-info/25 bg-accent-info/10 px-2.5 py-1 text-[11px] text-accent-info/90"
    >
      <Compass className="h-3 w-3 animate-pulse" />
      {t('problemFrame.framing')}
    </span>
  )
}
