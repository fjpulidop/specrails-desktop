import { useTranslation } from 'react-i18next'
import { format, parseISO } from 'date-fns'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts'
import type { SpendingResponse } from '../types/spending'
import { formatUsd } from '../lib/format'
import { getDateFnsLocale } from '../../../lib/i18n'
import { Skeleton } from '../../../components/ui/skeleton'
import { useActiveTheme } from '../../settings/context/ThemeContext'
import { ChartTooltip } from './ChartTooltip'

interface Props {
  data: SpendingResponse | null
  loading: boolean
}

export function SpendingTimeline({ data, loading }: Props) {
  const { t } = useTranslation('analytics')
  const theme = useActiveTheme()
  if (loading && !data) {
    return <Skeleton className="h-[220px]" />
  }
  if (!data) return null

  // Series colours come from the theme's chart palette (not the semantic
  // warning/success tokens, which carry state meaning); two extra hues from
  // the terminal palette cover the 7 named series.
  const palette = [...theme.chart, theme.xterm.brightBlue, theme.xterm.brightMagenta]

  // Series labels double as recharts dataKeys and tooltip display names.
  const labels = {
    jobs: t('surfaces.job'),
    explore: t('surfaces.exploreSpec'),
    quick: t('surfaces.quickSpec'),
    refine: t('surfaces.aiEdit'),
    fileSummaries: t('surfaces.fileSummary'),
    smash: t('surfaces.smash'),
    loop: t('surfaces.loop'),
    others: t('models.others'),
  }

  // The server already re-buckets dailyTimeline by the viewer's LOCAL calendar
  // day (it receives tzOffsetMinutes and applies it in the day-bucket SQL), so
  // each d.date is already a local YYYY-MM-DD string. The ONLY correct client
  // step is to label it in the viewer's language ("24 Oct") — parseISO reads a date-only
  // string as LOCAL midnight, so no offset is applied twice and the label never shifts a day.
  const sumOfSeven = (d: (typeof data.dailyTimeline)[number]) =>
    d.jobsCostUsd +
    d.exploreCostUsd +
    d.quickCostUsd +
    d.aiEditCostUsd +
    (d.fileSummaryCostUsd ?? 0) +
    (d.smashCostUsd ?? 0) +
    (d.loopCostUsd ?? 0)
  // Surfaces without their own series (chat, setup, flow, triage…) land in
  // "Others" so each day's stack reconciles with its total.
  const othersFor = (d: (typeof data.dailyTimeline)[number]) =>
    Math.max(0, (d.totalCostUsd ?? 0) - sumOfSeven(d))
  const chartData = data.dailyTimeline.map((d) => ({
    date: format(parseISO(d.date), 'd MMM', { locale: getDateFnsLocale() }),
    [labels.jobs]: d.jobsCostUsd,
    [labels.explore]: d.exploreCostUsd,
    [labels.quick]: d.quickCostUsd,
    [labels.refine]: d.aiEditCostUsd,
    [labels.fileSummaries]: d.fileSummaryCostUsd ?? 0,
    [labels.smash]: d.smashCostUsd ?? 0,
    [labels.loop]: d.loopCostUsd ?? 0,
    [labels.others]: othersFor(d),
  }))

  const isEmpty = data.dailyTimeline.every((d) => sumOfSeven(d) + othersFor(d) === 0)
  const unpricedCount = data.dailyTimeline.reduce(
    (sum, d) => sum + (d.unpricedCount ?? 0),
    0,
  )
  const costUnavailable = isEmpty && unpricedCount > 0
  const costPartiallyUnavailable = !isEmpty && unpricedCount > 0

  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-strong">{t('timeline.title')}</h2>
        <span className="text-caption text-muted-foreground">
          {costPartiallyUnavailable
            ? t('timeline.costPartiallyUnavailable', { count: unpricedCount })
            : t('timeline.subtitle')}
        </span>
      </div>
      {costUnavailable ? (
        <div
          data-testid="timeline-cost-unavailable"
          className="h-40 flex items-center justify-center text-xs text-muted-foreground"
        >
          {t('timeline.costUnavailable')}
        </div>
      ) : isEmpty ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">
          {t('timeline.empty')}
        </div>
      ) : (
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} barCategoryGap="28%" margin={{ top: 10, right: 10, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" className="text-border/30" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} tickLine={false} stroke="currentColor" className="text-muted-foreground num" />
              <YAxis tick={{ fontSize: 11 }} tickLine={false} axisLine={false} stroke="currentColor" className="text-muted-foreground num" tickFormatter={(v: number) => formatUsd(v)} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--color-accent)', fillOpacity: 0.25 }} />
              <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey={labels.jobs} stackId="a" fill={palette[0]} />
              <Bar dataKey={labels.explore} stackId="a" fill={palette[1]} />
              <Bar dataKey={labels.quick} stackId="a" fill={palette[2]} />
              <Bar dataKey={labels.refine} stackId="a" fill={palette[3]} />
              <Bar dataKey={labels.fileSummaries} stackId="a" fill={palette[4]} />
              <Bar dataKey={labels.smash} stackId="a" fill={palette[5]} />
              <Bar dataKey={labels.loop} stackId="a" fill={palette[6]} />
              <Bar dataKey={labels.others} stackId="a" fill="var(--color-muted-foreground)" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
