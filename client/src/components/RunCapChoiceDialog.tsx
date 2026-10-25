import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Input } from './ui/input'
import { formatUsd } from '../lib/format-usd'
import { dailyBudgetPausedMessage, type DailyBudgetInfo } from '../lib/daily-budget'
import { isValidRaise, suggestedRaise, type RunCapChoice } from '../lib/run-cap'

interface RunCapChoiceDialogProps {
  /** The per-run cap the run is paused at; null closes the dialog. */
  info: DailyBudgetInfo | null
  busy?: boolean
  onChoose: (choice: RunCapChoice) => void
  /** Leave the run paused. */
  onDismiss: () => void
}

/**
 * "Pause and ask at $X": the run reached its per-run soft cap and waits. The
 * person decides explicitly: continue without the cap, or raise it (it must
 * end above what the run already spent). Dismissing leaves the run paused.
 */
export function RunCapChoiceDialog({ info, busy = false, onChoose, onDismiss }: RunCapChoiceDialogProps) {
  const { t, i18n } = useTranslation('common')
  const [amount, setAmount] = useState('')
  useEffect(() => { if (info) setAmount(String(suggestedRaise(info))) }, [info])
  const parsed = parseFloat(amount)
  const valid = !!info && isValidRaise(parsed, info)
  // A disabled button alone says nothing: name the rule when the typed amount breaks it.
  const showError = !!info && amount.trim() !== '' && !valid
  const errorId = 'run-cap-amount-error'
  return (
    <ConfirmDialog
      open={info !== null}
      onOpenChange={(open) => { if (!open) onDismiss() }}
      title={t('budget.runCap.title')}
      description={info ? dailyBudgetPausedMessage(t, info) : undefined}
      confirmLabel={t('budget.runCap.raise')}
      confirmDisabled={!valid}
      busy={busy}
      tone="default"
      testId="run-cap-dialog"
      confirmTestId="run-cap-raise"
      secondaryAction={<Button variant="outline" disabled={busy} data-testid="run-cap-ignore" onClick={() => onChoose({ runCap: 'ignore' })}>{t('budget.runCap.continue')}</Button>}
      onConfirm={() => { if (valid) onChoose({ runCapUsd: parsed }) }}
    >
      <label className="flex flex-col gap-1 text-caption text-muted-foreground">
        {t('budget.runCap.raiseTo')}
        <Input
          type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)}
          aria-label={t('budget.runCap.raiseTo')} aria-invalid={showError || undefined} aria-describedby={showError ? errorId : undefined}
          className="num h-8 text-body" data-testid="run-cap-amount"
        />
        {showError && (
          <p id={errorId} role="alert" className="text-caption text-destructive" data-testid="run-cap-error">
            {t('budget.runCap.mustExceed', { spent: formatUsd(info.spentUsd, i18n.language) })}
          </p>
        )}
      </label>
    </ConfirmDialog>
  )
}
