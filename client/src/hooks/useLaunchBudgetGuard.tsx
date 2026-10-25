import { useCallback, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { useBudgetOutlook, useLaunchForecast } from './useLaunchForecast'
import type { ForecastQuery } from '../lib/launch-forecast'

/**
 * Budget-aware launch: when today's budget is already reached, a launch is not
 * blocked (the person may know better) but asks first, saying the run will
 * pause. Wrap the launch action in `guard(...)` and render `dialog` once.
 */
export function useLaunchBudgetGuard(query: ForecastQuery | null): { guard: (launch: () => void) => void; dialog: ReactNode } {
  const { t } = useTranslation('common')
  const outlook = useBudgetOutlook(query)
  const period = useLaunchForecast(query)?.budget?.period
  const ctx = period ? { context: period } : {}
  const [open, setOpen] = useState(false)
  const pending = useRef<(() => void) | null>(null)

  const guard = useCallback((launch: () => void) => {
    if (outlook !== 'reached') { launch(); return }
    pending.current = launch
    setOpen(true)
  }, [outlook])

  const dialog = (
    // The dialog is portalled but React still bubbles its events to the card or row that hosts the hook.
    <div
      style={{ display: 'contents' }}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onMouseUp={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
      onTouchEnd={(event) => event.stopPropagation()}
    >
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => { setOpen(next); if (!next) pending.current = null }}
        title={t('forecast.budgetReached', ctx)}
        description={t('forecast.launchOverBudget', ctx)}
        confirmLabel={t('forecast.launchAnyway')}
        tone="default"
        testId="launch-over-budget-dialog"
        confirmTestId="launch-over-budget-confirm"
        onConfirm={() => {
          const launch = pending.current
          pending.current = null
          setOpen(false)
          launch?.()
        }}
      />
    </div>
  )

  return { guard, dialog }
}
