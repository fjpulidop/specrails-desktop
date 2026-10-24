import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog'

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  description?: React.ReactNode
  /** Label of the destructive confirm button. Defaults to common:actions.delete. */
  confirmLabel?: React.ReactNode
  /** Label of the cancel button. Defaults to common:actions.cancel. */
  cancelLabel?: React.ReactNode
  onConfirm: () => void | Promise<void>
  /** Disables both buttons while the confirm action runs. */
  busy?: boolean
  /** Extra content between the description and the footer. */
  children?: React.ReactNode
  /** Optional third action rendered before the confirm button (e.g. "Save"). */
  secondaryAction?: React.ReactNode
}

/**
 * Shared confirmation for destructive actions: title, description, a ghost
 * Cancel and a destructive Confirm. Built on ui/dialog so it inherits focus
 * trapping, Escape-to-close and the dialog semantics.
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
}: ConfirmDialogProps) {
  const { t } = useTranslation('common')
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">{title}</DialogTitle>
          {description ? (
            <DialogDescription className="text-sm leading-relaxed">{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {children}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {cancelLabel ?? t('actions.cancel')}
          </Button>
          {secondaryAction}
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => { void onConfirm() }}
          >
            {confirmLabel ?? t('actions.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
