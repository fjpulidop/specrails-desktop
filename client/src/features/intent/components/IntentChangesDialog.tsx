// "View changes": the Intent worktree's files against its base, with status and
// +/− per file. The server reports a summary (no patch bodies), so this is a
// list — binary/untracked files without counts show "—". A refresh that fails
// keeps the earlier list but says so (the list may be stale); the first load
// shows a skeleton, never "0 files".

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { FileMinus2, FilePen, FilePlus2, FileQuestion, Files, Loader2, RefreshCw } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { Skeleton } from '../../../components/ui/skeleton'
import { cn } from '../../../lib/utils'
import { flowApi, type IntentSession, type IntentDiff, type IntentDiffFile } from '../lib/intent-api'

const STATUS_ICON: Record<IntentDiffFile['status'], typeof FilePen> = {
  added: FilePlus2,
  untracked: FileQuestion,
  modified: FilePen,
  renamed: Files,
  deleted: FileMinus2,
}

// Lamps only where the state is a state: added/deleted keep success/destructive;
// modified and renamed are the ordinary case (amber is caution or cost only).
const STATUS_TONE: Record<IntentDiffFile['status'], string> = {
  added: 'text-accent-success',
  untracked: 'text-accent-info',
  modified: 'text-muted-foreground',
  renamed: 'text-muted-foreground',
  deleted: 'text-destructive',
}

export function IntentChangesDialog({ projectId, flow, initial, onClose }: { projectId: string; flow: IntentSession; initial: IntentDiff | null; onClose: () => void }) {
  const { t } = useTranslation('agent')
  const [diff, setDiff] = useState<IntentDiff | null>(initial)
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
  const firstLoad = state === 'loading' && !diff
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      {/* Opened from the Intent strip, which can sit inside the floating chat (z-60): stacked layer. */}
      <DialogContent size="wide" layer="stacked" data-testid="flow-changes-dialog">
        <DialogHeader
          actions={(
            <button type="button" onClick={() => setVersion((v) => v + 1)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-label text-muted-foreground transition-colors hover:bg-surface hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50">
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
          {diff && (
            <p className="text-label tabular-nums text-muted-foreground" data-testid="flow-changes-totals">
              {t('flow.bar.files', { count: diff.totals.files })}
              {' · '}<span className="text-accent-success">+{diff.totals.additions}</span> <span className="text-destructive">−{diff.totals.deletions}</span>
            </p>
          )}
          {/* Any failed load says so: after a failed refresh the earlier list stays, marked as such. */}
          {state === 'error' && <p role="alert" data-testid="flow-changes-error" className="text-label text-destructive">{t('flow.changes.loadFailed')}</p>}
          {firstLoad && (
            <div data-testid="flow-changes-loading" className="space-y-1.5" aria-busy="true">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          )}
          {state === 'ready' && files.length === 0 && (
            <p className="rounded-lg border border-dashed border-border/60 px-3 py-6 text-center text-label text-muted-foreground">{t('flow.changes.empty')}</p>
          )}
          {files.length > 0 && (
            <ul className="divide-y divide-border/40 rounded-lg border border-border/50" aria-label={t('flow.changes.title')}>
              {files.map((file) => {
                const Icon = STATUS_ICON[file.status] ?? FilePen
                return (
                  <li key={file.path} className="flex items-center gap-2 px-3 py-1.5 text-label" data-testid="flow-changes-file">
                    <Icon className={cn('h-3.5 w-3.5 shrink-0', STATUS_TONE[file.status])} aria-hidden />
                    <span className="sr-only">{t(`flow.changes.status.${file.status}`)}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={file.path}>{file.path}</span>
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
