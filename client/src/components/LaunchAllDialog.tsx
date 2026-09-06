import { keyboardLabel } from '../lib/keyboard-label'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Rocket, GitBranch, Layers, DollarSign } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from './ui/dialog'
import { Button } from './ui/button'

interface Props {
  open: boolean
  /** How many rails the batch will launch. */
  railCount: number
  /** Total specs across those rails. */
  specCount: number
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation modal shown before "Launch all" starts every ready rail in
 * parallel. Frames the batch honestly: N independent AI pipelines spawn at
 * once (cost scales with the rail count), each isolated in its own git
 * worktree so the parallel runs never collide. Confirm is the affirmative
 * (green) action; ⌘/Ctrl+Enter triggers it.
 */
export function LaunchAllDialog({ open, railCount, specCount, onConfirm, onCancel }: Props) {
  const { t } = useTranslation('dashboard')
  const confirmRef = useRef<HTMLButtonElement>(null)

  // ⌘/Ctrl + Enter confirms while the dialog is open.
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
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent-primary/15 text-accent-primary ring-1 ring-accent-primary/30">
              <Rocket className="h-4.5 w-4.5" />
            </span>
            <div className="text-left">
              <DialogTitle className="text-base">{t('launchAllDialog.title')}</DialogTitle>
              <DialogDescription>
                {t('launchAllDialog.railsCount', { count: railCount })}
                {' · '}
                {t('launchAllDialog.specsCount', { count: specCount })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

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

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="ghost" className="h-9" onClick={onCancel}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            className="h-9 gap-2 bg-emerald-500 text-white hover:bg-emerald-400 focus-visible:ring-emerald-400"
            onClick={onConfirm}
          >
            {t('launchAllDialog.launch', { count: railCount })}
            <kbd className="hidden sm:inline-flex items-center rounded border border-white/30 bg-white/10 px-1 text-[9px] font-medium leading-4">{keyboardLabel('⌘↵')}</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
