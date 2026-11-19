import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { RunStateGlyph } from '../../../components/ui/run-state/run-state-glyph'
import { runStateLook } from '../../../components/ui/run-state/run-state'
import { compactRelativeTime, parseTimestampMs } from '../../../lib/relative-time'
import { formatUsd } from '../../../lib/format-usd'
import { cn } from '../../../lib/utils'
import { primaryLabelKey } from '../../inbox/lib/inbox-model'
import { useInboxItemTextOf, type InboxItemText } from '../../inbox/hooks/useInboxItemText'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip'
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
  if (card.column === 'needs') {
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

/** The inbox row's own words; the detail is left out when the card already shows the question it repeats. */
function AttentionPhrase({ text, withDetail }: { text: InboxItemText; withDetail: boolean }) {
  const detail = withDetail ? text.detail : null
  return (
    <p className="truncate text-caption text-muted-foreground" title={detail ? `${text.kindLabel} · ${detail}` : text.rawDetail ?? undefined} data-testid="live-card-phrase">
      {text.kindLabel}{detail ? ` · ${detail}` : ''}
    </p>
  )
}

function RunPhrase({ card }: { card: LiveCard }) {
  return <p className="truncate text-caption text-muted-foreground" data-testid="live-card-phrase">{useRunPhrase(card)}</p>
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
  /** Name the card's project (only when the board spans more than one). */
  showProject?: boolean
}

/**
 * A delivery's merge preview on its card: one short chip, the full sentence on
 * hover and focus. Conflicts with the current base or with sibling runs take
 * the `blocked` (warning) look; a moved base alone is a quiet chip. A clean
 * merge says nothing.
 */
function MergePreviewChip({ preview }: { preview: LiveMergePreview }) {
  const { t } = useTranslation('liveBoard')
  const parts: string[] = []
  if (preview.status === 'conflicts') parts.push(t('card.mergeConflicts', { count: preview.conflictFileCount }))
  if (preview.siblingConflictCount > 0) parts.push(t('card.mergeSiblings', { count: preview.siblingConflictCount }))
  const moved = preview.baseAdvancedBy ?? 0
  if (parts.length === 0 && moved === 0) return null
  const sentence = [...parts, ...(moved > 0 ? [t('card.baseMoved', { count: moved })] : [])].join(' · ')
  const warn = parts.length > 0
  const chip = preview.status === 'conflicts' ? t('card.mergeChip.conflicts', { count: preview.conflictFileCount })
    : preview.siblingConflictCount > 0 ? t('card.mergeChip.siblings', { count: preview.siblingConflictCount })
      : t('card.mergeChip.baseMoved')
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={sentence}
            data-testid="live-card-merge-preview"
            className={cn(
              'inline-flex h-5 max-w-full items-center gap-1 self-start rounded-pill border px-1.5 text-caption focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              warn ? 'border-accent-warning/40 text-foreground' : 'border-border/60 text-muted-foreground',
            )}
          >
            {warn ? <RunStateGlyph state="blocked" size="xs" /> : null}
            <span className="truncate">{chip}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-[16rem]">{sentence}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

/** One run: its state, kind (and project when there are several), title, phrase, progress, engine, time, cost and its one action. */
/**
 * The card's cost line. A chain card's cost is every attempt added up, as
 * analytics counts it. Billed and estimated stay apart: an all-estimate cost
 * reads `~$x`; a cost that is only partly estimated keeps the billed reading
 * and names the estimated part.
 */
function costLabel(card: Pick<LiveCard, 'costUsd' | 'costEstimated' | 'costEstimatedUsd'>, t: (key: string, options?: Record<string, unknown>) => string): { text: string; hint: string | null } | null {
  if (card.costUsd === null || card.costUsd <= 0) return null
  if (!card.costEstimated) return { text: formatUsd(card.costUsd), hint: null }
  const estimated = card.costEstimatedUsd
  if (estimated === null || estimated >= card.costUsd - 1e-9) {
    return { text: t('liveBoard:card.costEstimated', { cost: formatUsd(card.costUsd) }), hint: t('liveBoard:card.costEstimatedHint') }
  }
  return { text: formatUsd(card.costUsd), hint: t('liveBoard:card.costIncludesEstimate', { cost: t('liveBoard:card.costEstimated', { cost: formatUsd(estimated) }) }) }
}

export function LiveBoardCard({ card, actions, now, compact = false, showProject = false }: LiveBoardCardProps) {
  const { t } = useTranslation(['liveBoard', 'inbox'])
  const kindLabel = useKindLabel()
  const look = liveCardLook(card, useMissionExtensions().runStateOf)
  const time = useTimeLabel(card, now)
  const primary = primaryOf(card)
  const busy = actions.busy(card)
  const attentionText = useInboxItemTextOf(card.attention)
  // An inbox item that is not a run (a reached cap, a Jira update) is named exactly as the inbox names it.
  const ownTitle = card.status.source === 'attention' ? null : card.title
  const title = ownTitle ?? attentionText?.title ?? t(card.kind === 'intent' ? 'liveBoard:card.untitledIntent' : 'liveBoard:card.untitled')
  const kind = kindLabel(card)
  const meta = [showProject ? card.projectName : null, kind].filter(Boolean).join(' · ')
  const stateLabel = t(runStateLook(look.state).labelKey)
  const question = card.question
  const primaryLabel = primary.kind === 'inbox' ? t(`inbox:${primaryLabelKey(primary.item)}`)
    : primary.kind === 'review' ? t('liveBoard:card.openReview')
      : primary.kind === 'open' ? t('liveBoard:card.open') : null
  // Resume and Retry act on the run; the run itself still opens.
  const secondaryOpen = primary.kind === 'inbox' && (primary.item.action === 'resume-run' || primary.item.action === 'retry-jira' || primary.item.action === 'raise-cap') && canOpen(card)
  const settledStopped = card.column === 'done' && look.state === 'stopped'
  const cost = costLabel(card, t)
  const attemptCost = card.attempt && card.attempt.costUsd !== null && card.attempt.costUsd > 0
    ? t('liveBoard:card.attemptCost', {
      cost: card.attempt.costEstimated ? t('liveBoard:card.costEstimated', { cost: formatUsd(card.attempt.costUsd) }) : formatUsd(card.attempt.costUsd),
      of: card.attempt.of,
    })
    : null
  return (
    <li
      className={cn('flex min-w-0 flex-col gap-1.5 rounded-card border border-border/60 bg-card px-3 py-2.5 shadow-1', compact && 'w-full sm:w-64')}
      data-testid="live-card"
      data-card-id={card.id}
      data-column={card.column}
      data-run-state={look.state}
    >
      {meta && (
        <div className="flex min-w-0 items-center gap-1.5">
          <RunStateGlyph state={look.state} objectIcon={look.objectIcon} label={stateLabel} />
          <span className="truncate text-caption text-muted-foreground" data-testid="live-card-meta">{meta}</span>
        </div>
      )}
      <div className="flex min-w-0 items-center gap-1.5">
        {!meta && <RunStateGlyph state={look.state} objectIcon={look.objectIcon} label={stateLabel} />}
        {canOpen(card) ? (
          <button
            type="button"
            className="min-w-0 truncate text-left text-strong text-foreground hover:underline focus-visible:underline"
            title={title}
            onClick={() => actions.open(card)}
            data-testid="live-card-title"
          >
            <span className={cn(settledStopped && 'text-muted-foreground')}>{title}</span>
          </button>
        ) : (
          <p className={cn('min-w-0 truncate text-strong', settledStopped ? 'text-muted-foreground' : 'text-foreground')} title={title} data-testid="live-card-title">{title}</p>
        )}
        {card.attempt && (
          // Earlier attempts are this card's history, never cards of their own.
          // The card's cost is the chain's; this attempt's own cost is here.
          <span className="shrink-0 text-caption text-muted-foreground num" title={attemptCost ?? undefined} data-testid="live-card-attempt">
            {t('liveBoard:card.attempt', { number: card.attempt.number })}
            {attemptCost && <span className="sr-only"> ({attemptCost})</span>}
          </span>
        )}
      </div>
      {question && (
        <blockquote className="line-clamp-3 rounded-control bg-muted px-2 py-1 text-caption text-foreground" data-testid="live-card-question">
          <span className="sr-only">{t('liveBoard:card.question')}: </span>{question}
        </blockquote>
      )}
      {attentionText ? <AttentionPhrase text={attentionText} withDetail={!question} /> : <RunPhrase card={card} />}
      {card.mergePreview ? <MergePreviewChip preview={card.mergePreview} /> : null}
      {card.steps && card.column === 'working' && <Steps steps={card.steps} />}
      <div className="flex items-center gap-2 text-caption tabular-nums text-muted-foreground">
        {card.provider && <span className="truncate">{providerLabel(card.provider)}</span>}
        {time && <span className="shrink-0">{time}</span>}
        <span className="flex-1" aria-hidden />
        {cost && (
          <span className="shrink-0" title={cost.hint ?? undefined} data-testid="live-card-cost">
            {cost.text}
            {cost.hint && <span className="sr-only"> ({cost.hint})</span>}
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
