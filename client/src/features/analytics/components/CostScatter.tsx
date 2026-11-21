import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ZAxis, Symbols } from 'recharts'
import type { SpendingResponse, ScatterPoint, SpendCategory } from '../types/spending'
import { SPEND_CATEGORIES, categoryForSurface } from '../types/spending'
import { useCategoryColors } from '../lib/category-colors'
import { formatUsd } from '../lib/format'
import { Skeleton } from '../../../components/ui/skeleton'

interface Props {
  data: SpendingResponse | null
  loading: boolean
  onSelectPoint: (p: ScatterPoint) => void
}

interface ChartPoint {
  id: string
  x: number
  y: number
  surface: string
  ticketId: number | null
  startedAt: string
  raw: ScatterPoint
}

type PointShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'star'

// One axis, category: colour from the chart palette and a shape per category
// so the plot never relies on colour alone.
const SHAPE: Record<SpendCategory, PointShape> = {
  implementation: 'circle',
  missions: 'diamond',
  specs: 'square',
  code: 'triangle',
  support: 'star',
}

function LegendGlyph({ category, color }: { category: SpendCategory; color: string }) {
  return (
    <svg className="w-2 h-2 shrink-0 overflow-visible" viewBox="0 0 8 8" aria-hidden>
      <Symbols type={SHAPE[category]} cx={4} cy={4} size={40} sizeType="area" fill={color} />
    </svg>
  )
}


export function CostScatter({ data, loading, onSelectPoint }: Props) {
  const { t } = useTranslation('analytics')
  const colors = useCategoryColors()
  if (loading && !data) {
    return <Skeleton className="h-[260px]" />
  }
  if (!data) return null

  const datasets = SPEND_CATEGORIES.map((category) => ({
    category,
    points: data.scatter
      .filter((p) => categoryForSurface(p.surface) === category)
      .map<ChartPoint>((p) => ({
        id: p.id,
        x: p.numTurns ?? Math.round((p.durationMs ?? 0) / 1000),
        y: p.costUsd,
        surface: p.surface,
        ticketId: p.ticketId,
        startedAt: p.startedAt,
        raw: p,
      })),
  }))
  const isEmpty = data.scatter.length === 0
  const unpricedRuns = data.summary.unpricedRuns ?? 0
  const costUnavailable = isEmpty && unpricedRuns > 0
  const costPartiallyUnavailable = !isEmpty && unpricedRuns > 0
  // The server caps the scatter at the 500 most-recent priced rows. When it
  // reports a truncation it UNION-s in the single costliest row so the
  // budget-blowing outlier is never invisible, but earlier mid-cost points are
  // still dropped — surface a notice so the user knows the plot is incomplete.
  const truncated = data.scatterTruncated === true
  const scatterTotal = data.scatterTotal ?? data.scatter.length

  return (
    <div className="rounded-xl border border-border/50 bg-card/40 p-4">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-title">{t('scatter.title')}</h2>
        <div className="flex flex-wrap items-center gap-2 text-caption">
          {datasets.filter((d) => d.points.length > 0).map((d) => (
            <span key={d.category} className="inline-flex items-center gap-1">
              <LegendGlyph category={d.category} color={colors[d.category]} />
              <span className="text-muted-foreground">{t(`categories.${d.category}.label`)}</span>
            </span>
          ))}
        </div>
      </div>
      {truncated && !isEmpty && (
        <div
          data-testid="scatter-truncation-notice"
          className="mb-2 text-caption text-accent-warning"
        >
          {t('scatter.truncated', { shown: data.scatter.length, total: scatterTotal })}
        </div>
      )}
      {costPartiallyUnavailable && (
        <div
          data-testid="scatter-cost-partial-notice"
          className="mb-2 text-caption text-muted-foreground"
        >
          {t('scatter.costPartiallyUnavailable', { count: unpricedRuns })}
        </div>
      )}
      {costUnavailable ? (
        <div
          data-testid="scatter-cost-unavailable"
          className="h-40 flex items-center justify-center text-xs text-muted-foreground"
        >
          {t('scatter.costUnavailable')}
        </div>
      ) : isEmpty ? (
        <div className="h-40 flex items-center justify-center text-xs text-muted-foreground">
          {t('scatter.empty')}
        </div>
      ) : (
        <div className="h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 10, right: 10, left: -8, bottom: 5 }}>
              <CartesianGrid strokeDasharray="2 4" stroke="currentColor" className="text-border/30" />
              <XAxis
                type="number" dataKey="x" name="turns"
                tick={{ fontSize: 12 }} stroke="currentColor" className="text-muted-foreground"
                label={{ value: t('scatter.turnsLabel'), position: 'insideBottomRight', offset: -2, fontSize: 12, fill: 'currentColor' }}
              />
              <YAxis
                type="number" dataKey="y" name="cost"
                tick={{ fontSize: 12 }} stroke="currentColor" className="text-muted-foreground"
                tickFormatter={(v: number) => formatUsd(v)}
              />
              <ZAxis range={[40, 80]} />
              <Tooltip
                cursor={{ strokeDasharray: '3 3' }}
                contentStyle={{ backgroundColor: 'var(--color-popover)', border: '1px solid var(--color-border)', color: 'var(--color-popover-foreground)', fontSize: 12, borderRadius: 6 }}
                formatter={(value: unknown, name: unknown) => {
                  const n = String(name)
                  if (n === 'cost' && typeof value === 'number') return [formatUsd(value), t('scatter.costLabel')]
                  return [String(value), n === 'turns' ? t('scatter.turnsLabel') : n]
                }}
              />
              {datasets.map((d) => (
                <Scatter
                  key={d.category}
                  data={d.points}
                  fill={colors[d.category]}
                  shape={SHAPE[d.category]}
                  onClick={(point) => {
                    const cp = point as unknown as ChartPoint
                    if (cp?.raw) onSelectPoint(cp.raw)
                  }}
                />
              ))}
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
