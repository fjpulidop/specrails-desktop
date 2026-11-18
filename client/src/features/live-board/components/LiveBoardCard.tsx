import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { RunStateGlyph } from '../../../components/ui/run-state/run-state-glyph'
import { runStateLook } from '../../../components/ui/run-state/run-state'
import { compactRelativeTime, parseTimestampMs } from '../../../lib/relative-time'
import { formatUsd } from '../../../lib/format-usd'
import { projectMonogram } from '../../../lib/project-monogram'
import { cn } from '../../../lib/utils'
import { primaryLabelKey } from '../../inbox/lib/inbox-model'
import { useInboxItemText } from '../../inbox/hooks/useInboxItemText'
import type { InboxItem } from '../../inbox/lib/inbox-model'
import { humanizeStepId } from '../../missions/components/mission-run-strip'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { canOpen, primaryOf, type LiveCard, type LiveMergePreview } from '../lib/live-board-model'
import { liveCardLook } from '../lib/live-board-run-state'
import { useMissionExtensions } from '../../missions/context/MissionExtensionsContext'
import type { LiveBoardActions } from '../context/LiveBoardContext'

/** "Rail 2", "Loop", "Intent", "Job". */
export function useKindLabel(): (card: Pick<LiveCard, 'kind' | 'railIndex'>) => string | null {
  const { t } = useTranslation('liveBoard')
  return (card) => {
    if (card.kind === 'rail') return card.railIndex !== null ? t('kind.rail', { n: card.railIndex + 1 }) : t('kind.railUnknown')
    return card.kind ? t(`kind.${card.kind}`) : null
  }
}

function useAgeLabel(): (iso: string | null, now: number) => string | null {
  const { t } = useTranslation('liveBoard')
  return (iso, now) => {
    if (!iso) return null
    const age = compactRelativeTime(iso, now)
    if (!age) return null
    return age === 'now' ? t('card.now') : age
  }
}

/** The card's time: how long it has waited, how long it has run, or when it settled. */
function useTimeLabel(card: LiveCard, now: number): string | null {
  const { t, i18n } = useTranslation('liveBoard')
  const age = useAgeLabel()
  if (card.column === 'needs' || card.column === 'decide') {
    const value = age(card.at, now)
    return value ? t('card.waiting', { age: value }) : null
  }
  if (card.column === 'done') {
    const at = parseTimestampMs(card.finishedAt ?? card.at)
    if (Number.isNaN(at)) return null
    try { return new Date(at).toLocaleTimeString(i18n.language || 'en', { hour: 'numeric', minute: '2-digit' }) } catch { return null }
  }
  const queued = card.status.source === 'job' && card.status.status === 'queued'
  const value = age(card.startedAt ?? card.at, now)
  if (!value) return null
  return queued ? t('card.queuedFor', { age: value }) : value
}

/** The run's current phrase: its state's name and, while it works, the step it is on. */
function useRunPhrase(card: LiveCard): string {
  const { t } = useTranslation(['liveBoard', 'common'])
  const look = liveCardLook(card, useMissionExtensions().runStateOf)
  if (card.status.source === 'job' && card.status.status === 'queued') return t('liveBoard:card.queued')
  const state = t(runStateLook(look.state).labelKey)
  return look.state === 'working' && card.phase ? `${state} · ${humanizeStepId(card.phase)}` : state
}

function AttentionPhrase({ item }: { item: InboxItem }) {
  const text = useInboxItemText(item)
  return (
    <p className="truncate text-caption text-muted-foreground" title={text.rawDetail ?? undefined}>
      {text.kindLabel}{text.detail ? ` · ${text.detail}` : ''}
    </p>
  )
}

function RunPhrase({ card }: { card: LiveCard }) {
  return <p className="truncate text-caption text-muted-foreground">{useRunPhrase(card)}</p>
}

function Steps({ steps }: { steps: NonNullable<LiveCard['steps']> }) {
  const { t } = useTranslation('liveBoard')
  const label = t('card.steps', { done: steps.done, total: steps.total })
  return (
    <div className="flex gap-0.5" role="img" aria-label={label} title={label} data-testid="live-card-steps">
      {Array.from({ length: Math.min(steps.total, 12) }, (_, i) => (
        <span key={i} className={cn('h-0.5 flex-1 rounded-full', i < steps.done ? 'bg-accent-success' : i === steps.done ? 'bg-accent-info' : 'bg-border')} />
      ))}
    </div>
  )
}

export interface LiveBoardCardProps {
  card: LiveCard
  actions: LiveBoardActions
  now: number
  /** Inside a mission lane the mission is the header: the card leads with its run. */
  compact?: boolean
}

/** One run: its state, project, kind, title, phrase, progress, engine, time, cost and its one action. */
/**
 * A delivery's merge preview on its card: conflicts with the current base or
 * with sibling runs take the `blocked` (warning) look; a moved base is a quiet
 * note. A clean merge says nothing.
 */
function MergePreviewPhrase({ preview }: { preview: LiveMergePreview }) {
  const { t } = useTranslation('liveBoard')
  const parts: string[] = []
  if (preview.status === 'conflicts') parts.push(t('card.mergeConflicts', { count: preview.conflictFileCount }))
  if (preview.siblingConflictCount > 0) parts.push(t('card.mergeSiblings', { count: preview.siblingConflictCount }))
  const moved = preview.baseAdvancedBy ?? 0
  if (parts.length === 0 && moved === 0) return null
  return (
    <p className="flex min-w-0 items-center gap-1.5 text-caption" data-testid="live-card-merge-preview">
      {parts.length > 0 ? <RunStateGlyph state="blocked" size="xs" /> : null}
      <span className={cn('truncate', parts.length > 0 ? 'text-foreground' : 'text-muted-foreground')}>
        {[...parts, ...(moved > 0 ? [t('card.baseMoved', { count: moved })] : [])].join(' · ')}
      </span>
    </p>
  )
}

export function LiveBoardCard({ card, actions, now, compact = false }: LiveBoardCardProps) {
  const { t } = useTranslation(['liveBoard', 'inbox'])
  const kindLabel = useKindLabel()
  const look = liveCardLook(card, useMissionExtensions().runStateOf)
  const time = useTimeLabel(card, now)
  const primary = primaryOf(card)
  const busy = actions.busy(card)
  const attentionText = card.attention ? card.attention.title : null
  const title = card.title ?? attentionText ?? t(card.kind === 'intent' ? 'liveBoard:card.untitledIntent' : 'liveBoard:card.untitled')
  const kind = kindLabel(card)
  const stateLabel = t(runStateLook(look.state).labelKey)
  const question = card.question
  const primaryLabel = primary.kind === 'inbox' ? t(`inbox:${primaryLabelKey(primary.item)}`)
    : primary.kind === 'review' ? t('liveBoard:card.openReview')
      : primary.kind === 'open' ? t('liveBoard:card.open') : null
  // Resume and Retry act on the run; the run itself still opens.
  const secondaryOpen = primary.kind === 'inbox' && (primary.item.action === 'resume-run' || primary.item.action === 'retry-jira' || primary.item.action === 'raise-cap') && canOpen(card)
  const settledStopped = card.column === 'done' && look.state === 'stopped'
  return (
    <li
      className={cn('flex min-w-0 flex-col gap-1.5 rounded-card border border-border/60 bg-card px-3 py-2.5 shadow-1', compact && 'w-full sm:w-64')}
      data-testid="live-card"
      data-card-id={card.id}
      data-column={card.column}
      data-run-state={look.state}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <RunStateGlyph state={look.state} objectIcon={look.objectIcon} label={stateLabel} />
        <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded-control bg-muted px-0.5 text-caption font-semibold leading-none text-muted-foreground" aria-hidden>
          {projectMonogram(card.projectName)}
        </span>
        <span className="truncate text-caption text-muted-foreground">
          {card.projectName}{kind ? ` · ${kind}` : ''}
        </span>
      </div>
      {canOpen(card) ? (
        <button
          type="button"
          className="truncate text-left text-strong text-foreground hover:underline focus-visible:underline"
          title={title}
          onClick={() => actions.open(card)}
          data-testid="live-card-title"
        >
          <span className={cn(settledStopped && 'text-muted-foreground')}>{title}</span>
        </button>
      ) : (
        <p className={cn('truncate text-strong', settledStopped ? 'text-muted-foreground' : 'text-foreground')} title={title}>{title}</p>
      )}
      {question && (
        <blockquote className="line-clamp-3 rounded-control bg-muted px-2 py-1 text-caption text-foreground" data-testid="live-card-question">
          <span className="sr-only">{t('liveBoard:card.question')}: </span>{question}
        </blockquote>
      )}
      {card.attention ? <AttentionPhrase item={card.attention} /> : <RunPhrase card={card} />}
      {card.mergePreview ? <MergePreviewPhrase preview={card.mergePreview} /> : null}
      {card.steps && card.column === 'working' && <Steps steps={card.steps} />}
      <div className="flex items-center gap-2 text-caption tabular-nums text-muted-foreground">
        {card.provider && <span className="truncate">{providerLabel(card.provider)}</span>}
        {time && <span className="shrink-0">{time}</span>}
        <span className="flex-1" aria-hidden />
        {card.costUsd !== null && card.costUsd > 0 && (
          <span className="shrink-0" title={card.costEstimated ? t('liveBoard:card.costEstimatedHint') : undefined}>
            {card.costEstimated ? t('liveBoard:card.costEstimated', { cost: formatUsd(card.costUsd) }) : formatUsd(card.costUsd)}
            {card.costEstimated && <span className="sr-only"> ({t('liveBoard:card.costEstimatedHint')})</span>}
          </span>
        )}
      </div>
      {(primaryLabel || secondaryOpen) && (
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          {primaryLabel && (
            <Button
              size="sm"
              variant="outline"
              className="focus-visible:border-primary focus-visible:bg-primary focus-visible:text-primary-foreground"
              disabled={busy}
              data-live-primary=""
              data-testid="live-card-primary"
              aria-label={t('liveBoard:card.actionLabel', { action: primaryLabel, title })}
              onClick={() => actions.primary(card)}
            >
              {busy ? t('inbox:working') : primaryLabel}
            </Button>
          )}
          {secondaryOpen && (
            <Button size="sm" variant="ghost" data-testid="live-card-open" aria-label={t('liveBoard:card.actionLabel', { action: t('liveBoard:card.open'), title })} onClick={() => actions.open(card)}>
              {t('liveBoard:card.open')}
            </Button>
          )}
        </div>
      )}
    </li>
  )
}
