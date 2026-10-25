import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FolderOpen, GitBranch, ListChecks, Play } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import { isTauri } from '../../../lib/tauri-shell'
import { createSampleProject, SampleApiError, type CreateSampleOutcome } from '../lib/sample-api'
import { defaultSampleFolder, type SampleStatus } from '../lib/sample-model'
import { SampleCostStatement } from './SampleCostStatement'

interface SampleProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: SampleStatus | null
  onCreated: (outcome: CreateSampleOutcome) => void | Promise<void>
}

/**
 * "Try it on a sample project": says what will be created and where (the folder
 * is shown and editable), what a run would cost, and that nothing runs yet.
 * Creating the sample is free; the run is a separate, explicit step.
 */
export function SampleProjectDialog({ open, onOpenChange, status, onCreated }: SampleProjectDialogProps) {
  const { t, i18n } = useTranslation('onboarding')
  const sample = status?.catalog[0] ?? { id: 'tic-tac-toe', name: 'tic-tac-toe', specCount: 3 }
  const defaultFolder = useMemo(() => defaultSampleFolder(status?.defaultParentDir ?? '', sample.name), [status?.defaultParentDir, sample.name])
  const [folder, setFolder] = useState(defaultFolder)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { if (open) { setFolder(defaultFolder); setError(null) } }, [open, defaultFolder])

  const launch = status?.launch ?? null
  const edited = folder.trim() !== '' && folder.trim() !== defaultFolder

  async function create() {
    setBusy(true)
    setError(null)
    try {
      // The default folder lets the server pick a free name; an edited one is exact and must be new.
      const outcome = await createSampleProject({
        locale: i18n.language || 'en',
        ...(edited ? { path: folder.trim() } : status?.defaultParentDir ? { parentDir: status.defaultParentDir } : {}),
      })
      await onCreated(outcome)
      onOpenChange(false)
    } catch (err) {
      const code = err instanceof SampleApiError ? err.code : 'generic'
      setError(['path_exists', 'outside_home'].includes(code) ? t(`dialog.errors.${code}`) : t('dialog.errors.generic'))
    } finally {
      setBusy(false)
    }
  }

  async function choose() {
    try {
      const { open: pick } = await import('@tauri-apps/plugin-dialog')
      const selected = await pick({ directory: true, multiple: false, title: t('dialog.chooseTitle'), defaultPath: status?.defaultParentDir || undefined })
      if (typeof selected === 'string' && selected) setFolder(defaultSampleFolder(selected, sample.name))
    } catch { /* No native picker: the folder can still be typed. */ }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent size="form" data-testid="sample-project-dialog">
        <DialogHeader icon={<Play />}>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <ul className="space-y-1.5 text-body text-muted-foreground">
            <li className="flex items-start gap-2"><GitBranch className="mt-0.5 size-3.5 shrink-0 text-accent-primary" aria-hidden />{t('dialog.gets.repo', { name: sample.name })}</li>
            <li className="flex items-start gap-2"><ListChecks className="mt-0.5 size-3.5 shrink-0 text-accent-primary" aria-hidden />{t('dialog.gets.specs', { count: sample.specCount })}</li>
            <li className="flex items-start gap-2"><Play className="mt-0.5 size-3.5 shrink-0 text-accent-primary" aria-hidden />{t('dialog.gets.nothingRuns')}</li>
          </ul>

          <div className="space-y-1.5">
            <label htmlFor="sample-folder" className="text-label">{t('dialog.folder')}</label>
            <div className="flex gap-2">
              <Input id="sample-folder" value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} className="num" data-testid="sample-folder" aria-describedby="sample-folder-hint" />
              {isTauri() && (
                <Button type="button" variant="outline" size="icon" className="shrink-0" onClick={() => { void choose() }} aria-label={t('dialog.choose')} title={t('dialog.choose')}>
                  <FolderOpen className="size-4" aria-hidden />
                </Button>
              )}
            </div>
            <p id="sample-folder-hint" className="text-caption text-muted-foreground">{t('dialog.folderHint')}</p>
          </div>

          <div className="rounded-card border border-border/40 bg-muted/20 p-3 space-y-2" data-testid="sample-dialog-cost">
            <p className="text-label">{t('dialog.runLater')}</p>
            {launch?.ready ? (
              <>
                <SampleCostStatement preset={launch.preset} estimate={launch.estimate} />
                {launch.localPreset && <p className="text-caption text-muted-foreground">{t('dialog.localAlso', { engine: launch.localPreset.provider })}</p>}
              </>
            ) : (
              <p className="text-caption text-muted-foreground" data-testid="sample-dialog-not-ready">{t(launch?.reason === 'not_signed_in' ? 'dialog.notSignedIn' : 'dialog.noProvider')}</p>
            )}
          </div>
          {error && <p role="alert" className="text-caption text-destructive" data-testid="sample-error">{error}</p>}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('common:actions.cancel')}</Button>
          <Button onClick={() => { void create() }} disabled={busy || folder.trim() === ''} data-testid="sample-create">
            {busy ? t('dialog.creating') : t('dialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
