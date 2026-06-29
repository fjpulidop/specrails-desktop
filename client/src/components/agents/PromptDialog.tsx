import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

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
      <DialogContent movableResizable className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="py-2 space-y-2">
          {description && (
            <p className="text-xs text-muted-foreground">{description}</p>
          )}
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
            <p className="text-[11px] text-yellow-500 aurora-light:text-accent-warning">{inputInvalidHint}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
          <Button size="sm" onClick={() => onConfirm(trimmed)} disabled={!canConfirm}>
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
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent movableResizable className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {description && (
          <div className="py-2">
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('actions.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={onConfirm}
            className={destructive ? 'bg-red-500 hover:bg-red-600 text-white' : undefined}
          >
            {confirmLabel ?? t('actions.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
