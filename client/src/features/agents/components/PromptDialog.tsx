import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { ConfirmDialog as SharedConfirmDialog } from '../../../components/ui/confirm-dialog'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'

interface PromptDialogProps {
  open: boolean
  title: string
  description?: string
  placeholder?: string
  initialValue?: string
  confirmLabel?: string
  inputPattern?: RegExp
  inputInvalidHint?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

export function PromptDialog({
  open,
  title,
  description,
  placeholder,
  initialValue = '',
  confirmLabel,
  inputPattern,
  inputInvalidHint,
  onConfirm,
  onCancel,
}: PromptDialogProps) {
  const { t } = useTranslation()
  const [value, setValue] = useState(initialValue)

  useEffect(() => {
    if (open) setValue(initialValue)
  }, [open, initialValue])

  const trimmed = value.trim()
  const matchesPattern = !inputPattern || inputPattern.test(trimmed)
  const canConfirm = trimmed.length > 0 && matchesPattern

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent size="form" {...(description ? {} : { 'aria-describedby': undefined })}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DialogBody className="space-y-2">
          <Input
            autoFocus
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && canConfirm) {
                onConfirm(trimmed)
              }
            }}
            className="text-sm font-mono"
          />
          {trimmed.length > 0 && !matchesPattern && inputInvalidHint && (
            <p className="text-xs text-accent-warning">{inputInvalidHint}</p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
          <Button onClick={() => onConfirm(trimmed)} disabled={!canConfirm}>
            {confirmLabel ?? t('actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  description?: string
  confirmLabel?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Agents-local confirm API (`destructive` + `onCancel`), rendered by the shared
 * modal-standard `ConfirmDialog` so every confirm has the same anatomy.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  return (
    <SharedConfirmDialog
      open={open}
      onOpenChange={(o) => { if (!o) onCancel() }}
      title={title}
      description={description}
      confirmLabel={confirmLabel ?? t('actions.confirm')}
      tone={destructive ? 'destructive' : 'default'}
      onConfirm={onConfirm}
    />
  )
}
