import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import { toast } from 'sonner'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { Skeleton } from '../../../components/ui/skeleton'
import { HelpHint } from '../../../components/HelpHint'
import { API_ORIGIN } from '../../../lib/origin'
import { getApiBase } from '../../../lib/api'
import { getDateFnsLocale } from '../../../lib/i18n'
import { fetchUsageSnapshot, isMeteredBilled } from '../../../lib/launch-forecast'
import { cn } from '../../../lib/utils'
import { formatUsd } from '../lib/format'
import {
  CAP_PERIODS, barLevel, barPercent, fetchBudgetOverview, periodSpentUsd, projectionPassesCap,
  type BarLevel, type BudgetOverview, type CapConfig, type CapPeriod, type PeriodSpend,
} from '../lib/budget'
import { WhatIfPanel } from './WhatIfPanel'

type Scope = 'project' | 'desktop'
type Field = CapPeriod | 'run'
const FIELDS: readonly Field[] = [...CAP_PERIODS, 'run']

/** PATCH body key of a cap, per scope (the daily keys predate caps and keep their names). */
const BODY_KEY: Record<Scope, Record<Field, string>> = {
  project: { day: 'dailyBudgetUsd', week: 'weeklyBudgetUsd', month: 'monthlyBudgetUsd', run: 'runCapUsd' },
  desktop: { day: 'desktopDailyBudgetUsd', week: 'desktopWeeklyBudgetUsd', month: 'desktopMonthlyBudgetUsd', run: 'runCapUsd' },
}

const BAR_TONE: Record<BarLevel, string> = { ok: 'bg-primary', caution: 'bg-accent-warning', reached: 'bg-destructive' }
const LAMP_TONE: Record<Exclude<BarLevel, 'ok'>, string> = { caution: 'text-accent-warning', reached: 'text-destructive' }

const amount = (cap: number | null): string => (cap === null ? '' : String(cap))

function parseCap(raw: string): number | null | undefined {
  if (raw.trim() === '') return null
  const value = parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function resetLabel(iso: string): string | null {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? null : format(at, 'PP', { locale: getDateFnsLocale() })
}

interface Billing { ready: boolean; snapshot: unknown }

/** Subscription-usage snapshot: decides which providers may show dollars. Unknown = no dollars. */
function useBilling(): Billing {
  const [state, setState] = useState<Billing>(() => { const source = fetchUsageSnapshot(); return { ready: source.fresh !== null, snapshot: source.fresh } })
  useEffect(() => {
    const source = fetchUsageSnapshot()
    if (source.fresh) { setState({ ready: true, snapshot: source.fresh }); return }
    let cancelled = false
    void source.load().then((snapshot) => { if (!cancelled) setState({ ready: true, snapshot }) }, () => { if (!cancelled) setState({ ready: true, snapshot: null }) })
    return () => { cancelled = true }
  }, [])
  return state
}

/** Plan-billed spend has no dollar meaning: every provider with spend in the period is not positively metered. */
function planOnly(spend: PeriodSpend, billing: Billing): boolean {
  return spend.byProvider.length > 0 && spend.byProvider.every((row) => !isMeteredBilled(billing.snapshot, row.provider))
}

/** "5h 42% · weekly 18%" from the plan providers' usage windows (turns/limits instead of dollars). */
function planLimits(spend: PeriodSpend, billing: Billing): string | null {
  const providers = (billing.snapshot as { providers?: Array<{ providerId?: string; windows?: Array<{ label?: string; usedPercent?: number | null }> }> } | null)?.providers
  if (!Array.isArray(providers)) return null
  const parts: string[] = []
  for (const row of spend.byProvider) {
    const entry = providers.find((p) => p.providerId === row.provider)
    for (const w of entry?.windows ?? []) {
      if (typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.label) parts.push(`${w.label} ${Math.round(w.usedPercent)}%`)
    }
  }
  return parts.length ? parts.slice(0, 4).join(' · ') : null
}

interface RowProps {
  scope: Scope
  period: CapPeriod
  overview: BudgetOverview
  config: CapConfig
  billing: Billing
  value: string
  onChange: (value: string) => void
}

function UsageRow({ scope, period, overview, config, billing, value, onChange }: RowProps) {
  const { t } = useTranslation('analytics')
  const spend = overview.spend[period]
  const cap = config[period]
  const status = overview.caps.find((c) => c.scope === scope && c.period === period)
  // Scope-wide spend for the project page's app-wide group is the sum over projects; the overview already is.
  const spent = periodSpentUsd(overview, period, scope)
  const level = barLevel(spent, cap)
  const pending = !billing.ready && spend.byProvider.length > 0
  const plan = billing.ready && planOnly(spend, billing)
  const limits = plan ? planLimits(spend, billing) : null
  const turns = spend.byProvider.reduce((sum, row) => sum + row.turns, 0)
  const resets = status ? resetLabel(status.resetsAt) : null
  const label = t(`budget.period.${period}`)
  return (
    <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto_7rem]" data-testid={`budget-row-${scope}-${period}`} data-level={level ?? 'none'}>
      <span className="text-label text-foreground">{label}</span>
      <div className="h-1.5 overflow-hidden rounded-pill bg-border/60" role="presentation">
        {level && <div className={cn('h-full rounded-pill', BAR_TONE[level])} style={{ width: `${barPercent(spent, cap)}%` }} />}
      </div>
      <span className="num text-caption text-muted-foreground sm:text-right" data-testid={`budget-spent-${scope}-${period}`}>
        {pending
          ? '–'
          : plan
          ? t('budget.turns', { n: turns })
          : cap !== null ? t('budget.spentOf', { spent: formatUsd(spent), cap: formatUsd(cap) }) : t('budget.spentNoCap', { spent: formatUsd(spent) })}
        {level && level !== 'ok' && (
          <span className={cn('ml-2 inline-flex items-center gap-1', LAMP_TONE[level])}>
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {t(level === 'reached' ? 'budget.reached' : 'budget.nearing')}
          </span>
        )}
      </span>
      <Input
        type="number" min="0" step="0.01" inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('budget.noCap')}
        aria-label={t(`budget.capLabel.${scope}.${period}`)}
        className="num h-7 text-caption"
      />
      {(plan || resets || (period === 'month' && spend.estimatedUsd > 0 && !plan)) && (
        <p className="num text-micro text-muted-foreground sm:col-start-2 sm:col-span-3">
          {plan && t('budget.planNote')}
          {plan && limits && ` · ${limits}`}
          {!plan && period === 'month' && spend.estimatedUsd > 0 && t('budget.estimatedPart', { amount: formatUsd(spend.estimatedUsd) })}
          {resets && `${plan || (period === 'month' && spend.estimatedUsd > 0) ? ' · ' : ''}${t('budget.resets', { time: resets })}`}
        </p>
      )}
    </div>
  )
}

interface GroupProps {
  scope: Scope
  overview: BudgetOverview
  config: CapConfig
  billing: Billing
  onSaved: () => void
}

function CapGroup({ scope, overview, config, billing, onSaved }: GroupProps) {
  const { t } = useTranslation('analytics')
  const [values, setValues] = useState<Record<Field, string>>(() => Object.fromEntries(FIELDS.map((f) => [f, amount(config[f])])) as Record<Field, string>)
  const touched = useRef(new Set<Field>())
  const [saving, setSaving] = useState(false)

  // A refetch refreshes untouched fields; a field the person is editing is never overwritten.
  useEffect(() => {
    setValues((current) => Object.fromEntries(FIELDS.map((f) => [f, touched.current.has(f) ? current[f] : amount(config[f])])) as Record<Field, string>)
  }, [config])

  const dirty = FIELDS.filter((f) => touched.current.has(f) && values[f] !== amount(config[f]))

  const save = async () => {
    const body: Record<string, number | null> = {}
    for (const f of dirty) {
      const parsed = parseCap(values[f])
      if (parsed === undefined) { toast.error(t('budget.invalidNumber')); return }
      body[BODY_KEY[scope][f]] = parsed
    }
    if (!Object.keys(body).length) return
    setSaving(true)
    try {
      const url = scope === 'project' ? `${getApiBase()}/budget` : `${API_ORIGIN}/api/budget`
      const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      touched.current.clear()
      toast.success(t('budget.saved'))
      onSaved()
    } catch (err) {
      toast.error(t('budget.saveFailed'), { description: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-col gap-2.5" data-testid={`budget-group-${scope}`} aria-label={t(`budget.scope.${scope}`)}>
      <h4 className="text-caption text-muted-foreground">{t(`budget.scope.${scope}`)}</h4>
      {CAP_PERIODS.map((period) => (
        <UsageRow
          key={period} scope={scope} period={period} overview={overview} config={config} billing={billing}
          value={values[period]}
          onChange={(v) => { touched.current.add(period); setValues((c) => ({ ...c, [period]: v })) }}
        />
      ))}
      <div className="grid grid-cols-1 items-center gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_7rem]" data-testid={`budget-row-${scope}-run`}>
        <span className="text-label text-foreground">{t('budget.period.run')}</span>
        <p className="text-micro text-muted-foreground">{t('budget.runHint')}</p>
        <Input
          type="number" min="0" step="0.01" inputMode="decimal"
          value={values.run}
          onChange={(e) => { touched.current.add('run'); setValues((c) => ({ ...c, run: e.target.value })) }}
          placeholder={t('budget.noCap')}
          aria-label={t(`budget.capLabel.${scope}.run`)}
          className="num h-7 text-caption"
        />
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={saving || dirty.length === 0} onClick={() => { void save() }} data-testid={`budget-save-${scope}`}>
          {saving ? t('common:states.saving') : t('common:actions.save')}
        </Button>
      </div>
    </section>
  )
}

function ProjectionBlock({ overview }: { overview: BudgetOverview }) {
  const { t } = useTranslation('analytics')
  const p = overview.projection
  const passes = projectionPassesCap(p, overview.config.month)
  return (
    <section className="flex flex-col gap-1" data-testid="budget-projection" aria-label={t('budget.projection.title')}>
      <div className="flex items-center gap-2">
        <h4 className="text-caption text-muted-foreground">{t('budget.projection.title')}</h4>
        <span className="rounded-pill border border-border px-1.5 text-micro text-muted-foreground">{t('budget.estimate')}</span>
      </div>
      {p ? (
        <>
          <p className="num text-title text-foreground" data-testid="budget-projection-value">≈ {formatUsd(p.projectedUsd)}</p>
          <p className="num text-micro text-muted-foreground">
            {t('budget.projection.basis', { days: p.trailingDays, avg: formatUsd(p.avgDailyUsd), remaining: p.remainingDays, mtd: formatUsd(p.monthToDateUsd) })}
          </p>
          {passes && overview.config.month !== null && (
            <p className="inline-flex items-center gap-1.5 text-caption text-accent-warning" data-testid="budget-projection-over">
              <span className="size-1.5 rounded-full bg-accent-warning" aria-hidden />
              {t('budget.projection.overCap', { cap: formatUsd(overview.config.month) })}
            </p>
          )}
        </>
      ) : (
        <p className="text-caption text-muted-foreground">{t('budget.projection.none')}</p>
      )}
    </section>
  )
}

interface BudgetCardProps {
  /** The active project's id; null renders the app-wide caps only (the Desktop analytics overlay). */
  projectId: string | null
  /** Changes whenever new spend was recorded, so the bars follow the work. */
  refreshKey?: unknown
}

/**
 * Analytics ▸ Budget: spend against the daily, weekly and monthly caps (per
 * project and app-wide), the per-run soft cap, a month-end projection and a
 * what-if pricer. Caps are enforced by the same gate as the daily budget.
 */
export function BudgetCard({ projectId, refreshKey }: BudgetCardProps) {
  const { t } = useTranslation('analytics')
  // The project's own overview (null on the app-wide overlay) and the app-wide one.
  const [project, setProject] = useState<BudgetOverview | null>(null)
  const [app, setApp] = useState<BudgetOverview | null>(null)
  const [failed, setFailed] = useState(false)
  const billing = useBilling()
  const base = useMemo(() => (projectId ? `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}` : null), [projectId])

  const load = useCallback((signal?: AbortSignal) => {
    const settle = (set: (next: BudgetOverview) => void) => (next: BudgetOverview | null) => {
      if (signal?.aborted) return
      if (next) { set(next); setFailed(false) } else setFailed(true)
    }
    const onError = () => { if (!signal?.aborted) setFailed(true) }
    fetchBudgetOverview(null, signal).then(settle(setApp), onError)
    if (base) fetchBudgetOverview(base, signal).then(settle(setProject), onError)
  }, [base])

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load, refreshKey])

  const ready = base ? project && app : app
  if (!ready) {
    return failed
      ? <p role="alert" className="rounded-card border border-accent-warning/30 bg-accent-warning/10 p-3 text-caption text-accent-warning">{t('budget.loadFailed')}</p>
      : <Skeleton className="h-48" />
  }

  const refresh = () => load()
  return (
    <section id="budget-panel" className="flex flex-col gap-4 rounded-card border border-border bg-card p-4" data-testid="budget-card" aria-labelledby="budget-panel-title">
      <header className="flex items-center gap-1">
        <h3 id="budget-panel-title" className="text-strong">{t('budget.title')}</h3>
        <HelpHint topic="dailyBudget" />
      </header>
      {project && app ? (
        <>
          <CapGroup scope="project" overview={project} config={project.config} billing={billing} onSaved={refresh} />
          <CapGroup scope="desktop" overview={app} config={app.config} billing={billing} onSaved={refresh} />
          <ProjectionBlock overview={project} />
          <WhatIfPanel projectBase={base as string} billing={billing} />
        </>
      ) : app ? (
        <>
          <CapGroup scope="desktop" overview={app} config={app.config} billing={billing} onSaved={refresh} />
          <ProjectionBlock overview={app} />
        </>
      ) : null}
    </section>
  )
}
