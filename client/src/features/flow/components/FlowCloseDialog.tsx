import { useTranslation } from 'react-i18next'
import { GitBranch, LogOut } from 'lucide-react'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'

/**
 * Confirmation before closing a needs-review Flow. Nothing is deleted, so the
 * dialog names what is KEPT (the branch and the spec) instead of a loss list,
 * and its confirm is a plain (non-destructive) button.
 */
export function FlowCloseDialog({ open, busy, branch = null, onOpenChange, onConfirm }: {
  open: boolean
  busy: boolean
  branch?: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('agent')
  return (
    // Opened from the Flow strip, which can sit inside the floating chat (z-60): stacked layer.
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      tone="default"
      layer="stacked"
      testId="flow-close-dialog"
      confirmTestId="flow-close-confirm"
      title={t('flow.close.title')}
      description={t('flow.close.body')}
      cancelLabel={t('flow.close.cancel')}
      confirmLabel={<>{busy ? null : <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden />}{t('flow.close.confirm')}</>}
      onConfirm={onConfirm}
    >
      <ul className="space-y-1 rounded-lg border border-border/60 bg-surface/60 px-3 py-2 text-xs text-foreground/80" data-testid="flow-close-kept">
        {branch && (
          <li className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="h-3 w-3 shrink-0 text-foreground/70" aria-hidden />
            <span className="shrink-0">{t('flow.close.keptBranch')}</span>
            <span className="truncate font-mono" title={branch}>{branch}</span>
          </li>
        )}
        <li>{t('flow.close.keptSpec')}</li>
      </ul>
    </ConfirmDialog>
  )
}
