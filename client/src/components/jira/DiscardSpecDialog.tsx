import { useState } from 'react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { ArrowRight } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '../ui/dialog'
import { Button } from '../ui/button'
import { jiraApi } from '../../lib/jira-api'

export interface DiscardSpecDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The Jira-backed spec being discarded. */
  ticket: { id: number; title: string; jira_key?: string | null }
  /** The configured status the issue will be moved to. */
  discardStatus: string
  /** Called after a successful discard (e.g. to close the parent modal/menu). */
  onDiscarded?: () => void
}

/**
 * "Move to <status>" confirmation for a Jira-backed spec. Replaces the
 * destructive delete in Jira-synced projects: it transitions the linked issue to
 * the user-configured discard status and optionally posts a reason comment.
 * Reused by the spec detail modal and the right-click context menu.
 */
export function DiscardSpecDialog({ open, onOpenChange, ticket, discardStatus, onDiscarded }: DiscardSpecDialogProps) {
  const { t } = useTranslation('jira')
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)

  async function confirm() {
    setBusy(true)
    try {
      await jiraApi.discardSpec(ticket.id, comment.trim() || null)
      toast.success(t('discard.movedToast', { status: discardStatus, key: ticket.jira_key ?? `#${ticket.id}` }))
      onOpenChange(false)
      setComment('')
      onDiscarded?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!busy) onOpenChange(o) }}>
      <DialogContent movableResizable className="max-w-md" data-testid="jira-discard-dialog">
        <DialogHeader>
          <DialogTitle>{t('discard.title', { status: discardStatus })}</DialogTitle>
          <DialogDescription>
            {t('discard.body', { status: discardStatus, key: ticket.jira_key ?? `#${ticket.id}` })}
          </DialogDescription>
        </DialogHeader>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-foreground">{t('discard.commentLabel')}</span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t('discard.commentPlaceholder')}
            rows={3}
            className="w-full rounded-md border border-border bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-none"
            data-testid="jira-discard-comment"
          />
        </label>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('wizard.cancel')}
          </Button>
          <Button size="sm" onClick={confirm} disabled={busy} data-testid="jira-discard-confirm">
            <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
            {busy ? t('discard.moving') : t('discard.confirm', { status: discardStatus })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
