import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ArrowUpRight, ChevronDown, ChevronRight, ClipboardCheck, GitPullRequest, ListChecks, Loader2, MessagesSquare,
  Pencil, Play, RefreshCw, ScrollText, StickyNote, type LucideIcon,
} from 'lucide-react'
import { useDesktop } from '../../../hooks/useDesktop'
import { EmptyState } from '../../../components/ui/empty-state'
import { Button } from '../../../components/ui/button'
import { fetchUsageSnapshot, planProviderIds } from '../../../lib/launch-forecast'
import { formatUsd } from '../../../lib/format-usd'
import { getActiveLanguage } from '../../../lib/i18n'
import { cn } from '../../../lib/utils'
import {
  TIMELINE_KINDS, entryCost, eventCount, eventKey, groupByDay, timelineTarget,
  fetchSpecTimeline, type TimelineEntry, type TimelineKind, type TimelineTarget, type TimelineTone,
} from '../lib/spec-timeline'

const KIND_ICON: Record<TimelineKind, LucideIcon> = {
  spec_edit: Pencil,
  addendum: StickyNote,
  mission_turn: MessagesSquare,
  job: Play,
  phase: ListChecks,
  audit: ScrollText,
  pr_event: GitPullRequest,
  review: ClipboardCheck,
}

/** The lamp tokens: failure, review and done keep their meaning from the rest of the app. */
const TONE_CLASS: Record<TimelineTone, string> = {
  neutral: 'text-muted-foreground border-border/60',
  ok: 'text-accent-success border-accent-success/40',
  failure: 'text-destructive border-destructive/40',
  review: 'text-accent-review border-accent-review/40',
}

const PAGE_SIZE = 40
/** Entries titled by their source (job name, mission title, addendum title): the event phrase moves to the subtitle. */
const SOURCE_TITLED: ReadonlySet<TimelineKind> = new Set(['job', 'mission_turn', 'addendum'])

interface SpecTimelineProps {
  ticketId: number
  /** Changes whenever the spec changes (its `updated_at`): the tab refreshes. */
  refreshKey?: string
  /** Leads to a place (mission, run, review); the host decides how to navigate. */
  onNavigate: (target: TimelineTarget) => void
  uiMode: 'kanban' | 'agent'
  currentSearch: string
  onOpenExternal?: (url: string) => void
}

function usePlanProviders(): ReadonlySet<string> {
  const [plan, setPlan] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    let cancelled = false
    const source = fetchUsageSnapshot()
    const apply = (snapshot: unknown): void => { if (!cancelled) setPlan(new Set(planProviderIds(snapshot))) }
    if (source.fresh) apply(source.fresh)
    else void source.load().then(apply).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return plan
}

function dayHeading(key: string, at: string, t: (k: string) => string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  if (key === keyOf(now)) return t('timeline.today')
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1)
  if (key === keyOf(yesterday)) return t('timeline.yesterday')
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return key
  try {
    return new Intl.DateTimeFormat(getActiveLanguage(), { weekday: 'short', day: 'numeric', month: 'short', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' }).format(date)
  } catch {
    return key
  }
}

function timeOf(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  try {
    return new Intl.DateTimeFormat(getActiveLanguage(), { hour: '2-digit', minute: '2-digit' }).format(date)
  } catch {
    return ''
  }
}

export function SpecTimeline({ ticketId, refreshKey, onNavigate, uiMode, currentSearch, onOpenExternal }: SpecTimelineProps) {
  const { t } = useTranslation('tickets')
  const { activeProjectId } = useDesktop()
  const plan = usePlanProviders()
  const [selected, setSelected] = useState<ReadonlySet<TimelineKind>>(() => new Set())
  const [entries, setEntries] = useState<TimelineEntry[]>([])
  const [counts, setCounts] = useState<Record<TimelineKind, number> | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadingMore, setLoadingMore] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const [reload, setReload] = useState(0)
  const kindsKey = useMemo(() => TIMELINE_KINDS.filter((k) => selected.has(k)).join(','), [selected])
  const requestRef = useRef(0)

  // Cached data stays on screen while a refresh (project switch, filter, spec edit) runs.
  useEffect(() => {
    if (!activeProjectId) return
    const controller = new AbortController()
    const request = ++requestRef.current
    setState((prev) => (prev === 'ready' ? prev : 'loading'))
    fetchSpecTimeline(ticketId, { kinds: kindsKey ? (kindsKey.split(',') as TimelineKind[]) : [], limit: PAGE_SIZE, signal: controller.signal })
      .then((page) => {
        if (request !== requestRef.current) return
        setEntries(page.entries)
        setCounts(page.counts)
        setNextCursor(page.nextCursor)
        setState('ready')
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || request !== requestRef.current) return
        void err
        setState('error')
      })
    return () => controller.abort()
  }, [ticketId, activeProjectId, kindsKey, refreshKey, reload])

  const loadMore = useCallback(() => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    fetchSpecTimeline(ticketId, { kinds: kindsKey ? (kindsKey.split(',') as TimelineKind[]) : [], cursor: nextCursor, limit: PAGE_SIZE })
      .then((page) => {
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e.id))
          return [...prev, ...page.entries.filter((e) => !seen.has(e.id))]
        })
        setNextCursor(page.nextCursor)
      })
      .catch(() => setState('error'))
      .finally(() => setLoadingMore(false))
  }, [ticketId, kindsKey, nextCursor, loadingMore])

  const toggleKind = (kind: TimelineKind): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind); else next.add(kind)
      return next
    })
  }
  const toggleExpanded = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const days = useMemo(() => groupByDay(entries), [entries])
  const totalAll = counts ? TIMELINE_KINDS.reduce((sum, k) => sum + counts[k], 0) : 0
  const visibleKinds = TIMELINE_KINDS.filter((k) => (counts ? counts[k] > 0 : false) || selected.has(k))

  return (
    <div className="flex flex-col gap-4" data-testid="spec-timeline">
      {visibleKinds.length > 0 && (
        <div role="group" aria-label={t('timeline.filters.aria')} className="flex flex-wrap items-center gap-1.5" data-testid="spec-timeline-filters">
          {visibleKinds.map((kind) => {
            const on = selected.has(kind)
            return (
              <button
                key={kind}
                type="button"
                aria-pressed={on}
                data-chip=""
                data-testid={`spec-timeline-filter-${kind}`}
                onClick={() => toggleKind(kind)}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  on ? 'border-accent-primary/60 bg-accent-primary/15 text-foreground' : 'border-border/60 text-muted-foreground hover:text-foreground hover:bg-surface/50',
                )}
              >
                {t(`timeline.kinds.${kind}`)}
                <span className="tabular-nums text-muted-foreground">{counts?.[kind] ?? 0}</span>
              </button>
            )
          })}
        </div>
      )}

      {state === 'loading' && entries.length === 0 && (
        <p className="flex items-center gap-2 text-body text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin" aria-hidden />{t('timeline.loading')}</p>
      )}

      {state === 'error' && (
        <div className="flex items-center justify-between gap-3 rounded-card border border-destructive/40 px-3 py-2" role="alert">
          <p className="text-body text-destructive">{t('timeline.error')}</p>
          <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>{t('timeline.retry')}</Button>
        </div>
      )}

      {state === 'ready' && entries.length === 0 && (
        totalAll === 0 ? (
          <EmptyState
            data-testid="spec-timeline-empty"
            icon={<ScrollText className="h-5 w-5" />}
            title={t('timeline.empty.title')}
            description={t('timeline.empty.description')}
            action={<Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}><RefreshCw className="mr-1.5 h-3.5 w-3.5" aria-hidden />{t('timeline.empty.refresh')}</Button>}
            learnMore="specTimeline"
          />
        ) : (
          <p className="text-body text-muted-foreground" data-testid="spec-timeline-filtered-empty">{t('timeline.empty.filtered')}</p>
        )
      )}

      {days.map((day) => (
        <section key={day.key} aria-label={dayHeading(day.key, day.at, t as (k: string) => string)} data-testid="spec-timeline-day">
          <h3 className="mb-2 text-label text-muted-foreground">{dayHeading(day.key, day.at, t as (k: string) => string)}</h3>
          <ol className="relative ml-3 space-y-3 border-l border-border/50 pl-5">
            {day.entries.map((entry) => (
              <TimelineRow
                key={entry.id}
                entry={entry}
                plan={plan}
                open={expanded.has(entry.id)}
                onToggle={() => toggleExpanded(entry.id)}
                onNavigate={onNavigate}
                uiMode={uiMode}
                currentSearch={currentSearch}
                onOpenExternal={onOpenExternal}
              />
            ))}
          </ol>
        </section>
      ))}

      {nextCursor && (
        <div>
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore} data-testid="spec-timeline-more">
            {loadingMore && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
            {t('timeline.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}

function TimelineRow({ entry, plan, open, onToggle, onNavigate, uiMode, currentSearch, onOpenExternal }: {
  entry: TimelineEntry
  plan: ReadonlySet<string>
  open: boolean
  onToggle: () => void
  onNavigate: (target: TimelineTarget) => void
  uiMode: 'kanban' | 'agent'
  currentSearch: string
  onOpenExternal?: (url: string) => void
}) {
  const { t } = useTranslation('tickets')
  const Icon = KIND_ICON[entry.kind]
  const count = eventCount(entry)
  const phrase = t(eventKey(entry), { count, defaultValue: entry.title })
  const sourceTitled = SOURCE_TITLED.has(entry.kind)
  const heading = sourceTitled ? entry.title : phrase
  const subtitle = sourceTitled ? phrase : entry.summary
  const target = timelineTarget(entry.link, uiMode, currentSearch)
  const cost = entryCost(entry, plan)
  const actorLabel = entry.actor
    ? entry.actor.type === 'agent' && entry.actor.label && entry.actor.label !== 'agent' ? t(`timeline.agentRoles.${entry.actor.label}`, { defaultValue: entry.actor.label }) : t(`timeline.actors.${entry.actor.type}`)
    : null
  const details = entry.items ?? []
  const inlineSummary = sourceTitled && entry.tone === 'failure' && !!entry.summary
  const hasDetails = details.length > 0 || (sourceTitled && !inlineSummary && !!entry.summary)
  const failedPhases = entry.event === 'phase.group' ? Number(entry.params.failed ?? 0) : 0
  const findings = entry.event === 'review.verdict' ? Number(entry.params.findings ?? 0) : 0
  const linkLabel = target ? t(`timeline.links.${target.place}`) : null

  return (
    <li className="relative" data-testid="spec-timeline-entry" data-kind={entry.kind} data-tone={entry.tone} data-entry-id={entry.id}>
      <span className={cn('absolute -left-[1.85rem] top-0.5 grid h-5 w-5 place-items-center rounded-full border bg-popover', TONE_CLASS[entry.tone])} aria-hidden>
        <Icon className="h-3 w-3" />
      </span>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-body text-foreground">
            {entry.tone !== 'neutral' && <span className="sr-only">{t(`timeline.tone.${entry.tone}`)}: </span>}
            {heading}
          </p>
          <p className="flex flex-wrap items-center gap-x-2 text-label text-muted-foreground">
            <time dateTime={entry.at}>{timeOf(entry.at)}</time>
            {actorLabel && <span>{actorLabel}</span>}
            {subtitle && <span className={cn('min-w-0 break-words', entry.tone === 'failure' && !sourceTitled && 'text-destructive')}>{subtitle}</span>}
            {inlineSummary && <span className="min-w-0 break-words text-destructive">{entry.summary}</span>}
            {failedPhases > 0 && <span className="text-destructive">{t('timeline.phaseFailed', { count: failedPhases })}</span>}
            {findings > 0 && <span className="text-accent-review">{t('timeline.findings', { count: findings })}</span>}
            {cost?.kind === 'billed' && <span title={t('timeline.cost.billedTitle')}>{t('timeline.cost.billed', { amount: formatUsd(cost.usd) })}<span className="sr-only"> ({t('timeline.cost.billedTitle')})</span></span>}
            {cost?.kind === 'estimated' && <span title={t('timeline.cost.estimatedTitle')}>{t('timeline.cost.estimated', { amount: formatUsd(cost.usd) })}<span className="sr-only"> ({t('timeline.cost.estimatedTitle')})</span></span>}
            {cost?.kind === 'turns' && <span>{t('timeline.cost.turns', { count: cost.turns })}</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {entry.url && onOpenExternal && /^https?:\/\//i.test(entry.url) && (
            <button
              type="button"
              onClick={() => onOpenExternal(entry.url!)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-label text-muted-foreground hover:bg-surface/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t('timeline.links.pr')}
              data-testid="spec-timeline-pr-link"
            >
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />PR
            </button>
          )}
          {target && linkLabel && (
            <button
              type="button"
              onClick={() => onNavigate(target)}
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-label text-muted-foreground hover:bg-surface/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={linkLabel}
              title={linkLabel}
              data-testid="spec-timeline-link"
              data-place={target.place}
            >
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
          {hasDetails && (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={open ? t('timeline.collapse') : t('timeline.expand')}
              title={open ? t('timeline.collapse') : t('timeline.expand')}
              className="rounded-md p-0.5 text-muted-foreground hover:bg-surface/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="spec-timeline-expand"
            >
              {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="mt-1.5 space-y-1 rounded-card border border-border/40 bg-card/40 px-3 py-2" data-testid="spec-timeline-details">
          {sourceTitled && !inlineSummary && entry.summary && <p className="break-words text-label text-muted-foreground">{entry.summary}</p>}
          <ul className="space-y-0.5">
            {details.map((item, index) => (
              <li key={`${item.label}-${index}`} className="flex flex-wrap items-baseline gap-x-2 text-label">
                {item.at && <time dateTime={item.at} className="tabular-nums text-muted-foreground">{timeOf(item.at)}</time>}
                <span className={cn('break-words', item.tone === 'failure' ? 'text-destructive' : item.tone === 'review' ? 'text-accent-review' : 'text-foreground')}>{item.label}</span>
                {item.detail && <code className="break-all text-muted-foreground">{item.detail}</code>}
              </li>
            ))}
          </ul>
          {entry.kind !== 'audit' && typeof entry.count === 'number' && entry.count > details.length && (
            <p className="text-label text-muted-foreground">+{entry.count - details.length}</p>
          )}
        </div>
      )}
    </li>
  )
}
