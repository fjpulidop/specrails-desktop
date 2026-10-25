import { useTranslation } from 'react-i18next'
import { Clock3 } from 'lucide-react'
import { cn } from '../lib/utils'
import { useLaunchForecast, useProviderBilling } from '../hooks/useLaunchForecast'
import { budgetOutlook, forecastMinutes, formatUsdBand } from '../lib/launch-forecast'
import { openAppSettings, openBudgetPanel, openProjectSettings } from '../lib/app-settings-events'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

interface LaunchForecastProps {
  projectId: string | null | undefined
  /** What is about to run: a loop id (`factory:implement`, a custom loop, the Flow hand-off loop). */
  loopId: string | null | undefined
  /** The single engine that will run it; null (hybrid roles, unknown) shows nothing. */
  provider: string | null | undefined
  /** The band is for ONE spec, but the target holds several: say so, so it is not read as the total. */
  perSpec?: boolean
  /** Render nothing (instead of "Not enough history yet") while there is no band. */
  hideWhenInsufficient?: boolean
  className?: string
}

/**
 * "Usually 6–9 min · $2–4 for runs like this" next to a Launch action: a
 * measured band of this project's own past runs, labelled an estimate, with
 * "Not enough history yet" instead of a guess and the dollar figure shown only
 * when the provider is positively known to be metered (never on a plan or while
 * the billing mode is unknown). When today's spend plus the top of the band would reach
 * the daily budget it adds a caution that opens the budget settings.
 */
export function LaunchForecast({ projectId, loopId, provider, perSpec = false, hideWhenInsufficient = false, className }: LaunchForecastProps) {
  const { t, i18n } = useTranslation('common')
  const data = useLaunchForecast(projectId && loopId && provider ? { projectId, loopId, provider } : null)
  const billing = useProviderBilling(provider ?? null)
  if (!data) return null

  const outlook = budgetOutlook(data)
  // Nothing measured and nothing to warn about: stay silent rather than repeat "not enough history" on every idle rail.
  if (hideWhenInsufficient && !data.time && outlook === 'none') return null
  const openBudget = (event: React.MouseEvent) => {
    event.stopPropagation()
    // Weekly and monthly caps are edited in Analytics ▸ Budget; the daily budget in settings.
    if (data.budget?.period) openBudgetPanel()
    else if (data.budget?.scope === 'desktop') openAppSettings('advanced')
    else openProjectSettings('budget')
  }
  // Longer caps word the same lines for their own period (i18n context), daily keeps the base text.
  const ctx = data.budget?.period ? { context: data.budget.period } : {}
  const showCost = billing.ready && billing.metered && !billing.plan && data.cost !== null

  let line: React.ReactNode
  let hint: string
  if (!data.time) {
    line = t('forecast.insufficient')
    hint = t('forecast.insufficientHint', { count: data.minSamples })
  } else {
    const low = forecastMinutes(data.time.p25Ms)
    const high = forecastMinutes(data.time.p75Ms)
    const time = low === high ? t('forecast.minutesSingle', { value: low }) : t('forecast.minutesRange', { low, high })
    line = showCost && data.cost
      ? t('forecast.usually', { time, cost: formatUsdBand(data.cost.lowUsd, data.cost.highUsd, i18n.language || 'en') })
      : t('forecast.usuallyTime', { time })
    hint = showCost && data.cost && data.cost.sampleCount !== data.time.sampleCount
      ? t('forecast.estimateHintCost', { count: data.time.sampleCount, costCount: data.cost.sampleCount })
      : t('forecast.estimateHint', { count: data.time.sampleCount })
  }

  return (
    <div
      role="group"
      aria-label={t('forecast.label')}
      data-testid="launch-forecast"
      className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-caption tabular-nums text-muted-foreground', className)}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {/* Own provider: this renders in dialogs and cards that may sit outside the project layout's. */}
      <TooltipProvider delayDuration={400}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} data-testid="launch-forecast-line" className="inline-flex items-center gap-1 rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <Clock3 className="size-3 shrink-0" aria-hidden />
              {line}
              {perSpec && data.time && <span>({t('forecast.perSpec')})</span>}
            </span>
          </TooltipTrigger>
          <TooltipContent data-testid="launch-forecast-hint">{hint}</TooltipContent>
        </Tooltip>
        {outlook !== 'none' && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-testid="launch-forecast-budget"
                data-outlook={outlook}
                data-agent-interactive
                onClick={openBudget}
                className="inline-flex items-center gap-1 rounded-control text-accent-warning transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="size-1.5 rounded-full bg-accent-warning" aria-hidden />
                {outlook === 'reached' ? t('forecast.budgetReached', ctx) : t('forecast.budgetCaution')}
              </button>
            </TooltipTrigger>
            <TooltipContent>{outlook === 'reached' ? t('forecast.budgetReachedHint', ctx) : t('forecast.budgetCautionHint', ctx)}</TooltipContent>
          </Tooltip>
        )}
      </TooltipProvider>
    </div>
  )
}
