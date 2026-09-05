import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Eye, Loader2, Pause, Play, X as XIcon, Layers, ArrowRight, Ban, Flag, Zap } from 'lucide-react'
import { cn } from '../../lib/utils'
import { formatElapsed } from '../../lib/format-duration'
import { PrDecisionPill } from '../agent-chat/AgentPrPinnedDock'
import type { AgentPrDecisionValue } from '../../lib/agent-api'
import {
  chainAtCheckpoint,
  chainIsLive,
  chainPauseReason,
  deliveredCount,
  milestoneLabelFor,
  progressSegments,
  REVIEWABLE_DECISIONS,
  type MilestoneChainSnapshot,
  type MilestoneCounts,
  type MilestoneProgress,
  type MilestoneRail,
  type MilestoneState,
  type SegmentKey,
} from '../../lib/milestone-progress'

// Premium milestone surfaces (premium-milestone-progress D5). Everything here
// renders the SERVER-derived model verbatim: a segmented bar by spec state,
// honest counts ("3 of 8 delivered · 0 done" — never "complete" while anything
// is unmerged), one row per milestone rail with its decision + Review, and the
// launch chain's row (k of n, waiting / paused reason, Resume / Cancel).

const SEGMENT_TONE: Record<SegmentKey, string> = {
  done: 'bg-accent-success',
  onReview: 'bg-accent-warning',
  inProgress: 'bg-accent-info animate-pulse',
  failed: 'bg-destructive',
  todo: 'bg-muted-foreground/25',
}

const STATE_TONE: Record<MilestoneState, string> = {
  planned: 'border-border/60 bg-surface/60 text-foreground/60',
  committed: 'border-accent-primary/40 bg-accent-primary/10 text-accent-primary',
  running: 'border-accent-info/40 bg-accent-info/10 text-accent-info',
  delivered: 'border-accent-warning/40 bg-accent-warning/10 text-accent-warning',
  done: 'border-accent-success/40 bg-accent-success/10 text-accent-success',
}

export function MilestoneProgressBar({ counts, className }: { counts: MilestoneCounts; className?: string }) {
  const { t } = useTranslation('builder')
  const segments = progressSegments(counts)
  return (
    <div
      className={cn('flex h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      role="img"
      aria-label={t('milestoneProgress.counts', { delivered: deliveredCount(counts), total: counts.total, done: counts.done })}
      data-testid="milestone-progress-bar"
    >
      {segments.map((s) => (
        <div
          key={s.key}
          data-segment={s.key}
          className={cn('h-full transition-all duration-500', SEGMENT_TONE[s.key])}
          style={{ width: `${s.pct}%` }}
          title={`${t(`milestoneProgress.legend.${s.key}`)} · ${s.count}`}
        />
      ))}
    </div>
  )
}

export function MilestoneStatePill({ state }: { state: MilestoneState }) {
  const { t } = useTranslation('builder')
  return (
    <span
      data-testid="milestone-state-pill"
      data-state={state}
      className={cn('inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide', STATE_TONE[state])}
    >
      {t(`milestoneProgress.state.${state}`)}
    </span>
  )
}

/** 1-second clock while any rail is live (the elapsed label is real wall time). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export interface MilestoneRailRowProps {
  rail: MilestoneRail
  now: number
  onReview?: (deliveryId: string) => void
  onOpenRail?: (railIndex: number) => void
}

export function MilestoneRailRow({ rail, now, onReview, onOpenRail }: MilestoneRailRowProps) {
  const { t } = useTranslation('builder')
  const name = rail.name ?? t('milestoneProgress.rail.fallbackName', { n: rail.railIndex + 1 })
  const elapsed = rail.active && rail.startedAt ? Math.max(0, now - Date.parse(rail.startedAt)) : null
  const decision = rail.delivery?.decision ?? null
  const reviewable = decision !== null && REVIEWABLE_DECISIONS.has(decision) && rail.delivery !== null
  return (
    <div
      className="flex items-center gap-2 rounded-md border border-border/30 bg-surface/40 px-2 py-1.5"
      data-testid="milestone-rail-row"
      data-rail-index={rail.railIndex}
    >
      {rail.chunkIndex != null && (
        <span className="shrink-0 rounded bg-muted/70 px-1 py-px text-[9px] font-mono tabular-nums text-muted-foreground" title={t('milestoneProgress.rail.chunk', { k: rail.chunkIndex })}>
          {rail.chunkIndex}
        </span>
      )}
      <button
        type="button"
        onClick={() => onOpenRail?.(rail.railIndex)}
        className="min-w-0 flex-1 truncate text-left text-[11px] font-medium hover:underline"
        title={t('milestoneProgress.rail.open')}
      >
        {name}
      </button>
      {rail.active ? (
        <span className="flex shrink-0 items-center gap-1 text-[10px] text-accent-info" data-testid="milestone-rail-running">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
          {elapsed != null ? t('milestoneProgress.rail.running', { elapsed: formatElapsed(elapsed) }) : t('milestoneProgress.state.running')}
        </span>
      ) : decision ? (
        <PrDecisionPill decision={decision as AgentPrDecisionValue} />
      ) : (
        <span className="text-[10px] text-muted-foreground">{t('milestoneProgress.rail.noDelivery')}</span>
      )}
      {reviewable && rail.delivery && (
        <button
          type="button"
          onClick={() => onReview?.(rail.delivery!.id)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-accent-primary/40 bg-accent-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-accent-primary hover:bg-accent-primary/20"
          data-testid="milestone-rail-review"
        >
          <Eye className="h-3 w-3" aria-hidden />
          {t('milestoneProgress.rail.review')}
        </button>
      )}
    </div>
  )
}

/** Wave-checkpoint preference switch (premium-milestone-progress D9): ON =
 *  every delivered rail launches the next one; OFF = the chain stops after
 *  each rail and asks. Used by the launch controls (stored preference) and
 *  by a live chain row (PATCHes the chain). */
export function MilestoneAutoAdvanceToggle({
  checked,
  onChange,
  disabled = false,
  compact = false,
  testId = 'milestone-auto-advance',
}: {
  checked: boolean
  onChange: (on: boolean) => void
  disabled?: boolean
  compact?: boolean
  testId?: string
}) {
  const { t } = useTranslation('builder')
  const hint = checked ? t('milestoneProgress.chain.autoAdvanceHint') : t('milestoneProgress.chain.checkpointHint')
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={t('milestoneProgress.chain.autoAdvance')}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      title={hint}
      className={cn(
        'group inline-flex items-center gap-1.5 rounded-md border px-1.5 py-1 text-left text-[10px] transition-colors disabled:opacity-50',
        checked ? 'border-accent-success/40 bg-accent-success/10 text-accent-success' : 'border-border/50 text-muted-foreground hover:text-foreground',
        compact ? 'py-0.5' : 'w-full',
      )}
      data-testid={testId}
      data-checked={checked}
    >
      <span
        aria-hidden
        className={cn(
          'relative inline-flex h-3 w-5 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-accent-success/70' : 'bg-muted-foreground/30',
        )}
      >
        <span className={cn('absolute h-2 w-2 rounded-full bg-background shadow transition-transform', checked ? 'translate-x-2.5' : 'translate-x-0.5')} />
      </span>
      {checked ? <Zap className="h-3 w-3 shrink-0" aria-hidden /> : <Flag className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="min-w-0 flex-1 truncate font-medium">{t('milestoneProgress.chain.autoAdvance')}</span>
      {!compact && <span className="hidden truncate text-[9px] font-normal text-muted-foreground group-hover:inline">{hint}</span>}
    </button>
  )
}

export interface MilestoneChainRowProps {
  chain: MilestoneChainSnapshot
  busy?: boolean
  onResume?: (chainId: string) => void
  onCancel?: (chainId: string) => void
  /** Flip the chain's auto-continue flag (wave checkpoints). */
  onSetAutoAdvance?: (chainId: string, on: boolean) => void
}

export function MilestoneChainRow({ chain, busy = false, onResume, onCancel, onSetAutoAdvance }: MilestoneChainRowProps) {
  const { t } = useTranslation('builder')
  const live = chainIsLive(chain)
  const paused = chain.status === 'paused'
  const checkpoint = chainAtCheckpoint(chain)
  const reason = chainPauseReason(chain.pauseReason)
  const reasonText = paused
    ? t(`milestoneProgress.chain.reasons.${reason.key}`, { detail: reason.detail, defaultValue: chain.pauseReason ?? '' })
    : null
  const showToggle = chain.mode === 'sequential' && (live || paused || checkpoint) && Boolean(onSetAutoAdvance)
  return (
    <div
      className={cn(
        'rounded-md border px-2 py-1.5 text-[10px]',
        paused
          ? 'border-accent-warning/40 bg-accent-warning/5'
          : checkpoint
            ? 'border-accent-success/40 bg-accent-success/5'
            : live ? 'border-accent-info/30 bg-accent-info/5' : 'border-border/30 bg-surface/40',
      )}
      data-testid="milestone-chain-row"
      data-status={chain.status}
    >
      <div className="flex items-center gap-1.5">
        <Layers className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">
          {chain.mode === 'parallel' ? t('milestoneProgress.chain.parallelTitle') : t('milestoneProgress.chain.title')}
        </span>
        <span className="text-muted-foreground">
          {' · '}{t('milestoneProgress.chain.progress', { k: Math.min(chain.nextChunk, chain.totalChunks), n: chain.totalChunks })}
        </span>
        <span className="flex-1" />
        {checkpoint && onResume && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onResume(chain.id)}
            className="inline-flex items-center gap-1 rounded-md border border-accent-success/40 bg-accent-success/10 px-1.5 py-0.5 font-medium text-accent-success hover:bg-accent-success/20 disabled:opacity-50"
            data-testid="milestone-chain-launch-next"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
            {t('milestoneProgress.chain.launchNext')}
          </button>
        )}
        {paused && onResume && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onResume(chain.id)}
            className="inline-flex items-center gap-1 rounded-md border border-accent-success/40 bg-accent-success/10 px-1.5 py-0.5 font-medium text-accent-success hover:bg-accent-success/20 disabled:opacity-50"
            data-testid="milestone-chain-resume"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <Play className="h-3 w-3" aria-hidden />}
            {t('milestoneProgress.chain.resume')}
          </button>
        )}
        {(live || paused || checkpoint) && onCancel && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onCancel(chain.id)}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 px-1.5 py-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
            title={t('milestoneProgress.chain.cancel')}
            data-testid="milestone-chain-cancel"
          >
            <XIcon className="h-3 w-3" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1 text-muted-foreground">
        {paused ? (
          <>
            <Pause className="h-3 w-3 shrink-0 text-accent-warning" aria-hidden />
            <span className="text-accent-warning">{t('milestoneProgress.chain.paused', { reason: reasonText })}</span>
          </>
        ) : checkpoint ? (
          <>
            <Flag className="h-3 w-3 shrink-0 text-accent-success" aria-hidden />
            <span className="text-accent-success" data-testid="milestone-chain-checkpoint">
              {t('milestoneProgress.chain.checkpoint', { k: chain.nextChunk, next: chain.nextChunk + 1, n: chain.totalChunks })}
            </span>
            {chain.headBranch && (
              <span className="truncate font-mono" title={chain.headBranch}> · {t('milestoneProgress.chain.stackedOn', { branch: chain.headBranch })}</span>
            )}
          </>
        ) : chain.status === 'running' ? (
          <>
            <ArrowRight className="h-3 w-3 shrink-0" aria-hidden />
            <span>{t('milestoneProgress.chain.waiting', { k: chain.nextChunk })}</span>
            {chain.headBranch && chain.mode === 'sequential' && (
              <span className="truncate font-mono" title={chain.headBranch}> · {t('milestoneProgress.chain.stackedOn', { branch: chain.headBranch })}</span>
            )}
            {chain.mode === 'sequential' && !chain.autoAdvance && chain.nextChunk < chain.totalChunks && (
              <span className="shrink-0" data-testid="milestone-chain-checkpoint-note"> · {t('milestoneProgress.chain.checkpointNote')}</span>
            )}
          </>
        ) : chain.status === 'completed' ? (
          <span>{t('milestoneProgress.chain.completed')}</span>
        ) : chain.status === 'cancelled' ? (
          <span className="flex items-center gap-1"><Ban className="h-3 w-3" aria-hidden />{t('milestoneProgress.chain.cancelled')}</span>
        ) : (
          <span>{t('milestoneProgress.chain.waiting', { k: chain.nextChunk })}</span>
        )}
      </div>
      {showToggle && onSetAutoAdvance && (
        <div className="mt-1.5">
          <MilestoneAutoAdvanceToggle
            checked={chain.autoAdvance}
            disabled={busy}
            onChange={(on) => onSetAutoAdvance(chain.id, on)}
            testId="milestone-chain-auto-advance"
          />
        </div>
      )}
    </div>
  )
}

export interface MilestoneCardProps {
  progress: MilestoneProgress
  /** Extra action controls rendered under the counts (Launch, mode toggle…). */
  actions?: ReactNode
  chainBusy?: boolean
  onReview?: (deliveryId: string) => void
  onOpenRail?: (railIndex: number) => void
  onResume?: (chainId: string) => void
  onCancel?: (chainId: string) => void
  onSetAutoAdvance?: (chainId: string, on: boolean) => void
  className?: string
}

export function MilestoneCard({ progress, actions, chainBusy, onReview, onOpenRail, onResume, onCancel, onSetAutoAdvance, className }: MilestoneCardProps) {
  const { t } = useTranslation('builder')
  const anyActive = progress.rails.some((r) => r.active)
  const now = useNow(anyActive)
  const { counts } = progress
  const showChain = progress.chain !== null && progress.chain.status !== 'completed' && progress.chain.status !== 'cancelled'
    ? progress.chain
    : progress.chain && progress.chain.status === 'completed' && progress.rails.length > 0 && anyActive
      ? progress.chain
      : null
  return (
    <div className={cn('rounded-md border border-border/30 px-2 py-1.5', className)} data-testid="milestone-card" data-milestone={progress.n} data-state={progress.state}>
      <div className="flex items-center gap-2">
        <span className="rounded bg-accent-primary/10 px-1.5 py-px text-[9px] font-semibold text-accent-primary">
          {milestoneLabelFor(progress.n)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{progress.title}</span>
        <MilestoneStatePill state={progress.state} />
      </div>
      {counts.total > 0 && (
        <>
          <MilestoneProgressBar counts={counts} className="mt-1.5" />
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] tabular-nums text-muted-foreground">
            <span data-testid="milestone-counts">
              {t('milestoneProgress.counts', { delivered: deliveredCount(counts), total: counts.total, done: counts.done })}
            </span>
            {counts.inProgress > 0 && (
              <span className="text-accent-info">{t('milestoneProgress.legend.inProgress')} · {counts.inProgress}</span>
            )}
          </div>
          {counts.failed > 0 && (
            <p className="mt-0.5 text-[10px] text-destructive" data-testid="milestone-failed-note">
              {t('milestoneProgress.failedNote', { count: counts.failed })}
            </p>
          )}
        </>
      )}
      {actions && <div className="mt-2 flex flex-col gap-1.5">{actions}</div>}
      {showChain && (
        <div className="mt-2">
          <MilestoneChainRow chain={showChain} busy={chainBusy} onResume={onResume} onCancel={onCancel} onSetAutoAdvance={onSetAutoAdvance} />
        </div>
      )}
      {progress.rails.length > 0 && (
        <div className="mt-2 space-y-1" data-testid="milestone-rails">
          {progress.rails.map((rail) => (
            <MilestoneRailRow key={rail.railIndex} rail={rail} now={now} onReview={onReview} onOpenRail={onOpenRail} />
          ))}
        </div>
      )}
    </div>
  )
}
