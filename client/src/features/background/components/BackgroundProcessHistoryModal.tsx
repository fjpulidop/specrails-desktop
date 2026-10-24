import { useEffect, useMemo, useState } from 'react'
import { RailTrack } from '../../../components/brand/RailTrack'
import { useTranslation } from 'react-i18next'
import { AlertCircle, ChevronRight, RefreshCw, Search, Terminal } from 'lucide-react'
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../../components/ui/dialog'
import { BackgroundProcessLogsModal, sanitizeBackgroundLog } from './BackgroundProcessLogsModal'
import { isBackgroundProcessFinished } from './BackgroundProcessChip'
import { backgroundProcessKey } from '../lib/background-processes-api'
import type { BackgroundProcessView } from '../context/BackgroundProcessesContext'
import type { BackgroundProcess } from '../../../types'

export function BackgroundProcessHistoryModal({ processes, loading, error, onRefresh, onClose, onKill }: {
  processes: BackgroundProcessView[]
  loading: boolean
  error: string | null
  onRefresh: () => Promise<void>
  onClose: () => void
  onKill: (process: BackgroundProcess) => Promise<void> | void
}) {
  const { t, i18n } = useTranslation('agent')
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(100)
  const [selected, setSelected] = useState<BackgroundProcessView | null>(null)
  useEffect(() => { void onRefresh() }, [onRefresh])
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return processes.filter(process => !needle || [process.command, process.cwd, process.repositoryName, process.repositoryId, process.pid, t(`backgroundProcess.status.${process.status}`)].join(' ').toLocaleLowerCase().includes(needle))
      .sort((a, b) => Number(isBackgroundProcessFinished(a)) - Number(isBackgroundProcessFinished(b)) || b.startedAt - a.startedAt)
  }, [processes, query, t])
  if (selected) return <BackgroundProcessLogsModal
    process={processes.find(process => backgroundProcessKey(process) === backgroundProcessKey(selected)) ?? selected}
    onClose={onClose} onBack={() => setSelected(null)} onKill={onKill} />
  const control = 'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/60 px-2 text-xs text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary disabled:opacity-40'
  return <Dialog open onOpenChange={open => { if (!open) onClose() }}>
    {/* Capture layer: the process history opens over the browser capture / web view surfaces. */}
    <DialogContent size="wide" layer="capture" data-testid="background-process-history-modal">
      <DialogHeader icon={<Terminal className="text-accent-info" />}>
        <DialogTitle>{t('backgroundProcess.history.title')}</DialogTitle>
        <DialogDescription>{t('backgroundProcess.history.description')}</DialogDescription>
      </DialogHeader>
      <div className="flex shrink-0 gap-2 border-b border-border/50 px-5 py-3">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" aria-hidden />
          <input type="search" value={query} onChange={event => { setQuery(event.target.value); setLimit(100) }} placeholder={t('backgroundProcess.history.search')} aria-label={t('backgroundProcess.history.search')} className="h-8 w-full rounded-md border border-border/60 bg-background/50 pl-8 pr-2 text-xs outline-none focus:border-accent-primary/60" />
        </label>
        <button type="button" className={control} disabled={loading} onClick={() => void onRefresh()} aria-label={t('backgroundProcess.history.refresh')} title={t('backgroundProcess.history.refresh')}><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden /></button>
      </div>
      {error && <div role="alert" className="flex shrink-0 items-center gap-2 border-b border-border/40 bg-destructive/5 px-5 py-2 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /><span className="flex-1">{t('backgroundProcess.history.loadFailed')}</span><button type="button" className={control} onClick={() => void onRefresh()}>{t('backgroundProcess.retry')}</button></div>}
      <DialogBody className="min-h-[160px] p-2">
        {filtered.slice(0, limit).map(process => <button type="button" key={backgroundProcessKey(process)} onClick={() => setSelected(process)} aria-label={t('backgroundProcess.open', { command: process.command })} className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-primary">
          <Terminal className={`h-4 w-4 shrink-0 ${isBackgroundProcessFinished(process) ? 'text-muted-foreground' : 'text-accent-info'}`} aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-xs text-foreground">{sanitizeBackgroundLog(process.command)}</span>
            <span className="mt-1 block truncate text-xs text-muted-foreground">{sanitizeBackgroundLog(process.repositoryName ?? process.cwd)} · {new Date(process.startedAt).toLocaleString(i18n.language, { dateStyle: 'short', timeStyle: 'short' })} · PID {process.pid}</span>
          </span>
          <span data-chip="" className={`inline-flex h-5 max-w-[35%] shrink-0 items-center rounded-full px-2 text-caption ${process.status === 'failed' ? 'bg-destructive/10 text-destructive' : isBackgroundProcessFinished(process) ? 'bg-muted text-muted-foreground' : 'bg-accent-info/10 text-accent-info'}`}>{t(`backgroundProcess.status.${process.status}`)}</span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>)}
        {loading && !processes.length ? <p role="status" className="flex justify-center gap-2 py-12 text-xs text-muted-foreground"><span aria-hidden className="w-16 shrink-0"><RailTrack running /></span>{t('backgroundProcess.history.loading')}</p>
          : !error && !filtered.length && <p className="px-4 py-12 text-center text-xs text-muted-foreground">{t(query.trim() ? 'backgroundProcess.history.noMatches' : 'backgroundProcess.history.empty')}</p>}
        {filtered.length > limit && <div className="py-2 text-center"><button type="button" className={control} onClick={() => setLimit(value => value + 100)}>{t('backgroundProcess.history.showMore')}</button></div>}
      </DialogBody>
      <DialogFooter className="text-xs text-muted-foreground" start={<span>{t('backgroundProcess.history.count', { count: filtered.length })}</span>} />
    </DialogContent>
  </Dialog>
}
