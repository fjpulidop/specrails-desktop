import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, TrendingUp } from 'lucide-react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, BarChart, Bar } from 'recharts'
import { format } from 'date-fns'
import { getDateFnsLocale } from '../lib/i18n'
import type { DesktopAnalyticsResponse, AnalyticsPeriod } from '../types'
import { PeriodSelector } from '../components/analytics/PeriodSelector'
import { useActiveTheme } from '../context/ThemeContext'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'

// Server now splits authoritative (claude, provider-billed) vs estimated
// (codex/gemini rate-card) cost. These fields are populated by
// getDesktopAnalytics (server/desktop-analytics.ts); they are absent on legacy
// claude-only rollups, so they are modelled as optional and default to 0.
type EstimatedKpi = DesktopAnalyticsResponse['kpi'] & {
  estimatedCostUsd?: number
  estimatedCostToday?: number
  includesEstimated?: boolean
}
type EstimatedProjectStats = DesktopAnalyticsResponse['projectBreakdown'][number] & {
  estimatedCostUsd?: number
}
type EstimatedTimelinePoint = DesktopAnalyticsResponse['costTimeline'][number] & {
  estimatedCostUsd?: number
}

// ─── KPI Cards ────────────────────────────────────────────────────────────────

function DesktopKpiCards({ kpi, windowLabel }: { kpi: EstimatedKpi; windowLabel: string }) {
  const { t } = useTranslation('analytics')
  const estimatedTotal = kpi.estimatedCostUsd ?? 0
  const estimatedToday = kpi.estimatedCostToday ?? 0
  const includesEstimated = kpi.includesEstimated ?? estimatedTotal > 0
  // BUG-ANALYTICS-24/28: the grand total + avg are server-corrected to exclude
  // failed/aborted cost; when any part is a codex/gemini rate-card estimate the
  // figure carries a '~' marker so it is never read as a billed fact.
  const totalIsEstimated = estimatedTotal > 0
  const todayIsEstimated = estimatedToday > 0
  const cards = [
    {
      key: 'totalCost',
      label: t('desktop.totalCost'),
      value: `${totalIsEstimated ? '~' : ''}$${kpi.totalCostUsd.toFixed(4)}`,
      sub: t('desktop.costToday', { value: `${todayIsEstimated ? '~' : ''}$${kpi.costToday.toFixed(4)}` }),
      estimated: totalIsEstimated,
      // The KPI is windowed (default 7d) but labelled "Total cost" — state the
      // window explicitly so it is never read as a grand all-time total (MED-10).
      window: windowLabel,
    },
    {
      key: 'totalJobs',
      label: t('desktop.totalJobs'),
      value: kpi.totalJobs.toLocaleString(),
      sub: t('desktop.jobsToday', { n: kpi.jobsToday }),
      estimated: false,
    },
    {
      key: 'successRate',
      label: t('desktop.successRate'),
      value: `${(kpi.successRate * 100).toFixed(1)}%`,
      sub: t('desktop.acrossAllProjects'),
      estimated: false,
    },
    {
      key: 'avgCostPerJob',
      label: t('desktop.avgCostPerJob'),
      value: kpi.totalJobs > 0 ? `${totalIsEstimated ? '~' : ''}$${(kpi.totalCostUsd / kpi.totalJobs).toFixed(5)}` : '—',
      sub: t('desktop.periodAverage'),
      estimated: totalIsEstimated && kpi.totalJobs > 0,
    },
  ]

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((card) => (
          <div
            key={card.key}
            className="rounded-lg border border-border/40 bg-card/50 p-4"
            data-estimated={card.estimated ? 'true' : undefined}
          >
            <div className="flex items-center justify-between gap-1 mb-1">
              <p className="text-xs text-muted-foreground">{card.label}</p>
              {'window' in card && card.window && (
                <span
                  data-testid="kpi-window-label"
                  className="text-[10px] text-muted-foreground/70 whitespace-nowrap"
                >
                  {card.window}
                </span>
              )}
            </div>
            <p className="text-xl font-semibold font-mono">{card.value}</p>
            <p className="text-xs text-muted-foreground mt-1">{card.sub}</p>
          </div>
        ))}
      </div>
      {includesEstimated && (
        <p
          data-testid="kpi-estimated-footnote"
          className="text-[10px] text-muted-foreground/70 italic"
          title={t('desktop.includesEstimatedTooltip', { amount: `$${estimatedTotal.toFixed(4)}` })}
        >
          {t('desktop.includesEstimated', { amount: `$${estimatedTotal.toFixed(4)}` })}
        </p>
      )}
    </div>
  )
}

// ─── Cost Timeline ────────────────────────────────────────────────────────────

function DesktopCostTimeline({ data }: { data: EstimatedTimelinePoint[] }) {
  const { t } = useTranslation('analytics')
  const theme = useActiveTheme()
  const hasData = data.length > 0 && data.some((d) => d.costUsd > 0)
  const tickStep = Math.max(1, Math.floor(data.length / 7))
  const ticks = data.filter((_, i) => i % tickStep === 0).map((d) => d.date)
  // BUG-ANALYTICS-26: index estimated portion by date so the tooltip can flag
  // days whose cost partly comes from codex/gemini rate-card estimates.
  const estimatedByDate = new Map(data.map((d) => [d.date, d.estimatedCostUsd ?? 0]))
  const anyEstimated = data.some((d) => (d.estimatedCostUsd ?? 0) > 0)

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium">{t('desktop.costOverTime')}</h3>
        {anyEstimated && (
          <span
            data-testid="timeline-estimated-note"
            className="text-[10px] text-muted-foreground/70 italic"
            title={t('desktop.timelineEstimatedTooltip')}
          >
            {t('desktop.includesEstimatedShort')}
          </span>
        )}
      </div>
      {!hasData ? (
        <div className="h-[200px] flex items-center justify-center text-xs text-muted-foreground">
          {t('desktop.noCostData')}
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="date"
              ticks={ticks}
              tickFormatter={(d: string) => { try { return format(new Date(d), 'MMM d', { locale: getDateFnsLocale() }) } catch { return d } }}
              tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tickFormatter={(v: number) => `$${v.toFixed(2)}`}
              tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
              axisLine={false}
              tickLine={false}
              width={55}
            />
            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null
                const dayEstimated = (estimatedByDate.get(label as string) ?? 0) > 0
                return (
                  <div className="bg-popover border border-border/30 rounded-lg p-2 text-xs shadow-lg">
                    <p className="text-muted-foreground mb-1">{label}</p>
                    <p className="font-medium">{dayEstimated ? '~' : ''}${(payload[0].value as number).toFixed(4)}</p>
                  </div>
                )
              }}
            />
            <Line
              type="monotone"
              dataKey="costUsd"
              stroke={theme.chart[0]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 3, fill: theme.chart[0] }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ─── Project Breakdown Table ──────────────────────────────────────────────────

function ProjectBreakdown({ projects }: { projects: EstimatedProjectStats[] }) {
  const { t } = useTranslation('analytics')
  const theme = useActiveTheme()
  if (projects.length === 0) {
    return (
      <div className="rounded-lg border border-border/40 bg-card/50 p-4">
        <h3 className="text-sm font-medium mb-3">{t('desktop.projectComparison')}</h3>
        <p className="text-xs text-muted-foreground">{t('desktop.noProjects')}</p>
      </div>
    )
  }

  const maxCost = Math.max(...projects.map((p) => p.totalCostUsd), 0.0001)

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-4">{t('desktop.projectComparison')}</h3>
      <div className="space-y-3">
        {projects.map((p, idx) => {
          const estimated = p.estimatedCostUsd ?? 0
          const isEstimated = estimated > 0
          return (
          <div key={p.projectId} className="space-y-1" data-estimated={isEstimated ? 'true' : undefined}>
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium truncate max-w-[160px] flex items-center gap-1" title={p.projectName}>
                {p.projectName}
                {isEstimated && (
                  <span
                    data-testid="project-estimated-badge"
                    className="text-[9px] uppercase tracking-wide text-muted-foreground/70 not-italic border border-border/40 rounded px-1"
                    title={t('desktop.projectEstimatedTooltip', { amount: `$${estimated.toFixed(4)}` })}
                  >
                    {t('desktop.estimatedBadge')}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-4 text-muted-foreground">
                <span>{t('desktop.jobsCount', { count: p.totalJobs })}</span>
                <span>{t('desktop.successPct', { pct: (p.successRate * 100).toFixed(0) })}</span>
                <span className="font-mono text-foreground">{isEstimated ? '~' : ''}${p.totalCostUsd.toFixed(4)}</span>
              </div>
            </div>
            <div className="h-1.5 rounded-full bg-border/30 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${(p.totalCostUsd / maxCost) * 100}%`,
                  backgroundColor: theme.chart[idx % theme.chart.length],
                }}
              />
            </div>
          </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Per-Project Bar Chart ────────────────────────────────────────────────────

function ProjectCostBar({ projects }: { projects: EstimatedProjectStats[] }) {
  const { t } = useTranslation('analytics')
  const theme = useActiveTheme()
  if (projects.length === 0) return null
  const data = projects.map((p) => ({ name: p.projectName.slice(0, 12), costUsd: p.totalCostUsd }))

  return (
    <div className="rounded-lg border border-border/40 bg-card/50 p-4">
      <h3 className="text-sm font-medium mb-3">{t('desktop.costByProject')}</h3>
      <ResponsiveContainer width="100%" height={180}>
        <BarChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
          <XAxis
            dataKey="name"
            tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tickFormatter={(v: number) => `$${v.toFixed(2)}`}
            tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            axisLine={false}
            tickLine={false}
            width={55}
          />
          <Tooltip
            content={({ active, payload, label }) =>
              active && payload?.length ? (
                <div className="bg-popover border border-border/30 rounded-lg p-2 text-xs shadow-lg">
                  <p className="text-muted-foreground mb-1">{label}</p>
                  <p className="font-medium">${(payload[0].value as number).toFixed(4)}</p>
                </div>
              ) : null
            }
          />
          <Bar dataKey="costUsd" fill={theme.chart[1]} radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function DesktopAnalyticsPage() {
  const { t } = useTranslation('analytics')
  const [period, setPeriod] = useState<AnalyticsPeriod>('7d')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<DesktopAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Refresh KPIs when jobs complete via WebSocket
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const handleWsMessage = useCallback((raw: unknown) => {
    const msg = raw as { type?: string }
    // Cross-project page: refetch on any spend-affecting broadcast regardless of
    // projectId (MED-11). 'spending.invalidated' fires from every
    // recordInvocation site; 'rail.job_completed' is the rail job-completion
    // broadcast the server actually emits (the previous 'log'/'job_done' gate
    // matched a message the server never sends, so totals went stale).
    if (msg.type === 'spending.invalidated' || msg.type === 'rail.job_completed') {
      void load(period, from, to)
    }
  }, [period, from, to]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    registerHandler('desktop-analytics', handleWsMessage)
    return () => unregisterHandler('desktop-analytics')
  }, [handleWsMessage, registerHandler, unregisterHandler])

  async function load(p: AnalyticsPeriod, f?: string, t?: string) {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ period: p })
      if (p === 'custom' && f && t) { params.set('from', f); params.set('to', t) }
      const res = await fetch(`/api/analytics?${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as DesktopAnalyticsResponse
      setData(json)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load(period, from, to)
  }, [period, from, to])

  function handlePeriodChange(p: AnalyticsPeriod, f?: string, t?: string) {
    setPeriod(p)
    if (f !== undefined) setFrom(f)
    if (t !== undefined) setTo(t)
  }

  return (
    <div className="flex flex-col h-full overflow-auto bg-background">
      <div className="p-4 space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-muted-foreground" />
            <h1 className="text-sm font-semibold">{t('desktop.title')}</h1>
            {data && (
              <span className="text-xs text-muted-foreground">{data.period.label}</span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <PeriodSelector
              period={period}
              from={from}
              to={to}
              onChange={handlePeriodChange}
            />
            <button
              onClick={() => load(period, from, to)}
              disabled={loading}
              className="flex items-center gap-1.5 h-7 px-2 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
              aria-label={t('desktop.refreshAria')}
            >
              <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-400/30 aurora-light:border-destructive/30 bg-red-400/10 aurora-light:bg-destructive/10 p-3 text-xs text-red-400 aurora-light:text-destructive">
            {t('desktop.failedToLoad', { error })}
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !data && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-20 rounded-lg border border-border/40 bg-card/50 animate-pulse" />
              ))}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-[220px] rounded-lg border border-border/40 bg-card/50 animate-pulse" />
              ))}
            </div>
          </div>
        )}

        {/* Content */}
        {data && (
          <div className="space-y-3">
            <DesktopKpiCards
              kpi={data.kpi}
              windowLabel={period === 'custom' ? data.period.label : t(`windowLabels.${period}`)}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <DesktopCostTimeline data={data.costTimeline} />
              <ProjectCostBar projects={data.projectBreakdown} />
            </div>

            <ProjectBreakdown projects={data.projectBreakdown} />
          </div>
        )}
      </div>
    </div>
  )
}
