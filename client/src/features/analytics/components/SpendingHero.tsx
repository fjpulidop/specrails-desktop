import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowUpRight, ArrowDownRight } from 'lucide-react'
import type { SpendingResponse, Period } from '../types/spending'
import { formatUsd as fmtUsd } from '../lib/format'
import { formatTokens as fmtTokens } from '../../../lib/format-tokens'
import { isPlanBilledSpend, useBilling } from '../lib/use-billing'
import { categorySpend, useCategoryColors } from '../lib/category-colors'
import { CostValue } from './CostValue'
import { InfoHint } from './InfoHint'
import { Skeleton } from '../../../components/ui/skeleton'

interface Props {
  data: SpendingResponse | null
  loading: boolean
  /** Active window (period) so the headline states the range it covers
   *  explicitly — a 30-day figure must never read as an all-time total. */
  period?: Period
}

function StatCell({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col" data-testid={testId}>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="num text-title text-foreground">{children}</dd>
    </div>
  )
}

/**
 * "How much": the window's total, three stat cells (invocations, tokens,
 * billed vs estimated) and one bar split by spend category. Coverage caveats
 * live in a single hint instead of prose.
 */
export function SpendingHero({ data, loading, period }: Props) {
  const { t } = useTranslation('analytics')
  const billing = useBilling()
  const colors = useCategoryColors()
  if (loading && !data) {
    return <Skeleton className="h-44" />
  }
  if (!data) return null

  const total = data.summary.totalCostUsd
  const totalRuns = data.summary.totalRuns
  const totalTokens = data.summary.totalTokens
  const totalEstimated = data.summary.totalEstimatedCostUsd ?? 0
  const hasCostCoverage =
    typeof data.summary.pricedRuns === 'number'
    || typeof data.summary.unpricedRuns === 'number'
  const unpricedRuns = data.summary.unpricedRuns ?? 0
  const pricedRuns = data.summary.pricedRuns
    ?? (hasCostCoverage ? Math.max(0, totalRuns - unpricedRuns) : totalRuns)
  const costUnavailable =
    hasCostCoverage && totalRuns > 0 && pricedRuns === 0 && unpricedRuns > 0
  const costPartiallyUnavailable = pricedRuns > 0 && unpricedRuns > 0
  const hasUsageCoverage =
    typeof data.summary.usageReportedRuns === 'number'
    || typeof data.summary.usageUnavailableRuns === 'number'
  const usageUnavailableRuns = data.summary.usageUnavailableRuns ?? 0
  const usageReportedRuns = data.summary.usageReportedRuns
    ?? (hasUsageCoverage ? Math.max(0, totalRuns - usageUnavailableRuns) : totalRuns)
  const usageUnavailable =
    hasUsageCoverage && totalRuns > 0 && usageReportedRuns === 0 && usageUnavailableRuns > 0
  const usagePartiallyUnavailable = usageReportedRuns > 0 && usageUnavailableRuns > 0
  // A cost delta is only meaningful when both periods are fully priced.
  const delta = unpricedRuns > 0 ? null : data.summary.deltaPct
  const trackingStartedAt = data.trackingStartedAt
  const hasEstimatedCost = totalEstimated > 0
  const categories = categorySpend(data).filter((c) => c.costUsd > 0)
  // Human window label so the headline can never be read as an all-time total.
  const windowLabel = period ? t(`windowLabels.${period}`) : null
  // Every provider in the window is plan-billed: the dollar figure is an API-equivalent estimate,
  // never money that was charged, and says so right under the number.
  const planBilled = billing.ready && billing.snapshot != null && total > 0 && !costUnavailable && isPlanBilledSpend(data.byProvider, billing)
  const billed = Math.max(0, total - totalEstimated)

  // One hint carries every coverage caveat.
  const coverage = [
    costUnavailable ? t('hero.costUnavailableTooltip') : null,
    costPartiallyUnavailable ? t('hero.withoutCost', { count: unpricedRuns, total: totalRuns }) : null,
    usagePartiallyUnavailable ? t('hero.withoutUsage', { count: usageUnavailableRuns, total: totalRuns }) : null,
    usageUnavailable ? t('hero.usageUnavailableTooltip') : null,
  ].filter((line): line is string => !!line)

  return (
    <section aria-labelledby="spending-hero-title" className="rounded-card border border-border bg-card p-5">
      <h2 id="spending-hero-title" className="text-title text-foreground mb-1">
        {t('hero.spending')}
        {windowLabel && <span data-testid="hero-window-label" className="font-normal text-muted-foreground"> · {windowLabel}</span>}
      </h2>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div>
          <div className="flex items-baseline gap-3">
            <div
              className="text-display-xl num text-foreground"
              data-testid={costUnavailable ? 'hero-cost-unavailable' : 'hero-total'}
              title={costUnavailable ? t('hero.costUnavailableTooltip') : undefined}
            >
              <CostValue usd={total} estimated={hasEstimatedCost} unavailable={costUnavailable} />
            </div>
            {delta !== null && (
              <span className={`inline-flex items-center gap-0.5 text-label ${
                delta >= 0 ? 'text-accent-warning' : 'text-accent-success'
              }`}>
                {delta >= 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {t('hero.vsPrev', { pct: Math.abs(delta).toFixed(0) })}
              </span>
            )}
          </div>
          {planBilled && (
            <p className="text-caption text-muted-foreground" data-testid="hero-api-equivalent">{t('hero.apiEquivalent')}</p>
          )}
        </div>
        {totalRuns > 0 && (
          <div className="flex items-start gap-2">
            <dl className="flex flex-wrap gap-x-6 gap-y-2" data-testid="hero-stats">
              <StatCell label={t('hero.statInvocations')} testId="hero-stat-invocations">{totalRuns.toLocaleString()}</StatCell>
              <StatCell label={t('hero.statTokens')} testId="hero-stat-tokens">
                {usageUnavailable || totalTokens == null
                  ? <span data-testid="hero-usage-unavailable" className="text-muted-foreground">—</span>
                  : `${usagePartiallyUnavailable ? '≥' : ''}${fmtTokens(totalTokens)}`}
              </StatCell>
              <StatCell label={t(planBilled ? 'hero.statEstimated' : 'hero.statBilledEstimated')} testId="hero-stat-billed">
                {costUnavailable
                  ? <span className="text-muted-foreground">—</span>
                  : planBilled
                    ? `~${fmtUsd(total)}`
                    : hasEstimatedCost
                      ? <>{fmtUsd(billed)}<span className="text-muted-foreground"> · ~{fmtUsd(totalEstimated)}</span></>
                      : fmtUsd(billed)}
              </StatCell>
            </dl>
            {coverage.length > 0 && (
              <InfoHint testId="hero-cost-coverage" tone="caution" className="mt-0.5">
                {coverage.join(' ')}
              </InfoHint>
            )}
          </div>
        )}
      </div>

      {totalRuns === 0 ? (
        <div className="mt-4 rounded-card border border-dashed border-border p-6 text-center">
          <p className="text-body text-muted-foreground">{t('hero.emptyState')}</p>
          <p className="text-caption text-muted-foreground mt-1">
            {trackingStartedAt
              ? t('hero.trackingStarted', { date: trackingStartedAt.slice(0, 10) })
              : t('hero.trackingStartedFallback')}
          </p>
        </div>
      ) : costUnavailable || total <= 0 ? null : (
        <>
          <div className="mt-4 flex h-3 w-full overflow-hidden rounded-pill bg-background-deep" data-testid="hero-category-bar">
            {categories.map((c) => (
              <div
                key={c.category}
                data-category={c.category}
                className="h-full"
                style={{ width: `${(c.costUsd / total) * 100}%`, background: colors[c.category] }}
                title={t('hero.segmentTitle', { label: t(`categories.${c.category}.label`), value: fmtUsd(c.costUsd) })}
              />
            ))}
          </div>
          <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-label" data-testid="hero-category-legend">
            {categories.map((c) => {
              const share = (c.costUsd / total) * 100
              return (
                <li key={c.category} className="inline-flex items-center gap-1.5 num">
                  <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: colors[c.category] }} />
                  <span className="text-muted-foreground">{t(`categories.${c.category}.label`)}</span>
                  <span className="font-medium text-foreground">{fmtUsd(c.costUsd)}</span>
                  <span className="text-muted-foreground">{share < 1 ? '<1' : share.toFixed(0)}%</span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
