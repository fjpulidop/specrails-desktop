import { useTranslation } from 'react-i18next'
import { GitBranch, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'

/**
 * Confirmation before discarding a Flow. It names what is lost: the changed
 * files with their +/− lines, the worktree branch and the placeholder spec.
 */
export function FlowDiscardDialog({ open, busy, branch = null, totals = null, onOpenChange, onConfirm }: {
  open: boolean
  busy: boolean
  branch?: string | null
  /** The Flow's changes (null while unknown). */
  totals?: { files: number; additions: number; deletions: number } | null
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
      tone="destructive"
      layer="stacked"
      testId="flow-discard-dialog"
      confirmTestId="flow-discard-confirm"
      title={t('flow.discard.title')}
      description={t('flow.discard.body')}
      cancelLabel={t('flow.discard.cancel')}
      confirmLabel={<>{busy ? null : <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />}{t('flow.discard.confirm')}</>}
      onConfirm={onConfirm}
    >
      <ul className="space-y-1 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2 text-xs text-foreground" data-testid="flow-discard-loss">
        <li className="flex items-center gap-1.5 tabular-nums" data-testid="flow-discard-files">
          {totals
            ? totals.files > 0
              ? <>
                  <span>{t('flow.discard.lossFiles', { count: totals.files })}</span>
                  <span className="text-accent-success">+{totals.additions}</span>
                  <span className="text-destructive">−{totals.deletions}</span>
                </>
              : <span>{t('flow.discard.lossNoChanges')}</span>
            : <span>{t('flow.discard.lossUnknown')}</span>}
        </li>
        {branch && (
          <li className="flex min-w-0 items-center gap-1.5">
            <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate font-mono" title={branch}>{branch}</span>
          </li>
        )}
        <li>{t('flow.discard.lossSpec')}</li>
      </ul>
    </ConfirmDialog>
  )
}
