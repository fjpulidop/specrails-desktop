import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { getApiBase } from '../lib/api'
import { useDesktop, projectProviders } from '../hooks/useDesktop'
import { providerLabel } from '../lib/provider-capabilities'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import type {
  Period, Surface, SpendingFilters, SpendingResponse, InvocationsResponse,
} from '../types/spending'
import { ExportDropdown } from '../components/ExportDropdown'
import { SpendingHero } from '../components/analytics/SpendingHero'
import { ProviderBreakdownCard } from '../components/analytics/ProviderBreakdownCard'
import { SpendingTimeline } from '../components/analytics/SpendingTimeline'
import { QuickVsExploreCard } from '../components/analytics/QuickVsExploreCard'
import { ModelBreakdown } from '../components/analytics/ModelBreakdown'
import { CostScatter } from '../components/analytics/CostScatter'
import { TopTicketsCrossSurface } from '../components/analytics/TopTicketsCrossSurface'
import { InvocationsTable } from '../components/analytics/InvocationsTable'

const PERIODS: { value: Period; labelKey: string }[] = [
  { value: '7d', labelKey: 'periods.d7' },
  { value: '30d', labelKey: 'periods.d30' },
  { value: '90d', labelKey: 'periods.d90' },
  { value: 'all', labelKey: 'periods.all' },
]

const SURFACE_CHIPS: { value: Surface | 'all'; labelKey: string }[] = [
  { value: 'all', labelKey: 'page.all' },
  { value: 'job', labelKey: 'surfaces.job' },
  { value: 'explore-spec', labelKey: 'surfaces.exploreSpec' },
  { value: 'quick-spec', labelKey: 'surfaces.quickSpec' },
  { value: 'ai-edit', labelKey: 'surfaces.aiEdit' },
  { value: 'smash', labelKey: 'surfaces.smash' },
  { value: 'file-summary', labelKey: 'surfaces.fileSummary' },
  { value: 'loop', labelKey: 'surfaces.loop' },
]

function buildQuery(filters: SpendingFilters): string {
  const params = new URLSearchParams()
  if (filters.period) params.set('period', filters.period)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.surface && filters.surface.length > 0) params.set('surface', filters.surface.join(','))
  if (filters.provider && filters.provider.length > 0) params.set('provider', filters.provider.join(','))
  if (filters.model && filters.model.length > 0) params.set('model', filters.model.join(','))
  if (filters.status) params.set('status', filters.status)
  if (typeof filters.minCostUsd === 'number') params.set('minCostUsd', String(filters.minCostUsd))
  if (typeof filters.ticketId === 'number') params.set('ticketId', String(filters.ticketId))
  return params.toString()
}

export default function AnalyticsPage() {
  const { t } = useTranslation('analytics')
  const { activeProjectId, projects } = useDesktop()
  const [searchParams, setSearchParams] = useSearchParams()

  const activeProject = projects.find((p) => p.id === activeProjectId)
  const installedProviders = activeProject ? projectProviders(activeProject) : ['claude']
  const multiProvider = installedProviders.length > 1

  const initialPeriod = (searchParams.get('period') as Period | null) ?? '30d'
  const initialSurface = (searchParams.get('surface') ?? '').split(',').filter(Boolean) as Surface[]
  const initialProvider = (searchParams.get('provider') ?? '').split(',').filter(Boolean)
  const initialTicketId = searchParams.get('ticketId')

  const [filters, setFilters] = useState<SpendingFilters>({
    period: initialPeriod,
    surface: initialSurface.length > 0 ? initialSurface : undefined,
    provider: initialProvider.length > 0 ? initialProvider : undefined,
    ticketId: initialTicketId ? Number(initialTicketId) : undefined,
  })
  const [data, setData] = useState<SpendingResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Secondary filters scoped to the table only.
  const [tableFilters, setTableFilters] = useState<{
    model?: string
    status?: 'success' | 'failed' | 'aborted'
    minCostUsd?: number
  }>({})
  const [invocations, setInvocations] = useState<InvocationsResponse | null>(null)

  const cacheRef = useRef<Map<string, SpendingResponse>>(new Map())
  const refetchSeqRef = useRef(0)

  // Persist filter state to URL
  useEffect(() => {
    const next = new URLSearchParams()
    next.set('period', filters.period)
    if (filters.surface && filters.surface.length > 0) next.set('surface', filters.surface.join(','))
    if (filters.provider && filters.provider.length > 0) next.set('provider', filters.provider.join(','))
    if (filters.ticketId) next.set('ticketId', String(filters.ticketId))
    setSearchParams(next, { replace: true })
  }, [filters.period, filters.surface, filters.provider, filters.ticketId, setSearchParams])

  const fetchSpending = useCallback(async () => {
    if (!activeProjectId) return
    const seq = ++refetchSeqRef.current
    setError(null)
    const cacheKey = `${activeProjectId}:${buildQuery(filters)}`
    const cached = cacheRef.current.get(cacheKey)
    if (cached) {
      setData(cached)
      setLoading(false)
    } else {
      setLoading(true)
    }
    try {
      const res = await fetch(`${getApiBase()}/spending?${buildQuery(filters)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (seq !== refetchSeqRef.current) return
      const fresh = (await res.json()) as SpendingResponse
      cacheRef.current.set(cacheKey, fresh)
      setData(fresh)
      setLoading(false)
    } catch (err) {
      if (seq !== refetchSeqRef.current) return
      setError((err as Error).message)
      setLoading(false)
    }
  }, [activeProjectId, filters])

  const fetchInvocations = useCallback(async () => {
    if (!activeProjectId) return
    const merged: SpendingFilters = { ...filters }
    if (tableFilters.model) merged.model = [tableFilters.model]
    if (tableFilters.status) merged.status = tableFilters.status
    if (typeof tableFilters.minCostUsd === 'number') merged.minCostUsd = tableFilters.minCostUsd
    try {
      const res = await fetch(`${getApiBase()}/invocations?${buildQuery(merged)}&limit=100`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setInvocations((await res.json()) as InvocationsResponse)
    } catch {
      setInvocations(null)
    }
  }, [activeProjectId, filters, tableFilters])

  useEffect(() => { fetchSpending() }, [fetchSpending])
  useEffect(() => { fetchInvocations() }, [fetchInvocations])

  // WS invalidation: debounced 500ms refetch
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ws = useSharedWebSocket()
  useEffect(() => {
    const handlerId = 'analytics-spending'
    ws.registerHandler(handlerId, (raw: unknown) => {
      const m = raw as { type?: string; projectId?: string }
      if (m.type !== 'spending.invalidated') return
      if (m.projectId !== activeProjectId) return
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => {
        cacheRef.current.clear()
        fetchSpending()
        fetchInvocations()
      }, 500)
    })
    return () => { ws.unregisterHandler(handlerId) }
  }, [ws, activeProjectId, fetchSpending, fetchInvocations])

  function toggleSurface(s: Surface | 'all') {
    if (s === 'all') {
      setFilters((f) => ({ ...f, surface: undefined }))
      return
    }
    setFilters((f) => {
      const curr = f.surface ?? []
      const next = curr.includes(s) ? curr.filter((x) => x !== s) : [...curr, s]
      return { ...f, surface: next.length > 0 ? next : undefined }
    })
  }

  function toggleProvider(p: string | 'all') {
    if (p === 'all') {
      setFilters((f) => ({ ...f, provider: undefined }))
      return
    }
    setFilters((f) => {
      const curr = f.provider ?? []
      const next = curr.includes(p) ? curr.filter((x) => x !== p) : [...curr, p]
      return { ...f, provider: next.length > 0 ? next : undefined }
    })
  }

  const surfaceFilter = filters.surface
  const isAll = !surfaceFilter || surfaceFilter.length === 0
  const providerFilter = filters.provider
  const isAllProviders = !providerFilter || providerFilter.length === 0

  const exportParams = useMemo(() => {
    const p: Record<string, string> = { period: filters.period }
    if (filters.surface && filters.surface.length > 0) p.surface = filters.surface.join(',')
    if (filters.provider && filters.provider.length > 0) p.provider = filters.provider.join(',')
    if (filters.ticketId) p.ticketId = String(filters.ticketId)
    return p
  }, [filters])

  const isEmpty = data ? data.summary.totalRuns === 0 : false

  return (
    <div className="flex flex-col gap-6 p-4 pb-12">
      {/* Sticky filter header */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-3 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border/40">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-semibold tracking-tight">{t('page.title')}</h1>
            {filters.ticketId && (
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, ticketId: undefined }))}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium bg-accent-highlight/15 text-accent-highlight ring-1 ring-accent-highlight/30 hover:bg-accent-highlight/25"
              >
                {t('page.ticketChip', { id: filters.ticketId })}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 rounded-md border border-border/60 bg-card/40 p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setFilters((f) => ({ ...f, period: p.value }))}
                  className={`px-2.5 h-6 rounded text-[11px] font-medium transition-colors ${
                    filters.period === p.value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >{t(p.labelKey)}</button>
              ))}
            </div>
            <ExportDropdown
              baseUrl={`${getApiBase()}/analytics/export`}
              params={exportParams}
              disabled={isEmpty}
            />
            <button
              type="button"
              onClick={() => { cacheRef.current.clear(); fetchSpending(); fetchInvocations() }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-md border border-border/60 bg-card/50 text-muted-foreground hover:text-foreground hover:bg-accent/60"
              title={t('common:actions.refresh')}
            ><RefreshCw className="w-3 h-3" /></button>
          </div>
        </div>
        {/* Surface chips */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {SURFACE_CHIPS.map((c) => {
            const active = c.value === 'all' ? isAll : (surfaceFilter?.includes(c.value as Surface) ?? false)
            return (
              <button
                key={c.value}
                type="button"
                onClick={() => toggleSurface(c.value)}
                className={`h-7 px-3 rounded-full text-[11px] font-medium transition-all ${
                  active
                    ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/20'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
                }`}
              >{t(c.labelKey)}</button>
            )
          })}
        </div>
        {/* Provider chips — only when the project has more than one engine */}
        {multiProvider && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="analytics-provider-chips">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">{t('page.engine')}</span>
            <button
              type="button"
              onClick={() => toggleProvider('all')}
              className={`h-7 px-3 rounded-full text-[11px] font-medium transition-all ${
                isAllProviders
                  ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/20'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
              }`}
            >{t('page.all')}</button>
            {installedProviders.map((p) => {
              const active = providerFilter?.includes(p) ?? false
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => toggleProvider(p)}
                  className={`h-7 px-3 rounded-full text-[11px] font-medium transition-all ${
                    active
                      ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/20'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
                  }`}
                >{providerLabel(p)}</button>
              )
            })}
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-accent-warning/30 bg-accent-warning/10 p-4 flex items-center justify-between">
          <p className="text-sm text-accent-warning">{t('page.failedToLoad', { error })}</p>
          <button
            onClick={() => fetchSpending()}
            className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs text-accent-warning border border-accent-warning/30 hover:bg-accent-warning/10"
          ><RefreshCw className="w-3 h-3" />{t('common:actions.retry')}</button>
        </div>
      )}

      {/* Block 1: Hero */}
      <SpendingHero data={data} loading={loading} />

      {/* Block 1b: Provider breakdown (renders only on multi-provider projects) */}
      <ProviderBreakdownCard data={data} loading={loading} />

      {/* Block 2: Timeline */}
      <SpendingTimeline data={data} loading={loading} />

      {/* Blocks 3 + 4 side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <QuickVsExploreCard data={data} loading={loading} />
        <ModelBreakdown
          data={data}
          loading={loading}
          onSelectModel={(m) => setFilters((f) => ({ ...f, model: [m] }))}
          activeModel={filters.model?.[0]}
        />
      </div>

      {/* Block 5: Scatter */}
      <CostScatter
        data={data}
        loading={loading}
        onSelectPoint={(point) => {
          setTableFilters((tf) => ({ ...tf }))
          setFilters((f) => ({ ...f, ticketId: point.ticketId ?? undefined }))
        }}
      />

      {/* Block 6: Top tickets */}
      <TopTicketsCrossSurface
        data={data}
        loading={loading}
        onSelectTicket={(id) => setFilters((f) => ({ ...f, ticketId: id ?? undefined }))}
      />

      {/* Block 7: Raw table */}
      <InvocationsTable
        rows={invocations?.rows ?? []}
        loading={loading && !invocations}
        truncated={invocations?.truncated ?? false}
        totalAvailable={invocations?.totalAvailable ?? 0}
        tableFilters={tableFilters}
        onTableFiltersChange={setTableFilters}
      />
    </div>
  )
}
