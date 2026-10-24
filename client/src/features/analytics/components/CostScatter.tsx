import { useTranslation } from 'react-i18next'
import { ResponsiveContainer, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ZAxis, Symbols } from 'recharts'
import type { SpendingResponse, ScatterPoint, Surface } from '../types/spending'
import { SURFACE_LABEL } from '../types/spending'
import { formatUsd } from '../lib/format'

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

// Per-surface point/legend colour. Mirrors SURFACE_ACCENT's token mapping but
// as inline CSS-var strings (recharts `fill` / inline `background` can't consume
// Tailwind class names). Keyed on the full Surface union so file-summary + loop
// points are never silently dropped from the plot or the legend.
const COLOR: Record<Surface, string> = {
  job: 'var(--color-accent-info)',
  'quick-spec': 'var(--color-accent-secondary)',
  'explore-spec': 'var(--color-accent-highlight)',
  'ai-edit': 'var(--color-accent-success)',
  smash: 'var(--color-accent-warning)',
  'file-summary': 'var(--color-accent-flow)',
  loop: 'var(--color-accent-primary)',
  'chat-sidebar': 'var(--color-accent-info)',
  'spec-launcher': 'var(--color-accent-secondary)',
  proposal: 'var(--color-accent-highlight)',
  'agent-studio': 'var(--color-accent-success)',
  setup: 'var(--color-accent-primary)',
  flow: 'var(--color-accent-flow)',
  triage: 'var(--color-accent-warning)',
}

type PointShape = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'star' | 'wye'

// Shape per surface so the plot never relies on colour alone: surfaces that
// share a colour always differ in shape.
const SHAPE: Record<Surface, PointShape> = {
  job: 'circle',
  'quick-spec': 'square',
  'explore-spec': 'triangle',
  'ai-edit': 'diamond',
  smash: 'cross',
  'file-summary': 'star',
  loop: 'wye',
  'chat-sidebar': 'square',
  'spec-launcher': 'triangle',
  proposal: 'diamond',
  'agent-studio': 'cross',
  setup: 'star',
  flow: 'circle',
  triage: 'wye',
}

function LegendGlyph({ surface }: { surface: Surface }) {
  return (
    <svg className="w-2 h-2 shrink-0 overflow-visible" viewBox="0 0 8 8" aria-hidden>
      <Symbols type={SHAPE[surface] ?? 'circle'} cx={4} cy={4} size={40} sizeType="area" fill={COLOR[surface] ?? 'var(--color-muted-foreground)'} />
    </svg>
  )
}

// All surfaces, drawn in a stable order. Derived from SURFACE_LABEL keys so a
// newly added surface can never drift out of the scatter again.
const SURFACES = Object.keys(SURFACE_LABEL) as Surface[]

export function CostScatter({ data, loading, onSelectPoint }: Props) {
  const { t } = useTranslation('analytics')
  if (loading && !data) {
    return <div className="h-[260px] rounded-xl border border-border/40 bg-card/40 motion-safe:animate-pulse" />
  }
  if (!data) return null

  const surfaces = SURFACES
  const datasets = surfaces.map((s) => ({
    surface: s,
    points: data.scatter
      .filter((p) => p.surface === s)
      .map<ChartPoint>((p) => ({
        id: p.id,
        x: p.numTurns ?? Math.round((p.durationMs ?? 0) / 1000),
        y: p.costUsd,
        surface: s,
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
        <h2 className="text-xs font-medium text-muted-foreground">{t('scatter.title')}</h2>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {datasets.filter((d) => d.points.length > 0).map((d) => (
            <span key={d.surface} className="inline-flex items-center gap-1">
              <LegendGlyph surface={d.surface} />
              <span className="text-muted-foreground">{SURFACE_LABEL[d.surface]}</span>
            </span>
          ))}
        </div>
      </div>
      {truncated && !isEmpty && (
        <div
          data-testid="scatter-truncation-notice"
          className="mb-2 text-[11px] text-accent-warning"
        >
          {t('scatter.truncated', { shown: data.scatter.length, total: scatterTotal })}
        </div>
      )}
      {costPartiallyUnavailable && (
        <div
          data-testid="scatter-cost-partial-notice"
          className="mb-2 text-[11px] text-muted-foreground/80 italic"
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
                  key={d.surface}
                  data={d.points}
                  fill={COLOR[d.surface]}
                  shape={SHAPE[d.surface] ?? 'circle'}
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
