// "View changes": the Flow worktree's files against its base, with status and
// +/− per file. The server reports a summary (no patch bodies), so this is a
// list — binary/untracked files without counts show "—".

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileMinus2, FilePen, FilePlus2, FileQuestion, Files, Loader2, RefreshCw } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { cn } from '../../../lib/utils'
import { flowApi, type Flow, type FlowDiff, type FlowDiffFile } from '../lib/flow-api'

const STATUS_ICON: Record<FlowDiffFile['status'], typeof FilePen> = {
  added: FilePlus2,
  untracked: FileQuestion,
  modified: FilePen,
  renamed: Files,
  deleted: FileMinus2,
}

const STATUS_TONE: Record<FlowDiffFile['status'], string> = {
  added: 'text-accent-success',
  untracked: 'text-accent-info',
  modified: 'text-accent-warning',
  renamed: 'text-accent-primary',
  deleted: 'text-destructive',
}

export function FlowChangesDialog({ projectId, flow, initial, onClose }: { projectId: string; flow: Flow; initial: FlowDiff | null; onClose: () => void }) {
  const { t } = useTranslation('agent')
  const [diff, setDiff] = useState<FlowDiff | null>(initial)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>(initial ? 'ready' : 'loading')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState((current) => (current === 'ready' ? current : 'loading'))
    flowApi.diff(projectId, flow.id)
      .then((value) => { if (!cancelled) { setDiff(value); setState('ready') } })
      .catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [projectId, flow.id, version])

  const files = diff?.files ?? []
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      {/* Opened from the Flow strip, which can sit inside the floating chat (z-60): stacked layer. */}
      <DialogContent size="wide" layer="stacked" data-testid="flow-changes-dialog">
        <DialogHeader
          actions={(
            <button type="button" onClick={() => setVersion((v) => v + 1)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-foreground/65 hover:bg-surface hover:text-foreground">
              {state === 'loading' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <RefreshCw className="h-3 w-3" aria-hidden />}
              {t('flow.changes.refresh')}
            </button>
          )}
        >
          <DialogTitle>{t('flow.changes.title')}</DialogTitle>
          <DialogDescription>
            {flow.branch ? t('flow.changes.subtitle', { branch: flow.branch }) : t('flow.changes.subtitleNoBranch')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <p className="text-xs tabular-nums text-foreground/65" data-testid="flow-changes-totals">
            {t('flow.bar.files', { count: diff?.totals.files ?? 0 })}
            {diff && <> · <span className="text-accent-success">+{diff.totals.additions}</span> <span className="text-destructive">−{diff.totals.deletions}</span></>}
          </p>
          {state === 'error' && !diff && <p role="alert" className="text-xs text-destructive">{t('flow.changes.loadFailed')}</p>}
          {state !== 'error' && files.length === 0 && state === 'ready' && (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-xs text-foreground/50">{t('flow.changes.empty')}</p>
          )}
          {files.length > 0 && (
            <ul className="divide-y divide-border/40 rounded-lg border border-border/50" aria-label={t('flow.changes.title')}>
              {files.map((file) => {
                const Icon = STATUS_ICON[file.status] ?? FilePen
                return (
                  <li key={file.path} className="flex items-center gap-2 px-3 py-1.5 text-xs" data-testid="flow-changes-file">
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', STATUS_TONE[file.status])} aria-hidden />
                    <span className="sr-only">{t(`flow.changes.status.${file.status}`)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground/85" title={file.path}>{file.path}</span>
                    <span className="shrink-0 tabular-nums text-accent-success">{file.additions === null ? '—' : `+${file.additions}`}</span>
                    <span className="shrink-0 tabular-nums text-destructive">{file.deletions === null ? '—' : `−${file.deletions}`}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}
