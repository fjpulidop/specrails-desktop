/**
 * A run held at a spending limit, in its run window: what happened, the figures
 * (the limit, what the run spent, what its next step usually costs) and the ways
 * forward. At its own per-run limit these are the cap pause dialog's answers
 * (raise the limit, run this step once, continue without the limit); at a daily,
 * weekly or monthly limit, resume once that limit allows it.
 *
 * Docked under the log like the usage-limit card once steps ran; before the
 * first step it is the run window's whole content (`layout="centered"`).
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleDollarSign, Play } from 'lucide-react'
import { Button } from '../../../../components/ui/button'
import { Input } from '../../../../components/ui/input'
import { cn } from '../../../../lib/utils'
import { notifyError } from '../../../../lib/notify-error'
import { API_ORIGIN } from '../../../../lib/origin'
import { formatUsd } from '../../../../lib/format-usd'
import { openBudgetPanel } from '../../../../lib/app-settings-events'
import { useBubbleAvoid } from '../../../../lib/bubble-avoid'
import { dailyBudgetActionMessage, dailyBudgetPausedMessage, dailyBudgetStillExceededMessage, readDailyBudgetInfo, readDailyBudgetRejection, type DailyBudgetInfo } from '../../../../lib/daily-budget'
import { isValidRaise, suggestedRaise, type RunCapChoice } from '../../../../lib/run-cap'

/** Resume a budget-held run, optionally answering its per-run limit; the refusal's limit when it still holds. */
export async function resumeBudgetHeldRun(projectId: string, runId: string, choice?: RunCapChoice): Promise<{ ok: true } | { ok: false; budget: DailyBudgetInfo | null; detail?: string }> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/loop-runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(choice ?? {}),
    })
    if (res.ok) return { ok: true }
    const body = await res.json().catch(() => null) as { error?: string; detail?: string } | null
    return { ok: false, budget: readDailyBudgetRejection(body), detail: body?.detail ?? body?.error ?? `HTTP ${res.status}` }
  } catch (error) {
    return { ok: false, budget: null, detail: error instanceof Error ? error.message : String(error) }
  }
}

function Figure({ label, value, note, testId }: { label: string; value: string; note?: string; testId: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd className="text-strong num text-foreground">{value}</dd>
      {note && <dd className="truncate text-caption text-muted-foreground" title={note}>{note}</dd>}
    </div>
  )
}

export function RunBudgetPause({ projectId, runId, budget, stepsRan, layout = 'docked', className }: {
  projectId: string
  runId: string
  /** The job's `loopPauseBudget` (null after a restart: the limit is learnt from the first resume's refusal). */
  budget: unknown
  /** Whether any step of the run ran before it stopped. */
  stepsRan: boolean
  layout?: 'docked' | 'centered'
  className?: string
}) {
  const { t, i18n } = useTranslation('jobs')
  const [info, setInfo] = useState<DailyBudgetInfo | null>(() => readDailyBudgetInfo(budget))
  useEffect(() => { const next = readDailyBudgetInfo(budget); if (next) setInfo(next) }, [budget])
  const [amount, setAmount] = useState(() => (info ? String(suggestedRaise(info)) : ''))
  useEffect(() => { if (info) setAmount(String(suggestedRaise(info))) }, [info])
  const [busy, setBusy] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const avoidRef = useBubbleAvoid<HTMLElement>()
  if (sent) return null

  const perRun = info?.period === 'run'
  const parsed = parseFloat(amount)
  const valid = !!info && isValidRaise(parsed, info)
  const showError = perRun && amount.trim() !== '' && !valid
  const usd = (value: number) => formatUsd(value, i18n.language)

  const act = async (key: string, choice?: RunCapChoice) => {
    setBusy(key)
    const result = await resumeBudgetHeldRun(projectId, runId, choice)
    setBusy(null)
    if (result.ok) { setSent(true); return }
    // Still held: a per-run limit asks its question here; another limit says which and where to raise it.
    if (result.budget?.period === 'run') { setInfo(result.budget); return }
    if (result.budget) {
      setInfo(result.budget)
      notifyError(dailyBudgetStillExceededMessage(t, result.budget), { detail: dailyBudgetActionMessage(t, result.budget), action: { label: t('common:budget.raiseCap'), onClick: openBudgetPanel } })
      return
    }
    notifyError(t('budgetPause.failed'), { detail: result.detail })
  }

  const what = !stepsRan ? t('budgetPause.beforeFirstStep') : info?.nextStep ? t('budgetPause.beforeStep', { step: info.nextStep.label }) : t('budgetPause.betweenSteps')
  const centered = layout === 'centered'

  return (
    <section ref={avoidRef} role="region" aria-label={t('common:budget.runCap.title')} data-testid="run-budget-pause" data-layout={layout}
      className={cn('space-y-3 rounded-card border border-accent-warning/40 bg-accent-warning/5 px-3.5 py-3', centered && 'w-full max-w-xl px-5 py-4 shadow-1', className)}>
      <div className="flex items-start gap-2.5">
        <CircleDollarSign className="mt-0.5 h-4 w-4 shrink-0 text-accent-warning" aria-hidden />
        <div className="min-w-0 space-y-0.5">
          <p className={cn('text-foreground', centered ? 'text-title' : 'text-strong')}>{perRun || !info ? t('common:budget.runCap.title') : t('budgetPause.titleShared')}</p>
          <p className="text-body text-muted-foreground" data-testid="run-budget-pause-what">
            {what}{' '}{info && !perRun ? dailyBudgetPausedMessage(t, info) : null}
          </p>
        </div>
      </div>

      {perRun && info && (
        <dl className="grid grid-cols-3 gap-3 rounded-control border border-border bg-background/60 px-3 py-2">
          <Figure label={t('budgetPause.limit')} value={usd(info.budgetUsd)} testId="run-budget-pause-limit" />
          <Figure label={t('budgetPause.spent')} value={usd(info.spentUsd)} testId="run-budget-pause-spent" />
          {info.nextStep
            ? <Figure label={t('budgetPause.nextStep')} value={t('budgetPause.about', { usd: usd(info.nextStep.usd) })} note={t('budgetPause.nextStepNote', { step: info.nextStep.label })} testId="run-budget-pause-next" />
            : <Figure label={t('budgetPause.left')} value={usd(Math.max(0, info.budgetUsd - info.spentUsd))} testId="run-budget-pause-left" />}
        </dl>
      )}

      {perRun && info ? (
        <div className="space-y-2">
          <form className="flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (valid) void act('raise', { runCapUsd: parsed }) }}>
            <label className="flex min-w-0 flex-1 basis-40 flex-col gap-1 text-caption text-muted-foreground">
              {t('common:budget.runCap.raiseTo')}
              <Input type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)}
                aria-invalid={showError || undefined} aria-describedby={showError ? 'run-budget-pause-error' : undefined}
                className="num h-8 text-body" data-testid="run-budget-pause-amount" />
            </label>
            <Button type="submit" size="sm" className="h-8" disabled={!valid || busy !== null} data-testid="run-budget-pause-raise">{t('common:budget.runCap.raise')}</Button>
          </form>
          {showError && (
            <p id="run-budget-pause-error" role="alert" className="text-caption text-destructive">{t('common:budget.runCap.mustExceed', { spent: usd(info.spentUsd) })}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {info.nextStep && (
              <Button size="sm" variant="outline" className="gap-1.5" disabled={busy !== null} data-testid="run-budget-pause-once" onClick={() => void act('once', { runCap: 'once' })}>
                <Play className="h-3.5 w-3.5" aria-hidden />{t('common:budget.runCap.once')}
              </Button>
            )}
            <Button size="sm" variant="ghost" disabled={busy !== null} data-testid="run-budget-pause-ignore" onClick={() => void act('ignore', { runCap: 'ignore' })}>
              {t('common:budget.runCap.continue')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" className="gap-1.5" disabled={busy !== null} data-testid="run-budget-pause-resume" onClick={() => void act('resume')}>
            <Play className="h-3.5 w-3.5" aria-hidden />{t('common:budget.resume')}
          </Button>
          {info && (
            <Button size="sm" variant="ghost" onClick={openBudgetPanel} data-testid="run-budget-pause-settings">{t('common:budget.raiseCap')}</Button>
          )}
        </div>
      )}
    </section>
  )
}
