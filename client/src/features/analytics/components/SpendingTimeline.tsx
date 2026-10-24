import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts'
import type { SpendingResponse } from '../types/spending'
import { formatUsd } from '../lib/format'

interface Props {
  data: SpendingResponse | null
  loading: boolean
}

export function SpendingTimeline({ data, loading }: Props) {
  const { t } = useTranslation('analytics')
  if (loading && !data) {
    return <div className="h-[220px] rounded-xl border border-border/40 bg-card/40 motion-safe:animate-pulse" />
  }
  if (!data) return null

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
  // step is to drop the year for the MM-DD axis label — re-parsing it as UTC and
  // reformatting locally would double-apply the offset and shift the label a day.
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
    date: d.date.slice(5),
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
        <h2 className="text-xs font-medium text-muted-foreground">{t('timeline.title')}</h2>
        <span className="text-[11px] text-muted-foreground">
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
            <BarChart data={chartData} margin={{ top: 10, right: 10, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" className="text-border/30" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="currentColor" className="text-muted-foreground" />
              <YAxis tick={{ fontSize: 10 }} stroke="currentColor" className="text-muted-foreground" tickFormatter={(v: number) => formatUsd(v)} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--color-popover)', border: '1px solid var(--color-border)', color: 'var(--color-popover-foreground)', fontSize: 11, borderRadius: 6 }}
                formatter={(value: unknown, name: unknown) => [typeof value === 'number' ? formatUsd(value) : '—', String(name)]}
              />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey={labels.jobs} stackId="a" fill="var(--color-accent-info)" />
              <Bar dataKey={labels.explore} stackId="a" fill="var(--color-accent-highlight)" />
              <Bar dataKey={labels.quick} stackId="a" fill="var(--color-accent-secondary)" />
              <Bar dataKey={labels.refine} stackId="a" fill="var(--color-accent-success)" />
              <Bar dataKey={labels.fileSummaries} stackId="a" fill="var(--color-accent-flow)" />
              <Bar dataKey={labels.smash} stackId="a" fill="var(--color-accent-warning)" />
              <Bar dataKey={labels.loop} stackId="a" fill="var(--color-accent-primary)" />
              <Bar dataKey={labels.others} stackId="a" fill="var(--color-muted-foreground)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
