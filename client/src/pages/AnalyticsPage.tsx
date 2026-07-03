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
  // Provider-aligned model filter (BUG-ANALYTICS-30): emit `modelProvider` only
  // when it is index-aligned with `model` (same length), so the server can scope
  // the predicate to (provider, model) pairs and never merge a cross-provider id.
  if (
    filters.modelKeys &&
    filters.modelKeys.length > 0 &&
    filters.model &&
    filters.modelKeys.length === filters.model.length
  ) {
    params.set('modelProvider', filters.modelKeys.map((k) => k.provider).join(','))
  }
  if (filters.status) params.set('status', filters.status)
  if (typeof filters.minCostUsd === 'number') params.set('minCostUsd', String(filters.minCostUsd))
  if (typeof filters.ticketId === 'number') params.set('ticketId', String(filters.ticketId))
  if (typeof filters.tzOffsetMinutes === 'number') params.set('tzOffsetMinutes', String(filters.tzOffsetMinutes))
  if (filters.sortBy) params.set('sortBy', filters.sortBy)
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
  const initialModel = (searchParams.get('model') ?? '').split(',').filter(Boolean)
  const initialModelProvider = (searchParams.get('modelProvider') ?? '').split(',').filter(Boolean)
  // Reconstruct provider-aligned model keys only when the two CSVs line up.
  const initialModelKeys =
    initialModel.length > 0 && initialModel.length === initialModelProvider.length
      ? initialModel.map((m, i) => ({ provider: initialModelProvider[i], model: m }))
      : undefined

  // Local timezone offset so dailyTimeline buckets line up with the user's "today"
  // (positive = east of UTC). Computed once; getTimezoneOffset returns the inverse sign.
  const tzOffsetMinutes = useMemo(() => -new Date().getTimezoneOffset(), [])

  const [filters, setFilters] = useState<SpendingFilters>({
    period: initialPeriod,
    surface: initialSurface.length > 0 ? initialSurface : undefined,
    provider: initialProvider.length > 0 ? initialProvider : undefined,
    ticketId: initialTicketId ? Number(initialTicketId) : undefined,
    model: initialModel.length > 0 ? initialModel : undefined,
    modelKeys: initialModelKeys,
    tzOffsetMinutes,
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
  // BUG-ANALYTICS-35: raw-table ordering — 'recency' (default) or 'cost'.
  const [tableSort, setTableSort] = useState<'recency' | 'cost'>('recency')

  const cacheRef = useRef<Map<string, SpendingResponse>>(new Map())
  const refetchSeqRef = useRef(0)

  // Persist filter state to URL
  useEffect(() => {
    const next = new URLSearchParams()
    next.set('period', filters.period)
    if (filters.surface && filters.surface.length > 0) next.set('surface', filters.surface.join(','))
    if (filters.provider && filters.provider.length > 0) next.set('provider', filters.provider.join(','))
    if (filters.ticketId) next.set('ticketId', String(filters.ticketId))
    if (filters.model && filters.model.length > 0) {
      next.set('model', filters.model.join(','))
      if (filters.modelKeys && filters.modelKeys.length === filters.model.length) {
        next.set('modelProvider', filters.modelKeys.map((k) => k.provider).join(','))
      }
    }
    setSearchParams(next, { replace: true })
  }, [filters.period, filters.surface, filters.provider, filters.ticketId, filters.model, filters.modelKeys, setSearchParams])

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

  const invocationsSeqRef = useRef(0)
  const fetchInvocations = useCallback(async () => {
    if (!activeProjectId) return
    // BUG-ANALYTICS-20: seq guard so a late-landing stale-filter refetch (e.g. a
    // WS-debounced fetch firing the OLD closure after a filter/project change)
    // can never clobber the freshest response.
    const seq = ++invocationsSeqRef.current
    const merged: SpendingFilters = { ...filters }
    if (tableFilters.model) {
      // The table's own model dropdown overrides the header model filter; drop the
      // provider-aligned keys so buildQuery doesn't emit a mismatched modelProvider.
      merged.model = [tableFilters.model]
      merged.modelKeys = undefined
    }
    if (tableFilters.status) merged.status = tableFilters.status
    if (typeof tableFilters.minCostUsd === 'number') merged.minCostUsd = tableFilters.minCostUsd
    // BUG-ANALYTICS-35: let the user surface the costliest rows on page 1 instead
    // of the recency-only default, so a high-cost codex/gemini outlier isn't hidden.
    merged.sortBy = tableSort
    try {
      const res = await fetch(`${getApiBase()}/invocations?${buildQuery(merged)}&limit=100`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const fresh = (await res.json()) as InvocationsResponse
      if (seq !== invocationsSeqRef.current) return
      setInvocations(fresh)
    } catch {
      if (seq !== invocationsSeqRef.current) return
      setInvocations(null)
    }
  }, [activeProjectId, filters, tableFilters, tableSort])

  // BUG-ANALYTICS-23: on project switch, drop the previous project's aggregates so
  // the skeleton (gated on `loading && !data`) shows instead of leaking the prior
  // project's numbers until the new fetch resolves. A cached hit re-populates
  // `data` synchronously inside the very next `fetchSpending`, so revisiting a
  // project still avoids a flash. Filter changes are untouched (stale-while-revalidate).
  const prevProjectRef = useRef(activeProjectId)
  useEffect(() => {
    if (prevProjectRef.current !== activeProjectId) {
      prevProjectRef.current = activeProjectId
      setData(null)
      setInvocations(null)
      setLoading(true)
    }
  }, [activeProjectId])

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
    return () => {
      ws.unregisterHandler(handlerId)
      // BUG-ANALYTICS-20: cancel any pending debounced refetch so a timer armed
      // under the OLD filters/project can't fire after this effect is torn down.
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
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

  // BUG-ANALYTICS-22 + BUG-ANALYTICS-30: model click toggles the filter and is
  // provider-aligned. We look up every (provider, model) pair the clicked id maps
  // to in byModel so a cross-provider id collision scopes to exactly those pairs
  // (modelKeys index-aligned with model) rather than blending both providers.
  const selectModel = useCallback((m: string, provider?: string) => {
    setFilters((f) => {
      // Toggle off on re-click of the SAME selection. When a provider is given
      // (real ModelBreakdown click), require the current single key's provider
      // to match too, so two providers sharing a model id don't toggle each
      // other. When provider is absent (legacy/test), fall back to model-id.
      const toggleOff =
        f.model?.length === 1 && f.model[0] === m &&
        (provider === undefined || (f.modelKeys?.length === 1 && f.modelKeys[0].provider === provider))
      if (toggleOff) {
        return { ...f, model: undefined, modelKeys: undefined }
      }
      // Scope to the clicked (provider, model) pair so a cross-provider id
      // collision doesn't re-blend both providers (BUG-ANALYTICS-30).
      const keys = (data?.byModel ?? [])
        .filter((e) => e.model === m && (provider === undefined || e.provider === provider))
        .map((e) => ({ provider: e.provider, model: e.model }))
      const models = keys.length > 0 ? keys.map((k) => k.model) : [m]
      return {
        ...f,
        model: models,
        modelKeys: keys.length > 0 ? keys : undefined,
      }
    })
  }, [data])

  function clearModel() {
    setFilters((f) => ({ ...f, model: undefined, modelKeys: undefined }))
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
            {filters.model && filters.model.length > 0 && (
              <button
                type="button"
                data-testid="analytics-model-chip"
                onClick={clearModel}
                title={t('page.clearModelFilter')}
                className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] font-medium bg-accent-highlight/15 text-accent-highlight ring-1 ring-accent-highlight/30 hover:bg-accent-highlight/25"
              >
                {t('page.modelChip', { model: filters.model[0] })}
                <span aria-hidden className="opacity-70">×</span>
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
      <SpendingHero data={data} loading={loading} period={filters.period} />

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
          onSelectModel={selectModel}
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
      <div className="flex flex-col gap-2">
        {/* BUG-ANALYTICS-35: cost/recency ordering toggle for the raw table so the
            costliest rows can be surfaced on page 1, not just the most recent. */}
        <div className="flex items-center justify-end gap-1.5" data-testid="analytics-table-sort">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1">{t('table.sortLabel')}</span>
          {(['recency', 'cost'] as const).map((s) => (
            <button
              key={s}
              type="button"
              data-testid={`analytics-table-sort-${s}`}
              aria-pressed={tableSort === s}
              onClick={() => setTableSort(s)}
              className={`h-6 px-2.5 rounded-full text-[11px] font-medium transition-all ${
                tableSort === s
                  ? 'bg-foreground/10 text-foreground ring-1 ring-foreground/20'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/40'
              }`}
            >{s === 'recency' ? t('table.sortRecency') : t('table.sortCost')}</button>
          ))}
        </div>
        <InvocationsTable
          rows={invocations?.rows ?? []}
          loading={loading && !invocations}
          // BUG-ANALYTICS-19: the table caps at 100 rows; surface the "N of M"
          // footnote whenever more rows exist than are shown, since the server's
          // `truncated` flag only fires on the export `cap` path (always false here).
          truncated={
            (invocations?.truncated ?? false) ||
            (invocations?.totalAvailable ?? 0) > (invocations?.rows.length ?? 0)
          }
          totalAvailable={invocations?.totalAvailable ?? 0}
          tableFilters={tableFilters}
          onTableFiltersChange={setTableFilters}
        />
      </div>
    </div>
  )
}
