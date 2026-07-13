import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { GitPullRequest, GitBranch } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'
import { Button } from './ui/button'
import type { RailTargetPr } from './RailTargetPrSelector'

interface Props {
  open: boolean
  target: RailTargetPr | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation shown before a launch that delivers INTO an existing PR
 * (deliver-rail-into-existing-pr). Names the exact PR number, title, and head
 * branch so a mis-pick is visible before any work starts: the run pushes to
 * that PR's head branch and no new PR is created.
 */
export function TargetPrLaunchDialog({ open, target, onConfirm, onCancel }: Props) {
  const { t } = useTranslation('dashboard')
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        onConfirm()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onConfirm])

  if (!target) return null
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent
        movableResizable
        showCloseButton={false}
        className="max-w-md gap-5"
        onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus() }}
      >
        <DialogHeader>
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-info/15 text-accent-info ring-1 ring-accent-info/30">
              <GitPullRequest className="h-4.5 w-4.5" />
            </span>
            <div className="text-left">
              <DialogTitle className="text-base">{t('targetPr.confirmTitle')}</DialogTitle>
              <DialogDescription>{t('targetPr.confirmBody')}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-2 rounded-lg border border-border/60 bg-muted/30 p-3 text-xs">
          <div className="flex items-start gap-2">
            <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-info" aria-hidden />
            <span className="min-w-0 font-medium text-foreground">
              #{target.number}
              {target.title ? ` · ${target.title}` : ''}
            </span>
          </div>
          {target.headRefName && (
            <div className="flex items-start gap-2 text-muted-foreground">
              <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 truncate">
                {t('targetPr.confirmBranch')}: <span className="font-mono">{target.headRefName}</span>
              </span>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" className="h-9" onClick={onCancel}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            className="h-9 gap-2 bg-accent-info text-white hover:bg-accent-info/85 focus-visible:ring-accent-info"
            onClick={onConfirm}
          >
            {t('targetPr.confirmLaunch', { number: target.number })}
            <kbd className="hidden sm:inline-flex items-center rounded border border-white/30 bg-white/10 px-1 text-[9px] font-medium leading-4">⌘↵</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
