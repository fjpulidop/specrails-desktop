import { useTranslation } from 'react-i18next'
import { GitBranch, Loader2, LogOut } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'

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
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="z-[70] max-w-sm" overlayClassName="z-[70]" data-testid="flow-close-dialog">
        <DialogHeader>
          <DialogTitle>{t('flow.close.title')}</DialogTitle>
          <DialogDescription>{t('flow.close.body')}</DialogDescription>
        </DialogHeader>
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
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>{t('flow.close.cancel')}</Button>
          <Button size="sm" onClick={onConfirm} disabled={busy} data-testid="flow-close-confirm">
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : <LogOut className="mr-1.5 h-3.5 w-3.5" aria-hidden />}
            {t('flow.close.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
