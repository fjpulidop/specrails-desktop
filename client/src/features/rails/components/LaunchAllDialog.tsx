import { keyboardLabel } from '../../../lib/keyboard-label'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Rocket, GitBranch, Layers, DollarSign, Inbox } from 'lucide-react'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '../../../components/ui/dialog'
import { Button } from '../../../components/ui/button'

interface Props {
  open: boolean
  /** How many rails the batch will launch. */
  railCount: number
  /** Total specs across those rails. */
  specCount: number
  onConfirm: () => void
  onCancel: () => void
  /** Rails held back by the project's review WIP limit (null when none). */
  reviewLimit?: { limit: number; pending: number; held: number } | null
}

/**
 * Confirmation modal shown before "Launch all" starts every ready rail in
 * parallel. Frames the batch honestly: N independent AI pipelines spawn at
 * once (cost scales with the rail count), each isolated in its own git
 * worktree so the parallel runs never collide. Confirm is the affirmative
 * (green) action; ⌘/Ctrl+Enter triggers it.
 */
export function LaunchAllDialog({ open, railCount, specCount, onConfirm, onCancel, reviewLimit = null }: Props) {
  const { t } = useTranslation('dashboard')
  const confirmRef = useRef<HTMLButtonElement>(null)

  // ⌘/Ctrl + Enter confirms while the dialog is open.
  useEffect(() => {
    if (!open || railCount === 0) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onConfirm, railCount])

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent
        size="confirm"
        showCloseButton={false}
        onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus() }}
      >
        <DialogHeader icon={<Rocket />}>
          <DialogTitle>{t('launchAllDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('launchAllDialog.railsCount', { count: railCount })}
            {' · '}
            {t('launchAllDialog.specsCount', { count: specCount })}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          {reviewLimit && (
            <div
              role="status"
              data-testid="launch-all-review-limit"
              className="flex items-start gap-2.5 rounded-lg border border-accent-warning/40 bg-accent-warning/10 px-3 py-2 text-xs text-accent-warning"
            >
              <Inbox className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                <span className="font-medium">{t('launchAllDialog.reviewLimitTitle', { pending: reviewLimit.pending, limit: reviewLimit.limit })}</span>{' '}
                {railCount === 0
                  ? t('launchAllDialog.reviewLimitNone', { count: reviewLimit.held })
                  : t('launchAllDialog.reviewLimitPartial', { count: reviewLimit.held, launched: railCount })}
              </span>
            </div>
          )}

          <ul className="space-y-2.5 text-xs text-muted-foreground">
            <li className="flex items-start gap-2.5">
              <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-info" />
              <span><span className="font-medium text-foreground">{t('launchAllDialog.isolationTitle')}</span>{' '}{t('launchAllDialog.isolationBody')}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Layers className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-secondary" />
              <span><span className="font-medium text-foreground">{t('launchAllDialog.pipelinesTitle', { count: railCount })}</span>{' '}{t('launchAllDialog.pipelinesBody')}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <DollarSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-success" />
              <span><span className="font-medium text-foreground">{t('launchAllDialog.costTitle')}</span>{' '}{t('launchAllDialog.costBody')}</span>
            </li>
          </ul>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            disabled={railCount === 0}
            className="gap-2 bg-accent-success text-background hover:bg-accent-success/90 focus-visible:ring-accent-success"
            onClick={onConfirm}
          >
            {t('launchAllDialog.launch', { count: railCount })}
            <kbd className="hidden sm:inline-flex items-center rounded border border-background/30 bg-background/15 px-1 text-xs font-medium leading-4">{keyboardLabel('⌘↵')}</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
