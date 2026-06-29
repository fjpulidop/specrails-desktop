import { Trans, useTranslation } from 'react-i18next'
import type { SpendingResponse, ByModeEntry } from '../../types/spending'

interface Props {
  data: SpendingResponse | null
  loading: boolean
}

function fmtUsd(v: number | null): string {
  if (v == null) return '—'
  if (v < 0.005) return `$${v.toFixed(4)}`
  if (v < 1) return `$${v.toFixed(3)}`
  return `$${v.toFixed(2)}`
}

function fmtDur(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.floor((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(0.0001, ...values)
  return (
    <div className="flex items-end gap-[1px] h-5">
      {values.map((v, i) => (
        <div
          key={i}
          className="w-[3px] rounded-sm bg-foreground/40"
          style={{ height: `${Math.max(2, (v / max) * 20)}px` }}
        />
      ))}
    </div>
  )
}

function ModeColumn({ mode, label, accentClass }: { mode: ByModeEntry; label: string; accentClass: string }) {
  const { t } = useTranslation('analytics')
  const sparseExplore = mode.mode === 'explore' && mode.totalRuns < 5
  // codex/gemini per-spec cost is a pricing-table ESTIMATE — never present it as
  // an authoritative claude figure. Prefix a `~` when any of this mode's cost is
  // estimate-derived (mirrors the Hero footnote treatment).
  const isEstimated = (mode.estimatedCostUsd ?? 0) > 0
  return (
    <div className="flex-1 p-4 first:pr-2 last:pl-2">
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-1.5 h-1.5 rounded-full ${accentClass}`} />
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      </div>
      {sparseExplore ? (
        <div className="py-3">
          <p className="text-sm text-foreground">{t('quickVsExplore.sparseCta')}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {t('quickVsExplore.runsSoFar', { count: mode.totalRuns })}
          </p>
        </div>
      ) : (
        <>
          <div
            className="text-3xl font-semibold tabular-nums tracking-tight"
            data-estimated={isEstimated ? 'true' : undefined}
            title={isEstimated ? t('quickVsExplore.estimatedTooltip') : undefined}
          >
            {isEstimated && mode.avgCostPerSpec != null ? '~' : ''}
            {fmtUsd(mode.avgCostPerSpec)}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{t('quickVsExplore.perSpec')}</div>
          <div className="mt-3"><Sparkline values={mode.sparkline.length > 0 ? mode.sparkline : [0]} /></div>
          <div className="mt-3 space-y-0.5 text-xs tabular-nums text-muted-foreground">
            <div>
              <Trans
                ns="analytics"
                i18nKey="quickVsExplore.createdRuns"
                values={{ created: mode.ticketsCreated, runs: mode.totalRuns }}
                components={{ strong: <span className="text-foreground font-medium" /> }}
              />
            </div>
            <div>{t('quickVsExplore.avgDuration', { duration: fmtDur(mode.avgDurationMs) })}</div>
            <div className="truncate">{mode.dominantModel ?? '—'}</div>
          </div>
        </>
      )}
    </div>
  )
}

export function QuickVsExploreCard({ data, loading }: Props) {
  const { t } = useTranslation('analytics')
  if (loading && !data) {
    return <div className="h-[220px] rounded-xl border border-border/40 bg-card/40 animate-pulse" />
  }
  if (!data) return null

  const quick = data.byMode.find((m) => m.mode === 'quick')
  const explore = data.byMode.find((m) => m.mode === 'explore')
  if (!quick || !explore) return null

  const ratio = quick.avgCostPerSpec && explore.avgCostPerSpec && quick.avgCostPerSpec > 0
    ? explore.avgCostPerSpec / quick.avgCostPerSpec
    : null
  const showRatio = ratio !== null && quick.totalRuns >= 1 && explore.totalRuns >= 5

  // Any displayed per-spec figure (or the ratio derived from them) is partly a
  // codex/gemini pricing-table estimate → footnote it, matching the Hero card.
  const hasEstimated = (quick.estimatedCostUsd ?? 0) > 0 || (explore.estimatedCostUsd ?? 0) > 0

  return (
    <div className="rounded-xl border border-border/50 bg-card/40">
      <div className="px-4 pt-3 pb-1">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('quickVsExplore.title')}</h2>
      </div>
      <div className="flex divide-x divide-border/40">
        <ModeColumn mode={quick} label={t('quickVsExplore.quick')} accentClass="bg-accent-secondary" />
        <ModeColumn mode={explore} label={t('quickVsExplore.explore')} accentClass="bg-accent-highlight" />
      </div>
      {showRatio && (
        <div className="px-4 pb-3 -mt-1">
          <div className="text-center text-[11px] text-muted-foreground tabular-nums">
            <span className="px-2">━━━━━━ {t('quickVsExplore.ratio', { ratio: ratio!.toFixed(1) })} ━━━━━━</span>
          </div>
        </div>
      )}
      {hasEstimated && (
        <div className="px-4 pb-3 -mt-1" data-testid="quick-vs-explore-estimated-footnote">
          <p className="text-[10px] text-muted-foreground">{t('quickVsExplore.estimatedFootnote')}</p>
        </div>
      )}
    </div>
  )
}
