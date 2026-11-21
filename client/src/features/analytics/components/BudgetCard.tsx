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
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { InfoHint } from './InfoHint'
import { cn } from '../../../lib/utils'
import { formatUsd } from '../lib/format'
import { isPlanBilledSpend, useBilling, type Billing } from '../lib/use-billing'
import {
  CAP_PERIODS, barLevel, barPercent, fetchBudgetOverview, periodSpentUsd, projectionPassesCap,
  type BarLevel, type BudgetOverview, type CapConfig, type CapPeriod, type PeriodSpend,
} from '../lib/budget'
import { WhatIfPanel } from './WhatIfPanel'

import { notifyError } from '../../../lib/notify-error'
type Scope = 'project' | 'desktop'
type Field = CapPeriod | 'run'
const FIELDS: readonly Field[] = [...CAP_PERIODS, 'run']

/** PATCH body key of a cap, per scope (the daily keys predate caps and keep their names). */
const BODY_KEY: Record<Scope, Record<Field, string>> = {
  project: { day: 'dailyBudgetUsd', week: 'weeklyBudgetUsd', month: 'monthlyBudgetUsd', run: 'runCapUsd' },
  desktop: { day: 'desktopDailyBudgetUsd', week: 'desktopWeeklyBudgetUsd', month: 'desktopMonthlyBudgetUsd', run: 'runCapUsd' },
}

// Cost is amber (Amber Rule): "Reached" differs from "Nearing" by its label and dot, not by hue, and the
// healthy bar is neutral because cyan is reserved for the primary action (Lamp Rule).
const BAR_TONE: Record<BarLevel, string> = { ok: 'bg-foreground/40', caution: 'bg-accent-warning', reached: 'bg-accent-warning' }
const LAMP_TONE: Record<Exclude<BarLevel, 'ok'>, string> = { caution: 'text-accent-warning', reached: 'text-accent-warning' }

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

/** Plan-billed spend has no dollar meaning: every provider with spend in the period is not positively metered. */
function planOnly(spend: PeriodSpend, billing: Billing): boolean {
  return isPlanBilledSpend(spend.byProvider, billing)
}

interface PlanWindow { label: string; usedPercent: number }
interface PlanProvider { provider: string; windows: PlanWindow[] }

/**
 * The plan providers' usage windows (session, weekly), one entry per provider
 * that did work in the period and that the project has configured. Turns and
 * limits replace dollars under plan billing.
 */
function planProviders(overview: BudgetOverview, billing: Billing, configuredProviders?: readonly string[]): PlanProvider[] {
  const providers = (billing.snapshot as { providers?: Array<{ providerId?: string; windows?: Array<{ label?: string; usedPercent?: number | null }> }> } | null)?.providers
  if (!Array.isArray(providers)) return []
  const result: PlanProvider[] = []
  const seen = new Set<string>()
  for (const period of CAP_PERIODS) {
    for (const row of overview.spend[period].byProvider) {
      if (seen.has(row.provider)) continue
      if (configuredProviders && !configuredProviders.includes(row.provider)) continue
      seen.add(row.provider)
      const entry = providers.find((p) => p.providerId === row.provider)
      const windows: PlanWindow[] = []
      for (const w of entry?.windows ?? []) {
        if (typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && w.label) windows.push({ label: w.label, usedPercent: w.usedPercent })
      }
      if (windows.length) result.push({ provider: row.provider, windows: windows.slice(0, 2) })
    }
  }
  return result
}

/** A usage-window meter: neutral until 80%, then the caution lamp. */
function WindowMeter({ window: w }: { window: PlanWindow }) {
  const { t } = useTranslation('analytics')
  const known = w.label.toLowerCase()
  const label = known === 'session' || known === 'weekly' ? t(`budget.windowLabel.${known}`) : w.label
  const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)))
  const high = pct >= 80
  return (
    <span className="inline-flex items-center gap-2" data-testid="budget-plan-window" data-level={high ? 'caution' : 'ok'}>
      <span className="text-caption text-muted-foreground">{label}</span>
      <span className="h-1.5 w-20 overflow-hidden rounded-pill bg-border" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span className={cn('block h-full rounded-pill', high ? 'bg-accent-warning' : 'bg-foreground/40')} style={{ width: `${pct}%` }} />
      </span>
      <span className={cn('num text-caption', high ? 'text-accent-warning' : 'text-foreground')}>{pct}%</span>
      {high && <span className="size-1.5 rounded-full bg-accent-warning" aria-hidden />}
    </span>
  )
}

/** Plan billing: per-provider session and weekly meters, and turns today, this week and this month. */
function PlanLimits({ overview, billing, configuredProviders }: { overview: BudgetOverview; billing: Billing; configuredProviders?: readonly string[] }) {
  const { t } = useTranslation('analytics')
  const providers = planProviders(overview, billing, configuredProviders)
  return (
    <section className="flex flex-col gap-3" data-testid="budget-plan-limits" aria-label={t('budget.planLimits')}>
      <dl className="flex flex-wrap gap-x-6 gap-y-1" data-testid="budget-plan-turns">
        {CAP_PERIODS.map((period) => (
          <div key={period} className="flex flex-col">
            <dt className="text-caption text-muted-foreground">{t(`budget.period.${period}`)}</dt>
            <dd className="num text-title text-foreground" data-testid={`budget-turns-${period}`}>
              {overview.spend[period].byProvider.reduce((sum, row) => sum + row.turns, 0)}
              <span className="ml-1 text-caption font-normal text-muted-foreground">{t('budget.turnsUnit')}</span>
            </dd>
          </div>
        ))}
      </dl>
      {providers.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {providers.map((p) => (
            <li key={p.provider} className="flex flex-wrap items-center gap-x-4 gap-y-1" data-testid={`budget-plan-provider-${p.provider}`}>
              <span className="w-20 text-label text-foreground">{providerLabel(p.provider)}</span>
              {p.windows.map((w) => <WindowMeter key={w.label} window={w} />)}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

interface RowProps {
  scope: Scope
  period: CapPeriod
  overview: BudgetOverview
  config: CapConfig
  billing: Billing
  /** Plan billing for the whole card: rows show turns and limits and the dollar field moves to the collapsed editor. */
  plan: boolean
  value: string
  invalid: boolean
  onChange: (value: string) => void
}

/** One dollar field; a rejected value says so under the input instead of only in a toast. */
function CapInput({ scope, field, value, invalid, onChange }: { scope: Scope; field: Field; value: string; invalid: boolean; onChange: (value: string) => void }) {
  const { t } = useTranslation('analytics')
  const errorId = `budget-error-${scope}-${field}`
  return (
    <div className="flex flex-col gap-0.5">
      <Input
        type="number" min="0" step="0.01" inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t('budget.noCap')}
        aria-label={t(`budget.capLabel.${scope}.${field}`)}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        className="num h-7 text-caption"
      />
      {invalid && <p id={errorId} role="alert" className="text-caption text-destructive">{t('budget.invalidNumber')}</p>}
    </div>
  )
}

function UsageRow({ scope, period, overview, config, billing, plan, value, invalid, onChange }: RowProps) {
  const { t } = useTranslation('analytics')
  const spend = overview.spend[period]
  const cap = config[period]
  const status = overview.caps.find((c) => c.scope === scope && c.period === period)
  // Scope-wide spend for the project page's app-wide group is the sum over projects; the overview already is.
  const spent = periodSpentUsd(overview, period, scope)
  const level = barLevel(spent, cap)
  const pending = !billing.ready && spend.byProvider.length > 0
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
      {plan ? <span aria-hidden /> : (
        <CapInput scope={scope} field={period} value={value} invalid={invalid} onChange={onChange} />
      )}
      {(resets || (period === 'month' && spend.estimatedUsd > 0 && !plan)) && (
        <p className="num text-caption text-muted-foreground sm:col-start-2 sm:col-span-3">
          {!plan && period === 'month' && spend.estimatedUsd > 0 && t('budget.estimatedPart', { amount: formatUsd(spend.estimatedUsd) })}
          {resets && `${period === 'month' && spend.estimatedUsd > 0 && !plan ? ' · ' : ''}${t('budget.resets', { time: resets })}`}
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
  plan: boolean
  onSaved: () => void
}

function CapGroup({ scope, overview, config, billing, plan, onSaved }: GroupProps) {
  const { t } = useTranslation('analytics')
  const [values, setValues] = useState<Record<Field, string>>(() => Object.fromEntries(FIELDS.map((f) => [f, amount(config[f])])) as Record<Field, string>)
  const touched = useRef(new Set<Field>())
  const [saving, setSaving] = useState(false)
  const [invalid, setInvalid] = useState<ReadonlySet<Field>>(new Set())

  // A refetch refreshes untouched fields; a field the person is editing is never overwritten.
  useEffect(() => {
    setValues((current) => Object.fromEntries(FIELDS.map((f) => [f, touched.current.has(f) ? current[f] : amount(config[f])])) as Record<Field, string>)
  }, [config])

  const dirty = FIELDS.filter((f) => touched.current.has(f) && values[f] !== amount(config[f]))

  const save = async () => {
    const body: Record<string, number | null> = {}
    const rejected = new Set<Field>()
    for (const f of dirty) {
      const parsed = parseCap(values[f])
      if (parsed === undefined) rejected.add(f)
      else body[BODY_KEY[scope][f]] = parsed
    }
    setInvalid(rejected)
    if (rejected.size) return
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
      notifyError(t('budget.saveFailed'), { detail: err instanceof Error ? err.message : undefined })
    } finally {
      setSaving(false)
    }
  }

  const change = (field: Field, value: string) => {
    touched.current.add(field)
    setValues((c) => ({ ...c, [field]: value }))
    setInvalid((c) => { if (!c.has(field)) return c; const next = new Set(c); next.delete(field); return next })
  }

  const runRow = (
    <div className="grid grid-cols-1 items-start gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_7rem]" data-testid={`budget-row-${scope}-run`}>
      <span className="inline-flex items-center gap-1 text-label text-foreground">{t('budget.period.run')}<InfoHint>{t('budget.runHint')}</InfoHint></span>
      <span aria-hidden />
      <CapInput scope={scope} field="run" value={values.run} invalid={invalid.has('run')} onChange={(v) => change('run', v)} />
    </div>
  )
  const saveRow = (
    <div className="flex justify-end">
      <Button size="sm" variant="secondary" disabled={saving || dirty.length === 0} onClick={() => { void save() }} data-testid={`budget-save-${scope}`}>
        {saving ? t('common:states.saving') : t('common:actions.save')}
      </Button>
    </div>
  )

  return (
    <section className="flex flex-col gap-2.5" data-testid={`budget-group-${scope}`} aria-label={t(`budget.scope.${scope}`)}>
      <h4 className="text-caption text-muted-foreground">{t(`budget.scope.${scope}`)}</h4>
      {plan ? (
        // Plan billing has no per-use dollar meaning: only the dollar caps (for
        // metered providers), inside the card's collapsed editor.
        <>
          {CAP_PERIODS.map((period) => (
            <div key={period} className="grid grid-cols-1 items-start gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)]">
              <span className="text-label text-foreground">{t(`budget.period.${period}`)}</span>
              <CapInput scope={scope} field={period} value={values[period]} invalid={invalid.has(period)} onChange={(v) => change(period, v)} />
            </div>
          ))}
          {runRow}
          {saveRow}
        </>
      ) : (
        <>
          {CAP_PERIODS.map((period) => (
            <UsageRow
              key={period} scope={scope} period={period} overview={overview} config={config} billing={billing} plan={plan}
              value={values[period]} invalid={invalid.has(period)}
              onChange={(v) => change(period, v)}
            />
          ))}
          {runRow}
          {saveRow}
        </>
      )}
    </section>
  )
}

function ProjectionBlock({ overview, plan }: { overview: BudgetOverview; plan: boolean }) {
  const { t } = useTranslation('analytics')
  const p = overview.projection
  const passes = projectionPassesCap(p, overview.config.month)
  return (
    <section className="flex flex-col gap-1" data-testid="budget-projection" aria-label={t('budget.projection.title')}>
      <div className="flex items-center gap-2">
        <h4 className="text-caption text-muted-foreground">{t('budget.projection.title')}</h4>
        {!plan && <span className="rounded-pill border border-border px-1.5 text-caption text-muted-foreground">{t('budget.estimate')}</span>}
      </div>
      {plan ? (
        <p className="text-caption text-muted-foreground" data-testid="budget-projection-plan">{t('budget.projection.planNone')}</p>
      ) : p ? (
        <>
          <p className="num text-title text-foreground" data-testid="budget-projection-value">≈ {formatUsd(p.projectedUsd)}</p>
          <p className="num text-caption text-muted-foreground">
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
  /** Called once the card has real content (not the loading skeleton), e.g. to scroll it into view. */
  onReady?: () => void
  /** Engines configured for the project: plan-limit rows name only these. */
  configuredProviders?: readonly string[]
}

/**
 * Analytics ▸ Budget: spend against the daily, weekly and monthly caps (per
 * project and app-wide), the per-run soft cap, a month-end projection and a
 * what-if pricer. Caps are enforced by the same gate as the daily budget.
 */
export function BudgetCard({ projectId, refreshKey, onReady, configuredProviders }: BudgetCardProps) {
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
  const isReady = !!ready
  useEffect(() => { if (isReady) onReady?.() }, [isReady, onReady])
  // The page scrolls to the card when it is ready, so the failure state counts as ready too (it is what is there to see).
  useEffect(() => { if (!isReady && failed) onReady?.() }, [isReady, failed, onReady])
  if (!ready) {
    return failed
      ? (
        <div role="alert" data-testid="budget-load-failed" className="flex flex-wrap items-center gap-3 rounded-card border border-accent-warning/30 bg-accent-warning/10 p-3 text-caption text-accent-warning">
          <span>{t('budget.loadFailed')}</span>
          <Button size="sm" variant="outline" onClick={() => load()}>{t('common:actions.retry')}</Button>
        </div>
      )
      : <Skeleton className="h-48" />
  }
  // Plan billing is decided once for the whole card, so no row shows dollars while its neighbour shows turns.
  const plan = billing.ready && [project, app].every((o) => o === null || planOnly(o.spend.month, billing)) && (project ?? app) !== null

  const refresh = () => load()
  const primary = project ?? app
  const groups = project && app
    ? [<CapGroup key="project" scope="project" overview={project} config={project.config} billing={billing} plan={plan} onSaved={refresh} />,
      <CapGroup key="desktop" scope="desktop" overview={app} config={app.config} billing={billing} plan={plan} onSaved={refresh} />]
    : app ? [<CapGroup key="desktop" scope="desktop" overview={app} config={app.config} billing={billing} plan={plan} onSaved={refresh} />] : []
  return (
    <section id="budget-panel" className="flex flex-col gap-4 rounded-card border border-border bg-card p-4" data-testid="budget-card" aria-labelledby="budget-panel-title">
      <header className="flex items-center gap-1">
        <h3 id="budget-panel-title" className="text-title">{t(plan ? 'budget.planLimits' : 'budget.title')}</h3>
        <HelpHint topic="dailyBudget" />
        {plan && <InfoHint testId="budget-plan-note">{t('budget.planNote')}</InfoHint>}
      </header>
      {plan && primary ? (
        <>
          <PlanLimits overview={primary} billing={billing} configuredProviders={configuredProviders} />
          <details className="group" data-testid="budget-caps-metered">
            <summary className="cursor-pointer text-caption text-muted-foreground hover:text-foreground">{t('budget.capsMetered')}</summary>
            <div className="mt-2.5 flex flex-col gap-4">{groups}</div>
          </details>
          {project && <WhatIfPanel projectBase={base as string} billing={billing} />}
        </>
      ) : (
        <>
          {groups}
          {primary && <ProjectionBlock overview={primary} plan={false} />}
          {project && <WhatIfPanel projectBase={base as string} billing={billing} />}
        </>
      )}
    </section>
  )
}
