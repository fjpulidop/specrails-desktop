import { useTranslation } from 'react-i18next'
import { GitBranch, Loader2, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'

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
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="z-[70] max-w-sm" overlayClassName="z-[70]" data-testid="flow-discard-dialog">
        <DialogHeader>
          <DialogTitle>{t('flow.discard.title')}</DialogTitle>
          <DialogDescription>{t('flow.discard.body')}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1 rounded-lg border border-destructive/25 bg-destructive/[0.05] px-3 py-2 text-xs text-foreground/80" data-testid="flow-discard-loss">
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
              <GitBranch className="h-3 w-3 shrink-0 text-foreground/50" aria-hidden />
              <span className="truncate font-mono text-[11px]" title={branch}>{branch}</span>
            </li>
          )}
          <li>{t('flow.discard.lossSpec')}</li>
        </ul>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>{t('flow.discard.cancel')}</Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={busy} data-testid="flow-discard-confirm">
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-1.5 h-3.5 w-3.5" />}
            {t('flow.discard.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
