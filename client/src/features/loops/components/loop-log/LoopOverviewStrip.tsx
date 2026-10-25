import { Fragment, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Check, X, RotateCw, ArrowRight, Repeat } from 'lucide-react'
import { cn } from '../../../../lib/utils'
import type { NodeChip } from './loop-log-model'
import { loopNodeIcon, LOOP_NODE_TEXT_ACCENT, LOOP_NODE_BORDER_ACCENT } from './loop-node-visuals'
import { LiveDot } from '../../../../components/ui/live-dot'

export interface LoopOverviewStripProps {
  chips: NodeChip[]
  /** Live iteration counter — null hides the chip (legacy runs w/o iteration). */
  iteration: { current: number; limit: number | null } | null
  onChipClick: (segmentKey: string) => void
  variant: 'page' | 'glass'
}

function LoopOverviewStripInner({ chips, iteration, onChipClick, variant }: LoopOverviewStripProps) {
  const { t } = useTranslation('jobs')
  if (chips.length === 0 && !iteration) return null

  return (
    <div
      data-testid="loop-overview-strip"
      role="list"
      aria-label={t('loopExplorer.stepMapAria')}
      className={cn(
        'flex items-center gap-1 overflow-x-auto border-b border-border/30 bg-surface/20',
        variant === 'glass' ? 'px-3 py-1.5' : 'px-4 py-2',
      )}
    >
      {chips.map((chip, i) => {
        const Icon = loopNodeIcon(chip.kind)
        const textAccent = LOOP_NODE_TEXT_ACCENT[chip.kind] ?? 'text-foreground'
        const borderAccent = LOOP_NODE_BORDER_ACCENT[chip.kind] ?? 'border-border/40'
        const label =
          chip.label ?? t(`loops:builder.nodes.${chip.kind}`, { defaultValue: chip.kind })
        const clickable = chip.latestSegmentKey != null
        return (
          <Fragment key={chip.key}>
            {i > 0 && <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />}
            <button
              type="button"
              role="listitem"
              data-testid="loop-node-chip"
              data-state={chip.state}
              data-kind={chip.kind}
              data-decision={chip.decision}
              aria-label={`${label} — ${chip.state}`}
              disabled={!clickable}
              onClick={() => chip.latestSegmentKey && onChipClick(chip.latestSegmentKey)}
              className={cn(
                'relative flex items-center gap-1.5 shrink-0 rounded-full border bg-surface/40 px-2.5 py-1 text-caption transition-colors',
                borderAccent,
                chip.state === 'pending' && 'opacity-45 border-border/40',
                (chip.state === 'interrupted' || chip.state === 'paused') && 'border-dashed border-accent-warning/50',
                clickable ? 'cursor-pointer hover:bg-surface/70' : 'cursor-default',
              )}
            >
              {chip.state === 'running' && (
                <LiveDot tone="primary" size="xs" className="absolute -right-0.5 -top-0.5" aria-hidden />
              )}
              <Icon className={cn('w-3 h-3 shrink-0', textAccent)} />
              <span
                className={cn(
                  'max-w-[120px] truncate font-medium text-foreground',
                  chip.state === 'running' && 'title-shimmer',
                )}
              >
                {label}
              </span>
              {chip.state === 'paused' && <span className="text-accent-warning">{t('loopExplorer.paused')}</span>}
              {chip.state === 'ok' && <Check className="w-3 h-3 text-accent-success shrink-0" />}
              {chip.state === 'failed' && <X className="w-3 h-3 text-destructive shrink-0" />}
              {chip.decision === 'continue' && (
                <RotateCw className="w-3 h-3 text-accent-highlight shrink-0" />
              )}
              {chip.decision === 'stop' && (
                <ArrowRight className="w-3 h-3 text-accent-success shrink-0" />
              )}
            </button>
          </Fragment>
        )
      })}

      {iteration && (
        <span
          data-testid="loop-iteration-chip"
          className="ml-auto flex items-center gap-1.5 shrink-0 rounded-full border border-accent-highlight/40 bg-accent-highlight/10 px-2.5 py-1 text-caption font-medium text-accent-highlight tabular-nums"
        >
          <Repeat className="w-3 h-3" />
          {iteration.limit != null
            ? t('loopExplorer.iteration', { current: iteration.current, limit: iteration.limit })
            : t('loopExplorer.iterationBadge', { count: iteration.current })}
        </span>
      )}
    </div>
  )
}

export const LoopOverviewStrip = memo(LoopOverviewStripInner)
