import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, ChevronDown, ChevronRight, Copy, FolderOpen, Trash2 } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { isTauri, revealItemInDir } from '../../../lib/tauri-shell'
import { cn } from '../../../lib/utils'
import {
  dismissSafetyArchives, formatArchiveBytes, inspectSafetyArchives, isSafetyArchiveDismissed, removeSafetyArchives,
  safetyArchiveFolderName, type SafetyArchive, type SafetyArchiveDeletion,
} from '../lib/safety-archives-api'

/**
 * Release keeps a file outside the PR (in a "safety archive" folder beside the
 * run's worktree) only when it cannot prove the file is Specrails's own
 * unchanged kit. These pieces show such archives: short, with Delete /
 * Dismiss / Details. Deletion is confirmed and re-validated by the server.
 */

/** Live state of the archives a delivery recorded: only those still on disk. */
export function useSafetyArchives(projectId: string | null | undefined, paths: readonly string[]) {
  const key = paths.join('\n')
  const [archives, setArchives] = useState<SafetyArchive[]>([])
  const [dismissed, setDismissed] = useState(false)

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!projectId || !key) { setArchives([]); return }
    const wanted = key.split('\n').filter((archivePath) => !isSafetyArchiveDismissed(archivePath))
    if (wanted.length === 0) { setArchives([]); return }
    try {
      const answers = await inspectSafetyArchives(wanted.map((archivePath) => ({ projectId, path: archivePath })), signal)
      if (signal?.aborted) return
      setArchives(answers.flatMap((answer) => answer.status === 'present'
        ? [{ projectId, ...answer.quarantine }]
        : []).filter((archive) => archive.fileCount > 0))
    } catch {
      // Unreachable server: show nothing rather than a notice we cannot act on.
      if (!signal?.aborted) setArchives([])
    }
  }, [projectId, key])

  useEffect(() => {
    const controller = new AbortController()
    setDismissed(false)
    void refresh(controller.signal)
    return () => controller.abort()
  }, [refresh])

  const dismiss = useCallback(() => {
    dismissSafetyArchives(archives.map((archive) => archive.path))
    setDismissed(true)
  }, [archives])

  return { archives: dismissed ? [] : archives, refresh, dismiss }
}

function CopyPathButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation('dashboard')
  const [copied, setCopied] = useState(false)
  return <Button
    type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-caption"
    onClick={() => {
      void navigator.clipboard?.writeText(value).then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      }).catch(() => {})
    }}
  >
    {copied ? <Check className="h-3 w-3" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
    {copied ? t('safetyArchive.copied') : label}
  </Button>
}

/** Folder path (copy / show in Finder) and the kept files with their sizes. */
export function SafetyArchiveDetails({ archive }: { archive: SafetyArchive }) {
  const { t } = useTranslation('dashboard')
  const hidden = archive.fileCount - archive.files.length
  return <div className="space-y-1.5" data-testid="safety-archive-details">
    <code className="block break-all rounded bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground">{archive.path}</code>
    <div className="flex flex-wrap items-center gap-1">
      <CopyPathButton value={archive.path} label={t('safetyArchive.copyPath')} />
      {isTauri() && <Button
        type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-caption"
        onClick={() => { void revealItemInDir(archive.path).catch(() => {}) }}
      >
        <FolderOpen className="h-3 w-3" aria-hidden />{t(/mac/i.test(navigator.platform) ? 'safetyArchive.revealFinder' : 'safetyArchive.revealFolder')}
      </Button>}
    </div>
    <ul className="space-y-0.5" aria-label={t('safetyArchive.filesLabel')}>
      {archive.files.map((file) => <li key={file.path} className="flex items-baseline gap-2 text-caption">
        <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={file.path}>{file.path}</span>
        <span className="num shrink-0 text-muted-foreground">{file.kind === 'link' ? t('safetyArchive.link') : formatArchiveBytes(file.bytes)}</span>
      </li>)}
    </ul>
    {hidden > 0 && <p className="text-caption text-muted-foreground">{t('safetyArchive.moreFiles', { count: hidden })}</p>}
  </div>
}

/** Delete confirmation naming the folder(s) and file count. */
export function SafetyArchiveDeleteDialog({ archives, open, onOpenChange, onDeleted }: {
  archives: SafetyArchive[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: (results: SafetyArchiveDeletion[]) => void
}) {
  const { t } = useTranslation('dashboard')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const files = archives.reduce((sum, archive) => sum + archive.fileCount, 0)
  const bytes = archives.reduce((sum, archive) => sum + archive.bytes, 0)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      const results = await removeSafetyArchives(archives.map((archive) => ({ projectId: archive.projectId, path: archive.path })))
      const failed = results.filter((result) => result.status !== 'deleted')
      if (failed.length > 0) setError(t('safetyArchive.deleteFailed', { count: failed.length }))
      onDeleted(results)
      if (failed.length === 0) onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return <ConfirmDialog
    open={open}
    onOpenChange={(next) => { if (!next) setError(null); onOpenChange(next) }}
    busy={busy}
    title={t('safetyArchive.confirmTitle', { count: files })}
    description={archives.length === 1
      ? t('safetyArchive.confirmDescription', { folder: safetyArchiveFolderName(archives[0].path), count: files, size: formatArchiveBytes(bytes) })
      : t('safetyArchive.confirmDescriptionMany', { folders: archives.length, count: files, size: formatArchiveBytes(bytes) })}
    confirmLabel={t('safetyArchive.delete')}
    onConfirm={confirm}
    testId="safety-archive-confirm"
    confirmTestId="safety-archive-confirm-button"
  >
    {archives.length > 1 || error ? <>
      {archives.length > 1 && <ul className="space-y-0.5 font-mono text-caption text-muted-foreground">
        {archives.map((archive) => <li key={archive.path} className="break-all">{safetyArchiveFolderName(archive.path)}</li>)}
      </ul>}
      {error && <p role="alert" className="text-caption text-destructive">{error}</p>}
    </> : null}
  </ConfirmDialog>
}

/**
 * The notice a settled delivery shows when release really kept files. Hidden
 * when every recorded archive is gone, empty, or dismissed in this browser.
 */
export function SafetyArchiveNotice({ projectId, paths, compact = false, className, testId = 'safety-archive-notice' }: {
  projectId: string | null | undefined
  paths: readonly string[]
  compact?: boolean
  className?: string
  testId?: string
}) {
  const { t } = useTranslation('dashboard')
  const { archives, refresh, dismiss } = useSafetyArchives(projectId, paths)
  const [expanded, setExpanded] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const files = useMemo(() => archives.reduce((sum, archive) => sum + archive.fileCount, 0), [archives])
  if (archives.length === 0) return null
  return <div
    className={cn('basis-full rounded-md border border-accent-info/25 bg-accent-info/5 text-muted-foreground', compact ? 'px-1.5 py-1 text-caption' : 'px-2 py-1.5 text-label', className)}
    data-agent-interactive
    data-testid={testId}
    role="status"
  >
    <p className="font-medium text-foreground">{t('safetyArchive.title', { count: files })}</p>
    <p className="mt-0.5 text-caption">{t('safetyArchive.hint')}</p>
    <div className="mt-1 flex flex-wrap items-center gap-1">
      <Button type="button" size="sm" variant="destructive" className="h-6 gap-1 px-2 text-caption" onClick={() => setConfirming(true)} data-testid="safety-archive-delete">
        <Trash2 className="h-3 w-3" aria-hidden />{t('safetyArchive.delete')}
      </Button>
      <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-caption" onClick={dismiss} data-testid="safety-archive-dismiss">
        {t('safetyArchive.dismiss')}
      </Button>
      <Button
        type="button" size="sm" variant="ghost" className="h-6 gap-0.5 px-1.5 text-caption"
        aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} data-testid="safety-archive-details-toggle"
      >
        {expanded ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
        {t('safetyArchive.details')}
      </Button>
    </div>
    {expanded && <div className="mt-1.5 space-y-2">
      {archives.map((archive) => <SafetyArchiveDetails key={archive.path} archive={archive} />)}
    </div>}
    <SafetyArchiveDeleteDialog
      archives={archives}
      open={confirming}
      onOpenChange={setConfirming}
      onDeleted={() => { void refresh() }}
    />
  </div>
}

/** The same notice as a dialog, opened from the settlement toast's Details. */
export function SafetyArchiveDialog({ projectId, paths, open, onOpenChange }: {
  projectId: string | null | undefined
  paths: readonly string[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('dashboard')
  const { archives, refresh, dismiss } = useSafetyArchives(open ? projectId : null, paths)
  const [confirming, setConfirming] = useState(false)
  const files = archives.reduce((sum, archive) => sum + archive.fileCount, 0)
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent size="form" data-testid="safety-archive-dialog">
      <DialogHeader>
        <DialogTitle>{archives.length > 0 ? t('safetyArchive.title', { count: files }) : t('safetyArchive.goneTitle')}</DialogTitle>
        <DialogDescription>{archives.length > 0 ? t('safetyArchive.hint') : t('safetyArchive.gone')}</DialogDescription>
      </DialogHeader>
      {archives.length > 0 && <DialogBody className="space-y-3">
        {archives.map((archive) => <SafetyArchiveDetails key={archive.path} archive={archive} />)}
      </DialogBody>}
      <DialogFooter>
        {archives.length > 0 && <Button type="button" variant="ghost" onClick={() => { dismiss(); onOpenChange(false) }}>{t('safetyArchive.dismiss')}</Button>}
        {archives.length > 0
          ? <Button type="button" variant="destructive" className="gap-1.5" onClick={() => setConfirming(true)}>
            <Trash2 className="h-3.5 w-3.5" aria-hidden />{t('safetyArchive.delete')}
          </Button>
          : <Button type="button" onClick={() => onOpenChange(false)}>{t('safetyArchive.close')}</Button>}
      </DialogFooter>
      <SafetyArchiveDeleteDialog
        archives={archives}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={(results) => {
          void refresh()
          if (results.every((result) => result.status === 'deleted')) onOpenChange(false)
        }}
      />
    </DialogContent>
  </Dialog>
}
