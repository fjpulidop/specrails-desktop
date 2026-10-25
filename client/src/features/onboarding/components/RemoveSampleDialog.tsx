import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'

interface RemoveSampleDialogProps {
  open: boolean
  path: string
  busy: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: (deleteFolder: boolean) => void
}

/**
 * Removing the sample unregisters the project. Deleting its folder is a separate,
 * unchecked choice: it cannot be undone, so the confirm button says which of the
 * two is about to happen.
 */
export function RemoveSampleDialog({ open, path, busy, error, onOpenChange, onConfirm }: RemoveSampleDialogProps) {
  const { t } = useTranslation('onboarding')
  const [deleteFolder, setDeleteFolder] = useState(false)
  useEffect(() => { if (open) setDeleteFolder(false) }, [open])
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('remove.title')}
      description={t('remove.description')}
      confirmLabel={deleteFolder ? t('remove.confirmDelete') : t('remove.confirm')}
      tone={deleteFolder ? 'destructive' : 'default'}
      busy={busy}
      onConfirm={() => onConfirm(deleteFolder)}
      testId="remove-sample-dialog"
      confirmTestId="remove-sample-confirm"
    >
      <div className="space-y-2">
        <label className="flex items-start gap-2 text-body">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 accent-[var(--color-accent-primary)]"
            checked={deleteFolder}
            onChange={(e) => setDeleteFolder(e.target.checked)}
            disabled={busy}
            data-testid="remove-sample-delete-folder"
          />
          <span>{t('remove.deleteFolder')}</span>
        </label>
        <p className="num break-all rounded-control bg-muted/30 px-2 py-1 text-caption text-muted-foreground">{path}</p>
        {deleteFolder && <p className="text-caption text-destructive" role="note">{t('remove.irreversible')}</p>}
        {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
      </div>
    </ConfirmDialog>
  )
}
