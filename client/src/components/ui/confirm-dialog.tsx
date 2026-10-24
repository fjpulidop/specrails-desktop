import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from './button'
import type { DialogLayer } from '../../lib/layers'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Names the object or decision ("Discard local changes?"). */
  title: React.ReactNode
  /** States the consequence. */
  description?: React.ReactNode
  /** Label of the confirm button — a verb ("Discard changes"). Defaults to common:actions.delete. */
  confirmLabel?: React.ReactNode
  /** Label of the cancel button. Defaults to common:actions.cancel. */
  cancelLabel?: React.ReactNode
  onConfirm: () => void | Promise<void>
  /** Disables both buttons while the confirm action runs. */
  busy?: boolean
  /** Extra content between the header and the footer (rendered in the body). */
  children?: React.ReactNode
  /** Optional third action rendered before the confirm button (e.g. "Save"). */
  secondaryAction?: React.ReactNode
  /** `destructive` (default) for data loss; `default` for non-destructive confirms. */
  tone?: 'destructive' | 'default'
  /** Disables only the confirm button (e.g. until a required field is filled). */
  confirmDisabled?: boolean
  /** Stacking layer; defaults to the parent dialog's layer (see lib/layers). */
  layer?: DialogLayer
  /** data-testid on the panel / the confirm / the cancel button. */
  testId?: string
  confirmTestId?: string
  cancelTestId?: string
}

/**
 * Shared confirmation (modal standard): header with title + consequence, an
 * optional body, then Cancel (ghost) → Confirm on the right, both default
 * size. Initial focus goes to the confirm button; Escape and Cancel dismiss
 * unless `busy`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  onConfirm,
  busy = false,
  children,
  secondaryAction,
  tone = 'destructive',
  confirmDisabled = false,
  layer,
  testId,
  confirmTestId,
  cancelTestId,
}: ConfirmDialogProps) {
  const { t } = useTranslation('common')
  const confirmRef = React.useRef<HTMLButtonElement>(null)
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent
        size="confirm"
        layer={layer}
        showCloseButton={false}
        data-testid={testId}
        {...(description ? {} : { 'aria-describedby': undefined })}
        onOpenAutoFocus={(e) => {
          if (!confirmRef.current || confirmRef.current.disabled) return
          e.preventDefault()
          confirmRef.current.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children ? <DialogBody className="space-y-3 text-[13px]">{children}</DialogBody> : null}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            data-testid={cancelTestId}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel ?? t('actions.cancel')}
          </Button>
          {secondaryAction}
          <Button
            ref={confirmRef}
            type="button"
            variant={tone === 'destructive' ? 'destructive' : 'default'}
            disabled={busy || confirmDisabled}
            aria-busy={busy || undefined}
            data-testid={confirmTestId}
            onClick={() => { void onConfirm() }}
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
            {confirmLabel ?? t('actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
