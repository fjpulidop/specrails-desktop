import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, ArrowDownRight } from 'lucide-react'
import type { SpendingResponse, Surface } from '../../types/spending'
import { SURFACE_LABEL, SURFACE_ACCENT } from '../../types/spending'

interface Props {
  data: SpendingResponse | null
  loading: boolean
}

function fmtUsd(v: number): string {
  if (v >= 100) return `$${v.toFixed(0)}`
  if (v >= 10) return `$${v.toFixed(1)}`
  return `$${v.toFixed(2)}`
}

function fmtUsdLarge(v: number): string {
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}k`
  if (v >= 100) return `$${v.toFixed(2)}`
  return `$${v.toFixed(2)}`
}

function fmtTokens(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`
  return `${v}`
}

const SURFACES: Surface[] = ['job', 'explore-spec', 'quick-spec', 'ai-edit', 'smash', 'file-summary', 'loop']

export function SpendingHero({ data, loading }: Props) {
  const { t } = useTranslation('analytics')
  const [displayedTotal, setDisplayedTotal] = useState(0)
  const lastValueRef = useRef(0)

  useEffect(() => {
    if (!data) return
    const target = data.summary.totalCostUsd
    // Count up only on first non-zero arrival, not on filter changes.
    if (lastValueRef.current === 0 && target > 0) {
      const start = performance.now()
      const duration = 600
      const from = 0
      const animate = (now: number) => {
        const t = Math.min(1, (now - start) / duration)
        const eased = 1 - Math.pow(1 - t, 3)
        setDisplayedTotal(from + (target - from) * eased)
        if (t < 1) requestAnimationFrame(animate)
      }
      requestAnimationFrame(animate)
    } else {
      setDisplayedTotal(target)
    }
    lastValueRef.current = target
  }, [data])

  if (loading && !data) {
    return <div className="h-44 rounded-xl border border-border/40 bg-card/40 animate-pulse" />
  }
  if (!data) return null

  const total = data.summary.totalCostUsd
  const totalRuns = data.summary.totalRuns
  const totalTokens = data.summary.totalTokens ?? 0
  const totalEstimated = data.summary.totalEstimatedCostUsd ?? 0
  const delta = data.summary.deltaPct
  const trackingStartedAt = data.trackingStartedAt
  // Hero footnote: surface when any row in the window came from the local
  // pricing-table fallback (currently codex; future providers without a
  // native cost field will trigger this too).
  const hasEstimatedCost = totalEstimated > 0
  const segments = SURFACES.map((s) => {
    const row = data.bySurface.find((b) => b.surface === s)
    return { surface: s, costUsd: row?.costUsd ?? 0, count: row?.count ?? 0 }
  })

  return (
    <div className="rounded-xl border border-border/50 bg-gradient-to-br from-card/80 to-card/40 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-1">
            {t('hero.spending')}
          </div>
          <div className="flex items-baseline gap-3">
            <div className="text-5xl font-semibold tabular-nums tracking-tight">
              {fmtUsdLarge(displayedTotal)}
            </div>
            {delta !== null && (
              <span className={`inline-flex items-center gap-0.5 text-xs font-medium ${
                delta >= 0 ? 'text-accent-warning' : 'text-accent-success'
              }`}>
                {delta >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {t('hero.vsPrev', { pct: Math.abs(delta).toFixed(0) })}
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground mt-1 tabular-nums flex items-center gap-2">
            <span>{t('hero.invocations', { count: totalRuns })}</span>
            {totalTokens > 0 && (
              <span
                className="text-muted-foreground/80"
                title={t('hero.tokensTooltip')}
              >
                {t('hero.tokens', { tokens: fmtTokens(totalTokens) })}
              </span>
            )}
            {hasEstimatedCost && (
              <span
                className="text-[10px] text-muted-foreground/70 italic"
                title={t('hero.includesEstimatedTooltip', { amount: fmtUsd(totalEstimated) })}
              >
                {t('hero.includesEstimated', { amount: fmtUsd(totalEstimated) })}
              </span>
            )}
          </div>
        </div>
        {totalRuns === 0 && trackingStartedAt && (
          <div className="text-xs text-muted-foreground">
            {t('hero.trackingStarted', { date: trackingStartedAt.slice(0, 10) })}
          </div>
        )}
      </div>

      {totalRuns === 0 ? (
        <div className="rounded-lg border border-dashed border-border/40 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            {t('hero.emptyState')}
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            {trackingStartedAt
              ? t('hero.trackingStarted', { date: trackingStartedAt.slice(0, 10) })
              : t('hero.trackingStartedFallback')}
          </p>
        </div>
      ) : (
        <>
          <div className="h-3 w-full rounded-full overflow-hidden bg-background-deep flex">
            {segments.map((seg) => {
              const pct = total > 0 ? (seg.costUsd / total) * 100 : 0
              if (pct === 0) return null
              return (
                <div
                  key={seg.surface}
                  className={`h-full ${SURFACE_ACCENT[seg.surface].dot}`}
                  style={{ width: `${pct}%` }}
                  title={t('hero.segmentTitle', { label: SURFACE_LABEL[seg.surface], value: fmtUsd(seg.costUsd) })}
                />
              )
            })}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs">
            {segments.filter((s) => s.costUsd > 0).map((seg) => (
              <span key={seg.surface} className="inline-flex items-center gap-1.5 tabular-nums">
                <span className={`w-2 h-2 rounded-full ${SURFACE_ACCENT[seg.surface].dot}`} />
                <span className="text-muted-foreground">{SURFACE_LABEL[seg.surface]}</span>
                <span className="text-foreground font-medium">{fmtUsd(seg.costUsd)}</span>
                <span className="text-muted-foreground/60">·</span>
                <span className="text-muted-foreground/80">{seg.count}</span>
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
