/**
 * Narrated progress view (nontech-review-experience Wave 3b).
 *
 * The third altitude between the glance-level phase chips and the raw log: a
 * plain-language timeline of what the run actually did. Every line comes from
 * `buildNarration`, i.e. from structured events only — this component does no
 * interpretation of its own, which is why it can be trusted with a reader who
 * cannot check it against the log.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Check, CircleDot, Clock, RotateCcw } from 'lucide-react'
import { buildNarration, type MilestoneKind, type NarrationMilestone } from './narration-model'
import type { EventRow } from '../../types'

export interface DurationRange {
  p25Ms: number
  p75Ms: number
  medianMs: number
  sampleCount: number
}

export interface NarratedProgressProps {
  events: EventRow[]
  /** Terminal status reached — gates the "interrupted" wording. */
  settled: boolean
  /** Measured band; ABSENT below the server's sample floor. Never estimated. */
  durationRange?: DurationRange | null
  /** Real elapsed milliseconds for a live run. */
  elapsedMs?: number | null
  variant?: 'page' | 'glass'
}

const ICON: Record<MilestoneKind, typeof CircleDot> = {
  'step-start': CircleDot,
  'step-end': Check,
  'step-interrupted': AlertTriangle,
  decision: RotateCcw,
  activity: CircleDot,
}

const TONE: Record<NarrationMilestone['tone'], string> = {
  neutral: 'text-muted-foreground',
  good: 'text-accent-success',
  bad: 'text-accent-warning',
}

export function NarratedProgress({
  events,
  settled,
  durationRange,
  elapsedMs,
  variant = 'page',
}: NarratedProgressProps) {
  const { t } = useTranslation('narration')
  const model = useMemo(() => buildNarration({ events, settled }), [events, settled])

  const ordered = useMemo(
    () => [...model.milestones].sort((a, b) => a.seq - b.seq),
    [model.milestones],
  )

  return (
    <div className={variant === 'glass' ? 'flex h-full flex-col overflow-hidden' : 'flex flex-col'}>
      {/* Honest waiting line: a measured band or nothing at all. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
        {typeof elapsedMs === 'number' && elapsedMs > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden />
            {t('waiting.elapsed', { minutes: Math.max(1, Math.round(elapsedMs / 60_000)) })}
          </span>
        ) : null}
        {durationRange ? (
          <span data-testid="narration-range">
            {t('waiting.range', {
              low: Math.max(1, Math.round(durationRange.p25Ms / 60_000)),
              high: Math.max(1, Math.round(durationRange.p75Ms / 60_000)),
              count: durationRange.sampleCount,
            })}
          </span>
        ) : null}
        <span className="ml-auto italic opacity-70">{t('aiNote')}</span>
      </div>

      <ol className={`flex-1 space-y-1 px-3 py-2 ${variant === 'glass' ? 'overflow-y-auto' : ''}`} data-testid="narration-list">
        {ordered.length === 0 ? (
          <li className="py-6 text-center text-xs text-muted-foreground">
            {t(settled ? 'emptySettled' : 'emptyLive')}
          </li>
        ) : ordered.map((milestone, index) => {
          const Icon = ICON[milestone.kind]
          const isStep = milestone.kind === 'step-start' || milestone.kind === 'step-end'
            || milestone.kind === 'step-interrupted'
          const repeats = Number(milestone.values.repeats ?? 1)
          return (
            <li
              key={`${milestone.seq}-${milestone.code}-${index}`}
              className={`flex items-start gap-2 text-sm ${isStep ? 'font-medium text-foreground' : 'text-muted-foreground'} ${
                milestone.kind === 'step-start' && index > 0 ? 'pt-2' : ''
              }`}
            >
              <Icon className={`mt-0.5 size-3.5 shrink-0 ${TONE[milestone.tone]}`} aria-hidden />
              <span>
                {t(milestone.code, { ...milestone.values, defaultValue: milestone.code })}
                {repeats > 1 ? (
                  <span className="ml-1.5 text-[11px] opacity-70">{t('repeats', { count: repeats })}</span>
                ) : null}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
