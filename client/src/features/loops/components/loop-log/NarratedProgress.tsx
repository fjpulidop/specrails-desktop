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
import { Clock } from 'lucide-react'
import { LiveDot } from '../../../../components/ui/live-dot'
import { cn } from '../../../../lib/utils'
import { buildNarration, type NarrationMilestone } from './narration-model'
import type { EventRow } from '../../../../types'

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

/** Step-end codes that only add a duration to the step they close. */
const QUIET_END = new Set(['step.done', 'step.doneTimed', 'step.doneTimedMin', 'step.recovered'])

/** Engine step ids that have plain-language copy under `steps.<id>`. */
const STEP_ID = /^[a-z][a-z-]*$/

function isStation(m: NarrationMilestone): boolean {
  return m.kind === 'step-start' || m.kind === 'step-end' || m.kind === 'step-interrupted' || m.values.phaseBoundary === 1
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
  const programmatic = useMemo(() => events.some(event => event.event_type === 'workflow-event'), [events])

  const ordered = useMemo(
    () => [...model.milestones].sort((a, b) => a.seq - b.seq),
    [model.milestones],
  )

  // Rail view: step starts and runtime phases are stations on the track; a
  // successful "Finished step N in 1s" folds into its step's row as a duration.
  const rows = useMemo(() => {
    const endBySeq = new Map<number, NarrationMilestone>()
    for (const m of ordered) if (m.kind === 'step-end' && QUIET_END.has(m.code) && m.stepIndex !== null) endBySeq.set(m.stepIndex, m)
    const visible = ordered.filter(m => !(m.kind === 'step-end' && QUIET_END.has(m.code)))
    const lastStation = (() => {
      for (let i = visible.length - 1; i >= 0; i--) if (isStation(visible[i])) return i
      return -1
    })()
    return visible.map((milestone, i) => {
      const station = isStation(milestone)
      const end = milestone.kind === 'step-start' && milestone.stepIndex !== null ? endBySeq.get(milestone.stepIndex) : undefined
      const seconds = Number(end?.values.seconds ?? 0)
      const minutes = Number(end?.values.minutes ?? 0)
      const duration = end && seconds > 0
        ? (end.code === 'step.doneTimedMin' ? t('step.durationMin', { minutes }) : t('step.durationSec', { seconds }))
        : null
      return { milestone, station, duration, live: station && !settled && i === lastStation && !end }
    })
  }, [ordered, settled, t])

  return (
    <div className={variant === 'glass' ? 'flex h-full flex-col overflow-hidden' : 'flex flex-col'}>
      {/* Honest waiting line: a measured band or nothing at all. */}
      <div className="flex flex-wrap items-center gap-3 border-b border-border/50 px-3 py-2 text-caption text-muted-foreground">
        {typeof elapsedMs === 'number' && elapsedMs > 0 ? (
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden />
            {/* A settled run reports its total, never a live "running for". */}
            {t(settled ? 'waiting.took' : 'waiting.elapsed', { minutes: Math.max(1, Math.round(elapsedMs / 60_000)) })}
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
        <span className="ml-auto text-caption text-muted-foreground">{t('aiNote')}</span>
      </div>

      <ol className={`flex-1 px-3 py-2 ${variant === 'glass' ? 'overflow-y-auto' : ''}`} data-testid="narration-list">
        {rows.length === 0 ? (
          <li className="py-6 text-center text-xs text-muted-foreground">
            {t(settled ? 'emptySettled' : 'emptyLive')}
          </li>
        ) : rows.map((row, index) => {
          const { milestone, station, duration, live } = row
          // A folded "N files" line already states its count in the text; the
          // ×N badge is only for the same thing happening repeatedly.
          const repeats = Number(milestone.values.files ?? 0) > 1 || programmatic
            ? 1
            : Number(milestone.values.repeats ?? 1)
          const failed = milestone.tone === 'bad'
          const humanTitle = (title: unknown): string =>
            typeof title === 'string' && STEP_ID.test(title) ? t(`steps.${title}`, { defaultValue: title }) : String(title ?? '')
          return (
            <li
              key={`${milestone.seq}-${milestone.code}-${index}`}
              data-station={station ? 'true' : undefined}
              className={cn(
                'flex items-start gap-2 text-sm',
                station ? 'font-medium text-foreground' : 'text-muted-foreground',
                station && index > 0 && 'pt-1.5',
              )}
            >
              {/* Track column: a 1px line with a station node or a small sleeper. */}
              <span className="relative flex w-4 shrink-0 justify-center self-stretch" aria-hidden>
                <span className={cn('absolute left-1/2 w-px -translate-x-1/2 bg-border', index === 0 ? 'top-2.5' : 'top-0', index === rows.length - 1 ? 'h-2.5' : 'bottom-0')} />
                {station ? (
                  live
                    ? <LiveDot tone="primary" size="sm" className="mt-1.5" />
                    : <span className={cn('relative mt-1.5 size-2 rounded-full ring-2 ring-background', failed ? 'bg-destructive' : 'bg-accent-success')} />
                ) : (
                  <span className={cn('relative mt-2 size-1 rounded-full', failed ? 'bg-destructive' : 'bg-muted-foreground/40')} />
                )}
              </span>
              <span className="min-w-0 flex-1 break-words">
                {typeof milestone.values.repository === 'string' && milestone.values.repository && (
                  <span className="mr-2 inline-block rounded border border-border px-1.5 py-0.5 text-xs font-medium text-foreground">{milestone.values.repository}</span>
                )}
                {/* A step the engine named by role reads as its role; anything
                    else keeps the real title rather than a guessed label. */}
                {milestone.kind === 'step-start' && typeof milestone.values.roleCode === 'string'
                  ? t(milestone.code, {
                      ...milestone.values,
                      title: t(milestone.values.roleCode as string),
                      defaultValue: milestone.code,
                    })
                  : t(milestone.code, { ...milestone.values, title: humanTitle(milestone.values.title), defaultValue: milestone.code })}
                {repeats > 1 ? (
                  <span className="ml-1.5 text-caption opacity-70">{t('repeats', { count: repeats })}</span>
                ) : null}
              </span>
              {duration ? <span className="shrink-0 num text-caption text-muted-foreground">{duration}</span> : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
