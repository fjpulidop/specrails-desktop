import { useTranslation } from 'react-i18next'
import { format, parseISO } from 'date-fns'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts'
import type { SpendCategory, SpendingResponse } from '../types/spending'
import { SPEND_CATEGORIES } from '../types/spending'
import { useCategoryColors } from '../lib/category-colors'
import { formatUsd } from '../lib/format'
import { getDateFnsLocale } from '../../../lib/i18n'
import { Skeleton } from '../../../components/ui/skeleton'
import { ChartTooltip } from './ChartTooltip'
import { InfoHint } from './InfoHint'

interface Props {
  data: SpendingResponse | null
  loading: boolean
}

type Day = SpendingResponse['dailyTimeline'][number]

/** A day's cost per category: the server's split, else folded from the legacy per-surface fields. */
export function dayByCategory(d: Day): Record<SpendCategory, number> {
  if (d.byCategory) return d.byCategory
  const implementation = d.jobsCostUsd + (d.loopCostUsd ?? 0)
  const missions = d.missionCostUsd ?? 0
  const specs = d.quickCostUsd + d.exploreCostUsd + d.aiEditCostUsd + (d.smashCostUsd ?? 0)
  const code = d.fileSummaryCostUsd ?? 0
  // Surfaces without a legacy field (setup, failure analysis, side chats…) are support.
  const support = Math.max(0, (d.totalCostUsd ?? 0) - implementation - missions - specs - code)
  return { implementation, missions, specs, code, support }
}

export function SpendingTimeline({ data, loading }: Props) {
  const { t } = useTranslation('analytics')
  const colors = useCategoryColors()
  if (loading && !data) {
    return <Skeleton className="h-[220px]" />
  }
  if (!data) return null

  // The server already re-buckets dailyTimeline by the viewer's LOCAL calendar
  // day (it receives tzOffsetMinutes and applies it in the day-bucket SQL), so
  // each d.date is already a local YYYY-MM-DD string. The ONLY correct client
  // step is to label it in the viewer's language ("24 Oct") — parseISO reads a date-only
  // string as LOCAL midnight, so no offset is applied twice and the label never shifts a day.
  const split = data.dailyTimeline.map((d) => ({ d, byCategory: dayByCategory(d) }))
  // One axis: category. Only categories with spend in the window get a series
  // (and so a legend entry).
  const series = SPEND_CATEGORIES.filter((category) => split.some(({ byCategory }) => byCategory[category] > 0))
  const label = (category: SpendCategory) => t(`categories.${category}.label`)
  const chartData = split.map(({ d, byCategory }) => ({
    date: format(parseISO(d.date), 'd MMM', { locale: getDateFnsLocale() }),
    ...Object.fromEntries(series.map((category) => [label(category), byCategory[category]])),
  }))

  const isEmpty = series.length === 0
  const unpricedCount = data.dailyTimeline.reduce(
    (sum, d) => sum + (d.unpricedCount ?? 0),
    0,
  )
  const costUnavailable = isEmpty && unpricedCount > 0
  const costPartiallyUnavailable = !isEmpty && unpricedCount > 0

  return (
    <div className="rounded-card border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 mb-2">
        <h2 className="text-title">{t('timeline.title')}</h2>
        {costPartiallyUnavailable && (
          <InfoHint tone="caution" testId="timeline-cost-partial">{t('timeline.costPartiallyUnavailable', { count: unpricedCount })}</InfoHint>
        )}
      </div>
      {costUnavailable ? (
        <div
          data-testid="timeline-cost-unavailable"
          className="h-40 flex items-center justify-center gap-1.5 text-label text-muted-foreground"
        >
          {t('hero.costUnavailable')}
          <InfoHint>{t('timeline.costUnavailable')}</InfoHint>
        </div>
      ) : isEmpty ? (
        <div className="h-40 flex items-center justify-center text-label text-muted-foreground">
          {t('timeline.empty')}
        </div>
      ) : (
        <div className="h-[220px]" data-testid="timeline-chart" data-series={series.join(',')}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barCategoryGap="28%" margin={{ top: 10, right: 10, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} stroke="currentColor" className="text-muted-foreground num" />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} stroke="currentColor" className="text-muted-foreground num" tickFormatter={(v: number) => formatUsd(v)} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-accent)', fillOpacity: 0.25 }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              {series.map((category, index) => (
                <Bar
                  key={category}
                  dataKey={label(category)}
                  stackId="a"
                  fill={colors[category]}
                  radius={index === series.length - 1 ? [3, 3, 0, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
