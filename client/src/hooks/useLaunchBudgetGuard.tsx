import { useCallback, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../components/ui/confirm-dialog'
import { useBudgetOutlook, useLaunchForecast } from './useLaunchForecast'
import { openBudgetPanel } from '../lib/app-settings-events'
import type { ForecastQuery } from '../lib/launch-forecast'

/**
 * Budget-aware launch: when a cap is already reached the admission gate would
 * refuse the launch, so the guard never starts it. It explains that and offers
 * the way out: "Raise cap" opens the budget panel. Wrap the launch action in
 * `guard(...)` and render `dialog` once.
 */
export function useLaunchBudgetGuard(query: ForecastQuery | null): { guard: (launch: () => void) => void; dialog: ReactNode } {
  const { t } = useTranslation('common')
  const outlook = useBudgetOutlook(query)
  const period = useLaunchForecast(query)?.budget?.period
  const ctx = period ? { context: period } : {}
  const [open, setOpen] = useState(false)

  const guard = useCallback((launch: () => void) => {
    if (outlook !== 'reached') { launch(); return }
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
        onOpenChange={setOpen}
        title={t('forecast.budgetReached', ctx)}
        description={t('forecast.launchBlocked', ctx)}
        confirmLabel={t('forecast.raiseCap')}
        tone="default"
        testId="launch-over-budget-dialog"
        confirmTestId="launch-over-budget-confirm"
        onConfirm={() => { setOpen(false); openBudgetPanel() }}
      />
    </div>
  )

  return { guard, dialog }
}
