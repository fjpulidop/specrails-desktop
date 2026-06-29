import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts'
import type { SpendingResponse } from '../../types/spending'

interface Props {
  data: SpendingResponse | null
  loading: boolean
}

export function SpendingTimeline({ data, loading }: Props) {
  const { t } = useTranslation('analytics')
  if (loading && !data) {
    return <div className="h-[220px] rounded-xl border border-border/40 bg-card/40 animate-pulse" />
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
  }

  // The server already re-buckets dailyTimeline by the viewer's LOCAL calendar
  // day (it receives tzOffsetMinutes and applies it in the day-bucket SQL), so
  // each d.date is already a local YYYY-MM-DD string. The ONLY correct client
  // step is to drop the year for the MM-DD axis label — re-parsing it as UTC and
  // reformatting locally would double-apply the offset and shift the label a day.
  const chartData = data.dailyTimeline.map((d) => ({
    date: d.date.slice(5),
    [labels.jobs]: d.jobsCostUsd,
    [labels.explore]: d.exploreCostUsd,
    [labels.quick]: d.quickCostUsd,
    [labels.refine]: d.aiEditCostUsd,
    [labels.fileSummaries]: d.fileSummaryCostUsd ?? 0,
    [labels.smash]: d.smashCostUsd ?? 0,
    [labels.loop]: d.loopCostUsd ?? 0,
  }))

  const isEmpty = data.dailyTimeline.every(
    (d) =>
      d.jobsCostUsd +
        d.exploreCostUsd +
        d.quickCostUsd +
        d.aiEditCostUsd +
        (d.fileSummaryCostUsd ?? 0) +
        (d.smashCostUsd ?? 0) +
        (d.loopCostUsd ?? 0) ===
      0
  )

  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('timeline.title')}</h2>
        <span className="text-[10px] text-muted-foreground/70">{t('timeline.subtitle')}</span>
      </div>
      {isEmpty ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted-foreground/70">
          {t('timeline.empty')}
        </div>
      ) : (
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 10, right: 10, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" className="text-border/30" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="currentColor" className="text-muted-foreground" />
              <YAxis tick={{ fontSize: 10 }} stroke="currentColor" className="text-muted-foreground" tickFormatter={(v) => `$${v}`} />
              <Tooltip
                contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', fontSize: 11, borderRadius: 6 }}
                formatter={(value: unknown, name: unknown) => [`$${typeof value === 'number' ? value.toFixed(2) : '—'}`, String(name)]}
              />
              <Bar dataKey={labels.jobs} stackId="a" fill="var(--accent-info, #5fa8d3)" />
              <Bar dataKey={labels.explore} stackId="a" fill="var(--accent-highlight, #c084fc)" />
              <Bar dataKey={labels.quick} stackId="a" fill="var(--accent-secondary, #f7768e)" />
              <Bar dataKey={labels.refine} stackId="a" fill="var(--accent-success, #50fa7b)" />
              <Bar dataKey={labels.fileSummaries} stackId="a" fill="var(--accent-warning, #f1fa8c)" />
              <Bar dataKey={labels.smash} stackId="a" fill="var(--accent-highlight, #c084fc)" />
              <Bar dataKey={labels.loop} stackId="a" fill="var(--accent-primary, #7aa2f7)" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
