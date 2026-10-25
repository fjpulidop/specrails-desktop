import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../components/ui/select'
import { isMeteredBilled } from '../../../lib/launch-forecast'
import { providerLabel } from '../../providers/lib/provider-capabilities'
import { formatUsd } from '../lib/format'
import { modelLabel } from '../../../lib/model-label'
import { fetchWhatIf, parseRefKey, refKey, toCents, type ModelRef, type WhatIfOverview, type WhatIfResult } from '../lib/budget'

const refLabel = (ref: ModelRef): string => `${providerLabel(ref.provider)} · ${modelLabel(ref.model).text}`

interface ResultProps {
  result: WhatIfResult
  /** True when the current model's provider is billed per use; false hides every dollar figure. */
  metered: boolean
}

/**
 * The answer: an ESTIMATE on both sides (the current model is re-priced the
 * same way, so the delta compares like with like). A model without a price
 * says so; a plan provider shows tokens, not dollars.
 */
export function WhatIfResultView({ result, metered }: ResultProps) {
  const { t, i18n } = useTranslation('analytics')
  const number = (value: number): string => value.toLocaleString(i18n.language || 'en')
  if (result.noPricing) {
    return <p className="text-caption text-accent-warning" data-testid="whatif-no-pricing">{t('budget.whatIf.noPricing', { model: result.noPricing.model })}</p>
  }
  if (result.invocations === 0) return <p className="text-caption text-muted-foreground">{t('budget.whatIf.empty')}</p>
  const tokens = t('budget.whatIf.tokens', { input: number(result.tokens.in), output: number(result.tokens.out) })
  if (!metered || result.estimateCurrentUsd === null || result.estimateWhatIfUsd === null || result.deltaUsd === null) {
    return (
      <div className="flex flex-col gap-0.5" data-testid="whatif-plan">
        <p className="text-caption text-muted-foreground">{t('budget.whatIf.planNote')}</p>
        <p className="num text-caption text-muted-foreground">{tokens}</p>
      </div>
    )
  }
  const delta = result.deltaUsd
  const sign = toCents(delta) === 0 ? 'same' : delta < 0 ? 'saves' : 'costs'
  return (
    <div className="flex flex-col gap-1" data-testid="whatif-result">
      <p className="num text-body text-foreground">
        {t('budget.whatIf.compare', { current: formatUsd(result.estimateCurrentUsd), whatIf: formatUsd(result.estimateWhatIfUsd) })}
      </p>
      <p className="num text-caption text-foreground" data-testid="whatif-delta" data-sign={sign}>
        {sign === 'same' ? t('budget.whatIf.same') : t(sign === 'saves' ? 'budget.whatIf.saves' : 'budget.whatIf.costs', { amount: formatUsd(Math.abs(delta)) })}
        <span className="ml-2 rounded-pill border border-border px-1.5 text-caption text-muted-foreground">{t('budget.estimate')}</span>
      </p>
      <p className="num text-caption text-muted-foreground">{tokens}</p>
      {result.skipped > 0 && <p className="text-caption text-muted-foreground">{t('budget.whatIf.skipped', { n: result.skipped })}</p>}
      {result.recordedUsd !== null && <p className="num text-caption text-muted-foreground">{t('budget.whatIf.recorded', { amount: formatUsd(result.recordedUsd) })}</p>}
    </div>
  )
}

interface PanelProps {
  projectBase: string
  billing: { ready: boolean; snapshot: unknown }
}

/** "What if the work done on model X had run on model Y?" over the last 30 days of recorded usage. */
export function WhatIfPanel({ projectBase, billing }: PanelProps) {
  const { t } = useTranslation('analytics')
  const [open, setOpen] = useState(false)
  const [overview, setOverview] = useState<WhatIfOverview | null>(null)
  const [failed, setFailed] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [result, setResult] = useState<WhatIfResult | null>(null)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    fetchWhatIf(projectBase, null, controller.signal).then(
      (next) => { if (!controller.signal.aborted) { setOverview(next); setFailed(next === null) } },
      () => { if (!controller.signal.aborted) setFailed(true) },
    )
    return () => controller.abort()
  }, [open, projectBase])

  useEffect(() => {
    const source = parseRefKey(from), target = parseRefKey(to)
    if (!open || !source || !target) { setResult(null); return }
    const controller = new AbortController()
    fetchWhatIf(projectBase, { from: source, to: target }, controller.signal).then(
      (next) => { if (!controller.signal.aborted) setResult(next?.result ?? null) },
      () => { if (!controller.signal.aborted) setResult(null) },
    )
    return () => controller.abort()
  }, [open, projectBase, from, to])

  const sourceRef = parseRefKey(from)
  const metered = !!sourceRef && billing.ready && isMeteredBilled(billing.snapshot, sourceRef.provider)

  return (
    <details className="group rounded-card border border-border/60" data-testid="budget-whatif" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-card px-3 py-2 text-label text-foreground hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        {t('budget.whatIf.title')}
        <span className="rounded-pill border border-border px-1.5 text-caption text-muted-foreground">{t('budget.estimate')}</span>
      </summary>
      <div className="flex flex-col gap-3 px-3 pb-3 pt-1">
        <p className="text-caption text-muted-foreground">{t('budget.whatIf.description', { days: overview?.days ?? 30 })}</p>
        {failed && <p role="alert" className="text-caption text-accent-warning">{t('budget.loadFailed')}</p>}
        {overview && overview.sources.length === 0 && <p className="text-caption text-muted-foreground">{t('budget.whatIf.empty')}</p>}
        {overview && overview.sources.length > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-caption text-muted-foreground">
              {t('budget.whatIf.from')}
              <Select value={from} onValueChange={setFrom}>
                <SelectTrigger className="h-8" aria-label={t('budget.whatIf.from')} data-testid="whatif-from"><SelectValue placeholder={t('budget.whatIf.choose')} /></SelectTrigger>
                <SelectContent>
                  {overview.sources.map((s) => <SelectItem key={refKey(s)} value={refKey(s)}>{refLabel(s)} · {t('budget.whatIf.runs', { n: s.invocations })}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
            <label className="flex flex-col gap-1 text-caption text-muted-foreground">
              {t('budget.whatIf.to')}
              <Select value={to} onValueChange={setTo}>
                <SelectTrigger className="h-8" aria-label={t('budget.whatIf.to')} data-testid="whatif-to"><SelectValue placeholder={t('budget.whatIf.choose')} /></SelectTrigger>
                <SelectContent>
                  {overview.targets.map((s) => <SelectItem key={refKey(s)} value={refKey(s)}>{refLabel(s)}</SelectItem>)}
                </SelectContent>
              </Select>
            </label>
          </div>
        )}
        {result && <WhatIfResultView result={result} metered={metered} />}
        <p className="text-caption text-muted-foreground">{t('budget.whatIf.roleNote')}</p>
      </div>
    </details>
  )
}
