import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ChevronRight, RefreshCw, X } from 'lucide-react'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../../components/ui/select'
import { getApiBase } from '../../../lib/api'
import { useDesktop, projectProviders } from '../../../hooks/useDesktop'
import { isLocalEngineId, providerLabel } from '../../providers/lib/provider-capabilities'
import { useAvailableProviders } from '../../providers/hooks/useAvailableProviders'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import type {
  Period, Surface, SpendCategory, SpendingFilters, SpendingResponse, InvocationsResponse,
} from '../types/spending'
import { SPEND_CATEGORIES, SURFACE_LABEL, isSpendCategory } from '../types/spending'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../../components/ui/tooltip'
import { ExportDropdown } from '../components/ExportDropdown'
import { InfoHint } from '../components/InfoHint'
import { SegmentedControl } from '../../../components/ui/segmented-control'
import { SpendingHero } from '../components/SpendingHero'
import { ProviderBreakdownCard } from '../components/ProviderBreakdownCard'
import { SpendingTimeline } from '../components/SpendingTimeline'
import { QuickVsExploreCard } from '../components/QuickVsExploreCard'
import { SpendBreakdownCard } from '../components/SpendBreakdownCard'
import { ModelBreakdown } from '../components/ModelBreakdown'
import { CostScatter } from '../components/CostScatter'
import { TopTicketsCrossSurface } from '../components/TopTicketsCrossSurface'
import { InvocationsTable } from '../components/InvocationsTable'
import { LegacyWorkflowUsage } from '../components/LegacyWorkflowUsage'
import { DecisionTimesCard } from '../components/DecisionTimesCard'
import { LoopEconomicsCard } from '../components/LoopEconomicsCard'
import { BudgetCard } from '../components/BudgetCard'
import { BUDGET_PANEL_PARAM } from '../../../lib/app-settings-events'

const PERIODS: { value: Period; labelKey: string }[] = [
  { value: '7d', labelKey: 'periods.d7' },
  { value: '30d', labelKey: 'periods.d30' },
  { value: '90d', labelKey: 'periods.d90' },
  { value: 'all', labelKey: 'periods.all' },
]

const CHIP_CLASS = 'h-7 px-2.5 rounded-full text-label transition-colors'
const CHIP_ACTIVE = 'bg-muted text-foreground ring-1 ring-border'
const CHIP_IDLE = 'text-muted-foreground hover:text-foreground hover:bg-muted'
/** An active filter: click clears it. */
const FILTER_CHIP = 'inline-flex items-center gap-1 h-6 px-2 rounded-full text-caption font-medium bg-muted text-foreground ring-1 ring-border hover:bg-accent'

/** Engines with activity in the period, excluding the internal agent runtime. */
export function activeEngines(byProvider: SpendingResponse['byProvider']): string[] {
  return byProvider.filter((entry) => entry.count > 0 && entry.provider !== 'agent-runtime').map((entry) => entry.provider)
}

function buildQuery(filters: SpendingFilters): string {
  const params = new URLSearchParams()
  if (filters.period) params.set('period', filters.period)
  if (filters.from) params.set('from', filters.from)
  if (filters.to) params.set('to', filters.to)
  if (filters.surface && filters.surface.length > 0) params.set('surface', filters.surface.join(','))
  if (filters.category && filters.category.length > 0) params.set('category', filters.category.join(','))
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

  const budgetAnchor = useRef<HTMLDivElement | null>(null)
  // Land on the Budget panel when asked to (the inbox's "Raise cap", the launch forecast). Captured once
  // from the URL: the filter-persisting effect below rewrites the query string, so the param cannot be
  // the source of truth. The scroll waits for the card itself (it renders a skeleton while loading).
  const [landOnBudget, setLandOnBudget] = useState(() => searchParams.get(BUDGET_PANEL_PARAM) === 'budget')
  const onBudgetReady = useCallback(() => {
    if (!landOnBudget) return
    budgetAnchor.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
    setLandOnBudget(false)
  }, [landOnBudget])
  // A repeated "Raise cap" while already on Analytics re-arms the landing.
  const wantsBudget = searchParams.get(BUDGET_PANEL_PARAM) === 'budget'
  useEffect(() => { if (wantsBudget) setLandOnBudget(true) }, [wantsBudget])

  const activeProject = projects.find((p) => p.id === activeProjectId)
  // Only the engines the project has configured, minus any the registry reports
  // unavailable (unknown while the catalog loads = kept). Spend by a provider
  // outside this list still counts in the totals; it just gets no chip.
  const { available: providerAvailability } = useAvailableProviders()

  const initialPeriod = (searchParams.get('period') as Period | null) ?? '30d'
  const initialSurface = (searchParams.get('surface') ?? '').split(',').filter(Boolean) as Surface[]
  const initialCategory = (searchParams.get('category') ?? '').split(',').filter(isSpendCategory)
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
    category: initialCategory.length > 0 ? initialCategory : undefined,
    provider: initialProvider.length > 0 ? initialProvider : undefined,
    ticketId: initialTicketId ? Number(initialTicketId) : undefined,
    model: initialModel.length > 0 ? initialModel : undefined,
    modelKeys: initialModelKeys,
    tzOffsetMinutes,
  })
  const [data, setData] = useState<SpendingResponse | null>(null)
  // The engines worth a chip: the project's configured ones plus any that ran in
  // the period (a rail can run on another engine), minus those the registry
  // reports unavailable. Installed-but-unused CLIs get no chip.
  const installedProviders = useMemo(() => {
    const configured = activeProject ? projectProviders(activeProject) : ['claude']
    const active = (data?.byProvider ?? []).filter((entry) => entry.count > 0).map((entry) => entry.provider)
    return [...new Set([...configured, ...active])]
      .filter((p) => providerAvailability[p] !== false && p !== 'agent-runtime')
  }, [activeProject, data?.byProvider, providerAvailability])
  // Engine filter: only the engines that did work in the period (count > 0),
  // never the internal runtime. Remembered from the last unfiltered response so
  // filtering to one engine never hides the control that undoes it.
  const [engineOptions, setEngineOptions] = useState<string[]>([])
  useEffect(() => { setEngineOptions([]) }, [activeProjectId])
  useEffect(() => {
    if (!data || (filters.provider && filters.provider.length > 0)) return
    setEngineOptions(activeEngines(data.byProvider))
  }, [data, filters.provider])
  const engines = useMemo(() => [...new Set([...engineOptions, ...(filters.provider ?? [])])], [engineOptions, filters.provider])
  const showEngines = engines.length >= 2
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
    if (filters.category && filters.category.length > 0) next.set('category', filters.category.join(','))
    if (filters.provider && filters.provider.length > 0) next.set('provider', filters.provider.join(','))
    if (filters.ticketId) next.set('ticketId', String(filters.ticketId))
    if (filters.model && filters.model.length > 0) {
      next.set('model', filters.model.join(','))
      if (filters.modelKeys && filters.modelKeys.length === filters.model.length) {
        next.set('modelProvider', filters.modelKeys.map((k) => k.provider).join(','))
      }
    }
    if (landOnBudget) next.set(BUDGET_PANEL_PARAM, 'budget')
    setSearchParams(next, { replace: true })
  }, [filters.period, filters.surface, filters.category, filters.provider, filters.ticketId, filters.model, filters.modelKeys, landOnBudget, setSearchParams])

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

  // Category chips ("why" filter). Multi-select; "All" clears.
  function toggleCategory(c: SpendCategory | 'all') {
    if (c === 'all') {
      setFilters((f) => ({ ...f, category: undefined }))
      return
    }
    setFilters((f) => {
      const curr = f.category ?? []
      const next = curr.includes(c) ? curr.filter((x) => x !== c) : [...curr, c]
      return { ...f, category: next.length > 0 ? next : undefined }
    })
  }

  // Surface-level filter, reached from the breakdown card (and `?surface=`).
  function toggleSurface(s: Surface) {
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
  const categoryFilter = filters.category
  const isAllCategories = !categoryFilter || categoryFilter.length === 0
  const providerFilter = filters.provider
  const isAllProviders = !providerFilter || providerFilter.length === 0

  const exportParams = useMemo(() => {
    const p: Record<string, string> = { period: filters.period }
    if (filters.surface && filters.surface.length > 0) p.surface = filters.surface.join(',')
    if (filters.category && filters.category.length > 0) p.category = filters.category.join(',')
    if (filters.provider && filters.provider.length > 0) p.provider = filters.provider.join(',')
    if (filters.ticketId) p.ticketId = String(filters.ticketId)
    return p
  }, [filters])

  const isEmpty = data ? data.summary.totalRuns === 0 : false

  return (
    <div className="flex flex-col gap-6 p-4 pb-12">
      {/* Sticky filter header: one row — title, active filters, category chips,
          engine, period, export, refresh. */}
      <div className="sticky top-0 z-10 -mx-4 px-4 py-3 bg-background border-b border-border" data-testid="analytics-header">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-headline text-foreground">{t('page.title')}</h1>
          <InfoHint testId="analytics-subtitle">{t('page.subtitle')}</InfoHint>
          {filters.ticketId && (
            <button
              type="button"
              onClick={() => setFilters((f) => ({ ...f, ticketId: undefined }))}
              className={FILTER_CHIP}
            >
              {t('page.ticketChipLabel', { id: filters.ticketId })}
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
          {filters.model && filters.model.length > 0 && (
            <button
              type="button"
              data-testid="analytics-model-chip"
              onClick={clearModel}
              title={t('page.clearModelFilter')}
              className={FILTER_CHIP}
            >
              {t('page.modelChip', { model: filters.model[0] })}
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
          {surfaceFilter && surfaceFilter.length > 0 && (
            <button
              type="button"
              data-testid="analytics-surface-chip"
              onClick={() => setFilters((f) => ({ ...f, surface: undefined }))}
              title={t('page.clearSurfaceFilter')}
              className={FILTER_CHIP}
            >
              {t('page.surfaceChip', { surface: surfaceFilter.map((s) => SURFACE_LABEL[s]).join(', ') })}
              <X className="h-3 w-3" aria-hidden />
            </button>
          )}
          {/* Category chips: the "why" filter. Surface-level filters live in the breakdown card. */}
          <TooltipProvider delayDuration={300}>
            <div className="flex flex-wrap items-center gap-1" role="group" aria-label={t('page.categoryFilterAria')} data-testid="analytics-category-chips">
              <button
                type="button"
                aria-pressed={isAllCategories}
                onClick={() => toggleCategory('all')}
                className={`${CHIP_CLASS} ${isAllCategories ? CHIP_ACTIVE : CHIP_IDLE}`}
              >{t('page.all')}</button>
              {SPEND_CATEGORIES.map((c) => {
                const active = categoryFilter?.includes(c) ?? false
                return (
                  <Tooltip key={c}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-pressed={active}
                        aria-describedby={`analytics-category-why-${c}`}
                        onClick={() => toggleCategory(c)}
                        className={`${CHIP_CLASS} ${active ? CHIP_ACTIVE : CHIP_IDLE}`}
                      >
                        {t(`categories.${c}.label`)}
                        <span id={`analytics-category-why-${c}`} className="sr-only">{t(`categories.${c}.why`)}</span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t(`categories.${c}.why`)}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </TooltipProvider>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* Engine: only when at least two engines did work in the period. */}
            {showEngines && (
              <Select
                value={isAllProviders ? 'all' : providerFilter?.length === 1 ? providerFilter[0] : ''}
                onValueChange={(v) => (v === 'all' ? toggleProvider('all') : setFilters((f) => ({ ...f, provider: [v] })))}
              >
                <SelectTrigger className="h-7 w-auto min-w-[8rem] gap-2" aria-label={t('page.engine')} data-testid="analytics-provider-select">
                  <SelectValue placeholder={t('page.allEngines')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('page.allEngines')}</SelectItem>
                  {engines.map((p) => (
                    <SelectItem key={p} value={p}>{providerLabel(p)}{isLocalEngineId(p) ? ` · ${t('page.localEngine')}` : ''}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <SegmentedControl
              value={filters.period}
              onChange={(period) => setFilters((f) => ({ ...f, period }))}
              label={t('page.period')}
              options={PERIODS.map((p) => ({ value: p.value, label: t(p.labelKey) }))}
            />
            <ExportDropdown
              baseUrl={`${getApiBase()}/analytics/export`}
              params={exportParams}
              disabled={isEmpty}
            />
            <button
              type="button"
              onClick={() => { cacheRef.current.clear(); fetchSpending(); fetchInvocations() }}
              className="h-7 w-7 inline-flex items-center justify-center rounded-control border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent"
              title={t('common:actions.refresh')}
              aria-label={t('common:actions.refresh')}
            ><RefreshCw className="w-3 h-3" /></button>
          </div>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-lg border border-accent-warning/30 bg-accent-warning/10 p-4 flex items-center justify-between gap-3">
          <p className="text-sm text-accent-warning">{t('page.failedToLoad')}</p>
          <button
            type="button"
            onClick={() => fetchSpending()}
            className="flex items-center gap-1.5 h-7 px-3 rounded-md text-xs text-accent-warning border border-accent-warning/30 hover:bg-accent-warning/10"
          ><RefreshCw className="w-3 h-3" />{t('common:actions.retry')}</button>
        </div>
      )}

      {/* How much */}
      <SpendingHero data={data} loading={loading} period={filters.period} />
      {/* On what and why */}
      <SpendBreakdownCard data={data} loading={loading} activeSurfaces={surfaceFilter} onSelectSurface={toggleSurface} />
      {/* Internal telemetry: development builds only. */}
      {import.meta.env.DEV && activeProjectId && <LegacyWorkflowUsage projectId={activeProjectId} />}

      {/* When */}
      <SpendingTimeline data={data} loading={loading} />

      {/* With which engines and models */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 lg:[&>*:only-child]:col-span-2" data-testid="analytics-engines-models">
        <ProviderBreakdownCard data={data} loading={loading} configuredProviders={installedProviders} />
        <ModelBreakdown
          data={data}
          loading={loading}
          onSelectModel={selectModel}
          activeModel={filters.model?.[0]}
        />
      </div>

      {/* Limits: plan meters or dollar caps, projection and what-if. `?panel=budget` (inbox, forecast) lands here. */}
      {activeProjectId && <div ref={budgetAnchor}><BudgetCard projectId={activeProjectId} onReady={onBudgetReady} refreshKey={data?.summary?.totalCostUsd ?? null} configuredProviders={installedProviders} /></div>}

      {/* Which specs */}
      <TopTicketsCrossSurface
        data={data}
        loading={loading}
        onSelectTicket={(id) => setFilters((f) => ({ ...f, ticketId: id ?? undefined }))}
      />

      {/* The individual calls */}
      <div className="flex flex-col gap-2">
        {/* BUG-ANALYTICS-35: cost/recency ordering toggle for the raw table so the
            costliest rows can be surfaced on page 1, not just the most recent. */}
        <div className="flex items-center justify-end gap-1.5" data-testid="analytics-table-sort">
          <span className="text-xs text-muted-foreground mr-1">{t('table.sortLabel')}</span>
          {(['recency', 'cost'] as const).map((s) => (
            <button
              key={s}
              type="button"
              data-testid={`analytics-table-sort-${s}`}
              aria-pressed={tableSort === s}
              onClick={() => setTableSort(s)}
              className={`h-6 px-2.5 rounded-full text-caption font-medium transition-all ${
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
      {/* Secondary breakdowns: collapsed by default so the primary story
          (how much → why → when → models → calls) reads first. */}
      <details className="group rounded-lg border border-border/40" data-testid="analytics-more-breakdowns">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-lg px-4 py-3 text-sm font-medium text-foreground hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground motion-safe:transition-transform motion-safe:duration-150 group-open:rotate-90" aria-hidden />
          {t('page.moreBreakdowns')}
        </summary>
        <div className="flex flex-col gap-6 px-4 pb-4 pt-2">
          {/* Time to decision / merge per delivery (period-scoped only) */}
          {activeProjectId && (
            <DecisionTimesCard projectId={activeProjectId} period={filters.period} from={filters.from} to={filters.to} />
          )}
          {/* Loop economics — per-loop delivery, cost, rework and escaped defects */}
          {activeProjectId && (
            <LoopEconomicsCard projectId={activeProjectId} period={filters.period} from={filters.from} to={filters.to} />
          )}
          <CostScatter
            data={data}
            loading={loading}
            onSelectPoint={(point) => {
              setTableFilters((tf) => ({ ...tf }))
              setFilters((f) => ({ ...f, ticketId: point.ticketId ?? undefined }))
            }}
          />
          <QuickVsExploreCard data={data} loading={loading} />
        </div>
      </details>
    </div>
  )
}
