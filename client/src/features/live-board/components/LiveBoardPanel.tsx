import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleCheck, Columns3, ExternalLink, Inbox, OctagonAlert, SearchX } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { DialogBody, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { EmptyState } from '../../../components/ui/empty-state'
import { RailTrack } from '../../../components/brand/RailTrack'
import { RunStateGlyph } from '../../../components/ui/run-state/run-state-glyph'
import type { RunState } from '../../../components/ui/run-state/run-state'
import { useNow } from '../../../hooks/useNow'
import { formatUsd } from '../../../lib/format-usd'
import { keyboardLabel } from '../../../lib/keyboard-label'
import { cn } from '../../../lib/utils'
import { isDismissed, readDismissals } from '../../inbox/lib/inbox-model'
import { useInbox } from '../../inbox/context/InboxContext'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import type { LiveBoardActions } from '../context/LiveBoardContext'
import type { LiveBoardData } from '../hooks/useLiveBoardData'
import {
  LIVE_COLUMNS, LIVE_KINDS, NO_FILTERS, columnsOf, countVisible, isPausedCard, lanesOf, providersOf, readLayout, writeLayout,
  type LiveBoardFilters, type LiveBoardLayout, type LiveColumn, type VisibleLane,
} from '../lib/live-board-model'
import { liveCardLook } from '../lib/live-board-run-state'
import { useMissionExtensions } from '../../missions/context/MissionExtensionsContext'
import { LiveBoardCard } from './LiveBoardCard'

/** ⌘⇧B on macOS, Ctrl+Shift+B elsewhere (the cheatsheet and ⌘K show the same chord). */
export const LIVE_BOARD_CHORD = '⌘⇧B'

/** In progress and Done today speak their state; Needs you mixes states (each card carries its own), so it wears the inbox's neutral mark. */
const COLUMN_STATE: Record<Exclude<LiveColumn, 'needs'>, RunState> = { working: 'working', done: 'done' }

function Chip({ pressed, onClick, children, testId }: { pressed: boolean; onClick: () => void; children: ReactNode; testId?: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-pill border px-2.5 text-caption transition-colors duration-150',
        pressed ? 'border-border bg-muted text-foreground' : 'border-border/60 text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function LayoutSelector({ layout, onChange }: { layout: LiveBoardLayout; onChange: (layout: LiveBoardLayout) => void }) {
  const { t } = useTranslation('liveBoard')
  return (
    <div role="radiogroup" aria-label={t('layout.label')} className="inline-flex rounded-control border border-border p-0.5" data-testid="live-board-layout">
      {(['status', 'mission'] as const).map((value) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={layout === value}
          data-layout={value}
          onClick={() => onChange(value)}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
            event.preventDefault()
            const other = value === 'status' ? 'mission' : 'status'
            onChange(other)
            event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-layout="${other}"]`)?.focus()
          }}
          tabIndex={layout === value ? 0 : -1}
          className={cn(
            'h-6 rounded-control px-2.5 text-label transition-colors duration-150',
            layout === value ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t(`layout.${value}`)}
        </button>
      ))}
    </div>
  )
}

function Column({ column, cards, actions, now, showProject }: { column: LiveColumn; cards: ReturnType<typeof columnsOf>[LiveColumn]; actions: LiveBoardActions; now: number; showProject: boolean }) {
  const { t } = useTranslation('liveBoard')
  const hint = column === 'done' ? t('columns.doneHint') : null
  const openInbox = column === 'needs' ? actions.openInbox : undefined
  const pausedCount = column === 'working' ? cards.filter(isPausedCard).length : 0
  return (
    <section
      aria-labelledby={`live-col-${column}`}
      className={cn('flex min-w-0 flex-col rounded-card border border-border/60 xl:min-h-0', column === 'needs' ? 'bg-card' : 'bg-background')}
      data-testid="live-column"
      data-column={column}
    >
      <h3 id={`live-col-${column}`} className="flex items-center gap-2 px-3 pb-2 pt-3 text-label text-foreground">
        {column === 'needs'
          ? <Inbox className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          : <RunStateGlyph state={COLUMN_STATE[column]} quiet />}
        <span>{t(`columns.${column}`)}</span>
        <span className="tabular-nums text-muted-foreground" data-testid="live-column-count">{column === 'working' ? cards.length - pausedCount : cards.length}</span>
        {column === 'working' && pausedCount > 0 && (
          <span className="tabular-nums text-caption text-muted-foreground" data-testid="live-column-paused">{t('summary.paused', { count: pausedCount })}</span>
        )}
        {hint && <span className="ml-auto truncate text-caption text-muted-foreground">{hint}</span>}
        {openInbox && (
          <Button variant="link" size="sm" className="ml-auto h-auto p-0 text-caption" onClick={openInbox} data-testid="live-board-open-inbox">
            {t('columns.openInbox')}
          </Button>
        )}
      </h3>
      {cards.length === 0 ? (
        <p className="px-3 pb-3 text-caption text-muted-foreground" data-testid="live-column-empty">{t(`columnEmpty.${column}`)}</p>
      ) : (
        <ul role="list" className="flex flex-col gap-2 px-2 pb-2 xl:overflow-y-auto">
          {cards.map((card) => <LiveBoardCard key={card.id} card={card} actions={actions} now={now} showProject={showProject} />)}
        </ul>
      )}
    </section>
  )
}

function Lane({ entry, actions, now, projectNames }: { entry: VisibleLane; actions: LiveBoardActions; now: number; projectNames: ReadonlyMap<string, string> }) {
  const { t } = useTranslation('liveBoard')
  const { lane, cards } = entry
  const mission = lane.conversationId !== null
  const look = liveCardLook(cards[0], useMissionExtensions().runStateOf)
  const title = mission ? lane.title ?? t('lane.untitled') : t('lane.noMission')
  const projects = lane.projectIds.length === 1 ? projectNames.get(lane.projectIds[0]) ?? lane.projectIds[0] : t('lane.projects', { count: lane.projectIds.length })
  const meta = [projects, mission ? t('lane.mission') : null, lane.provider ? providerLabel(lane.provider) : null].filter(Boolean).join(' · ')
  const counts = [t('lane.runs', { count: cards.length }), lane.todayCostUsd !== null && lane.todayCostUsd > 0 ? t('lane.today', { cost: formatUsd(lane.todayCostUsd) }) : null].filter(Boolean).join(' · ')
  const id = `live-lane-${lane.conversationId ?? 'none'}`
  return (
    <section aria-labelledby={id} className="grid grid-cols-[minmax(0,1fr)] gap-3 border-b border-border/40 py-3 last:border-b-0 md:grid-cols-[13rem_minmax(0,1fr)]" data-testid="live-lane" data-conversation-id={lane.conversationId ?? ''}>
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id={id} className="flex min-w-0 items-start gap-2 text-strong text-foreground">
          {mission ? <RunStateGlyph state={look.state} className="mt-0.5" /> : null}
          <span className="line-clamp-2 break-words" title={title}>{title}</span>
        </h3>
        <p className="truncate text-caption text-muted-foreground">{mission ? meta : t('lane.noMissionHint')}</p>
        <p className="text-caption tabular-nums text-muted-foreground">{counts}</p>
      </div>
      <ul role="list" className="flex min-w-0 flex-wrap gap-2">
        {cards.map((card) => <LiveBoardCard key={card.id} card={card} actions={actions} now={now} compact showProject={lane.projectIds.length > 1} />)}
      </ul>
    </section>
  )
}

export interface LiveBoardPanelProps {
  data: LiveBoardData
  actions: LiveBoardActions
  /** Moves the board to its own window; absent in the browser and inside that window. */
  onOpenInWindow?: (() => void) | null
}

/**
 * The live board inside a dialog (or its own window): the header with the
 * summary, the layout selector and "Open in window"; the filters; then the
 * columns (by status) or the lanes (by mission).
 */
export function LiveBoardPanel({ data, actions, onOpenInWindow }: LiveBoardPanelProps) {
  const { t } = useTranslation('liveBoard')
  const [layout, setLayout] = useState<LiveBoardLayout>(readLayout)
  const [filters, setFilters] = useState<LiveBoardFilters>(NO_FILTERS)
  const now = useNow(30_000, true)
  const inbox = useInbox()
  const snapshot = data.snapshot
  // The inbox's own Snooze / Done (per viewer): a dismissed item leaves "Needs you" here too, so its count is the inbox's.
  const dismissals = useMemo(() => readDismissals(), [snapshot, inbox?.items]) // eslint-disable-line react-hooks/exhaustive-deps
  const showProject = (snapshot?.projects.length ?? 0) > 1
  const cards = useMemo(() => snapshot?.cards ?? [], [snapshot])
  const columns = useMemo(() => columnsOf(cards, filters, (item) => isDismissed(item, dismissals, Date.now())), [cards, filters, dismissals])
  const lanes = useMemo(() => (snapshot ? lanesOf(snapshot, filters) : []), [snapshot, filters])
  const providers = useMemo(() => providersOf(cards), [cards])
  const projectNames = useMemo(() => new Map((snapshot?.projects ?? []).map((p) => [p.projectId, p.projectName])), [snapshot])
  const visible = countVisible(columns)
  const filtered = filters.projectId !== null || filters.kind !== null || filters.provider !== null
  const visibleCount = LIVE_COLUMNS.reduce((sum, column) => sum + columns[column].length, 0)
  const changeLayout = (next: LiveBoardLayout): void => { setLayout(next); writeLayout(next) }
  const totals = snapshot?.totals
  const cost = totals?.costTodayUsd ?? null

  const summary = snapshot ? (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-0.5 tabular-nums" data-testid="live-board-summary">
      <span>{t('summary.needsYou', { count: visible.needsYou })}</span>
      <span>{t('summary.inProgress', { count: visible.inProgress })}</span>
      {visible.paused > 0 && <span>{t('summary.paused', { count: visible.paused })}</span>}
      {cost !== null && <span>{t(totals?.costTodayEstimated ? 'summary.todayEstimated' : 'summary.today', { cost: formatUsd(cost) })}</span>}
    </span>
  ) : t('description')

  const headerActions = (
    <div className="flex items-center gap-2">
      <LayoutSelector layout={layout} onChange={changeLayout} />
      {onOpenInWindow && (
        <Button size="sm" variant="outline" onClick={onOpenInWindow} data-testid="live-board-open-window">
          <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          {t('openInWindow')}
        </Button>
      )}
    </div>
  )

  return (
    <>
      <DialogHeader icon={<Columns3 />} actions={headerActions}>
        <DialogTitle>{t('title')}</DialogTitle>
        <DialogDescription className="text-caption">{summary}</DialogDescription>
        <span className="sr-only">{t('shortcutHint', { shortcut: keyboardLabel(LIVE_BOARD_CHORD) })}</span>
        {data.stale && data.status === 'ready' && (
          <p role="status" className="text-caption text-muted-foreground" data-testid="live-board-stale">
            {t('stale')}{' '}
            <Button variant="link" size="sm" className="h-auto p-0 text-caption" onClick={() => { void data.refresh() }}>{t('error.retry')}</Button>
          </p>
        )}
      </DialogHeader>
      <DialogBody className={cn('flex min-h-0 flex-col gap-3', layout === 'status' && snapshot && cards.length > 0 && 'xl:overflow-hidden')}>
        {snapshot && cards.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label={t('filters.label')} data-testid="live-board-filters">
            <div role="group" aria-label={t('filters.project')} className="flex flex-wrap gap-1.5">
              <Chip pressed={filters.projectId === null} onClick={() => setFilters((f) => ({ ...f, projectId: null }))} testId="live-filter-project-all">
                {t('filters.allProjects')} <span className="tabular-nums text-muted-foreground">{snapshot.projects.length}</span>
              </Chip>
              {snapshot.projects.map((project) => (
                <Chip key={project.projectId} pressed={filters.projectId === project.projectId} onClick={() => setFilters((f) => ({ ...f, projectId: f.projectId === project.projectId ? null : project.projectId }))} testId="live-filter-project">
                  {project.projectName}
                </Chip>
              ))}
            </div>
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />
            <div role="group" aria-label={t('filters.kind')} className="flex flex-wrap gap-1.5">
              {LIVE_KINDS.map((kind) => (
                <Chip key={kind} pressed={filters.kind === kind} onClick={() => setFilters((f) => ({ ...f, kind: f.kind === kind ? null : kind }))} testId={`live-filter-kind-${kind}`}>
                  {t(`kinds.${kind}`)}
                </Chip>
              ))}
            </div>
            {providers.length > 1 && (
              <>
                <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />
                <div role="group" aria-label={t('filters.engine')} className="flex flex-wrap gap-1.5">
                  {providers.map((provider) => (
                    <Chip key={provider} pressed={filters.provider === provider} onClick={() => setFilters((f) => ({ ...f, provider: f.provider === provider ? null : provider }))} testId="live-filter-engine">
                      {providerLabel(provider)}
                    </Chip>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {!snapshot && data.status === 'loading' && (
          <div className="space-y-2" data-testid="live-board-loading">
            <RailTrack running aria-label={t('loading')} />
            <p className="text-body text-muted-foreground">{t('loading')}</p>
          </div>
        )}
        {!snapshot && data.status === 'error' && (
          <EmptyState
            icon={<OctagonAlert className="h-4 w-4" />}
            title={t('error.title')}
            description={t('error.description')}
            action={<Button size="sm" variant="outline" onClick={() => { void data.refresh() }}>{t('error.retry')}</Button>}
            data-testid="live-board-error"
          />
        )}
        {snapshot && cards.length === 0 && (
          <EmptyState icon={<CircleCheck className="h-4 w-4" />} title={t('empty.title')} description={t('empty.description')} learnMore="liveBoard" data-testid="live-board-empty" />
        )}
        {snapshot && cards.length > 0 && filtered && visibleCount === 0 && layout === 'status' && (
          <EmptyState
            icon={<SearchX className="h-4 w-4" />}
            title={t('emptyFiltered.title')}
            action={<Button size="sm" variant="outline" onClick={() => setFilters(NO_FILTERS)}>{t('emptyFiltered.clear')}</Button>}
            data-testid="live-board-empty-filtered"
          />
        )}

        {snapshot && cards.length > 0 && layout === 'status' && !(filtered && visibleCount === 0) && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:min-h-0 xl:flex-1 xl:grid-cols-3" data-testid="live-board-columns">
            {LIVE_COLUMNS.map((column) => <Column key={column} column={column} cards={columns[column]} actions={actions} now={now} showProject={showProject} />)}
          </div>
        )}
        {snapshot && cards.length > 0 && layout === 'mission' && (
          lanes.length > 0 ? (
            <div className="flex flex-col" data-testid="live-board-lanes">
              {lanes.map((entry) => <Lane key={entry.lane.conversationId ?? 'none'} entry={entry} actions={actions} now={now} projectNames={projectNames} />)}
            </div>
          ) : (
            <EmptyState
              icon={<SearchX className="h-4 w-4" />}
              title={t('emptyFiltered.title')}
              action={<Button size="sm" variant="outline" onClick={() => setFilters(NO_FILTERS)}>{t('emptyFiltered.clear')}</Button>}
              data-testid="live-board-empty-filtered"
            />
          )
        )}
      </DialogBody>
    </>
  )
}
