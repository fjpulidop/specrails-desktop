import { useTranslation } from 'react-i18next'
import { Loader2, Trash2 } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'

/** Confirmation before discarding a Flow: worktree, branch and placeholder spec go away. */
export function FlowDiscardDialog({ open, busy, onOpenChange, onConfirm }: { open: boolean; busy: boolean; onOpenChange: (open: boolean) => void; onConfirm: () => void }) {
  const { t } = useTranslation('agent')
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="z-[70] max-w-sm" overlayClassName="z-[70]" data-testid="flow-discard-dialog">
        <DialogHeader>
          <DialogTitle>{t('flow.discard.title')}</DialogTitle>
          <DialogDescription>{t('flow.discard.body')}</DialogDescription>
        </DialogHeader>
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
