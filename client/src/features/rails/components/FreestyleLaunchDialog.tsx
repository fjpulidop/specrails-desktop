import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, GitBranch, Bot, DollarSign } from 'lucide-react'
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
import { keyboardLabel } from '../../../lib/keyboard-label'
import { providerLabel } from '../../providers/lib/provider-capabilities'

interface Props {
  open: boolean
  railLabel: string
  specCount: number
  provider?: string
  /** Selected provider-native model. Shown for context. */
  model?: string | null
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation modal shown before launching a rail in Freestyle mode. Freestyle
 * bypasses the OpenSpec pipeline and lets the selected provider run autonomously
 * dynamic workflows, so cost is variable — the user explicitly opts in here.
 * Continue is the affirmative (green) action; ⌘/Ctrl+Enter triggers it.
 */
export function FreestyleLaunchDialog({ open, railLabel, specCount, provider = 'claude', model, onConfirm, onCancel }: Props) {
  const { t } = useTranslation('dashboard')
  const confirmRef = useRef<HTMLButtonElement>(null)
  const providerName = providerLabel(provider)

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
        size="confirm"
        showCloseButton={false}
        onOpenAutoFocus={(e) => { e.preventDefault(); confirmRef.current?.focus() }}
      >
        <DialogHeader icon={<Sparkles className="text-accent-highlight" />}>
          <DialogTitle>{t('freestyleDialog.title')}</DialogTitle>
          {/* Plain-language gloss of what "Freestyle" means (fix 26). */}
          <DialogDescription>{t('freestyleDialog.gloss', { provider: providerName })}</DialogDescription>
        </DialogHeader>

        <DialogBody className="space-y-4">
          <p className="text-label text-foreground" data-testid="freestyle-launch-context">
            {t('freestyleDialog.context', { rail: railLabel, count: specCount })}
            {model ? ` · ${model}` : ''}
          </p>
          <ul className="space-y-2.5 text-xs text-muted-foreground">
            <li className="flex items-start gap-2.5">
              <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-warning" />
              <span><span className="font-medium text-foreground">{t('freestyleDialog.noPipelineTitle')}</span>{' '}{t('freestyleDialog.noPipelineBody')}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-info" />
              <span><span className="font-medium text-foreground">{t('freestyleDialog.autonomyTitle', { provider: providerName })}</span>{' '}{t('freestyleDialog.autonomyBody', { provider: providerName })}</span>
            </li>
            <li className="flex items-start gap-2.5">
              <DollarSign className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-success" />
              <span><span className="font-medium text-foreground">{t('freestyleDialog.costTitle')}</span>{' '}{t('freestyleDialog.costBody', { provider: providerName })}</span>
            </li>
          </ul>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('common:actions.cancel')}
          </Button>
          <Button
            ref={confirmRef}
            className="gap-2 bg-accent-success text-background hover:bg-accent-success/90 focus-visible:ring-accent-success"
            onClick={onConfirm}
          >
            {t('freestyleDialog.continue')}
            <kbd className="hidden sm:inline-flex items-center rounded border border-background/30 bg-background/15 px-1 text-label leading-4">{keyboardLabel('⌘↵')}</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
