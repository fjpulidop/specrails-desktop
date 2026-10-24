/**
 * Narrated progress view (nontech-review-experience Wave 3b).
 *
 * The third altitude between the glance-level phase chips and the raw log: a
 * plain-language timeline of what the run actually did. Every line comes from
 * `buildNarration`, i.e. from structured events only — this component does no
 * interpretation of its own, which is why it can be trusted with a reader who
 * cannot check it against the log.
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Clock } from 'lucide-react'
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

/** Unknown engine step ids are reported once per session (dev only) so new steps get copy. */
const reportedUnknownSteps = new Set<string>()

/** A settled step that took under 5 s counts as bookkeeping. */
const QUICK_SECONDS = 5

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
  const { t, i18n } = useTranslation('narration')
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
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
      // Bookkeeping: a clean step that ended in under 2 s with no activity of its own.
      const next = visible[i + 1]
      const quick = milestone.kind === 'step-start' && !!end && end.tone !== 'bad' && milestone.tone !== 'bad'
        && end.code !== 'step.doneTimedMin' && seconds < QUICK_SECONDS
        && (!next || next.kind === 'step-start')
        && !(!settled && i === lastStation)
      return { milestone, station, duration, quick, live: station && !settled && i === lastStation && !end }
    })
  }, [ordered, settled, t])

  // Display list: consecutive bookkeeping steps fold into one "+N checks" line and
  // retry attempts sit under a "Fix round N of M" header.
  const items = useMemo(() => {
    type Row = (typeof rows)[number]
    type Item =
      | { type: 'row'; row: Row }
      | { type: 'round'; key: number; round: number }
      | { type: 'folded'; key: number; rows: Row[] }
    const maxRound = rows.reduce((max, r) => (r.milestone.kind === 'step-start' ? Math.max(max, Number(r.milestone.values.iteration ?? 1)) : max), 1)
    const out: Item[] = []
    let currentRound = 1
    for (const row of rows) {
      const iteration = row.milestone.kind === 'step-start' ? Number(row.milestone.values.iteration ?? 1) : 1
      if (row.milestone.kind === 'step-start' && iteration > currentRound) {
        currentRound = iteration
        out.push({ type: 'round', key: row.milestone.seq, round: iteration })
      }
      if (row.quick) {
        const last = out[out.length - 1]
        if (last && last.type === 'folded') last.rows.push(row)
        else out.push({ type: 'folded', key: row.milestone.seq, rows: [row] })
      } else {
        out.push({ type: 'row', row })
      }
    }
    return { out, maxRound }
  }, [rows])

  const toggle = (key: number) =>
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Flat list of what is on screen, so the track line knows its first and last stop.
  const flat = useMemo(() => {
    type Flat =
      | { type: 'row'; row: (typeof rows)[number] }
      | { type: 'round'; key: number; round: number }
      | { type: 'folded'; key: number; count: number; open: boolean }
    const list: Flat[] = []
    for (const item of items.out) {
      if (item.type === 'folded') {
        const open = expanded.has(item.key)
        list.push({ type: 'folded', key: item.key, count: item.rows.length, open })
        if (open) for (const row of item.rows) list.push({ type: 'row', row })
      } else list.push(item)
    }
    return list
  }, [items, expanded])

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
        {flat.length === 0 ? (
          <li className="py-6 text-center text-xs text-muted-foreground">
            {t(settled ? 'emptySettled' : 'emptyLive')}
          </li>
        ) : flat.map((entry, index) => {
          const track = (node: ReactNode) => (
            <span className="relative flex w-4 shrink-0 justify-center self-stretch" aria-hidden>
              <span className={cn('absolute left-1/2 w-px -translate-x-1/2 bg-border', index === 0 ? 'top-2.5' : 'top-0', index === flat.length - 1 ? 'h-2.5' : 'bottom-0')} />
              {node}
            </span>
          )
          if (entry.type === 'round') {
            return (
              <li key={`round-${entry.key}`} data-testid="narration-round" className="flex items-start gap-2 pt-2 text-label font-semibold text-foreground">
                {track(<span className="relative mt-1.5 size-2 rounded-full bg-accent-warning ring-2 ring-background" />)}
                <span className="min-w-0 flex-1">{t('round', { round: entry.round, total: items.maxRound })}</span>
              </li>
            )
          }
          if (entry.type === 'folded') {
            return (
              <li key={`folded-${entry.key}`} data-testid="narration-folded" className="flex items-start gap-2 text-caption text-muted-foreground">
                {track(<span className="relative mt-2 size-1 rounded-full bg-muted-foreground/40" />)}
                <button
                  type="button"
                  aria-expanded={entry.open}
                  onClick={() => toggle(entry.key)}
                  className="inline-flex items-center gap-1 rounded-control py-0.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronRight className={cn('size-3 transition-transform motion-reduce:transition-none', entry.open && 'rotate-90')} aria-hidden />
                  {t('checks', { count: entry.count })}
                </button>
              </li>
            )
          }
          const row = entry.row
          const { milestone, station, duration, live } = row
          // Runtime phases are section headers for the steps below them: a
          // label, no dot, with room above — steps keep the rail's stops.
          if (milestone.kind === 'activity' && milestone.values.phaseBoundary === 1) {
            return (
              <li
                key={`${milestone.seq}-${milestone.code}-${index}`}
                data-testid="narration-phase"
                data-station="true"
                className={cn('flex items-start gap-2 text-label font-semibold text-muted-foreground', index > 0 && 'pt-3')}
              >
                {track(null)}
                <span className="min-w-0 flex-1 break-words">{t(milestone.code, { ...milestone.values, defaultValue: milestone.code })}</span>
              </li>
            )
          }
          // Inside a "Fix round N of M" group the round is already named.
          const stepCode = milestone.code === 'step.startRetry' ? 'step.start' : milestone.code
          // A folded "N files" line already states its count in the text; the
          // ×N badge is only for the same thing happening repeatedly.
          const repeats = Number(milestone.values.files ?? 0) > 1 || programmatic
            ? 1
            : Number(milestone.values.repeats ?? 1)
          const failed = milestone.tone === 'bad'
          const humanTitle = (title: unknown): string => {
            if (typeof title !== 'string' || !STEP_ID.test(title)) return String(title ?? '')
            if (import.meta.env.DEV && !reportedUnknownSteps.has(title) && !i18n.exists(`narration:steps.${title}`)) {
              reportedUnknownSteps.add(title)
              console.warn(`[narration] engine step "${title}" has no plain-language copy under narration:steps`)
            }
            return t(`steps.${title}`, { defaultValue: title })
          }
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
              {track(station ? (
                live
                  ? <LiveDot tone="primary" size="sm" className="mt-1.5" />
                  : <span className={cn('relative mt-1.5 size-2 rounded-full ring-2 ring-background', failed ? 'bg-destructive' : 'bg-accent-success')} />
              ) : (
                <span className={cn('relative mt-2 size-1 rounded-full', failed ? 'bg-destructive' : 'bg-muted-foreground/40')} />
              ))}
              <span className="min-w-0 flex-1 break-words">
                {typeof milestone.values.repository === 'string' && milestone.values.repository && (
                  <span className="mr-2 inline-block rounded border border-border px-1.5 py-0.5 text-label text-foreground">{milestone.values.repository}</span>
                )}
                {/* A step the engine named by role reads as its role; anything
                    else keeps the real title rather than a guessed label. */}
                {milestone.kind === 'step-start' && typeof milestone.values.roleCode === 'string'
                  ? t(stepCode, {
                      ...milestone.values,
                      title: t(milestone.values.roleCode as string),
                      defaultValue: stepCode,
                    })
                  : t(stepCode, { ...milestone.values, title: humanTitle(milestone.values.title), defaultValue: stepCode })}
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
